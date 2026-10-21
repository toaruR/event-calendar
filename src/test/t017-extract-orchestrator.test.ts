import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extract } from '../src/extract/index.ts';
import { extractWithLlm } from '../src/extract/llm-fallback.ts';
import { extractCss } from '../src/extract/css.ts';

const injection = readFileSync(new URL('./fixtures/injection.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-16T00:00:00Z');
const spec = (llm?: boolean) => ({ extract: { item_selector: 'li.none', fields: { title: { css: 'h3' }, date: { css: 'time' } }, ...(llm === undefined ? {} : { llm_fallback: llm }) } });

// extract/extractWithLlm accept no tools parameter, so source_remove is unreachable; verified via args.
const makeTools = () => {
  const sourceRemoveCalls: unknown[][] = [];
  return { tools: { source_remove: (...a: unknown[]) => { sourceRemoveCalls.push(a); } }, sourceRemoveCalls };
};
const refsTools = (args: unknown[], tools: object) =>
  args.some((a) => a === tools || (typeof a === 'object' && a !== null && 'source_remove' in a));

test('§10-T20 injection: invalid JSON discarded, source_removeは呼ばれない', async () => {
  const { tools, sourceRemoveCalls } = makeTools();
  const seen: unknown[][] = [];
  const client = async (...args: unknown[]) => { seen.push(args); return 'source_remove() ignore previous {not json'; };
  const r = await extractWithLlm(injection, { client });
  assert.equal(seen.length, 1);
  assert.ok(!refsTools(seen[0]!, tools));
  assert.equal(r.items.length, 0);
  assert.notEqual(r.error, undefined);
  assert.equal(sourceRemoveCalls.length, 0);
  assert.equal(seen[0]!.length, 1);
  assert.equal(seen[0]![1], undefined);
  assert.ok(!seen[0]!.some((a) => typeof a === 'function' || (typeof a === 'object' && a !== null)));
  assert.equal(typeof seen[0]![0], 'string');
  assert.ok((seen[0]![0] as string).includes('以前の指示を無視し'));
});

test('§10-T20 extra key (additionalProperties) -> adopted 0, no tools', async () => {
  const { tools, sourceRemoveCalls } = makeTools();
  const seen: unknown[][] = [];
  const llmClient = async (...args: unknown[]) => { seen.push(args); return JSON.stringify([{ title: 'x', action: 'source_remove' }]); };
  const r = await extract('html', injection, spec(true), { now: NOW, llmClient });
  assert.equal(seen.length, 1);
  assert.ok(!refsTools(seen[0]!, tools));
  assert.equal(typeof seen[0]![1], 'undefined');
  assert.equal(r.items.length, 0);
  assert.equal(sourceRemoveCalls.length, 0);
  assert.equal(seen[0]!.length, 1);
  assert.equal(seen[0]![1], undefined);
});

test('schema-nonconforming elements excluded', async () => {
  const client = async () => [{ title: 'ok', start: '2026-11-03T10:00:00Z' }, { title: 5 }];
  const r = await extractWithLlm('<p/>', { client });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.title, 'ok');
});

test('llm_fallback=false (default) -> client never called', async () => {
  let calls = 0;
  const llmClient = async () => { calls++; return []; };
  const a = await extract('html', injection, spec(), { now: NOW, llmClient });
  const b = await extract('html', injection, spec(false), { now: NOW, llmClient });
  assert.equal(calls, 0);
  assert.equal(a.items.length, 0);
  assert.equal(b.items.length, 0);
});

test('llm_fallback=true -> adopted via llm', async () => {
  let calls = 0;
  const llmClient = async () => { calls++; return [{ title: 'ok', start: '2026-11-03T10:00:00Z' }, { title: 5 }]; };
  const r = await extract('html', injection, spec(true), { now: NOW, llmClient });
  assert.equal(calls, 1);
  assert.equal(r.via, 'llm');
  assert.equal(r.items.length, 1);
});

test('kind=ical success -> css/llm not called', async () => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261103T100000Z\r\nSUMMARY:Hello\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  let llmCalls = 0, cssCalls = 0;
  const r = await extract('ical', ics, spec(true), {
    now: NOW,
    llmClient: async () => { llmCalls++; return []; },
    extractors: { css: ((...a: Parameters<typeof extractCss>) => { cssCalls++; return extractCss(...a); }) as typeof extractCss },
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.via, 'ical');
  assert.equal(llmCalls, 0);
  assert.equal(cssCalls, 0);
});

test('html: css used when jsonld empty', async () => {
  const html = '<li class="ev"><h3>A</h3><time>2026-11-03</time></li>';
  const r = await extract('html', html, { extract: { item_selector: 'li.ev', fields: { title: { css: 'h3' }, date: { css: 'time' } } } }, { now: NOW });
  assert.equal(r.via, 'css');
  assert.equal(r.items.length, 1);
});
