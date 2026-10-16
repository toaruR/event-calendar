import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { renderMonth, renderEventList, eventDate, eventTime } from '../gui/render.js';
import { monthRange, regionsOf } from '../gui/app.js';

const ev = {
  title: '名画鑑賞会', start_utc: '2026-11-13T15:00:00Z', start_local_date: '2026-11-14', all_day: true,
  tz: 'Asia/Tokyo', venue_name: 'プラザノース', url: 'https://example.test/e1', description: 'desc',
};

test('eventDate prefers start_local_date over UTC prefix', () => {
  assert.equal(eventDate(ev), '2026-11-14');
  assert.equal(eventDate({ start: '2026-11-05T10:00:00Z' }), '2026-11-05');
});

test('eventTime: tz-local HH:MM, empty for all-day', () => {
  assert.equal(eventTime(ev), '');
  assert.equal(eventTime({ ...ev, all_day: false, start_utc: '2026-11-14T01:30:00Z' }), '10:30');
});

test('renderMonth places event on local date with link; leading pads are not .day', () => {
  const $ = cheerio.load(renderMonth(2026, 11, [ev]));
  assert.equal($('.day').length, 30);
  assert.equal($('.pad').length, 0); // 2026-11-01 is Sunday
  const cell = $('.day[data-date="2026-11-14"]');
  assert.equal(cell.find('.event a').text(), '名画鑑賞会');
  assert.equal(cell.find('.event a').attr('href'), 'https://example.test/e1');
  assert.equal(cheerio.load(renderMonth(2026, 10, [])).root().find('.pad').length, 4); // 2026-10-01 is Thursday
});

test('non-http urls are not linked', () => {
  const $ = cheerio.load(renderMonth(2026, 11, [{ ...ev, url: 'javascript:alert(1)' }]));
  assert.equal($('a').length, 0);
});

test('renderEventList shows date, title, venue; empty message', () => {
  const $ = cheerio.load(renderEventList([ev]));
  assert.ok($('td.when').text().includes('2026-11-14(土)'));
  assert.ok($('td.venue').text().includes('プラザノース'));
  assert.ok(renderEventList([]).includes('class="empty"'));
});

test('monthRange pads a day on each side; regionsOf dedups', () => {
  assert.deepEqual(monthRange(2026, 11), { from: '2026-10-31T00:00:00.000Z', to: '2026-12-02T00:00:00.000Z' });
  assert.deepEqual(regionsOf([{ region_id: 'b' }, { region_id: 'a' }, { region_id: 'b' }]), ['a', 'b']);
});
