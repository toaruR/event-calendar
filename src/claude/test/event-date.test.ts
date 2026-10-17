import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEventDate, findEventDateIn } from '../src/normalize/event-date.ts';
import { extract } from '../src/extract/index.ts';
import { validateSourceSpec } from '../src/validate.ts';

const opts = { ref: new Date('2026-10-14T02:20:00Z'), pastWindow: 30, futureWindow: 183 };

test('findEventDate: 令和 / 西暦 / year-less', () => {
  assert.deepEqual(findEventDate('令和9年1月16日(土曜日)に開催', opts), { start: '2027-01-16', end: null, status: 'confirmed' });
  assert.deepEqual(findEventDate('2026年11月14日（土）ステラタウン', opts), { start: '2026-11-14', end: null, status: 'confirmed' });
  assert.deepEqual(findEventDate('「さいたまKI-TAまつり2026」が10月18日開催！', opts), { start: '2026-10-18', end: null, status: 'confirmed' });
});

test('findEventDate: year-less resolves against published date across new year', () => {
  const ref = new Date('2026-12-20T00:00:00Z');
  assert.equal(findEventDate('1月10日に初売り', { ...opts, ref })?.start, '2027-01-10');
});

test('findEventDate: time and range', () => {
  assert.equal(findEventDate('11月14日（土）10:30から', opts)?.start, '2026-11-14T10:30');
  assert.equal(findEventDate('11月14日 午後2時開演', opts)?.start, '2026-11-14T14:00');
  assert.deepEqual(findEventDate('10月18日〜19日に開催', opts), { start: '2026-10-18', end: '2026-10-19', status: 'confirmed' });
  assert.deepEqual(findEventDate('12月30日～1月3日 休館', opts), { start: '2026-12-30', end: '2027-01-03', status: 'confirmed' });
});

test('findEventDate: full-width digits; invalid / none -> null', () => {
  assert.equal(findEventDate('１１月５日オープン', opts)?.start, '2026-11-05');
  assert.equal(findEventDate('2月30日', opts), null);
  assert.equal(findEventDate('窓口の電話録音を開始します', opts), null);
  assert.equal(findEventDate(null, opts), null);
});

test('findEventDateIn: title wins over description and content', () => {
  assert.equal(findEventDateIn(['11月1日開催', '12月1日', '1月1日'], opts)?.start, '2026-11-01');
  assert.equal(findEventDateIn(['お知らせ', null, '本文: 11月3日に実施'], opts)?.start, '2026-11-03');
});

const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<item><title>北区秋の防犯フェアを開催します</title><link>https://a.test/1</link><pubDate>Thu, 01 Oct 2026 15:00:00 GMT</pubDate>
<description>令和8年11月14日（土）ステラタウンにて開催</description></item>
<item><title>電話の通話録音を開始します</title><link>https://a.test/2</link><pubDate>Sun, 27 Sep 2026 15:00:00 GMT</pubDate></item>
<item><title>新店情報</title><link>https://a.test/3</link><pubDate>Tue, 13 Oct 2026 23:28:12 GMT</pubDate>
<description>[&#8230;]</description><content:encoded><![CDATA[<p>オープンは<b>10月16日</b>です</p>]]></content:encoded></item>
</channel></rss>`;

test('extract rss date_from:content uses event dates and drops undated items', async () => {
  const r = await extract('rss', feed, { date_from: 'content' }, { now: new Date('2026-10-17T00:00:00Z') });
  assert.deepEqual(r.items.map((i) => [i.url, i.start]), [['https://a.test/1', '2026-11-14'], ['https://a.test/3', '2026-10-16']]);
  assert.ok(r.items.every((i) => !('content' in i)));
  assert.ok(r.warnings.some((w) => w.includes('1 item(s) without event date')));
});

test('extract rss default keeps published date', async () => {
  const r = await extract('rss', feed, {}, { now: new Date('2026-10-17T00:00:00Z') });
  assert.equal(r.items[0]!.start, '2026-10-01T15:00:00Z');
  assert.equal(r.items.length, 3);
});

test('SourceSpec accepts date_from published|content only', () => {
  assert.doesNotThrow(() => validateSourceSpec({ kind: 'rss', date_from: 'content', region_policy: { mode: 'trust_source' } }));
  assert.throws(() => validateSourceSpec({ kind: 'rss', date_from: 'title', region_policy: { mode: 'trust_source' } }));
});
