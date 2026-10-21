import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionConfidence, passesMinConfidence, geoConfidence } from '../src/normalize/region.ts';
import { sanitizeText } from '../src/normalize/sanitize.ts';
import { defaultConfig } from '../src/config.ts';

const c = defaultConfig();
const region = { keywords: ['三軒茶屋', '世田谷'], center_lat: 35.643, center_lon: 139.670, radius_km: 3 };
const kw = { mode: 'keyword' as const };
const evs = [{ title: '三軒茶屋 世田谷 祭' }, { title: '三軒茶屋 祭' }, { title: '渋谷 祭' }];

test('§10-T18 keyword confidence and min_confidence', () => {
  const conf = evs.map((e) => regionConfidence(e, kw, region, c.keyword_full_hits));
  assert.deepEqual(conf, [1, 0.5, 0]);
  assert.equal(conf.filter((x) => passesMinConfidence(x, 0.5)).length, 2);
  assert.equal(conf.filter((x) => passesMinConfidence(x, 0.6)).length, 1);
});

test('geo within/outside/no coords; trust_source', () => {
  assert.equal(geoConfidence(35.644, 139.671, region), 1);
  assert.equal(geoConfidence(35.70, 139.80, region), 0);
  assert.equal(geoConfidence(null, null, region), 0);
  assert.equal(regionConfidence({ title: 'x' }, { mode: 'geo' }, region, 2), 0);
  assert.equal(regionConfidence({ title: 'x' }, { mode: 'trust_source' }, region, 2), 1);
});

test('F9 control chars removed', () => {
  const out = sanitizeText('a\r\nb\0c', true);
  assert.equal(/[\r\n\0]/.test(out), false);
  assert.equal(/[\r\n\0]/.test(sanitizeText('a\r\nb\0c', false)), false);
});

test('redact_contact', () => {
  const d = '問合せ 03-1234-5678 または a@example.com まで';
  const r = sanitizeText(d, true);
  assert.equal(r.includes('03-1234-5678'), false);
  assert.equal(r.includes('a@example.com'), false);
  const k = sanitizeText(d, false);
  assert.ok(k.includes('03-1234-5678') && k.includes('a@example.com'));
});
