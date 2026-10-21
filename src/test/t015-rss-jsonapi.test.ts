import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRss } from '../src/extract/rss.ts';
import { extractJsonApi } from '../src/extract/json-api.ts';

const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title>A</title><link>http://x.test/a</link><guid>g1</guid><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><description>d</description></item>
<item><title>B</title><link>http://x.test/b</link></item></channel></rss>`;
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>f</title>
<entry><title>C</title><id>urn:c</id><link href="http://x.test/c"/><updated>2026-11-03T10:00:00Z</updated><summary>s</summary></entry>
<entry><title>D</title><id>urn:d</id><link href="http://x.test/d"/><updated>2026-11-04T10:00:00Z</updated></entry></feed>`;

test('RSS 2.0 items', () => {
  const r = extractRss(rss);
  assert.equal(r.error, undefined);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0]!.title, 'A');
  assert.equal(r.items[0]!.source_uid, 'g1');
  assert.equal(r.items[0]!.start, '2026-11-03T10:00:00Z');
  assert.equal(r.items[0]!.url, 'http://x.test/a');
  assert.equal(r.items[1]!.source_uid, 'http://x.test/b');
});

test('Atom entries', () => {
  const r = extractRss(atom);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0]!.title, 'C');
  assert.equal(r.items[0]!.url, 'http://x.test/c');
  assert.equal(r.items[0]!.source_uid, 'urn:c');
  assert.equal(r.items[0]!.start, '2026-11-03T10:00:00Z');
});

test('json_api same-name keys', () => {
  const r = extractJsonApi(JSON.stringify([
    { title: 'J1', start_utc: '2026-11-03T10:00:00Z', end_utc: '2026-11-03T11:00:00Z', venue_name: 'V', url: 'http://x.test/j', source_uid: 'u1', status: 'cancelled' },
    { title: 'J2' }, 5, { start_utc: 'x' },
  ]));
  assert.equal(r.error, undefined);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0]!.source_uid, 'u1');
  assert.equal(r.items[0]!.venue, 'V');
  assert.equal(r.items[0]!.start, '2026-11-03T10:00:00Z');
  assert.equal(r.items[0]!.end, '2026-11-03T11:00:00Z');
  assert.equal(r.items[0]!.status, 'cancelled');
  assert.equal(r.items[1]!.start, null);
});

test('invalid XML / JSON: 0 items, error, no throw', () => {
  const a = extractRss('<rss');
  assert.equal(a.items.length, 0);
  assert.notEqual(a.error, undefined);
  const b = extractJsonApi('{');
  assert.equal(b.items.length, 0);
  assert.notEqual(b.error, undefined);
  assert.notEqual(extractJsonApi('{"a":1}').error, undefined);
});

test('json_api acceptance example', () => {
  const r = extractJsonApi(JSON.stringify([{ title: 'T', start_utc: '2026-11-03T10:00:00Z', url: 'http://x/1' }]));
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.title, 'T');
  assert.equal(r.items[0]!.start, '2026-11-03T10:00:00Z');
  assert.equal(r.items[0]!.url, 'http://x/1');
});

test('RSS invalid pubDate does not throw', () => {
  const r = extractRss('<rss><channel><item><title>Z</title><pubDate>garbage</pubDate></item></channel></rss>');
  assert.equal(r.items.length, 1);
});
