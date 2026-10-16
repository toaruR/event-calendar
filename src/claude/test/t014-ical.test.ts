import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractIcal } from '../src/extract/ical.ts';

const now = Date.parse('2026-11-01T00:00:00Z');
const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${body}END:VCALENDAR\r\n`;

test('§10-T21 daily forever -> 90 items + horizon warning', () => {
  const r = extractIcal(readFileSync(new URL('./fixtures/daily-forever.ics', import.meta.url), 'utf8'), { now });
  assert.equal(r.error, undefined);
  assert.equal(r.items.length, 90);
  assert.ok(r.warnings.filter((w) => w.includes('recurrence_horizon')).length >= 1);
  assert.equal(r.items[0]!.start, '2026-11-01T10:00:00Z');
  assert.equal(new Set(r.items.map((i) => i.source_uid)).size, 90);
});

test('STATUS:CANCELLED -> cancelled item', () => {
  const r = extractIcal(wrap('BEGIN:VEVENT\r\nUID:c1\r\nDTSTART:20261110T100000Z\r\nSUMMARY:Gone\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n'), { now });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.status, 'cancelled');
});

test('two plain VEVENTs map fields', () => {
  const r = extractIcal(wrap(
    'BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261103T100000Z\r\nDTEND:20261103T120000Z\r\nSUMMARY:世田谷夏祭り\r\nLOCATION:世田谷公園\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:b\r\nDTSTART;VALUE=DATE:20261105\r\nSUMMARY:B\r\nEND:VEVENT\r\n'), { now });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0]!.title, '世田谷夏祭り');
  assert.equal(r.items[0]!.start, '2026-11-03T10:00:00Z');
  assert.equal(r.items[0]!.end, '2026-11-03T12:00:00Z');
  assert.equal(r.items[0]!.venue, '世田谷公園');
  assert.equal(r.items[1]!.start, '2026-11-05');
  assert.equal(r.warnings.length, 0);
});

test('invalid ICS -> error, no throw', () => {
  for (const bad of ['not an ics', 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n', '']) {
    const r = extractIcal(bad, { now });
    assert.equal(r.items.length, 0);
    assert.notEqual(r.error, undefined);
  }
});
