import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { buildCalendar } from '../src/ics/calendar.ts';
import { unfold } from '../src/ics/fold.ts';

const NOW = Date.parse('2026-10-16T00:00:00Z');
const day = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();
const range = { from: '2026-01-01T00:00:00.000Z', to: '2027-12-31T00:00:00.000Z', now: NOW };

function setup(allow = 1): DatabaseSync {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO region(id,name,tz,keywords_json) VALUES(?,?,?,?)').run('r1', '世田谷', 'Asia/Tokyo', '[]');
  db.prepare('INSERT INTO source(id,region_id,url,kind,terms_note,allow_redistribute) VALUES(?,?,?,?,?,?)')
    .run('s1', 'r1', 'http://s1.test/', 'ical', 'n', allow);
  return db;
}
function addEvent(db: DatabaseSync, id: string, o: Record<string, unknown> = {}): void {
  const e = { title: 'T', start_utc: '2026-11-03T10:00:00.000Z', all_day: 0, start_local_date: '2026-11-03', status: 'confirmed',
    description: null, url: null, cancelled_at: null, seq: 0, ...o };
  db.prepare(`INSERT INTO event(id,region_id,title,start_utc,all_day,start_local_date,tz,description,url,status,first_seen_at,last_seen_at,cancelled_at,seq)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'r1', e.title as string, e.start_utc as string, e.all_day as number,
    e.start_local_date as string, 'Asia/Tokyo', e.description as string | null, e.url as string | null, e.status as string,
    '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', e.cancelled_at as string | null, e.seq as number);
  db.prepare('INSERT INTO event_source_ref(event_id,source_id,source_uid) VALUES(?,?,?)').run(id, 's1', 'u-' + id);
}

test('§10-T13: parse with ical.js, values match, CANCELLED, 75 octets', () => {
  const db = setup();
  const title = 'あ'.repeat(30);
  addEvent(db, 'e1', { title });
  addEvent(db, 'e2', { title: '終日', all_day: 1, start_local_date: '2026-11-05', start_utc: '2026-11-04T15:00:00.000Z' });
  addEvent(db, 'e3', { title: '取消', status: 'cancelled', cancelled_at: day(1), start_utc: '2026-11-06T10:00:00.000Z' });
  const { body } = buildCalendar(db, 'r1', range);
  for (const l of body.split('\r\n')) assert.ok(Buffer.byteLength(l, 'utf8') <= 75);
  const comp = new ICAL.Component(ICAL.parse(body));
  const evs = comp.getAllSubcomponents('vevent').map((c) => new ICAL.Event(c));
  assert.equal(evs.length, 3);
  assert.equal(evs[0]!.summary, title);
  assert.equal(evs[0]!.startDate.toJSDate().toISOString(), '2026-11-03T10:00:00.000Z');
  assert.equal(evs[1]!.summary, '終日');
  assert.equal(evs[1]!.startDate.isDate, true);
  assert.equal(evs[1]!.startDate.toString(), '2026-11-05');
  assert.equal(evs[2]!.summary, '取消');
  assert.ok(unfold(body).includes('STATUS:CANCELLED'));
});

test('cancelled retention: 31 days dropped, 29 days kept', () => {
  const db = setup();
  addEvent(db, 'old', { status: 'cancelled', cancelled_at: day(31) });
  addEvent(db, 'new', { status: 'cancelled', cancelled_at: day(29), start_utc: '2026-11-04T10:00:00.000Z' });
  const { body } = buildCalendar(db, 'r1', range);
  assert.ok(!body.includes('UID:old@ec.local'));
  assert.ok(body.includes('UID:new@ec.local'));
});

test('§10-T17: allow_redistribute=0 -> title+URL only; normal source redacts phone', () => {
  const desc = '問い合わせ 03-1234-5678 まで';
  const db = setup(0);
  addEvent(db, 'e1', { description: desc, url: 'http://x.test/e1' });
  const { body } = buildCalendar(db, 'r1', range);
  assert.ok(!body.includes('DESCRIPTION'));
  assert.ok(body.includes('SUMMARY:T') && body.includes('URL:http://x.test/e1'));
  assert.ok(!body.includes('1234'));
  const db2 = setup(1);
  addEvent(db2, 'e1', { description: desc });
  const b2 = unfold(buildCalendar(db2, 'r1', range).body);
  assert.ok(!b2.includes('1234-5678'));
  assert.ok(b2.includes('DESCRIPTION'));
});

test('ETag stable for same content, changes on seq+1', () => {
  const db = setup();
  addEvent(db, 'e1');
  const a = buildCalendar(db, 'r1', range);
  assert.equal(buildCalendar(db, 'r1', range).etag, a.etag);
  db.prepare('UPDATE event SET seq = seq + 1 WHERE id = ?').run('e1');
  assert.notEqual(buildCalendar(db, 'r1', range).etag, a.etag);
});

test('unknown region -> NOT_FOUND', () => {
  const db = setup();
  assert.throws(() => buildCalendar(db, 'zz', range), (e: any) => e.code === 'NOT_FOUND');
});
