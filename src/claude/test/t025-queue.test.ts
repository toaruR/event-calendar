import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.ts';
import { complete, enqueue, getJob, leaseNext, reapExpired, requeueWithBackoff } from '../src/jobs/queue.ts';
import { count, setupDb } from './helpers/run-helpers.ts';

const T0 = Date.UTC(2026, 9, 16);

test('enqueue -> leaseNext leases for 600s', () => {
  const { db } = setupDb(); const clock = new FakeClock(T0);
  const id = enqueue(db, 's1', clock);
  const j = leaseNext(db, clock)!;
  assert.equal(j.id, id);
  assert.equal(j.status, 'leased');
  assert.equal(j.lease_until, new Date(T0 + 600_000).toISOString());
  assert.equal(leaseNext(db, clock), undefined);
});

test('expired lease is reaped and re-leased; ok job stays ok', () => {
  const { db } = setupDb(); const clock = new FakeClock(T0);
  const id = enqueue(db, 's1', clock);
  leaseNext(db, clock);
  clock.advance(601_000);
  assert.equal(reapExpired(db, clock), 1);
  assert.equal(getJob(db, id)!.status, 'queued');
  assert.equal(leaseNext(db, clock)!.id, id);
  complete(db, id, 'ok');
  clock.advance(1_000_000);
  reapExpired(db, clock);
  assert.equal(getJob(db, id)!.status, 'ok');
});

test('retry_backoff: 5 requeues then failed; enqueue is idempotent', () => {
  const { db } = setupDb(); const clock = new FakeClock(T0);
  const id = enqueue(db, 's1', clock);
  assert.equal(enqueue(db, 's1', clock), id);
  assert.equal(count(db, 'job'), 1);
  for (let i = 1; i <= 5; i++) {
    const j = requeueWithBackoff(db, id, clock, () => 0.5);
    assert.equal(j.status, 'queued'); assert.equal(j.attempt, i);
  }
  const last = requeueWithBackoff(db, id, clock, () => 0.5);
  assert.equal(last.status, 'failed');
});

test('backoff requeue is not leasable until wait elapses', () => {
  const { db } = setupDb(); const clock = new FakeClock(T0);
  const id = enqueue(db, 's1', clock);
  leaseNext(db, clock);
  requeueWithBackoff(db, id, clock, () => 0.5);
  assert.equal(leaseNext(db, clock), undefined);
  clock.advance(60_000);
  assert.equal(leaseNext(db, clock)!.id, id);
});
