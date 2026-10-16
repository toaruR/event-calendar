import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSourceSpec } from '../src/validate.ts';

const rp = { mode: 'trust_source' };
const bad = (spec: unknown) => assert.throws(() => validateSourceSpec(spec), (e: any) => e.code === 'INVALID_ARGUMENT');
const html = (fields: object) => ({ kind: 'html', region_policy: rp, extract: { item_selector: '.a', fields } });
const f = { css: 'x' };

test('ical with trust_source is valid', () => {
  validateSourceSpec({ kind: 'ical', region_policy: rp });
});
test('html requires extract and title/date fields', () => {
  bad({ kind: 'html', region_policy: rp });
  bad(html({ title: f }));
  bad(html({ date: f }));
  validateSourceSpec(html({ title: f, date: f }));
});
test('region_policy / unknown keys', () => {
  bad({ kind: 'ical' });
  bad({ kind: 'ical', region_policy: { mode: 'x' } });
  bad({ kind: 'ical', region_policy: { mode: 'geo', min_confidence: 1.1 } });
  bad({ kind: 'ical', region_policy: rp, foo: 1 });
});
test('paging.max_pages bounds', () => {
  const s = (n: number) => ({ kind: 'ical', region_policy: rp, fetch: { paging: { type: 'next_link', max_pages: n } } });
  validateSourceSpec(s(20));
  bad(s(21));
  bad(s(0));
});
