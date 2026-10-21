import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from '../src/config.ts';
import { evaluateDrift } from '../src/pipeline/drift.ts';
import { runJob } from '../src/pipeline/run-job.ts';
import type { SourceRow } from '../src/pipeline/run-job.ts';
import { count, jsonLdPage, setupDb, staticFetch } from './helpers/run-helpers.ts';

const config = defaultConfig();
const day = (n: number): Date => new Date(Date.UTC(2026, 9, 16 + n));
const evs = (n: number) => Array.from({ length: n }, (_, i) => ({ uid: `u${i}`, name: `世田谷祭り${String.fromCharCode(0x3042 + i)}`, venue: `会場${i}` }));
const go = (db: DatabaseSync, source: SourceRow, n: number, k: number) =>
  runJob({ db, source, fetchText: staticFetch(jsonLdPage(evs(k))), now: day(n), config });
const src = (db: DatabaseSync) => db.prepare('SELECT zero_item_streak AS z, last_item_count AS l FROM source').get() as { z: number; l: number };

test('evaluateDrift boundaries', () => {
  assert.equal(evaluateDrift(50, 10, config).drift, true);
  assert.equal(evaluateDrift(50, 11, config).drift, false);
  assert.equal(evaluateDrift(4, 0, config).drift, false);
  assert.equal(evaluateDrift(null, 0, config).drift, false);
});

test('§10-T7: 50 -> 10 is schema_drift with DB unchanged; 11 is ok', async () => {
  const { db, sources } = setupDb(); const s = sources[0]!;
  assert.equal((await go(db, s, 0, 50)).outcome, 'ok');
  assert.equal(count(db, 'event'), 50);
  const r = await go(db, s, 1, 10);
  assert.equal(r.outcome, 'schema_drift');
  assert.equal(count(db, 'event'), 50);
  assert.equal(src(db).l, 50);
  const miss = db.prepare('SELECT MAX(miss_count) AS m FROM event_source_ref').get() as { m: number };
  assert.equal(miss.m, 0);
  assert.equal((db.prepare("SELECT outcome FROM run ORDER BY started_at DESC LIMIT 1").get() as { outcome: string }).outcome, 'schema_drift');
  const { db: db2, sources: s2 } = setupDb();
  await go(db2, s2[0]!, 0, 50);
  assert.equal((await go(db2, s2[0]!, 1, 11)).outcome, 'ok');
});

test('N=4, M=0 is not drift; zero_item_streak increments, then resets', async () => {
  const { db, sources } = setupDb(); const s = sources[0]!;
  await go(db, s, 0, 4);
  const r = await go(db, s, 1, 0);
  assert.equal(r.outcome, 'ok');
  assert.equal(src(db).z, 1);
  await go(db, s, 2, 0);
  assert.equal(src(db).z, 2);
  await go(db, s, 3, 4);
  assert.equal(src(db).z, 0);
  assert.equal(src(db).l, 4);
});

test('schema_drift run does not bump miss_count', async () => {
  const { db, sources } = setupDb(); const s = sources[0]!;
  await go(db, s, 0, 10);
  for (const n of [1, 2, 3]) assert.equal((await go(db, s, n, 1)).outcome, 'schema_drift');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM event WHERE status='cancelled'").get()!['c'], 0);
  assert.equal((db.prepare('SELECT MAX(miss_count) AS m FROM event_source_ref').get() as { m: number }).m, 0);
});
