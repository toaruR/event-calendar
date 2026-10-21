import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.ts';
import { upsertRegion } from '../../src/service/regions.ts';
import { startMockServer } from '../helpers/mock-server.ts';
import type { MockServer } from '../helpers/mock-server.ts';
import { startProc, runProc, isGone, spawnedPids } from '../helpers/spawn.ts';

const root = join(import.meta.dirname, '..', '..');
const ecBin = join(root, 'bin', 'ec.ts');
const daemonChild = join(root, 'test', 'helpers', 'daemon-child.ts');
const spec = { kind: 'jsonld', region_policy: { mode: 'trust_source' } };
const N = 100;

const page = (prefix: string): string => {
  const evs = [];
  for (let i = 0; i < N; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const hour = String(8 + Math.floor(i / 28)).padStart(2, '0');
    evs.push({
      '@context': 'https://schema.org', '@type': 'Event', '@id': `${prefix}-${i}`,
      name: `${prefix} イベント ${i}`, startDate: `2026-12-${day}T${hour}:00:00+09:00`,
      location: { '@type': 'Place', name: `${prefix} 会場 ${i}` }, url: `http://example.test/${prefix}/${i}`,
    });
  }
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(evs)}</script></head><body></body></html>`;
};

let srv: MockServer;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.text('/cli', page('cli'));
  srv.text('/dmn', page('dmn'));
});
after(async () => { await srv.close(); });

test('§10-T16: embedded CLI and a separate daemon process upsert 100 events each into one file DB -> 0 errors, 200 events, no leftover pids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec46-'));
  const host = new URL(srv.base).hostname;
  const conf = { ssrf_allowlist: [host], host_rate: { requests: 1000, per_sec: 1 } };
  const cfgPath = join(dir, 'ec-config.json');
  writeFileSync(cfgPath, JSON.stringify({ ssrf_allowlist: [host] }));
  const db = openDb(join(dir, 'event-calendar.db'));
  upsertRegion(db, 'r1', { name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷'] });
  db.close();

  const dmn = startProc([daemonChild, '--port', '0', '--data-dir', dir, '--stdin-shutdown'], {
    cwd: root, env: { EC_TEST_CONFIG: JSON.stringify(conf) },
  });
  const results: { pid: number; status: number | null; stderr: string }[] = [];
  try {
    const info = JSON.parse(await dmn.waitLine((l) => l.includes('listening')));
    const base = `http://127.0.0.1:${info.port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', 'x-gui-token': info.token },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const addBody = (path: string) => ({ url: `${srv.base}${path}`, region_id: 'r1', terms_note: 'n', allow_redistribute: true, spec });

    // CLI side: add + run, real `node bin/ec.ts --embedded` processes against the same DB file
    const cliFlow = async (): Promise<void> => {
      const g = ['--embedded', '--data-dir', dir, '--config', cfgPath];
      const add = await runProc([ecBin, 'source', 'add', '--url', `${srv.base}/cli`, '--region-id', 'r1', '--terms-note', 'n',
        '--allow-redistribute', 'true', '--spec', JSON.stringify(spec), ...g], { cwd: root });
      results.push({ pid: add.pid, status: add.status, stderr: add.stderr });
      assert.equal(add.status, 0, add.stdout + add.stderr);
      const j = JSON.parse(add.stdout);
      const id = j.source?.id ?? j.id;
      assert.ok(id, add.stdout);
      const run = await runProc([ecBin, 'run', String(id), ...g], { cwd: root });
      results.push({ pid: run.pid, status: run.status, stderr: run.stderr });
      assert.equal(run.status, 0, run.stdout + run.stderr);
    };
    // Daemon side: add + run over HTTP
    const daemonFlow = async (): Promise<void> => {
      const add = await call('POST', '/sources', addBody('/dmn'));
      assert.equal(add.status, 200, JSON.stringify(add.body));
      const id = add.body.source?.id ?? add.body.id;
      assert.ok(id, JSON.stringify(add.body));
      const run = await call('POST', `/sources/${id}/run`, {});
      assert.equal(run.status, 200, JSON.stringify(run.body));
    };
    await Promise.all([cliFlow(), daemonFlow()]);

    const range = 'region_id=r1&from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z&limit=1000';
    const ev = await call('GET', `/events?${range}`);
    assert.equal(ev.status, 200);
    assert.equal(ev.body.count, 2 * N, `events: ${ev.body.count}`);
    for (const r of results) assert.equal(r.stderr, '', 'CLI stderr must be empty');
    assert.ok(results.every((r) => r.status === 0));

    dmn.child.stdin!.write('shutdown\n');
    assert.equal(await dmn.exited, 0);
    assert.equal(dmn.stderr(), '', 'daemon stderr must be empty');
  } finally {
    if (!isGone(dmn.pid)) dmn.child.kill('SIGKILL');
    await dmn.exited;
    rmSync(dir, { recursive: true, force: true });
  }
  const pids = spawnedPids();
  assert.ok(pids.length >= 3, `spawned ${pids.length}`);
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), (e: any) => e.code === 'ESRCH', `pid ${pid} still alive`);
  }
});
