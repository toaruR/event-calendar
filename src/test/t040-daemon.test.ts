import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../src/daemon.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ecd-'));

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

test('startDaemon: /health 200, stop -> ECONNREFUSED', async () => {
  const dir = tmp();
  const d = await startDaemon({ dbPath: ':memory:', port: 0, dataDir: dir, deps: { autoRun: false } });
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as any).sources, []);
  } finally { await d.stop(); }
  await assert.rejects(fetch(`http://127.0.0.1:${d.port}/health`), (e: any) => e.cause?.code === 'ECONNREFUSED');
  rmSync(dir, { recursive: true, force: true });
});

test('guiToken: 64 hex, accepted; wrong -> 400', async () => {
  const dir = tmp();
  const d = await startDaemon({ dbPath: ':memory:', port: 0, dataDir: dir, deps: { autoRun: false } });
  try {
    assert.match(d.guiToken, /^[0-9a-f]{64}$/);
    const ok = await fetch(`http://127.0.0.1:${d.port}/sources`, { headers: { 'x-gui-token': d.guiToken } });
    assert.equal(ok.status, 200);
    const bad = await fetch(`http://127.0.0.1:${d.port}/sources`, { headers: { 'x-gui-token': 'x'.repeat(64) } });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as any).error.code, 'INVALID_ARGUMENT');
  } finally { await d.stop(); }
  rmSync(dir, { recursive: true, force: true });
});

test('node src/daemon.ts child: /health 200, SIGTERM -> exit 0', async () => {
  const dir = tmp();
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/daemon.ts', import.meta.url)),
    '--port', String(port), '--data-dir', dir, '--stdin-shutdown'], { stdio: ['pipe', 'ignore', 'inherit'] });
  const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/health`)).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(up, 'daemon did not come up');
    // Windows has no graceful SIGTERM: use the stdin shutdown hook there, a real SIGTERM elsewhere.
    if (process.platform === 'win32') child.stdin!.write('shutdown\n'); else child.kill('SIGTERM');
    assert.equal(await exited, 0);
  } finally { child.kill('SIGKILL'); }
  rmSync(dir, { recursive: true, force: true });
});
