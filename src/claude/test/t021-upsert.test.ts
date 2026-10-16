import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.ts';
import { runJob } from '../src/pipeline/run-job.ts';
import { count, jsonLdPage, setupDb, staticFetch } from './helpers/run-helpers.ts';

const config = defaultConfig();
const now = new Date('2026-10-16T00:00:00Z');
const run = (db: never, source: never, evs: Parameters<typeof jsonLdPage>[0], at = now) =>
  runJob({ db, source, fetchText: staticFetch(jsonLdPage(evs)), now: at, config });

test('§10-T5: two sources, same event -> 1 event, 2 refs', async () => {
  const { db, sources } = setupDb([{ id: 's1' }, { id: 's2' }]);
  await run(db as never, sources[0] as never, [{ uid: 'a1', name: '世田谷夏祭り' }]);
  await run(db as never, sources[1] as never, [{ uid: 'b9', name: '世田谷夏祭り' }]);
  assert.equal(count(db, 'event'), 1);
  assert.equal(count(db, 'event_source_ref'), 2);
  await run(db as never, sources[1] as never, [{ uid: 'b9', name: '世田谷夏祭り' }]);
  assert.equal(count(db, 'event'), 1);
  assert.equal(count(db, 'event_source_ref'), 2);
  assert.equal((db.prepare('SELECT seq FROM event').get() as { seq: number }).seq, 0);
});

test('rerun same UID is idempotent; seq+1 only on title change', async () => {
  const { db, sources } = setupDb();
  const s = sources[0] as never;
  await run(db as never, s, [{ uid: 'a1', name: '世田谷夏祭り' }]);
  const seq = () => (db.prepare('SELECT seq FROM event').get() as { seq: number }).seq;
  assert.equal(seq(), 0);
  await run(db as never, s, [{ uid: 'a1', name: '世田谷夏祭り' }], new Date('2026-10-17T00:00:00Z'));
  assert.equal(count(db, 'event'), 1);
  assert.equal(count(db, 'event_source_ref'), 1);
  assert.equal(seq(), 0);
  await run(db as never, s, [{ uid: 'a1', name: '世田谷夏祭り2026' }], new Date('2026-10-18T00:00:00Z'));
  assert.equal(count(db, 'event'), 1);
  assert.equal(seq(), 1);
  assert.equal((db.prepare('SELECT title FROM event').get() as { title: string }).title, '世田谷夏祭り2026');
});

test('source-side cancelled sets status and cancelled_at', async () => {
  const { db, sources } = setupDb();
  const s = sources[0] as never;
  await run(db as never, s, [{ uid: 'a1', name: '世田谷夏祭り' }]);
  await run(db as never, s, [{ uid: 'a1', name: '世田谷夏祭り', status: 'https://schema.org/EventCancelled' }]);
  const e = db.prepare('SELECT status, cancelled_at, seq FROM event').get() as { status: string; cancelled_at: string | null; seq: number };
  assert.equal(e.status, 'cancelled');
  assert.ok(e.cancelled_at);
  assert.equal(e.seq, 1);
});
