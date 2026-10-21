import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, utcToLocal, startLocalDate } from '../src/normalize/time.ts';
import { inferYear } from '../src/normalize/year.ts';
import { defaultConfig } from '../src/config.ts';

const c = defaultConfig();
const yr = (m: number, d: number, now: string) =>
  inferYear(m, d, new Date(now), c.year_past_window, c.year_future_window);

test('§10-T9 tz round trip', () => {
  const u = localToUtc({ year: 2026, month: 11, day: 3, hour: 19, minute: 0 }, 'Asia/Tokyo');
  assert.equal(u, '2026-11-03T10:00:00Z');
  const l = utcToLocal(u, 'Asia/Tokyo');
  assert.deepEqual([l.year, l.month, l.day, l.hour, l.minute], [2026, 11, 3, 19, 0]);
});

test('§10-T9 year inference', () => {
  assert.deepEqual(yr(1, 5, '2026-12-20T00:00:00Z'), { date: '2027-01-05', status: 'confirmed' });
  assert.deepEqual(yr(4, 20, '2026-10-16T00:00:00Z'), { date: '2027-04-20', status: 'tentative' });
});

test('§10-T19 boundaries', () => {
  const now = '2026-10-16T00:00:00Z';
  assert.deepEqual(yr(9, 15, now), { date: '2027-09-15', status: 'tentative' });
  assert.deepEqual(yr(9, 16, now), { date: '2026-09-16', status: 'confirmed' });
  assert.deepEqual(yr(4, 17, now), { date: '2027-04-17', status: 'confirmed' });
  assert.deepEqual(yr(4, 18, now), { date: '2027-04-18', status: 'tentative' });
});

test('all_day start_local_date uses tz not UTC', () => {
  const u = localToUtc({ year: 2026, month: 11, day: 3, hour: 0, minute: 30 }, 'Asia/Tokyo');
  assert.equal(u, '2026-11-02T15:30:00Z');
  assert.equal(startLocalDate(u, 'Asia/Tokyo'), '2026-11-03');
});

test('invalid tz -> INVALID_ARGUMENT', () => {
  const lt = { year: 2026, month: 1, day: 1, hour: 0, minute: 0 };
  for (const f of [() => localToUtc(lt, 'Mars/Base'), () => utcToLocal('2026-01-01T00:00:00Z', 'Mars/Base'), () => startLocalDate('2026-01-01T00:00:00Z', 'Mars/Base')]) {
    assert.throws(f, (e: any) => e.code === 'INVALID_ARGUMENT');
  }
});

test('DST: New York spring/fall', () => {
  assert.equal(localToUtc({ year: 2026, month: 7, day: 1, hour: 12, minute: 0 }, 'America/New_York'), '2026-07-01T16:00:00Z');
  assert.equal(localToUtc({ year: 2026, month: 1, day: 1, hour: 12, minute: 0 }, 'America/New_York'), '2026-01-01T17:00:00Z');
});
