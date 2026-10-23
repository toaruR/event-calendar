import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootHttp } from './helpers/http-helpers.ts';
import type { DatabaseSync } from 'node:sqlite';

function seed(db: DatabaseSync): void {
  db.prepare('INSERT INTO source(id,region_id,url,kind,terms_note,allow_redistribute) VALUES(?,?,?,?,?,?)').run('s1', 'r1', 'http://s1.test/', 'ical', 'n', 1);
  db.prepare('INSERT INTO source(id,region_id,url,kind,terms_note,allow_redistribute) VALUES(?,?,?,?,?,?)').run('s2', 'r1', 'http://s2.test/', 'ical', 'n', 1);
  const ins = (id: string, title: string, start: string, venue: string | null, src: string): void => {
    db.prepare(`INSERT INTO event(id,region_id,title,start_utc,all_day,tz,venue_name,status,first_seen_at,last_seen_at,seq)
      VALUES(?,?,?,?,0,'Asia/Tokyo',?,'confirmed','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',0)`).run(id, 'r1', title, start, venue);
    db.prepare('INSERT INTO event_source_ref(event_id,source_id,source_uid) VALUES(?,?,?)').run(id, src, 'u' + id);
  };
  ins('e1', '夏祭り', '2026-11-03T10:00:00Z', '公園', 's1');
  ins('e2', 'ヨガ教室', '2026-11-04T10:00:00Z', '体育館', 's1');
  ins('e3', '盆踊り', '2026-11-05T10:00:00Z', '公園', 's2');
}
const Q = 'region_id=r1&from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z';

test('GET /events: {events,count}, q/source filters, from>to 400', async () => {
  const s = await bootHttp();
  try {
    seed(s.db);
    const all = await s.call('GET', `/events?${Q}`);
    assert.equal(all.status, 200);
    assert.equal(all.body.events.length, 3);
    assert.equal(all.body.count, all.body.events.length);
    const q = await s.call('GET', `/events?${Q}&q=${encodeURIComponent('公園')}`);
    assert.equal(q.body.count, 2);
    assert.equal(q.body.events.length, 2);
    const src = await s.call('GET', `/events?${Q}&source=s2`);
    assert.equal(src.body.count, 1);
    const bad = await s.call('GET', '/events?region_id=r1&from=2026-12-01T00:00:00Z&to=2026-11-01T00:00:00Z');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_ARGUMENT');
    const missing = await s.call('GET', '/events?region_id=r1');
    assert.equal(missing.status, 400);
  } finally { await s.stop(); }
});

test('GET /calendar/{region}.ics: ETag, 304, change -> new ETag, 404, no token ok', async () => {
  const s = await bootHttp();
  try {
    seed(s.db);
    const base = `http://127.0.0.1:${(s.h.server.address() as { port: number }).port}`;
    const r1 = await fetch(`${base}/calendar/r1.ics`);
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('content-type') ?? '', /^text\/calendar/);
    const etag = r1.headers.get('etag');
    assert.ok(etag);
    assert.match(await r1.text(), /BEGIN:VCALENDAR/);
    const r2 = await fetch(`${base}/calendar/r1.ics`, { headers: { 'if-none-match': etag } });
    assert.equal(r2.status, 304);
    assert.equal(await r2.text(), '');
    s.db.prepare("UPDATE event SET title='変更後', seq=1 WHERE id='e1'").run();
    const r3 = await fetch(`${base}/calendar/r1.ics`, { headers: { 'if-none-match': etag } });
    assert.equal(r3.status, 200);
    assert.notEqual(r3.headers.get('etag'), etag);
    const one = await (await fetch(`${base}/calendar/r1.ics?event_id=e2&from=2026-11-04T10:00:00Z&to=2026-11-04T10:00:00Z`)).text();
    assert.equal(one.match(/BEGIN:VEVENT/g)?.length, 1);
    assert.match(one, /ヨガ教室/);
    const nf = await s.call('GET', '/calendar/zz.ics');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, 'NOT_FOUND');
  } finally { await s.stop(); }
});
