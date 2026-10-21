import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.ts';
import { httpStatus, exitCode } from '../src/errors.ts';
import { defaultConfig } from '../src/config.ts';
import type { Clock } from '../src/clock.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { RobotsCache } from '../src/net/robots.ts';
import type { FetchStageDeps } from '../src/pipeline/fetch-stage.ts';
import { upsertRegion } from '../src/service/regions.ts';
import { addSource, approveCandidate, listSources, testSource } from '../src/service/sources.ts';
import type { SourceDeps } from '../src/service/sources.ts';
import { startMockServer } from './helpers/mock-server.ts';
import type { MockServer } from './helpers/mock-server.ts';
import { count } from './helpers/run-helpers.ts';

const config = defaultConfig();
const jsonld3 = readFileSync(new URL('./fixtures/jsonld-3.html', import.meta.url), 'utf8');
const code = (c: string) => (e: any) => e.code === c;

class AutoClock implements Clock {
  t = Date.parse('2026-10-01T00:00:00Z');
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

let srv: MockServer;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.text('/ok', jsonld3);
  srv.text('/zero', '<html><head></head><body>nothing</body></html>');
});
after(async () => { await srv.close(); });

function setup(allow: string[] = ['127.0.0.1']) {
  const db = openDb(':memory:');
  upsertRegion(db, 'r1', { name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷'] });
  const clock = new AutoClock();
  const net: FetchStageDeps = {
    clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: allow },
  };
  const deps: SourceDeps = { net, config: { ...config, ssrf_allowlist: allow } };
  return { db, deps };
}
const body = (path: string, o: Record<string, unknown> = {}) => ({
  url: `${srv.base}${path}`, region_id: 'r1', terms_note: 'ok to crawl', allow_redistribute: true,
  spec: { kind: 'jsonld', region_policy: { mode: 'trust_source' } }, ...o,
});

test('§10-T2: 0 items -> ZERO_ITEMS, source rows unchanged; force=true adds one', async () => {
  const { db, deps } = setup();
  const before = count(db, 'source');
  await assert.rejects(addSource(db, body('/zero'), deps), code('ZERO_ITEMS'));
  assert.equal(httpStatus('ZERO_ITEMS'), 422);
  assert.equal(exitCode('ZERO_ITEMS'), 3);
  assert.equal(count(db, 'source'), before);
  assert.equal(count(db, 'source_spec_history'), 0);
  const r = await addSource(db, body('/zero', { force: true }), deps);
  assert.equal(count(db, 'source'), before + 1);
  assert.equal(r.source.state, 'active');
});

test('§10-T3 (F3): robots Disallow -> ROBOTS_DISALLOWED and body hits = 0', async () => {
  const g = await startMockServer();
  try {
    g.text('/robots.txt', 'User-agent: *\nDisallow: /');
    g.text('/e', jsonld3);
    const { db, deps } = setup();
    const url = `${g.base}/e`;
    await assert.rejects(addSource(db, body('/e', { url }), deps), code('ROBOTS_DISALLOWED'));
    await assert.rejects(testSource(db, { url, spec: body('/e').spec }, deps), code('ROBOTS_DISALLOWED'));
    assert.equal(g.requestCount('/e'), 0);
    assert.equal(count(db, 'source'), 0);
  } finally { await g.close(); }
});

test('SSRF target -> SSRF_BLOCKED for addSource/testSource', async () => {
  const { db, deps } = setup([]);
  await assert.rejects(addSource(db, body('/ok'), deps), code('SSRF_BLOCKED'));
  await assert.rejects(testSource(db, { url: `${srv.base}/ok` }, deps), code('SSRF_BLOCKED'));
  await assert.rejects(testSource(db, { url: 'http://169.254.169.254/' }, deps), code('SSRF_BLOCKED'));
  assert.equal(count(db, 'source'), 0);
});

test('terms_note missing -> INVALID_ARGUMENT; unknown region -> NOT_FOUND; interval_sec 899 -> INVALID_ARGUMENT', async () => {
  const { db, deps } = setup();
  const { terms_note: _t, ...noTerms } = body('/ok');
  await assert.rejects(addSource(db, noTerms, deps), code('INVALID_ARGUMENT'));
  await assert.rejects(addSource(db, body('/ok', { terms_note: '  ' }), deps), code('INVALID_ARGUMENT'));
  await assert.rejects(addSource(db, body('/ok', { region_id: 'nope' }), deps), code('NOT_FOUND'));
  await assert.rejects(addSource(db, body('/ok', { interval_sec: 899 }), deps), code('INVALID_ARGUMENT'));
  assert.equal(count(db, 'source'), 0);
});

test('addSource success: history v1, next_run_at set, samples <= 5; testSource leaves DB untouched', async () => {
  const { db, deps } = setup();
  const t = await testSource(db, { url: `${srv.base}/ok`, spec: body('/ok').spec }, deps);
  assert.equal(t.ok, true);
  assert.equal(t.item_count, 3);
  assert.equal(t.robots_allowed, true);
  assert.ok(t.samples.length <= 5 && t.samples.length === 3);
  assert.equal(count(db, 'source'), 0);
  assert.equal(count(db, 'event'), 0);

  const r = await addSource(db, body('/ok', { interval_sec: 900 }), deps);
  assert.equal(r.samples.length, 3);
  assert.equal(r.source.spec_version, 1);
  assert.equal(r.source.interval_sec, 900);
  const h = db.prepare('SELECT spec_version FROM source_spec_history WHERE source_id = ?').all(r.source.id) as { spec_version: number }[];
  assert.deepEqual(h.map((x) => Number(x.spec_version)), [1]);
  const row = db.prepare('SELECT next_run_at FROM source WHERE id = ?').get(r.source.id) as { next_run_at: string | null };
  assert.ok(row.next_run_at);
  assert.equal(count(db, 'event'), 0);
});

test('approveCandidate: NOT_FOUND, ZERO_ITEMS, success; listSources filters', async () => {
  const { db, deps } = setup();
  upsertRegion(db, 'r2', { name: '渋谷', tz: 'Asia/Tokyo', keywords: ['渋谷'] });
  const ins = db.prepare("INSERT INTO source_candidate(id,region_id,url,status,robots_allowed) VALUES(?,?,?,'proposed',1)");
  ins.run('c1', 'r1', `${srv.base}/ok`);
  ins.run('c2', 'r1', `${srv.base}/zero`);
  const a = { terms_note: 'n', allow_redistribute: false, spec: { kind: 'jsonld', region_policy: { mode: 'trust_source' } } };
  await assert.rejects(approveCandidate(db, 'nope', a, deps), code('NOT_FOUND'));
  await assert.rejects(approveCandidate(db, 'c2', a, deps), code('ZERO_ITEMS'));
  assert.equal(count(db, 'source'), 0);
  const r = await approveCandidate(db, 'c1', a, deps);
  assert.equal(r.source.url, `${srv.base}/ok`);
  assert.equal((db.prepare("SELECT status FROM source_candidate WHERE id='c1'").get() as { status: string }).status, 'approved');
  await assert.rejects(approveCandidate(db, 'c1', a, deps), code('CONFLICT'));

  await addSource(db, body('/ok', { region_id: 'r2' }), deps);
  assert.equal(listSources(db).sources.length, 2);
  assert.equal(listSources(db, { region_id: 'r1' }).sources.length, 1);
  assert.equal(listSources(db, { region_id: 'r2', state: 'active' }).sources.length, 1);
  assert.equal(listSources(db, { state: 'disabled' }).sources.length, 0);
  assert.throws(() => listSources(db, { state: 'bogus' }), code('INVALID_ARGUMENT'));
});
