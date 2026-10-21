import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.ts';
import { retryWaitSec, nextRunAfterFailure, jitteredNextRun, retryWithBackoff } from '../src/net/backoff.ts';
import type { AttemptResult } from '../src/net/backoff.ts';

const mid = () => 0.5;

test('(F5b) retry_backoff n=1..5 with zero jitter', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => retryWaitSec(n, null, mid)), [60, 120, 240, 480, 600]);
});

test('+/-20% bounds', () => {
  assert.equal(retryWaitSec(3, null, () => 0), 192);
  assert.equal(retryWaitSec(3, null, () => 1), 288);
  assert.equal(retryWaitSec(5, null, () => 0), 480);
  assert.equal(retryWaitSec(5, null, () => 1), 720);
});

test('Retry-After honoured up to 86400', () => {
  assert.equal(retryWaitSec(1, 43200, mid), 43200);
  assert.equal(retryWaitSec(1, 172800, mid), 86400);
});

test('(F5c) failure_stretch', () => {
  assert.deepEqual([1, 2, 3].map((f) => nextRunAfterFailure(f, 21600)), [43200, 86400, 86400]);
});

test('interval_jitter +/-10%', () => {
  assert.equal(jitteredNextRun(1000, mid), 1000);
  assert.ok(Math.abs(jitteredNextRun(1000, () => 0) - 900) < 1e-9);
  assert.ok(Math.abs(jitteredNextRun(1000, () => 1) - 1100) < 1e-9);
});

async function pump<T>(p: Promise<T>, clock: FakeClock): Promise<T> {
  let done = false;
  void p.finally(() => { done = true; }).catch(() => {});
  while (!done) {
    await new Promise((r) => setImmediate(r));
    clock.advance(10_000_000);
  }
  return p;
}

test('§10-T10 429 Retry-After:120 twice then 200', async () => {
  const clock = new FakeClock(0);
  const seq: AttemptResult[] = [
    { status: 429, retryAfterSec: 120 }, { status: 429, retryAfterSec: 120 }, { status: 200 },
  ];
  let i = 0;
  const r = await pump(retryWithBackoff(async () => seq[i++]!, clock, mid), clock);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.waits.length, 2);
  assert.ok(r.waits.every((w) => w >= 120));
  assert.ok(r.waits.reduce((a, b) => a + b, 0) >= 240);
});

test('always 429 stops after 5 retries (6 calls)', async () => {
  const clock = new FakeClock(0);
  let calls = 0;
  const r = await pump(retryWithBackoff(async () => { calls++; return { status: 429 }; }, clock, mid), clock);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.waits.length, 5);
  assert.equal(calls, 6);
});

test('non-retryable 404 fails immediately', async () => {
  const clock = new FakeClock(0);
  const r = await retryWithBackoff(async () => ({ status: 404 }), clock, mid);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.attempts, 1);
});
