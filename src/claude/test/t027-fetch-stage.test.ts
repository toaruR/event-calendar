import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../src/pipeline/run-job.ts';
import type { SourceRow } from '../src/pipeline/run-job.ts';
import type { FetchStageDeps } from '../src/pipeline/fetch-stage.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { RobotsCache } from '../src/net/robots.ts';
import { defaultConfig } from '../src/config.ts';
import type { Clock } from '../src/clock.ts';
import { startMockServer } from './helpers/mock-server.ts';
import type { MockServer } from './helpers/mock-server.ts';
import { count, jsonLdPage, setupDb } from './helpers/run-helpers.ts';

const config = defaultConfig();

/** Clock whose sleep() advances time instantly (deterministic, no real waiting). */
class AutoClock implements Clock {
  t = 1_000_000;
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

let srv: MockServer;
before(async () => { srv = await startMockServer(); });
after(async () => { await srv.close(); });

function mk(path: string) {
  const { db, sources } = setupDb();
  const source: SourceRow = { ...sources[0]!, url: `${srv.base}${path}` };
  db.prepare('UPDATE source SET url = ? WHERE id = ?').run(source.url, source.id);
  const clock = new AutoClock();
  const net: FetchStageDeps = {
    clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: ['127.0.0.1'] },
  };
  return { db, source, net, clock };
}
const now = new Date('2026-10-01T00:00:00Z');

test('§10-T24: 6MB response -> partial, no events', async () => {
  srv.route('/big', (_q, res) => { res.statusCode = 200; res.end('a'.repeat(6 * 1024 * 1024)); });
  const { db, source, net } = mk('/big');
  const before = count(db, 'event');
  const r = await runJob({ db, source, net, now, config });
  assert.equal(r.outcome, 'partial');
  assert.equal(count(db, 'event') - before, 0);
});

test('robots Disallow -> blocked_robots, zero body GETs', async () => {
  srv.text('/robots.txt', 'User-agent: *\nDisallow: /private');
  srv.text('/private/e', jsonLdPage([{ uid: 'a', name: 'x' }]));
  const { db, source, net } = mk('/private/e');
  const r = await runJob({ db, source, net, now, config });
  assert.equal(r.outcome, 'blocked_robots');
  assert.equal(srv.requestCount('/private/e'), 0);
  assert.equal(count(db, 'event'), 0);
});

test('304 -> not_modified, event count unchanged', async () => {
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.route('/nm', (req, res) => {
    if (req.headers['if-none-match'] === '"v1"') { res.statusCode = 304; res.end(); return; }
    res.statusCode = 200; res.setHeader('etag', '"v1"'); res.end(jsonLdPage([{ uid: 'a', name: 'フェス' }]));
  });
  const { db, source, net } = mk('/nm');
  const r1 = await runJob({ db, source, net, now, config });
  assert.equal(r1.outcome, 'ok');
  assert.equal(count(db, 'event'), 1);
  const r2 = await runJob({ db, source, net, now: new Date(now.getTime() + 3600_000), config });
  assert.equal(r2.outcome, 'not_modified');
  assert.equal(count(db, 'event'), 1);
});

test('retry_backoff: 429 + Retry-After 120 -> rate_limited, retryAfterSec>=120', async () => {
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.route('/rl', (_q, res) => { res.statusCode = 429; res.setHeader('retry-after', '120'); res.end('slow'); });
  const { db, source, net } = mk('/rl');
  const r = await runJob({ db, source, net, now, config });
  assert.equal(r.outcome, 'rate_limited');
  assert.ok((r.retryAfterSec ?? 0) >= 120);
  assert.ok(srv.requestCount('/rl') > 1, 'retried');
});

test('F5, host_rate: consecutive jobs to same host are >=5s apart', async () => {
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  const { db, source, net, clock } = mk('/h1');
  const times: number[] = [];
  const body = jsonLdPage([{ uid: 'a', name: 'フェス' }]);
  for (const p of ['/h1', '/h2']) srv.route(p, (_q, res) => { times.push(clock.now()); res.statusCode = 200; res.end(body); });
  await runJob({ db, source, net, now, config });
  const second = { ...source, url: `${srv.base}/h2` };
  await runJob({ db, source: second, net, now, config });
  assert.equal(times.length, 2);
  assert.ok(times[1]! - times[0]! >= 5000, `gap ${times[1]! - times[0]!}ms`);
});

test('login/captcha page -> login_or_captcha', async () => {
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.text('/cap', '<form><input type="password"></form>');
  const { db, source, net } = mk('/cap');
  const r = await runJob({ db, source, net, now, config });
  assert.equal(r.outcome, 'login_or_captcha');
});
