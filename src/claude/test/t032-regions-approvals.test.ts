import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { FakeClock } from '../src/clock.ts';
import { upsertRegion } from '../src/service/regions.ts';
import { issueApproval, consumeApproval } from '../src/service/approvals.ts';

const body = (o: Record<string, unknown> = {}) => ({ name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷', '三軒茶屋'], ...o });
const code = (c: string) => (e: any) => e.code === c;

function setup() {
  const db = openDb(':memory:');
  upsertRegion(db, 'r1', body());
  db.prepare('INSERT INTO source(id,region_id,url,kind,terms_note,allow_redistribute) VALUES(?,?,?,?,?,?)')
    .run('s1', 'r1', 'http://s1.test/', 'ical', 'n', 1);
  return db;
}

test('upsert twice keeps 1 row and updates content', () => {
  const db = openDb(':memory:');
  upsertRegion(db, 'r1', body());
  const r = upsertRegion(db, 'r1', body({ name: '渋谷', keywords: ['渋谷'], center: { lat: 35.6, lon: 139.7 }, radius_km: 3 }));
  const n = db.prepare('SELECT COUNT(*) AS c FROM region').get() as { c: number };
  assert.equal(Number(n.c), 1);
  assert.equal(r.name, '渋谷');
  assert.deepEqual(JSON.parse(r.keywords_json), ['渋谷']);
  assert.equal(r.radius_km, 3);
});

test('invalid tz -> INVALID_ARGUMENT; unknown source -> NOT_FOUND', () => {
  const db = setup();
  assert.throws(() => upsertRegion(db, 'r2', body({ tz: 'Mars/Base' })), code('INVALID_ARGUMENT'));
  assert.throws(() => issueApproval(db, { action: 'source_remove', source_id: 'nope' }), code('NOT_FOUND'));
});

test('single use and TTL 600s boundary', () => {
  const db = setup();
  const clock = new FakeClock(1_000_000);
  const { approval_token: t } = issueApproval(db, { action: 'source_remove', source_id: 's1' }, { clock });
  assert.equal(consumeApproval(db, t, { clock }), true);
  assert.equal(consumeApproval(db, t, { clock }), false);

  const c2 = new FakeClock(0);
  const t2 = issueApproval(db, { action: 'source_remove', source_id: 's1' }, { clock: c2 }).approval_token;
  c2.advance(601_000);
  assert.equal(consumeApproval(db, t2, { clock: c2 }), false);

  const c3 = new FakeClock(0);
  const t3 = issueApproval(db, { action: 'enable_browser', source_id: 's1' }, { clock: c3 }).approval_token;
  c3.advance(599_000);
  assert.equal(consumeApproval(db, t3, { clock: c3 }), true);
});

test('require_approval: only source_remove / enable_browser', () => {
  const db = setup();
  assert.ok(issueApproval(db, { action: 'source_remove', source_id: 's1' }).approval_token);
  assert.ok(issueApproval(db, { action: 'enable_browser', source_id: 's1' }).approval_token);
  assert.throws(() => issueApproval(db, { action: 'source_update', source_id: 's1' }), code('INVALID_ARGUMENT'));
});

test('token bound to action/source and unknown token rejected', () => {
  const db = setup();
  const t = issueApproval(db, { action: 'source_remove', source_id: 's1' }).approval_token;
  assert.equal(consumeApproval(db, t, { action: 'enable_browser' }), false);
  assert.equal(consumeApproval(db, 'bogus'), false);
  assert.equal(consumeApproval(db, t, { action: 'source_remove', source_id: 's1' }), true);
});
