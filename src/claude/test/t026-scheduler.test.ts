import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.ts';
import { scheduleTick, setNextRun } from '../src/jobs/scheduler.ts';
import { applyRunOutcome, disableSource } from '../src/jobs/source-state.ts';
import { count, setupDb } from './helpers/run-helpers.ts';

const T0 = Date.UTC(2026, 9, 16);
const nextRun = (db: ReturnType<typeof setupDb>['db'], id = 's1'): number =>
  Date.parse((db.prepare('SELECT next_run_at AS n FROM source WHERE id = ?').get(id) as { n: string }).n);

test('§10-T23: jitter stays within +/-10% over 1000 draws', () => {
  const { db } = setupDb(); const clock = new FakeClock(T0);
  db.prepare('UPDATE source SET interval_sec = 21600').run();
  let bad = 0;
  for (let i = 0; i < 1000; i++) {
    const r = i === 0 ? 0 : i === 1 ? 1 : Math.random();
    setNextRun(db, 's1', clock, () => r, 0);
    const d = (nextRun(db) - T0) / 1000;
    if (d < 19440 - 1e-6 || d > 23760 + 1e-6) bad++;
  }
  assert.equal(bad, 0);
});

test('§10-T22: failure_stretch 43200 / 86400 / 86400', () => {
  const { db } = setupDb(); const clock = new FakeClock(T0);
  db.prepare('UPDATE source SET interval_sec = 21600').run();
  for (const [f, want] of [[1, 43200], [2, 86400], [3, 86400]] as const) {
    setNextRun(db, 's1', clock, () => 0.5, f);
    assert.equal((nextRun(db) - T0) / 1000, want);
  }
});

test('catch-up after 3 missed periods enqueues once', () => {
  const { db } = setupDb(); const clock = new FakeClock(T0);
  db.prepare('UPDATE source SET interval_sec = 21600, next_run_at = ?').run(new Date(T0).toISOString());
  clock.advance(3 * 21600 * 1000 + 1000);
  const ids = scheduleTick(db, clock, () => 0.5);
  assert.equal(ids.length, 1);
  assert.equal(scheduleTick(db, clock, () => 0.5).length, 0);
  assert.equal(count(db, 'job'), 1);
  assert.ok(nextRun(db) > clock.now());
});

test('disabled/quarantined sources are not enqueued', () => {
  const { db } = setupDb([{ id: 's1' }, { id: 's2' }, { id: 's3' }]); const clock = new FakeClock(T0);
  disableSource(db, 's1');
  applyRunOutcome(db, 's2', 'blocked_robots');
  const ids = scheduleTick(db, clock, () => 0.5);
  assert.equal(ids.length, 1);
  assert.equal(count(db, 'job'), 1);
  assert.equal((db.prepare('SELECT source_id AS s FROM job').get() as { s: string }).s, 's3');
});
