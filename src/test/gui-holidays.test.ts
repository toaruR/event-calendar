import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { holidaysOf, holidayName } from '../gui/holidays.js';
import { renderMonth } from '../gui/render.js';

test('2026 Japanese holidays incl. 振替休日 and 国民の休日', () => {
  assert.deepEqual([...holidaysOf(2026)].sort(), [
    ['2026-01-01', '元日'], ['2026-01-12', '成人の日'], ['2026-02-11', '建国記念の日'], ['2026-02-23', '天皇誕生日'],
    ['2026-03-20', '春分の日'], ['2026-04-29', '昭和の日'], ['2026-05-03', '憲法記念日'], ['2026-05-04', 'みどりの日'],
    ['2026-05-05', 'こどもの日'], ['2026-05-06', '振替休日'], ['2026-07-20', '海の日'], ['2026-08-11', '山の日'],
    ['2026-09-21', '敬老の日'], ['2026-09-22', '国民の休日'], ['2026-09-23', '秋分の日'], ['2026-10-12', 'スポーツの日'],
    ['2026-11-03', '文化の日'], ['2026-11-23', '勤労感謝の日'],
  ]);
});

test('2025 substitutes and Olympic moves', () => {
  assert.equal(holidayName('2025-02-24'), '振替休日');
  assert.equal(holidayName('2025-11-24'), '振替休日');
  assert.equal(holidayName('2021-07-23'), 'スポーツの日');
  assert.equal(holidayName('2021-10-11'), '');
  assert.equal(holidayName('2026-10-13'), '');
});

test('renderMonth marks holiday cells with name', () => {
  const $ = cheerio.load(renderMonth(2026, 9, []));
  assert.deepEqual($('.day.holiday').map((_, el) => $(el).attr('data-date')).get(), ['2026-09-21', '2026-09-22', '2026-09-23']);
  assert.equal($('.day[data-date="2026-09-23"] .holiday-name').text(), '秋分の日');
});
