import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { foldLine, unfold } from '../src/ics/fold.ts';
import { eventToVevent } from '../src/ics/generate.ts';
import type { IcsEvent } from '../src/ics/generate.ts';

const base = (o: Partial<IcsEvent> = {}): IcsEvent => ({
  id: 'ev1', title: 'T', start_utc: '2026-11-03T10:00:00.000Z', end_utc: null, all_day: false,
  start_local_date: '2026-11-03', tz: 'Asia/Tokyo', venue_name: null, address: null,
  description: null, url: null, status: 'confirmed', seq: 0, ...o,
});
const opts = { dtstamp: '2026-10-01T00:00:00.000Z' };
const oct = (s: string): number => Buffer.byteLength(s, 'utf8');

test('fold: あ×30 SUMMARY folds to 74 + 25 octets and unfolds', () => {
  const line = 'SUMMARY:' + 'あ'.repeat(30);
  const f = foldLine(line).split('\r\n');
  assert.equal(f.length, 2);
  assert.equal(oct(f[0]!), 74);
  assert.equal(f[1], ' ' + 'あ'.repeat(8));
  assert.equal(oct(f[1]!), 25);
  assert.equal(unfold(f.join('\r\n')), line);
  assert.equal(oct(unfold(f.join('\r\n'))), 98);
});

test('fold: all lines <= 75 octets, no U+FFFD, mixed widths incl. emoji', () => {
  const line = 'DESCRIPTION:' + 'aあ😀b'.repeat(80);
  const folded = foldLine(line);
  for (const l of folded.split('\r\n')) {
    assert.ok(oct(l) <= 75);
    assert.ok(!l.includes('\uFFFD'));
  }
  assert.equal(unfold(folded), line);
  assert.equal(foldLine('short'), 'short');
});

test('§10-T14: injection of CR/LF yields no fake property line', () => {
  const v = eventToVevent(base({ title: '<script>alert(1)</script>\r\nSUMMARY:evil' }), opts);
  const lines = v.split('\r\n');
  assert.equal(lines.filter((l) => l.startsWith('SUMMARY:')).length, 1);
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1);
  assert.ok(!/[\r\n]/.test(unfold(v).replace(/\r\n/g, '')));
});

test('all-day, UTC, SEQUENCE, UID', () => {
  const a = eventToVevent(base({ all_day: true, start_local_date: '2026-11-03', seq: 4 }), opts);
  assert.ok(a.includes('DTSTART;VALUE=DATE:20261103'));
  assert.ok(a.includes('SEQUENCE:4'));
  assert.ok(a.includes('UID:ev1@ec.local'));
  const b = eventToVevent(base({ end_utc: '2026-11-03T12:30:00.000Z' }), opts);
  assert.ok(b.includes('DTSTART:20261103T100000Z'));
  assert.ok(b.includes('DTEND:20261103T123000Z'));
});

test('escaping and minimal mode', () => {
  const BS = String.fromCharCode(92);
  const e = base({ title: 'a,b;c' + BS + 'd', description: 'desc', venue_name: 'V', url: 'http://x/y' });
  const v = eventToVevent(e, opts);
  assert.ok(v.includes('SUMMARY:a' + BS + ',b' + BS + ';c' + BS + BS + 'd'));
  assert.ok(v.includes('DESCRIPTION:desc'));
  const m = eventToVevent(e, { ...opts, minimal: true });
  assert.ok(!m.includes('DESCRIPTION') && !m.includes('LOCATION'));
  assert.ok(m.includes('URL:http://x/y'));
});

test('ical.js round-trip', () => {
  const body = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n' + eventToVevent(base({ title: 'あ'.repeat(30) }), opts) + '\r\nEND:VCALENDAR\r\n';
  const ev = new ICAL.Event(new ICAL.Component(ICAL.parse(body)).getFirstSubcomponent('vevent')!);
  assert.equal(ev.summary, 'あ'.repeat(30));
});
