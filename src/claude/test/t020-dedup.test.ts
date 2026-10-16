import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKey, bigramJaccard, shouldMerge, pickPrimary } from '../src/pipeline/dedup.ts';

const ev = (title: string, o: object = {}) => ({
  title, start_utc: '2026-08-01T01:00:00Z', start_local_date: '2026-08-01', ...o,
});

test('§10-T6 boundary: 8 common of 9 each => J=0.8 merge; 7 common => false', () => {
  // 10-char strings with all-distinct bi-grams => 9 bi-grams each
  const base = 'ABCDEFGHIJ';
  const same8 = 'ABCDEFGHIK'; // shares AB..HI (8), differs IJ vs IK
  const same7 = 'ABCDEFGHXY'; // shares AB..GH (7)
  assert.equal(bigramJaccard(base, same8), 0.8);
  assert.ok(Math.abs(bigramJaccard(base, same7) - 7 / 11) < 1e-9);
  assert.equal(shouldMerge(ev(base), ev(same8)), true);
  assert.equal(shouldMerge(ev(base), ev(same7)), false);
});
test('世田谷夏祭り vs 世田谷夏まつり J=0.375', () => {
  const j = bigramJaccard('世田谷夏祭り', '世田谷夏まつり');
  assert.equal(j, 0.375);
  assert.equal(shouldMerge(ev('世田谷夏祭り'), ev('世田谷夏まつり')), false);
});
test('venue rule', () => {
  assert.equal(shouldMerge(ev('same title', { venue_name: 'A館' }), ev('same title', { venue_name: 'B館' })), false);
  assert.equal(shouldMerge(ev('same title', { venue_name: 'A館' }), ev('same title')), true);
  assert.equal(shouldMerge(ev('same title', { venue_name: 'A館' }), ev('same title', { venue_name: 'A館' })), true);
});
test('NFKC dedupKey and time window', () => {
  assert.equal(dedupKey('ＡＢＣ　祭 123', '2026-08-01', 'ホール'), dedupKey('ABC 祭 123', '2026-08-01', 'ﾎｰﾙ'));
  assert.notEqual(dedupKey('a', '2026-08-01', ''), dedupKey('a', '2026-08-02', ''));
  assert.equal(shouldMerge(ev('same title'), ev('same title', { start_utc: '2026-08-01T02:01:00Z' })), false); // 61min
  assert.equal(shouldMerge(ev('same title'), ev('same title', { start_utc: '2026-08-01T02:00:00Z' })), true); // 60min
});
test('pickPrimary', () => {
  const hi = ev('x', { trust: 0.9 });
  const lo = ev('x', { trust: 0.5 });
  assert.equal(pickPrimary(lo, hi), hi);
  const long = ev('x', { trust: 0.5, description: 'd'.repeat(100) });
  const short = ev('x', { trust: 0.5, description: 'd'.repeat(10) });
  assert.equal(pickPrimary(short, long), long);
  assert.equal(pickPrimary(long, short), long);
});
