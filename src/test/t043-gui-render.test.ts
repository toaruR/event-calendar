import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { esc, renderSources, renderSpecEditor, renderMonth, renderWeek, renderHealth } from '../gui/render.js';

test('esc escapes html metacharacters', () => {
  assert.equal(esc(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('§10-T14 GUI escapes script title (no script element rendered)', () => {
  const title = '<script>alert(1)</script>';
  const outputs = [
    renderMonth(2026, 11, [{ title, start: '2026-11-05T10:00:00Z' }]),
    renderWeek('2026-11-02', [{ title, start: '2026-11-05T10:00:00Z' }]),
    renderSources([{ id: '<b>', name: title, state: 'active', spec_version: 1 }]),
  ];
  for (const html of outputs) {
    const $ = cheerio.load(html);
    assert.equal($('script').length, 0);
    assert.ok(!html.includes('<script>'));
    assert.ok($.root().text().includes(title));
  }
});

test('renderMonth 2026-11 yields 30 day cells; renderWeek yields 7', () => {
  assert.equal(cheerio.load(renderMonth(2026, 11, [])).root().find('.day').length, 30);
  const w = cheerio.load(renderWeek('2026-11-02', []));
  assert.equal(w('.day').length, 7);
  assert.equal(w('.day').last().attr('data-date'), '2026-11-08');
});

test('renderSpecEditor escapes spec_json in textarea and has expected_version data attr', () => {
  const spec = '{"x":"</textarea><script>1</script>"}';
  const $ = cheerio.load(renderSpecEditor({ id: 's1', spec_json: spec, expected_version: 3 }));
  assert.equal($('script').length, 0);
  assert.equal($('textarea').text(), spec);
  assert.equal($('[data-expected-version]').attr('data-expected-version'), '3');
});

test('renderHealth: 3 sources give 3 tr rows with state text', () => {
  const states = ['active', 'degraded', 'quarantined'];
  const $ = cheerio.load(renderHealth(states.map((state, i) => ({ id: `s${i}`, state }))));
  const rows = $('tr');
  assert.equal(rows.length, 3);
  states.forEach((st, i) => assert.ok($(rows[i]).text().includes(st)));
});

test('gui/render.js has no external URLs', () => {
  const src = readFileSync(new URL('../gui/render.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('http://') && !src.includes('https://'));
});
