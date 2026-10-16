import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCss } from '../src/extract/css.ts';
import type { CssSpec } from '../src/extract/css.ts';

const html = `<ul>
<li class="ev"><h3>A</h3><time>2026-11-03</time><a href="/e/1">d</a></li>
<li class="ev"><h3>B</h3><time>2026-11-04</time><a href="/e/2">d</a></li>
<li class="ev"><h3>C</h3><time>2026-11-05</time><a href="/e/3">d</a></li></ul>`;
const mkSpec = (absolutize: boolean, fetch?: CssSpec['fetch']): CssSpec => ({
  ...(fetch ? { fetch } : {}),
  extract: { item_selector: 'li.ev', fields: {
    title: { css: 'h3' }, date: { css: 'time' }, url: { css: 'a', attr: 'href', absolutize },
  } },
});
const noFetch = async (): Promise<string> => { throw new Error('should not fetch'); };

test('3 items', async () => {
  const r = await extractCss(html, mkSpec(false), { fetchPage: noFetch, baseUrl: 'http://x.test/list' });
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => i.title), ['A', 'B', 'C']);
  assert.deepEqual(r.items.map((i) => i.date), ['2026-11-03', '2026-11-04', '2026-11-05']);
  assert.equal(r.items[0]!.start, '2026-11-03');
});

test('absolutize true/false', async () => {
  const a = await extractCss(html, mkSpec(true), { fetchPage: noFetch, baseUrl: 'http://x.test/list' });
  assert.equal(a.items[0]!.url, 'http://x.test/e/1');
  const b = await extractCss(html, mkSpec(false), { fetchPage: noFetch, baseUrl: 'http://x.test/list' });
  assert.equal(b.items[0]!.url, '/e/1');
});

const pageHtml = (n: number) => `<li class="ev"><h3>P${n}</h3><time>2026-11-03</time><a href="/e/${n}">d</a></li><a class="next" href="/p/${n + 1}">next</a>`;

test('max_pages=5 -> 4 follow-up fetches, 5 pages of items', async () => {
  let calls = 0;
  const r = await extractCss(pageHtml(1), mkSpec(true, { paging: { type: 'next_link', selector: 'a.next', max_pages: 5 } }), {
    baseUrl: 'http://x.test/p/1',
    fetchPage: async () => { calls++; return pageHtml(calls + 1); },
  });
  assert.equal(calls, 4);
  assert.equal(r.items.length, 5);
  assert.equal(r.items[4]!.url, 'http://x.test/e/5');
});

test('default max_pages is 5', async () => {
  let calls = 0;
  const r = await extractCss(pageHtml(1), mkSpec(false, { paging: { type: 'next_link', selector: 'a.next' } }), {
    baseUrl: 'http://x.test/p/1', fetchPage: async () => { calls++; return pageHtml(calls + 1); },
  });
  assert.equal(calls, 4);
  assert.equal(r.items.length, 5);
});

test('max_pages 21 invalid, 20 ok', async () => {
  const mk = (n: number) => mkSpec(false, { paging: { type: 'next_link', selector: 'a.next', max_pages: n } });
  const bad = await extractCss(html, mk(21), { fetchPage: noFetch, baseUrl: 'http://x.test/' });
  assert.equal(bad.error?.code, 'INVALID_ARGUMENT');
  const ok = await extractCss(html, mk(20), { fetchPage: noFetch, baseUrl: 'http://x.test/' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.items.length, 3);
});

test('no selector match -> 0 items, no throw', async () => {
  const r = await extractCss('<p>none</p>', mkSpec(false), { fetchPage: noFetch, baseUrl: 'http://x.test/' });
  assert.equal(r.items.length, 0);
  assert.equal(r.error, undefined);
});
