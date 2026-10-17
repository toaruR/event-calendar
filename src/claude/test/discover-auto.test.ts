import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.ts';
import { defaultConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { Clock } from '../src/clock.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { RobotsCache } from '../src/net/robots.ts';
import type { FetchStageDeps } from '../src/pipeline/fetch-stage.ts';
import { runJob } from '../src/pipeline/run-job.ts';
import type { SourceRow } from '../src/pipeline/run-job.ts';
import { upsertRegion } from '../src/service/regions.ts';
import { approveCandidate } from '../src/service/sources.ts';
import type { SourceDeps } from '../src/service/sources.ts';
import { discoverDue, discoverSources, listCandidates, rejectCandidate } from '../src/service/discover.ts';
import type { SearchProvider } from '../src/service/discover.ts';
import { buildSearchProvider, combineProviders, parseDuckDuckGo } from '../src/service/search-providers.ts';
import { extractYahooRealtime } from '../src/extract/yahoo-realtime.ts';
import { startMockServer } from './helpers/mock-server.ts';
import type { MockServer } from './helpers/mock-server.ts';
import { count } from './helpers/run-helpers.ts';

const jsonld3 = readFileSync(new URL('./fixtures/jsonld-3.html', import.meta.url), 'utf8');

class AutoClock implements Clock {
  t = Date.parse('2026-10-01T00:00:00Z');
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

function yahooPage(entries: Array<{ id: string; text: string; createdAt?: number }>): string {
  const data = {
    props: { pageProps: { pageData: { timeline: { entry: entries.map((e) => ({
      id: e.id, url: `https://x.com/u/status/${e.id}?utm_source=yjrealtime&utm_medium=search`,
      displayText: e.text, createdAt: e.createdAt ?? Date.parse('2026-10-01T00:00:00Z') / 1000,
    })) } } } },
  };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

let srv: MockServer;
let jina: MockServer;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.text('/ok', jsonld3);
  srv.text('/js', '<html><body><div id="app"></div></body></html>');
  srv.text('/captcha', '<html><body><div class="g-recaptcha"></div></body></html>');
  srv.route('/down', (_q, res) => { res.statusCode = 503; res.end('down'); });
  srv.text('/realtime', yahooPage([
    { id: '1', text: '\tSTART\t世田谷\tEND\t 11月14日(土) 10時から 秋まつり開催！' },
    { id: '2', text: '今日は雨' },
  ]));
  jina = await startMockServer();
  for (const p of ['/down', '/js', '/captcha']) jina.text(`/${srv.base}${p}`, jsonld3);
});
after(async () => { await srv.close(); await jina.close(); });

function setup(over: Partial<Config> = {}) {
  const db = openDb(':memory:');
  upsertRegion(db, 'r1', { name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷'] });
  const clock = new AutoClock();
  const config: Config = { ...defaultConfig(), ssrf_allowlist: ['127.0.0.1'], x_search_base: `${srv.base}/realtime`, ...over };
  const net: FetchStageDeps = {
    clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: ['127.0.0.1'] },
  };
  const deps: SourceDeps = { net, config };
  return { db, deps, clock, config, net };
}

function insertSource(db: ReturnType<typeof openDb>, id: string, url: string, spec: Record<string, unknown>): SourceRow {
  const specJson = JSON.stringify(spec);
  db.prepare('INSERT INTO source(id,region_id,url,kind,spec_json,terms_note,allow_redistribute,state) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, 'r1', url, String(spec['kind']), specJson, 'n', 0, 'active');
  return { id, region_id: 'r1', url, kind: String(spec['kind']), spec_json: specJson };
}

test('parseDuckDuckGo decodes uddg redirect links and drops non-http targets', () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://a.example/events')}&rut=x">A イベント</a>
    <a class="result__a" href="https://b.example/feed.xml">B</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('javascript:alert(1)')}">bad</a>
    <a class="other" href="https://c.example/">not a result</a>`;
  assert.deepEqual(parseDuckDuckGo(html), [
    { url: 'https://a.example/events', title: 'A イベント' },
    { url: 'https://b.example/feed.xml', title: 'B' },
  ]);
});

test('combineProviders merges unique urls in order and survives one failing provider', async () => {
  const a: SearchProvider = async () => [{ url: 'https://a/' }, { url: 'https://b/' }];
  const boom: SearchProvider = async () => { throw new Error('down'); };
  const b: SearchProvider = async () => [{ url: 'https://b/' }, { url: 'https://c/' }];
  assert.deepEqual((await combineProviders([a, boom, b])('q', 10)).map((h) => h.url), ['https://a/', 'https://b/', 'https://c/']);
  assert.equal((await combineProviders([a, b])('q', 2)).length, 2);
  await assert.rejects(combineProviders([boom])('q', 10), /down/);
});

test('buildSearchProvider: none without usable providers (brave needs a key)', () => {
  const { net } = setup();
  assert.equal(buildSearchProvider({ ...defaultConfig(), search_providers: [] }, net), 'none');
  assert.equal(buildSearchProvider({ ...defaultConfig(), search_providers: ['brave'] }, net), 'none');
  assert.equal(typeof buildSearchProvider({ ...defaultConfig(), search_providers: ['duckduckgo'] }, net), 'function');
  assert.equal(typeof buildSearchProvider({ ...defaultConfig(), search_providers: ['brave'], brave_api_key: 'k' }, net), 'function');
});

test('extractYahooRealtime: strips hit markers and utm params; post time as start', () => {
  const r = extractYahooRealtime(yahooPage([{ id: '9', text: '\tSTART\tさいたま\tEND\t 祭り' }]));
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.title, 'さいたま 祭り');
  assert.equal(r.items[0]!.url, 'https://x.com/u/status/9');
  assert.equal(r.items[0]!.start, '2026-10-01T00:00:00Z');
  assert.match(extractYahooRealtime('<html></html>').error ?? '', /__NEXT_DATA__/);
});

test('discover with x_search proposes a yahoo_realtime candidate; approve imports dated posts only', async () => {
  const { db, deps } = setup({ x_search: true });
  const provider: SearchProvider = async () => [{ url: `${srv.base}/ok` }];
  const r = await discoverSources(db, 'r1', { provider }, deps);
  assert.equal(r.candidates.length, 2);
  const x = r.candidates.find((c) => c.url.startsWith(`${srv.base}/realtime?`))!;
  assert.ok(x);
  assert.equal(x.robots_allowed, true);
  const { source } = await approveCandidate(db, x.id, { terms_note: 'GUIで承認', allow_redistribute: false }, deps);
  assert.deepEqual(source.spec_json, { kind: 'html', parser: 'yahoo_realtime', date_from: 'content', region_policy: { mode: 'trust_source' } });
  const run = await runJob({ db, source: { ...source, spec_json: JSON.stringify(source.spec_json) }, net: deps.net, now: new Date(deps.net.clock.now()), config: deps.config! });
  assert.equal(run.outcome, 'ok');
  assert.equal(run.items_upserted, 1, 'undated post dropped');
  const ev = db.prepare('SELECT start_local_date, url FROM event').get() as { start_local_date: string; url: string };
  assert.equal(ev.start_local_date, '2026-11-14');
  assert.equal(ev.url, 'https://x.com/u/status/1');
});

test('discover skips registered urls; list/reject candidates; rejected is not re-proposed', async () => {
  const { db, deps } = setup();
  insertSource(db, 's1', `${srv.base}/ok`, { kind: 'jsonld', region_policy: { mode: 'trust_source' } });
  const provider: SearchProvider = async () => [{ url: `${srv.base}/ok` }, { url: `${srv.base}/js` }];
  const r = await discoverSources(db, 'r1', { provider }, deps);
  assert.deepEqual(r.candidates.map((c) => c.url), [`${srv.base}/js`]);
  assert.equal(listCandidates(db).candidates.length, 1);
  rejectCandidate(db, r.candidates[0]!.id);
  assert.equal(listCandidates(db).candidates.length, 0);
  assert.equal(listCandidates(db, { status: 'rejected' }).candidates.length, 1);
  await discoverSources(db, 'r1', { provider }, deps);
  assert.equal(listCandidates(db).candidates.length, 0);
  assert.throws(() => rejectCandidate(db, r.candidates[0]!.id), (e: any) => e.code === 'CONFLICT');
  assert.throws(() => listCandidates(db, { status: 'x' }), (e: any) => e.code === 'INVALID_ARGUMENT');
});

test('discoverDue runs once per discover_interval_sec per region', async () => {
  const { db, deps, clock } = setup({ discover_interval_sec: 3600 });
  let calls = 0;
  const provider: SearchProvider = async () => { calls++; return []; };
  assert.deepEqual(await discoverDue(db, provider, deps), [{ region_id: 'r1', found: 0 }]);
  assert.deepEqual(await discoverDue(db, provider, deps), []);
  clock.t += 3600 * 1000;
  await discoverDue(db, provider, deps);
  assert.equal(calls, 2);
  assert.deepEqual(await discoverDue(db, 'none', deps), [], 'nothing to search with');
});

test('jina_fallback: 5xx and 0-item pages are re-read via jina; captcha pages are not', async () => {
  const spec = { kind: 'jsonld', region_policy: { mode: 'trust_source' } };
  for (const [path, expectJina] of [['/down', true], ['/js', true], ['/captcha', false]] as const) {
    const { db, deps } = setup({ jina_fallback: true, jina_base: `${jina.base}/` });
    const src = insertSource(db, 's1', `${srv.base}${path}`, spec);
    const before = jina.requestCount();
    const r = await runJob({ db, source: src, net: deps.net, now: new Date(deps.net.clock.now()), config: deps.config! });
    if (expectJina) {
      assert.equal(r.outcome, 'ok', path);
      assert.equal(count(db, 'event'), 3, path);
      assert.equal(jina.lastHeaders(`/${srv.base}${path}`)?.['x-return-format'], 'html');
    } else {
      assert.equal(r.outcome, 'login_or_captcha');
      assert.equal(jina.requestCount(), before, 'jina not used for captcha');
    }
  }
  const { db, deps } = setup({ jina_fallback: false, jina_base: `${jina.base}/` });
  const src = insertSource(db, 's1', `${srv.base}/js`, spec);
  const before = jina.requestCount();
  await runJob({ db, source: src, net: deps.net, now: new Date(deps.net.clock.now()), config: deps.config! });
  assert.equal(jina.requestCount(), before, 'off by default');
});
