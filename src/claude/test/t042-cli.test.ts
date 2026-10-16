import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { upsertRegion } from '../src/service/regions.ts';
import { startMockServer } from './helpers/mock-server.ts';
import { bootHttp } from './helpers/http-helpers.ts';

const jsonld3 = readFileSync(new URL('./fixtures/jsonld-3.html', import.meta.url), 'utf8');
const root = join(import.meta.dirname, '..');
const ec = (args: string[]) => spawnSync(process.execPath, [join(root, 'bin', 'ec.ts'), ...args], { cwd: root, encoding: 'utf8' });

test('source list --embedded -> exit 0, JSON with sources array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec42-'));
  try {
    const r = ec(['source', 'list', '--embedded', '--data-dir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.ok(Array.isArray(body.sources));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown command -> INVALID_ARGUMENT, exit 2', () => {
  const r = ec(['nosuch']);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).error.code, 'INVALID_ARGUMENT');
});

test('missing required arg -> exit 2; NOT_FOUND -> exit 1 (embedded)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec42-'));
  try {
    assert.equal(ec(['events', '--embedded', '--data-dir', dir]).status, 2);
    const nf = ec(['run', 'nope', '--embedded', '--data-dir', dir]);
    assert.equal(nf.status, 1);
    assert.equal(JSON.parse(nf.stdout).error.code, 'NOT_FOUND');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no daemon and no --embedded -> exit 4', () => {
  const r = ec(['source', 'list', '--base-url', 'http://127.0.0.1:1']);
  assert.equal(r.status, 4);
  assert.equal(JSON.parse(r.stdout).error.code, 'DAEMON_UNAVAILABLE');
});

test('package.json bin has ec and ecd', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.ec, 'bin/ec.ts');
  assert.equal(pkg.bin.ecd, 'src/daemon.ts');
});

test('§10-T15: CLI --embedded and direct HTTP give deepEqual JSON for normal / ZERO_ITEMS / NOT_FOUND / INVALID_ARGUMENT; exits 0 / 3 / 1 / 2', async () => {
  const srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.text('/ok', jsonld3);
  srv.text('/empty', '<html><body>nothing</body></html>');
  const dir = mkdtempSync(join(tmpdir(), 'ec42-'));
  const s = await bootHttp();
  try {
    const db = openDb(join(dir, 'event-calendar.db'));
    upsertRegion(db, 'r1', { name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷'] });
    db.close();
    const spec = { kind: 'jsonld', region_policy: { mode: 'trust_source' } };
    const addBody = (path: string, extra: Record<string, unknown> = {}) => (
      { url: `${srv.base}${path}`, region_id: 'r1', terms_note: 'n', allow_redistribute: true, spec, ...extra });
    const addArgs = (b: Record<string, unknown>): string[] => [
      'source', 'add', '--url', String(b['url']), '--region-id', 'r1', '--terms-note', 'n', '--allow-redistribute', 'true',
      '--spec', JSON.stringify(spec), ...(b['interval_sec'] !== undefined ? ['--interval-sec', String(b['interval_sec'])] : []),
    ];
    const cfgPath = join(dir, 'ec-config.json');
    writeFileSync(cfgPath, JSON.stringify({ ssrf_allowlist: [new URL(srv.base).hostname] }));
    // async spawn: the in-process mock server must keep serving while the CLI child runs (spawnSync would block it)
    const cli = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [join(root, 'bin', 'ec.ts'), ...args, '--embedded', '--data-dir', dir, '--config', cfgPath], { cwd: root });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const cases: { name: string; args: string[]; method: string; path: string; body?: unknown; exit: number; status: number }[] = [
      { name: 'normal', args: ['source', 'test', '--url', `${srv.base}/ok`, '--spec', JSON.stringify(spec)], method: 'POST', path: '/sources:test', body: { url: `${srv.base}/ok`, spec }, exit: 0, status: 200 },
      { name: 'ZERO_ITEMS', args: addArgs(addBody('/empty')), method: 'POST', path: '/sources', body: addBody('/empty'), exit: 3, status: 422 },
      { name: 'NOT_FOUND', args: ['run', 'nope'], method: 'POST', path: '/sources/nope/run', body: {}, exit: 1, status: 404 },
      { name: 'INVALID_ARGUMENT', args: addArgs(addBody('/ok', { interval_sec: 899 })), method: 'POST', path: '/sources', body: addBody('/ok', { interval_sec: 899 }), exit: 2, status: 400 },
    ];
    for (const c of cases) {
      const r = await cli(c.args);
      const h = await s.call(c.method, c.path, c.body);
      assert.equal(r.status, c.exit, `${c.name}: ${r.stderr}${r.stdout}`);
      assert.equal(h.status, c.status, c.name);
      assert.deepEqual(JSON.parse(r.stdout), h.body, c.name);
    }
  } finally {
    await s.stop(); await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--config validation: non-embedded, missing file, bad JSON, bad allowlist, unknown key -> INVALID_ARGUMENT exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec42-'));
  try {
    const cfg = (name: string, text: string): string => { const p = join(dir, name); writeFileSync(p, text); return p; };
    const run = (args: string[]) => ec(['source', 'list', ...args]);
    const expectBad = (r: ReturnType<typeof ec>, label: string): void => {
      assert.equal(r.status, 2, `${label}: ${r.stderr}${r.stdout}`);
      assert.equal(JSON.parse(r.stdout).error.code, 'INVALID_ARGUMENT', label);
    };
    const emb = ['--embedded', '--data-dir', dir, '--config'];
    const ok = cfg('ok.json', JSON.stringify({ ssrf_allowlist: ['127.0.0.1'] }));
    expectBad(run(['--config', ok]), 'without --embedded');
    expectBad(run([...emb, join(dir, 'missing.json')]), 'missing file');
    expectBad(run([...emb, cfg('bad.json', '{nope')]), 'invalid JSON');
    expectBad(run([...emb, cfg('arr.json', '[]')]), 'not an object');
    expectBad(run([...emb, cfg('al1.json', JSON.stringify({ ssrf_allowlist: 'x' }))]), 'allowlist not array');
    expectBad(run([...emb, cfg('al2.json', JSON.stringify({ ssrf_allowlist: ['http://x/'] }))]), 'allowlist entry with scheme');
    expectBad(run([...emb, cfg('al3.json', JSON.stringify({ ssrf_allowlist: [1] }))]), 'allowlist non-string');
    expectBad(run([...emb, cfg('unk.json', JSON.stringify({ bogus: 1 }))]), 'unknown key');
    const good = run([...emb, ok]);
    assert.equal(good.status, 0, good.stderr + good.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('EC_SSRF_ALLOWLIST env var is NOT honoured (no backdoor): loopback stays blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec42-'));
  try {
    const r = spawnSync(process.execPath, [join(root, 'bin', 'ec.ts'), 'source', 'test', '--url', 'http://127.0.0.1:9/x', '--spec', '{"kind":"jsonld","region_policy":{"mode":"trust_source"}}', '--embedded', '--data-dir', dir],
      { cwd: root, encoding: 'utf8', env: { ...process.env, EC_SSRF_ALLOWLIST: '127.0.0.1' } });
    assert.equal(JSON.parse(r.stdout).error.code, 'SSRF_BLOCKED', r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
