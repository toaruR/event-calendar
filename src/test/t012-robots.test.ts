import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { makeFetchText } from '../src/net/fetcher.ts';
import { checkRobots, RobotsCache, parseRobots, isPathAllowed } from '../src/net/robots.ts';
import { startMockServer } from './helpers/mock-server.ts';

const fetch = makeFetchText({ config: { ssrf_allowlist: ['127.0.0.1'] } });
const txt = (s: Awaited<ReturnType<typeof startMockServer>>, body: string, status = 200) =>
  s.route('/robots.txt', (_q, res) => { res.statusCode = status; res.end(body); });

test('§10-T27 robots 503 -> deferred, no body GET; other host Crawl-delay=10 with host_rate', async () => {
  const a = await startMockServer();
  const b = await startMockServer();
  try {
    txt(a, 'oops', 503);
    a.text('/events', 'body');
    const clock = new FakeClock(0);
    const cache = new RobotsCache();
    const v = await checkRobots(`${a.base}/events`, { fetch, clock, cache });
    assert.equal(v.decision, 'deferred');
    assert.equal(a.requestCount('/events'), 0);
    // not cached: next time retried
    await checkRobots(`${a.base}/events`, { fetch, clock, cache });
    assert.equal(a.requestCount('/robots.txt'), 2);

    txt(b, 'User-agent: *\nCrawl-delay: 10\n');
    const vb = await checkRobots(`${b.base}/events`, { fetch, clock, cache });
    assert.equal(vb.decision, 'allowed');
    assert.equal(vb.crawlDelay, 10);
    const rl = new RateLimiter({ requests: 1, per_sec: 5 }, clock);
    const o = { crawlDelay: vb.crawlDelay };
    assert.equal(rl.acquire('b', o), 0);
    clock.set(5000);
    assert.equal(rl.acquire('b', o), 5);
    clock.set(10000);
    assert.equal(rl.acquire('b', o), 0);
  } finally { await a.close(); await b.close(); }
});

test('Disallow: / blocked, 404 allowed', async () => {
  const a = await startMockServer();
  const b = await startMockServer();
  try {
    txt(a, 'User-agent: *\nDisallow: /\n');
    a.text('/events', 'body');
    const v = await checkRobots(`${a.base}/events`, { fetch });
    assert.equal(v.decision, 'blocked');
    assert.equal(a.requestCount('/events'), 0);
    const w = await checkRobots(`${b.base}/events`, { fetch }); // 404 robots
    assert.equal(w.decision, 'allowed');
  } finally { await a.close(); await b.close(); }
});

test('robots_cache 24h', async () => {
  const a = await startMockServer();
  try {
    txt(a, 'User-agent: *\nDisallow: /private\n');
    const clock = new FakeClock(0);
    const cache = new RobotsCache();
    const deps = { fetch, clock, cache };
    await checkRobots(`${a.base}/x`, deps);
    clock.advance((23 * 3600 + 59 * 60) * 1000);
    await checkRobots(`${a.base}/x`, deps);
    assert.equal(a.requestCount('/robots.txt'), 1);
    clock.advance(61 * 1000); // total 24h + 0m 1s... = 24h00m00s
    clock.advance(1000);      // 24h00m01s
    const v = await checkRobots(`${a.base}/private/y`, deps);
    assert.equal(a.requestCount('/robots.txt'), 2);
    assert.equal(v.decision, 'blocked');
  } finally { await a.close(); }
});

test('parse: specific agent group, Allow longest match, wildcard', () => {
  const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: event-calendar-bot\nDisallow: /a\nAllow: /a/ok\nCrawl-delay: 3\n');
  assert.equal(r.crawlDelay, 3);
  assert.equal(isPathAllowed(r, '/b'), true);
  assert.equal(isPathAllowed(r, '/a/x'), false);
  assert.equal(isPathAllowed(r, '/a/ok'), true);
  assert.equal(isPathAllowed(parseRobots('User-agent: *\nDisallow: /*.pdf$'), '/f.pdf'), false);
});
