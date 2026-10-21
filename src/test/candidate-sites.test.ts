import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteSpec } from '../src/extract/site-spec.ts';
import { extract } from '../src/extract/index.ts';
import { extractSaitamaCalendar } from '../src/extract/saitama-calendar.ts';
import { validateInput } from '../src/validate.ts';
import { defaultConfig } from '../src/config.ts';
import { startMockServer } from './helpers/mock-server.ts';
import { bootHttp } from './helpers/http-helpers.ts';
import { approveCandidate, loadAll } from '../gui/app.js';

const choco = 'https://chocotabi-saitama.jp/event/';
const pref = 'https://www.pref.saitama.lg.jp/cgi-bin/event_cal/cal_month.cgi';
const card = `<article class="single-near-spot-card"><a class="single-near-spot-card__link" href="/event/123/">
  <span class="single-near-spot-card__event-date-pc">2026年10月24日(土)</span>
  <h1 class="single-near-spot-card__title">秋バラまつり</h1><p class="single-near-spot-card__description-text">秋のバラが見頃</p>
</a></article><script src="https://www.google.com/recaptcha/api.js"></script>`;
const calendar = `<input name="year" value="2026"><input name="month" value="10"><table class="calendar_tbl"><tr>
  <td id="eventidx-3-0"><a href="/a1105/event.html" title="体験会">体験会</a></td>
  <td id="eventidx-10-0"><a href="/a1105/event.html" title="体験会">体験会</a></td>
  <td id="eventidx-10-1"><a href="/a1105/event.html">体験会</a></td>
  <td id="eventidx-32-0"><a href="/invalid">無効な日</a></td>
  <td id="eventidx-11-0"><a href="javascript:alert(1)">無効なURL</a></td>
</tr></table>`;

test('known list pages get valid extraction specs; other URLs keep automatic detection', async () => {
  for (const url of [choco, pref]) {
    const spec = siteSpec(url)!;
    validateInput('source_test', { url, spec }, defaultConfig());
    const r = await extract('html', url === choco ? card : calendar, spec, { now: new Date(), baseUrl: url });
    assert.ok(r.items.length > 0);
    assert.ok(r.items.every((i) => i.title && i.start && i.url?.startsWith('https://')));
  }
  for (const url of ['https://example.com/event/', `${choco}123/`, 'https://chocotabi-saitama.jp.evil.example/event/']) {
    assert.equal(siteSpec(url), undefined);
  }
});

test('official calendar keeps separate dates for the same URL, deduplicates cells and validates dates', () => {
  const r = extractSaitamaCalendar(calendar, pref);
  assert.deepEqual(r.items.map((i) => i.start), ['2026-10-03', '2026-10-10']);
  assert.notEqual(r.items[0]!.source_uid, r.items[1]!.source_uid);
  assert.equal(extractSaitamaCalendar(calendar.replace('value="10"', 'value="13"'), pref).items.length, 0);
  assert.equal(extractSaitamaCalendar(calendar.replace('value="2026"', 'value=""'), pref).items.length, 0);
});

test('GUI approval saves working HTML specs; reloading shows sources and removes approved candidates', async () => {
  const pages = await startMockServer();
  const s = await bootHttp();
  const base = `http://127.0.0.1:${(s.h.server.address() as { port: number }).port}`;
  try {
    pages.text('/robots.txt', 'User-agent: *\nAllow: /');
    pages.text('/choco', card);
    pages.text('/pref', calendar);
    for (const [id, url, path] of [['c1', choco, '/choco'], ['c2', pref, '/pref']]) {
      s.db.prepare("INSERT INTO source_candidate(id,region_id,url,status,robots_allowed,spec_guess_json) VALUES(?,'r1',?,'proposed',1,?)")
        .run(id!, pages.base + path, JSON.stringify(siteSpec(url!)));
      const fetchFn = (p: string, init: RequestInit) => fetch(base + p, init);
      const result = await approveCandidate(fetchFn, s.h.token, id!);
      assert.equal(result.error, undefined);
      assert.equal(result.source.enabled, true);
      const el = () => ({ innerHTML: '' });
      const root = { health: el(), sources: el(), candidates: el(), events: el() };
      await loadAll(fetchFn, s.h.token, root);
      assert.ok(root.sources.innerHTML.includes(result.source.id));
      assert.ok(!root.candidates.innerHTML.includes(`data-id="${id}"`));
      const saved = s.db.prepare('SELECT spec_json, enabled FROM source WHERE id=?').get(result.source.id)!;
      assert.equal(saved.enabled, 1);
      assert.deepEqual(JSON.parse(saved.spec_json as string), siteSpec(url!));
    }
  } finally { await s.stop(); await pages.close(); }
});
