import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { defaultConfig } from '../src/config.ts';
import type { Clock } from '../src/clock.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { AppError } from '../src/errors.ts';
import type { ErrorCode } from '../src/errors.ts';
import { createServer } from '../src/http/server.ts';
import type { Core } from '../src/http/server.ts';
import type { SourceDeps } from '../src/service/sources.ts';

const config = defaultConfig();
const clock: Clock = { now: () => Date.parse('2026-10-01T00:00:00Z'), sleep: async () => {} };

export function makeCore(): Core {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO region(id,name,tz,keywords_json) VALUES(?,?,?,?)').run('r1', '世田谷', 'Asia/Tokyo', '["世田谷"]');
  db.prepare('INSERT INTO source(id,region_id,url,kind,spec_json,terms_note,allow_redistribute,state) VALUES(?,?,?,?,?,?,?,?)')
    .run('s1', 'r1', 'http://a.test/', 'jsonld', '{"kind":"jsonld"}', 'n', 1, 'active');
  db.prepare('INSERT INTO source(id,region_id,url,kind,spec_json,terms_note,allow_redistribute,state) VALUES(?,?,?,?,?,?,?,?)')
    .run('s2', 'r1', 'http://b.test/', 'jsonld', '{"kind":"jsonld"}', 'n', 1, 'degraded');
  const deps: SourceDeps = { net: { clock, limiter: new RateLimiter(config.host_rate, clock) }, config };
  return { db, deps };
}

async function boot() {
  const h = createServer(makeCore(), {
    port: 0,
    register: (r) => {
      r.add('GET', '/boom/{code}', ({ params }) => { throw new AppError(params['code'] as ErrorCode, 'x'); });
    },
  });
  await h.start();
  const addr = h.server.address() as { address: string; port: number };
  return { h, base: `http://127.0.0.1:${addr.port}`, addr };
}

test('gui_token: 64 hex, differs per start', async () => {
  const a = await boot();
  const b = await boot();
  try {
    assert.match(a.h.token, /^[0-9a-f]{64}$/);
    assert.match(b.h.token, /^[0-9a-f]{64}$/);
    assert.notEqual(a.h.token, b.h.token);
  } finally { await a.h.stop(); await b.h.stop(); }
});

test('token check: wrong -> 400 envelope; correct/no header -> 200', async () => {
  const { h, base } = await boot();
  try {
    const bad = await fetch(`${base}/sources`, { headers: { 'X-GUI-Token': 'wrong' } });
    assert.equal(bad.status, 400);
    const bb = await bad.json() as any;
    assert.equal(bb.error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(Object.keys(bb.error), ['code', 'message', 'details']);
    const ok = await fetch(`${base}/sources`, { headers: { 'X-GUI-Token': h.token } });
    assert.equal(ok.status, 200);
    assert.equal(Array.isArray(((await ok.json()) as any).sources), true);
    const none = await fetch(`${base}/sources`);
    assert.equal(none.status, 200);
    const filtered = await (await fetch(`${base}/sources?state=degraded`)).json() as any;
    assert.deepEqual(filtered.sources.map((s: any) => s.id), ['s2']);
    assert.equal((await fetch(`${base}/sources?state=bogus`)).status, 400);
  } finally { await h.stop(); }
});

test('GET /health: 4-key entries', async () => {
  const { h, base } = await boot();
  try {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    const b = await r.json() as any;
    assert.equal(b.sources.length, 2);
    for (const s of b.sources) assert.deepEqual(Object.keys(s), ['id', 'state', 'last_success_at', 'failures']);
  } finally { await h.stop(); }
});

test('404 NOT_FOUND and error code -> status mapping', async () => {
  const { h, base } = await boot();
  try {
    const r = await fetch(`${base}/nope`);
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as any).error.code, 'NOT_FOUND');
    for (const [code, status] of [['INVALID_ARGUMENT', 400], ['CONFLICT', 409], ['ZERO_ITEMS', 422], ['SSRF_BLOCKED', 403]] as const) {
      const x = await fetch(`${base}/boom/${code}`);
      assert.equal(x.status, status);
      assert.equal(((await x.json()) as any).error.code, code);
    }
  } finally { await h.stop(); }
});

test('binds 127.0.0.1 by default', async () => {
  const { h, addr } = await boot();
  try { assert.equal(addr.address, '127.0.0.1'); } finally { await h.stop(); }
});
