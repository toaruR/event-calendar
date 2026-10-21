import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.ts';
import { defaultConfig } from '../src/config.ts';
import type { Clock } from '../src/clock.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { RobotsCache } from '../src/net/robots.ts';
import type { FetchStageDeps } from '../src/pipeline/fetch-stage.ts';
import { runJob } from '../src/pipeline/run-job.ts';
import { upsertRegion } from '../src/service/regions.ts';
import { issueApproval } from '../src/service/approvals.ts';
import { addSource } from '../src/service/sources.ts';
import type { SourceDeps } from '../src/service/sources.ts';
import { removeSource, rollbackSource, updateSource } from '../src/service/sources-mutate.ts';
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
});
after(async () => { await srv.close(); });

const spec1 = { kind: 'jsonld', region_policy: { mode: 'trust_source' } };

async function setup() {
  const db = openDb(':memory:');
  upsertRegion(db, 'r1', { name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷'] });
  const clock = new AutoClock();
  const net: FetchStageDeps = {
    clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: ['127.0.0.1'] },
  };
  const cfg = { ...config, ssrf_allowlist: ['127.0.0.1'] };
  const deps: SourceDeps = { net, config: cfg };
  const { source } = await addSource(db, {
    url: `${srv.base}/ok`, region_id: 'r1', terms_note: 'n', allow_redistribute: true, spec: spec1,
  }, deps);
  return { db, deps, clock, id: source.id };
}

test('F11: CONFLICT on stale expected_version; match -> +1 and old row kept in history', async () => {
  const { db, deps, id } = await setup();
  const spec2 = { kind: 'jsonld', region_policy: { mode: 'keyword', min_confidence: 0.5 } };
  await assert.rejects(updateSource(db, id, { expected_version: 5, spec: spec2 }, deps), code('CONFLICT'));
  const r = await updateSource(db, id, { expected_version: 1, spec: spec2 }, deps);
  assert.equal(r.spec_version, 2);
  assert.equal(r.source.spec_version, 2);
  const h = db.prepare('SELECT spec_version, spec_json FROM source_spec_history WHERE source_id = ? ORDER BY spec_version').all(id) as
    { spec_version: number; spec_json: string }[];
  assert.deepEqual(h.map((x) => Number(x.spec_version)), [1, 2]);
  assert.deepEqual(JSON.parse(h[0]!.spec_json), spec1);
  // stale version now conflicts
  await assert.rejects(updateSource(db, id, { expected_version: 1, spec: spec2 }, deps), code('CONFLICT'));
  await assert.rejects(updateSource(db, 'nope', { expected_version: 1 }, deps), code('NOT_FOUND'));
});

test('rollbackSource(version=1) restores spec_json of v1 as a new version', async () => {
  const { db, deps, id } = await setup();
  const spec2 = { kind: 'jsonld', region_policy: { mode: 'keyword', min_confidence: 0.5 } };
  await updateSource(db, id, { expected_version: 1, spec: spec2 }, deps);
  const r = rollbackSource(db, id, 1, deps);
  assert.equal(r.spec_version, 3);
  const row = db.prepare('SELECT spec_json, spec_version FROM source WHERE id = ?').get(id) as { spec_json: string; spec_version: number };
  assert.deepEqual(JSON.parse(row.spec_json), spec1);
  assert.equal(Number(row.spec_version), 3);
  assert.equal(count(db, 'source_spec_history'), 3);
  assert.throws(() => rollbackSource(db, id, 99, deps), code('NOT_FOUND'));
});

test('require_approval: render=browser needs a single-use enable_browser token; plain spec update needs none', async () => {
  const { db, deps, clock, id } = await setup();
  const browser = { kind: 'jsonld', fetch: { render: 'browser' }, region_policy: { mode: 'trust_source' } };
  await assert.rejects(updateSource(db, id, { expected_version: 1, spec: browser }, deps), code('APPROVAL_REQUIRED'));
  assert.equal(Number((db.prepare('SELECT spec_version FROM source WHERE id = ?').get(id) as any).spec_version), 1);
  const { approval_token: tok } = issueApproval(db, { action: 'enable_browser', source_id: id }, { clock });
  const ok = await updateSource(db, id, { expected_version: 1, spec: browser, approval_token: tok }, deps);
  assert.equal(ok.spec_version, 2);
  // same token again (browser -> none -> browser) is refused
  await updateSource(db, id, { expected_version: 2, spec: spec1 }, deps);
  await assert.rejects(updateSource(db, id, { expected_version: 3, spec: browser, approval_token: tok }, deps), code('APPROVAL_REQUIRED'));
  // wrong action token refused
  const { approval_token: rm } = issueApproval(db, { action: 'source_remove', source_id: id }, { clock });
  await assert.rejects(updateSource(db, id, { expected_version: 3, spec: browser, approval_token: rm }, deps), code('APPROVAL_REQUIRED'));
});

test('removeSource: APPROVAL_REQUIRED, dry_run reports events_affected, approved delete cascades refs', async () => {
  const { db, deps, clock, id } = await setup();
  const src = db.prepare('SELECT * FROM source WHERE id = ?').get(id) as any;
  const res = await runJob({ db, source: src, net: deps.net, now: new Date(clock.now()), config: deps.config! });
  assert.equal(res.outcome, 'ok');
  assert.equal(count(db, 'event'), 3);
  assert.equal(count(db, 'event_source_ref'), 3);

  assert.throws(() => removeSource(db, id, {}, deps), code('APPROVAL_REQUIRED'));
  assert.throws(() => removeSource(db, id, { approval_token: 'bogus' }, deps), code('APPROVAL_REQUIRED'));
  const d = removeSource(db, id, { dry_run: true }, deps);
  assert.deepEqual(d, { removed: false, events_affected: 3 });
  assert.equal(count(db, 'source'), 1);
  assert.equal(count(db, 'event_source_ref'), 3);

  const { approval_token: tok } = issueApproval(db, { action: 'source_remove', source_id: id }, { clock });
  const r = removeSource(db, id, { approval_token: tok }, deps);
  assert.deepEqual(r, { removed: true, events_affected: 3 });
  assert.equal(count(db, 'source'), 0);
  assert.equal(count(db, 'event_source_ref'), 0);
  assert.throws(() => removeSource(db, id, { dry_run: true }, deps), code('NOT_FOUND'));
});

test('interval_sec=899 -> INVALID_ARGUMENT; update to a 0-item spec -> ZERO_ITEMS (version unchanged)', async () => {
  const { db, deps, id } = await setup();
  await assert.rejects(updateSource(db, id, { expected_version: 1, interval_sec: 899 }, deps), code('INVALID_ARGUMENT'));
  const zero = { kind: 'ical', region_policy: { mode: 'trust_source' } };
  await assert.rejects(updateSource(db, id, { expected_version: 1, spec: zero }, deps), code('ZERO_ITEMS'));
  const row = db.prepare('SELECT spec_version, spec_json FROM source WHERE id = ?').get(id) as { spec_version: number; spec_json: string };
  assert.equal(Number(row.spec_version), 1);
  assert.deepEqual(JSON.parse(row.spec_json), spec1);
  const ok = await updateSource(db, id, { expected_version: 1, interval_sec: 1800, enabled: false }, deps);
  assert.equal(ok.source.interval_sec, 1800);
  assert.equal(ok.source.enabled, false);
  assert.equal(ok.source.state, 'disabled');
});

test('spec update / rollback clears etag and last_modified (next run re-extracts, no 304)', async () => {
  const { db, deps, id } = await setup();
  const setValidators = () => db.prepare("UPDATE source SET etag = '\"v1\"', last_modified = 'Thu, 01 Oct 2026 00:00:00 GMT' WHERE id = ?").run(id);
  const validators = () => db.prepare('SELECT etag, last_modified FROM source WHERE id = ?').get(id) as { etag: string | null; last_modified: string | null };
  setValidators();
  await updateSource(db, id, { expected_version: 1, trust: 0.7 }, deps);
  assert.equal(validators().etag, '"v1"'); // non-spec update keeps validators
  await updateSource(db, id, { expected_version: 2, spec: { kind: 'jsonld', region_policy: { mode: 'keyword', min_confidence: 0.5 } } }, deps);
  assert.deepEqual({ ...validators() }, { etag: null, last_modified: null });
  setValidators();
  rollbackSource(db, id, 1, deps);
  assert.deepEqual({ ...validators() }, { etag: null, last_modified: null });
});
