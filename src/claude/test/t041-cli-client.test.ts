import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../src/cli/client.ts';
import { startDaemon } from '../src/daemon.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ecc-'));
const region = { id: 'r1', name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷'] };

test('daemon down: embedded=false -> DAEMON_UNAVAILABLE exit 4; embedded=true succeeds', async () => {
  const dir = tmp();
  const d = await startDaemon({ dbPath: ':memory:', port: 0, dataDir: dir, deps: { autoRun: false } });
  const baseUrl = `http://127.0.0.1:${d.port}`;
  await d.stop();
  try {
    const r = await callTool('health', {}, { embedded: false, baseUrl });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.code, 'DAEMON_UNAVAILABLE'); assert.equal(r.exitCode, 4); }
    const e = await callTool('health', {}, { embedded: true, dataDir: dir });
    assert.equal(e.ok, true);
    assert.equal(e.exitCode, 0);
    assert.deepEqual((e as any).body, { sources: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exit code mapping via HTTP error envelopes', async () => {
  const table: Record<string, [number, number]> = {
    INVALID_ARGUMENT: [400, 2], ZERO_ITEMS: [422, 3], NOT_FOUND: [404, 1], SSRF_BLOCKED: [403, 1],
  };
  const srv = createServer((req, res) => {
    const code = (req.url ?? '').split('code=')[1] ?? '';
    res.statusCode = table[code]![0];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code, message: 'm', details: {} } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    // the mock reads `code=` from the query string: use events_search passthrough of an arbitrary key
    for (const [code, [, exit]] of Object.entries(table)) {
      const r = await callTool('events_search', { code }, { baseUrl });
      assert.equal(r.ok, false);
      if (!r.ok) { assert.equal(r.code, code); assert.equal(r.exitCode, exit); }
    }
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
});

test('embedded domain errors map to exit codes; unknown tool -> 2', async () => {
  const dir = tmp();
  try {
    const bad = await callTool('events_search', { region_id: 'r1' }, { embedded: true, dataDir: dir });
    assert.ok(!bad.ok && bad.code === 'INVALID_ARGUMENT' && bad.exitCode === 2);
    const nf = await callTool('run_now', { id: 'nope' }, { embedded: true, dataDir: dir });
    assert.ok(!nf.ok && nf.code === 'NOT_FOUND' && nf.exitCode === 1);
    const unk = await callTool('bogus', {}, { embedded: true, dataDir: dir });
    assert.ok(!unk.ok && unk.exitCode === 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP and embedded return identical body JSON for identical input', async () => {
  const dir = tmp();
  const dbPath = join(dir, 'shared.db');
  const d = await startDaemon({ dbPath, port: 0, dataDir: dir, deps: { autoRun: false } });
  const baseUrl = `http://127.0.0.1:${d.port}`;
  try {
    const up = await callTool('region_upsert', region, { baseUrl });
    assert.ok(up.ok);
    const range = { region_id: 'r1', from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' };
    for (const [tool, input] of [['source_list', {}], ['health', {}], ['events_search', range]] as const) {
      const viaHttp = await callTool(tool, input, { baseUrl });
      const viaEmb = await callTool(tool, input, { embedded: true, dbPath });
      assert.ok(viaHttp.ok && viaEmb.ok, tool);
      assert.deepEqual((viaEmb as any).body, (viaHttp as any).body, tool);
    }
    const upEmb = await callTool('region_upsert', region, { embedded: true, dbPath });
    assert.deepEqual((upEmb as any).body, (up as any).body);
    // ICS: both paths give the same body and ETag; conditional request -> 304
    const icsH = await callTool('calendar_export', { region_id: 'r1' }, { baseUrl });
    const icsE = await callTool('calendar_export', { region_id: 'r1' }, { embedded: true, dbPath });
    assert.ok(icsH.ok && icsE.ok);
    assert.equal((icsE as any).body, (icsH as any).body);
    assert.equal((icsE as any).etag, (icsH as any).etag);
    const nm = await callTool('calendar_export', { region_id: 'r1', if_none_match: (icsH as any).etag }, { baseUrl });
    assert.ok(nm.ok && nm.status === 304);
  } finally { await d.stop(); rmSync(dir, { recursive: true, force: true }); }
});
