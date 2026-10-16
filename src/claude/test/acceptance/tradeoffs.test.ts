import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../../src/config.ts';
import { FakeClock } from '../../src/clock.ts';
import { runJob } from '../../src/pipeline/run-job.ts';
import type { SourceRow } from '../../src/pipeline/run-job.ts';
import type { FetchStageDeps } from '../../src/pipeline/fetch-stage.ts';
import { RateLimiter } from '../../src/net/rate-limiter.ts';
import { RobotsCache } from '../../src/net/robots.ts';
import { applyRunOutcome, getSourceState, resumeSource } from '../../src/jobs/source-state.ts';
import { scheduleTick } from '../../src/jobs/scheduler.ts';
import { extract } from '../../src/extract/index.ts';
import { searchEvents } from '../../src/service/events.ts';
import { buildCalendar } from '../../src/ics/calendar.ts';
import { startMockServer } from '../helpers/mock-server.ts';
import type { MockServer } from '../helpers/mock-server.ts';
import { AutoClock, bootHttp } from '../helpers/http-helpers.ts';
import { bootDaemon } from '../helpers/daemon-fixture.ts';
import { count, jsonLdPage, setupDb } from '../helpers/run-helpers.ts';

const config = defaultConfig();
const now = new Date('2026-10-01T00:00:00Z');
const specObj = { kind: 'jsonld', region_policy: { mode: 'trust_source' } };
const PHONE = '03-1234-5678';
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

let srv: MockServer;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
});
after(async () => { await srv.close(); });

function netDeps(): FetchStageDeps {
  const clock = new AutoClock();
  return {
    clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: ['127.0.0.1'] },
  };
}

function mkSource(path: string) {
  const { db, sources } = setupDb();
  const url = `${srv.base}${path}`;
  db.prepare('UPDATE source SET url = ? WHERE id = ?').run(url, 's1');
  const source: SourceRow = { ...sources[0]!, url };
  return { db, source };
}

test('tradeoffs: body_max exceeded -> partial, event increment 0 (control: normal body yields events)', async () => {
  assert.equal(config.body_max, 5242880);
  const page = jsonLdPage([{ uid: 'big1', name: '巨大ページ祭り' }]);
  srv.text('/ok', page);
  // valid JSON-LD first, then > 5MB padding: if the truncated body were parsed, an event would appear
  srv.text('/big', page + '<!--' + 'x'.repeat(config.body_max + 1024) + '-->');

  const okA = mkSource('/ok');
  const okRes = await runJob({ db: okA.db, source: okA.source, net: netDeps(), now, config });
  assert.equal(okRes.outcome, 'ok');
  assert.equal(count(okA.db, 'event'), 1);

  const big = mkSource('/big');
  const before0 = count(big.db, 'event');
  const r = await runJob({ db: big.db, source: big.source, net: netDeps(), now, config });
  assert.equal(r.outcome, 'partial');
  assert.equal(count(big.db, 'event') - before0, 0);
  const run = big.db.prepare('SELECT outcome FROM run ORDER BY rowid DESC LIMIT 1').get() as { outcome: string };
  assert.equal(run.outcome, 'partial');
});

test('tradeoffs: per-source body_max override in spec -> INVALID_ARGUMENT (400), nothing registered', async () => {
  const h = await bootHttp();
  try {
    const body = {
      url: `${srv.base}/ok`, region_id: 'r1', terms_note: 'n', allow_redistribute: true,
      spec: { ...specObj, body_max: 10_000_000 },
    };
    const add = await h.call('POST', '/sources', body);
    assert.equal(add.status, 400);
    assert.equal(add.body.error.code, 'INVALID_ARGUMENT');
    const tst = await h.call('POST', '/sources:test', { url: body.url, spec: body.spec });
    assert.equal(tst.status, 400);
    assert.equal(tst.body.error.code, 'INVALID_ARGUMENT');
    assert.equal(count(h.db, 'source'), 0);
  } finally { await h.stop(); }
});

test('tradeoffs: quarantined stays quarantined after FakeClock +30 days (no auto recovery); manual resume only', () => {
  const { db } = setupDb();
  const clock = new FakeClock(Date.parse('2026-10-01T00:00:00Z'));
  applyRunOutcome(db, 's1', 'blocked_robots');
  assert.equal(getSourceState(db, 's1').state, 'quarantined');
  clock.advance(30 * 86_400_000);
  assert.deepEqual(scheduleTick(db, clock, () => 0.5, config), []);
  assert.equal(count(db, 'job'), 0);
  applyRunOutcome(db, 's1', 'ok', { itemsFound: 3 });
  assert.equal(getSourceState(db, 's1').state, 'quarantined');
  assert.equal(resumeSource(db, 's1').state, 'active');
});

test('tradeoffs: dry run with 0 items -> ZERO_ITEMS without force; force=true registers the source', async () => {
  srv.text('/empty', '<html><body>nothing</body></html>');
  const h = await bootHttp();
  try {
    const body = { url: `${srv.base}/empty`, region_id: 'r1', terms_note: 'n', allow_redistribute: true, spec: specObj };
    const no = await h.call('POST', '/sources', body);
    assert.equal(no.status, 422);
    assert.equal(no.body.error.code, 'ZERO_ITEMS');
    assert.equal(count(h.db, 'source'), 0);
    const yes = await h.call('POST', '/sources', { ...body, force: true });
    assert.equal(yes.status, 200);
    assert.equal(count(h.db, 'source'), 1);
  } finally { await h.stop(); }
});

test('tradeoffs: llm_fallback defaults to OFF -> LLM client calls == 0 (control: explicit true calls it)', async () => {
  let calls = 0;
  const llmClient = async (): Promise<unknown> => { calls++; return '[]'; };
  const fields = { title: { css: '.t' }, date: { css: '.d' } };
  const emptyHtml = '<html><body><p>no events here</p></body></html>';
  const off = await extract('html', emptyHtml, { extract: { item_selector: '.item', fields } }, { now, config, llmClient });
  assert.equal(off.items.length, 0);
  assert.equal(calls, 0);
  const offJsonld = await extract('jsonld', emptyHtml, {}, { now, config, llmClient });
  assert.equal(offJsonld.items.length, 0);
  assert.equal(calls, 0);
  await extract('html', emptyHtml, { extract: { item_selector: '.item', fields, llm_fallback: true } }, { now, config, llmClient });
  assert.equal(calls, 1);
});

test('tradeoffs: default redact_contact=true -> phone number absent from stored events, search output and ICS', async () => {
  assert.equal(config.redact_contact, true);
  const ev = {
    '@context': 'https://schema.org', '@type': 'Event', '@id': 'c1', name: '連絡先付き祭り',
    startDate: '2026-11-03T19:00:00+09:00', location: { '@type': 'Place', name: '世田谷公園' },
    description: `お問い合わせは ${PHONE} まで`,
  };
  srv.text('/contact', `<html><head><script type="application/ld+json">${JSON.stringify([ev])}</script></head></html>`);
  const a = mkSource('/contact');
  const r = await runJob({ db: a.db, source: a.source, net: netDeps(), now, config });
  assert.equal(r.outcome, 'ok');
  assert.equal(count(a.db, 'event'), 1);
  const stored = a.db.prepare('SELECT description FROM event').get() as { description: string | null };
  assert.equal(occurrences(stored.description ?? '', PHONE), 0);
  const search = JSON.stringify(searchEvents(a.db, { region_id: 'r1', from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' }));
  assert.ok(search.includes('連絡先付き祭り'), 'event is present in output');
  assert.equal(occurrences(search, PHONE), 0);
  const ics = buildCalendar(a.db, 'r1', {
    from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z', now: now.getTime(), config,
  }).body;
  assert.ok(ics.includes('連絡先付き祭り'));
  assert.equal(occurrences(ics, PHONE), 0);
});

test('tradeoffs: default config.ssrf_allowlist deepEquals []', () => {
  assert.deepEqual(defaultConfig().ssrf_allowlist, []);
  assert.deepEqual(config.ssrf_allowlist, []);
});

test('tradeoffs: SSRF rejected by default (loopback source_test -> 403 SSRF_BLOCKED)', async () => {
  const f = await bootDaemon({ tick: 1 });
  try {
    const r = await f.call('POST', '/sources:test', { url: 'http://127.0.0.1/', spec: specObj });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'SSRF_BLOCKED');
  } finally { await f.stop(); }
});

test('tradeoffs: disappear_runs is 3 (cancelled on the 3rd consecutive miss, not before)', async () => {
  assert.equal(config.disappear_runs, 3);
  const { db, sources } = setupDb();
  const s = sources[0]!;
  const day = (n: number): Date => new Date(Date.UTC(2026, 9, 16 + n));
  const fetchOf = (names: Array<{ uid: string; name: string }>) => async () => ({ status: 200, text: jsonLdPage(names) });
  const A = { uid: 'a1', name: '世田谷夏祭り' };
  const B = { uid: 'b1', name: '三軒茶屋盆踊り' };
  await runJob({ db, source: s, fetchText: fetchOf([A, B]), now: day(0), config });
  const statusOfA = (): string => (db.prepare('SELECT status FROM event WHERE title = ?').get(A.name) as { status: string }).status;
  for (let i = 1; i <= 2; i++) {
    await runJob({ db, source: s, fetchText: fetchOf([B]), now: day(i), config });
    assert.equal(statusOfA(), 'confirmed', `miss ${i}`);
  }
  await runJob({ db, source: s, fetchText: fetchOf([B]), now: day(3), config });
  assert.equal(statusOfA(), 'cancelled');
});
