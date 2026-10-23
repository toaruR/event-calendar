import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icsUrl, icsFileName } from '../gui/app.js';
import { eventIcsUrl, renderEventList, renderMonth } from '../gui/render.js';

test('eventIcsUrl pins one event; list and month render ICS links', () => {
  const e = { id: 'e 1', region_id: 'r1', title: 't', start_utc: '2026-11-03T10:00:00Z', start_local_date: '2026-11-03' };
  const u = new URL(eventIcsUrl(e), 'http://x');
  assert.equal(u.pathname, '/calendar/r1.ics');
  assert.equal(u.searchParams.get('event_id'), 'e 1');
  assert.equal(u.searchParams.get('from'), e.start_utc);
  assert.equal(u.searchParams.get('to'), e.start_utc);
  assert.equal(eventIcsUrl({ title: 'x' }), '');
  assert.match(renderEventList([e]), /class="ics"/);
  assert.match(renderMonth(2026, 11, [e]), /class="ics"/);
});

test('icsUrl covers exactly the local month with inclusive end', () => {
  const u = new URL(icsUrl('r1', 2026, 11), 'http://x');
  assert.equal(u.pathname, '/calendar/r1.ics');
  assert.equal(u.searchParams.get('from'), new Date(2026, 10, 1).toISOString());
  assert.equal(Date.parse(u.searchParams.get('to') ?? ''), new Date(2026, 11, 1).getTime() - 1);
});

test('icsUrl escapes region; icsFileName pads month', () => {
  assert.ok(icsUrl('a b', 2026, 1).startsWith('/calendar/a%20b.ics?'));
  assert.equal(icsFileName('r1', 2026, 3), 'r1-2026-03.ics');
});
