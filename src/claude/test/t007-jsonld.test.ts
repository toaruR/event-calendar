import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractJsonLd } from '../src/extract/jsonld.ts';

const html = readFileSync(new URL('./fixtures/jsonld-3.html', import.meta.url), 'utf8');

test('extracts 3 events (array and @graph)', () => {
  const r = extractJsonLd(html);
  assert.equal(r.error, undefined);
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => i.title), ['世田谷夏祭り', '三軒茶屋盆踊り', '渋谷ヨガ教室']);
  assert.equal(r.items[0]!.venue, '世田谷公園');
  assert.equal(r.items[0]!.start, '2026-11-03T19:00:00+09:00');
  assert.equal(r.items[0]!.source_uid, 'ev-1');
});

test('no JSON-LD -> 0 items, no throw', () => {
  const r = extractJsonLd('<html><body>nothing</body></html>');
  assert.equal(r.items.length, 0);
  assert.equal(r.error, undefined);
});

test('invalid JSON -> 0 items with error, no throw', () => {
  const r = extractJsonLd('<script type="application/ld+json">{bad json</script>');
  assert.equal(r.items.length, 0);
  assert.notEqual(r.error, undefined);
});
