import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from '../src/config.ts';
import { runJob } from '../src/pipeline/run-job.ts';
import type { FetchText, SourceRow } from '../src/pipeline/run-job.ts';
import type { FetchStageDeps } from '../src/pipeline/fetch-stage.ts';
import { FakeClock } from '../src/clock.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { RobotsCache } from '../src/net/robots.ts';
import { startMockServer } from './helpers/mock-server.ts';
import { jsonLdPage, setupDb, staticFetch } from './helpers/run-helpers.ts';

const config = defaultConfig();
const day = (n: number): Date => new Date(Date.UTC(2026, 9, 16 + n));
const A = { uid: 'a1', name: '世田谷夏祭り' };
const B = { uid: 'b1', name: '三軒茶屋盆踊り', start: '2026-11-10T18:00:00+09:00' };
const go = (db: DatabaseSync, source: SourceRow, f: FetchText, n: number) => runJob({ db, source, fetchText: f, now: day(n), config });
const evOf = (db: DatabaseSync, title: string) =>
  db.prepare('SELECT e.status, e.cancelled_at, r.miss_count FROM event e JOIN event_source_ref r ON r.event_id=e.id WHERE e.title=?').get(title) as
    { status: string; cancelled_at: string | null; miss_count: number };

test('§10-T8: 3 consecutive misses -> cancelled on 3rd', async () => {
  const { db, sources } = setupDb(); const s = sources[0]!;
  await go(db, s, staticFetch(jsonLdPage([A, B])), 0);
  const only = staticFetch(jsonLdPage([B]));
  await go(db, s, only, 1);
  assert.deepEqual([evOf(db, A.name).status, evOf(db, A.name).miss_count], ['confirmed', 1]);
  await go(db, s, only, 2);
  assert.deepEqual([evOf(db, A.name).status, evOf(db, A.name).miss_count], ['confirmed', 2]);
  await go(db, s, only, 3);
  const e = evOf(db, A.name);
  assert.equal(e.status, 'cancelled');
  assert.ok(e.cancelled_at);
  assert.equal(evOf(db, B.name).status, 'confirmed');
});

test('reappearance after 2 misses resets miss_count', async () => {
  const { db, sources } = setupDb(); const s = sources[0]!;
  await go(db, s, staticFetch(jsonLdPage([A, B])), 0);
  await go(db, s, staticFetch(jsonLdPage([B])), 1);
  await go(db, s, staticFetch(jsonLdPage([B])), 2);
  await go(db, s, staticFetch(jsonLdPage([A, B])), 3);
  const e = evOf(db, A.name);
  assert.equal(e.miss_count, 0);
  assert.equal(e.status, 'confirmed');
});

test('past events are never cancelled by disappearance', async () => {
  const { db, sources } = setupDb(); const s = sources[0]!;
  await go(db, s, staticFetch(jsonLdPage([A, B])), 0);
  for (const n of [30, 31, 32, 33]) await go(db, s, staticFetch(jsonLdPage([B])), n); // A (11/03) is past by day 30 (11/15)
  assert.equal(evOf(db, A.name).status, 'confirmed');
});

test('failed runs do not bump miss_count', async () => {
  const { db, sources } = setupDb(); const s = sources[0]!;
  await go(db, s, staticFetch(jsonLdPage([A, B])), 0);
  for (const n of [1, 2, 3, 4]) {
    const r = await go(db, s, staticFetch('', 500), n);
    assert.equal(r.outcome, 'failed');
  }
  await go(db, s, async () => { throw new Error('x'); }, 5);
  assert.equal(evOf(db, A.name).miss_count, 0);
  assert.equal(evOf(db, A.name).status, 'confirmed');
});

test('partial runs (truncated body) do not bump miss_count', async () => {
  const { db, sources } = setupDb(); const s = sources[0]!;
  await go(db, s, staticFetch(jsonLdPage([A, B])), 0);
  const srv = await startMockServer();
  try {
    srv.text('/robots.txt', 'User-agent: *\nAllow: /');
    srv.text('/e', jsonLdPage([B]) + 'x'.repeat(2000));
    const clock = new FakeClock(0);
    const net: FetchStageDeps = {
      clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
      config: { ssrf_allowlist: ['127.0.0.1'], body_max: 100 },
    };
    const ns: SourceRow = { ...s, url: srv.base + '/e' };
    for (const n of [1, 2, 3, 4]) {
      const pending = runJob({ db, source: ns, net, now: day(n), config });
      let done = false;
      void pending.finally(() => { done = true; }).catch(() => {});
      while (!done) { await new Promise((r) => setImmediate(r)); clock.advance(10_000); }
      assert.equal((await pending).outcome, 'partial');
    }
  } finally { await srv.close(); }
  assert.equal(evOf(db, A.name).miss_count, 0);
  assert.equal(evOf(db, A.name).status, 'confirmed');
});
