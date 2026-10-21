import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker } from '../src/jobs/worker.ts';
import { FakeClock } from '../src/clock.ts';
import { defaultConfig } from '../src/config.ts';
import { enqueue } from '../src/jobs/queue.ts';
import type { RunJobResult } from '../src/pipeline/run-job.ts';
import { count, jsonLdPage, setupDb, staticFetch } from './helpers/run-helpers.ts';

const config = defaultConfig();
const T0 = Date.parse('2026-10-01T00:00:00Z');
const page = jsonLdPage([{ uid: 'a', name: '世田谷A' }, { uid: 'b', name: '世田谷B' }, { uid: 'c', name: '世田谷C' }]);
const okResult = (): RunJobResult => ({ run_id: 'r', outcome: 'ok', items_found: 0, items_upserted: 0 });
const never = (): Promise<RunJobResult> => new Promise(() => {});
const jobStatus = (db: ReturnType<typeof setupDb>['db']): string[] =>
  (db.prepare('SELECT status FROM job ORDER BY id').all() as { status: string }[]).map((r) => r.status);

test('§10-T11 (F10): crash while leased -> restart after +601s reruns job, no duplicate events', async () => {
  // baseline: crash-free run
  const base = setupDb();
  const bc = new FakeClock(T0);
  const bw = startWorker({ db: base.db, clock: bc, autoRun: false, fetchText: staticFetch(page), rand: () => 0.5 });
  await bw.tick(); await bw.idle(); bw.stop();
  const expected = count(base.db, 'event');
  assert.equal(expected, 3);

  const { db } = setupDb();
  const clock = new FakeClock(T0);
  const w1 = startWorker({ db, clock, autoRun: false, runJobFn: never, rand: () => 0.5 });
  await w1.tick();
  assert.equal(w1.runningCount(), 1);
  assert.deepEqual(jobStatus(db), ['leased']);
  w1.stop(); // process "dies"; DB survives
  clock.advance(601_000);
  const w2 = startWorker({ db, clock, autoRun: false, fetchText: staticFetch(page), rand: () => 0.5 });
  await w2.tick(); await w2.idle();
  assert.deepEqual(jobStatus(db), ['ok']);
  assert.equal(count(db, 'event'), expected);
  w2.stop();
});

test('global_concurrency: at most 4 concurrent runJob for 10 due sources', async () => {
  const { db } = setupDb(Array.from({ length: 10 }, (_, i) => ({ id: `s${i + 1}` })));
  const clock = new FakeClock(T0);
  let cur = 0, max = 0, done = 0;
  const w = startWorker({
    db, clock, autoRun: false, rand: () => 0.5,
    runJobFn: async () => {
      cur++; max = Math.max(max, cur);
      await new Promise((r) => setImmediate(r));
      cur--; done++;
      return okResult();
    },
  });
  await w.tick(); await w.idle();
  assert.equal(done, 10);
  assert.ok(max <= 4 && max >= 2, `max=${max}`);
  assert.deepEqual([...new Set(jobStatus(db))], ['ok']);
  w.stop();
});

test('job_timeout: runJob stuck >120s -> job failed', async () => {
  const { db } = setupDb();
  const clock = new FakeClock(T0);
  const w = startWorker({ db, clock, autoRun: false, runJobFn: never, rand: () => 0.5 });
  await w.tick();
  assert.deepEqual(jobStatus(db), ['leased']);
  clock.advance(config.job_timeout * 1000 + 1000);
  await w.idle();
  assert.deepEqual(jobStatus(db), ['failed']);
  w.stop();
});

test('stop(): no new leaseNext afterwards', async () => {
  const { db } = setupDb(Array.from({ length: 10 }, (_, i) => ({ id: `s${i + 1}` })));
  const clock = new FakeClock(T0);
  const w = startWorker({ db, clock, autoRun: false, rand: () => 0.5, runJobFn: async () => { await new Promise((r) => setImmediate(r)); return okResult(); } });
  await w.tick();
  assert.equal(w.runningCount(), 4);
  w.stop();
  await w.idle();
  const st = jobStatus(db);
  assert.equal(st.filter((s) => s === 'ok').length, 4);
  assert.equal(st.filter((s) => s === 'queued').length, 6);
  enqueue(db, 's1', clock);
  await w.tick();
  assert.equal(w.runningCount(), 0);
  assert.equal(jobStatus(db).filter((s) => s === 'queued').length, 7); // 6 + the newly enqueued one, none leased
});
