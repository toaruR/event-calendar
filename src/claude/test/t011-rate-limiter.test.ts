import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';

const rate = { requests: 1, per_sec: 5 };

test('§10-T26 host_rate 1req/5s sequence', () => {
  const c = new FakeClock(0);
  const rl = new RateLimiter(rate, c);
  const at = (sec: number) => { c.set(sec * 1000); return rl.acquire('a.example'); };
  assert.equal(at(0), 0);
  assert.equal(at(3), 2);
  assert.ok(at(4.999) > 0);
  assert.equal(at(5), 0);
  assert.equal(at(10), 0);
  assert.equal(at(12), 3);
  assert.equal(at(15), 0);
});

test('hosts are independent', () => {
  const c = new FakeClock(0);
  const rl = new RateLimiter(rate, c);
  assert.equal(rl.acquire('a.example'), 0);
  assert.equal(rl.acquire('b.example'), 0);
});

test('Crawl-delay=10 overrides', () => {
  const c = new FakeClock(0);
  const rl = new RateLimiter(rate, c);
  const o = { crawlDelay: 10 };
  assert.equal(rl.acquire('a.example', o), 0);
  c.set(5000);
  assert.equal(rl.acquire('a.example', o), 5);
  c.set(10000);
  assert.equal(rl.acquire('a.example', o), 0);
});

test('wait() resolves via fake clock', async () => {
  const c = new FakeClock(0);
  const rl = new RateLimiter(rate, c);
  rl.acquire('a.example');
  let done = false;
  const p = rl.wait('a.example').then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  c.advance(5000);
  await p;
  assert.equal(done, true);
});
