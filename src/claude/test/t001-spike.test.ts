import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

test('node:sqlite WAL and busy_timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 't001-'));
  const db = new DatabaseSync(join(dir, 'x.db'));
  try {
    const jm = db.prepare('PRAGMA journal_mode=wal').get() as Record<string, unknown>;
    assert.equal(jm['journal_mode'], 'wal');
    db.exec('PRAGMA busy_timeout=5000');
    const bt = db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>;
    assert.equal(Object.values(bt)[0], 5000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TS type-strip direct run', () => {
  const out = execFileSync(process.execPath, ['src/spike/probe.ts'], { encoding: 'utf8' });
  assert.ok(out.includes('probe-ok'));
});

test('http listen on 127.0.0.1 and fetch 200', async () => {
  const srv = createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { port } = srv.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
  } finally {
    srv.close();
  }
});
