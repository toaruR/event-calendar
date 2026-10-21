import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen } from '../src/pipeline/run-job.ts';

test('parseWhen: Japanese date with weekday is all-day in tz', () => {
  assert.deepEqual(parseWhen('2026年12月13日(日)', 'Asia/Tokyo'), { utc: '2026-12-12T15:00:00Z', allDay: true });
});

test('parseWhen: Japanese date with time', () => {
  assert.deepEqual(parseWhen('2026年1月5日（月） 9:30', 'Asia/Tokyo'), { utc: '2026-01-05T00:30:00Z', allDay: false });
  assert.deepEqual(parseWhen('2026年1月5日 14時', 'Asia/Tokyo'), { utc: '2026-01-05T05:00:00Z', allDay: false });
});

test('parseWhen: Japanese range uses first date', () => {
  assert.deepEqual(parseWhen('2026年10月1日(木)〜2026年12月25日(金)', 'Asia/Tokyo'), { utc: '2026-09-30T15:00:00Z', allDay: true });
});

test('parseWhen: ISO and unparsable unchanged', () => {
  assert.deepEqual(parseWhen('2026-12-13', 'Asia/Tokyo'), { utc: '2026-12-12T15:00:00Z', allDay: true });
  assert.equal(parseWhen('12月13日', 'Asia/Tokyo'), null);
});
