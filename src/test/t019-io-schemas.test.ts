import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, validateOutput } from '../src/validate.ts';

const bad = (fn: () => unknown) => assert.throws(fn, (e: any) => e.code === 'INVALID_ARGUMENT');
const add = (o: object = {}) => ({ url: 'https://e.com/a.ics', region_id: 'r', terms_note: 't', allow_redistribute: true, ...o });

test('source_add interval and trust bounds', () => {
  bad(() => validateInput('source_add', add({ interval_sec: 899 })));
  validateInput('source_add', add({ interval_sec: 900 }));
  bad(() => validateInput('source_add', add({ trust: 1.1 })));
  validateInput('source_add', add({ trust: 0.5 }));
});
test('source_add required fields', () => {
  for (const k of ['terms_note', 'allow_redistribute', 'url']) {
    const b: any = add(); delete b[k];
    bad(() => validateInput('source_add', b));
  }
});
test('source_update / events_search', () => {
  bad(() => validateInput('source_update', { enabled: true }));
  validateInput('source_update', { expected_version: 1 });
  bad(() => validateInput('events_search', { region_id: 'r', from: 'yesterday', to: '2026-01-01T00:00:00Z' }));
  validateInput('events_search', { region_id: 'r', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00+09:00' });
});
test('region_upsert tz check and keywords conversion', () => {
  bad(() => validateInput('region_upsert', { id: 'r', name: 'n', tz: 'Mars/Base', keywords: ['a'] }));
  const r = validateInput('region_upsert', { id: 'r', name: 'n', tz: 'Asia/Tokyo', keywords: ['世田谷', '三軒茶屋'] });
  assert.equal(r.keywords_json, JSON.stringify(['世田谷', '三軒茶屋']));
  assert.equal(r.keywords, undefined);
});
test('unknown tool rejected', () => bad(() => validateInput('nope', {})));
test('Event output schema', () => {
  const ev = { id: 'e', region_id: 'r', title: 't', start_utc: '2026-01-01T00:00:00Z', tz: 'Asia/Tokyo', status: 'confirmed' };
  validateOutput('Event', ev);
  for (const k of ['id', 'region_id', 'title', 'start_utc', 'tz', 'status']) {
    const e: any = { ...ev }; delete e[k];
    bad(() => validateOutput('Event', e));
  }
  bad(() => validateOutput('Event', { ...ev, status: 'x' }));
});
