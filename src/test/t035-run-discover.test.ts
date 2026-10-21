import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.ts';
import { defaultConfig } from '../src/config.ts';
import type { Clock } from '../src/clock.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { RobotsCache } from '../src/net/robots.ts';
import type { FetchStageDeps } from '../src/pipeline/fetch-stage.ts';
import { upsertRegion } from '../src/service/regions.ts';
import { addSource } from '../src/service/sources.ts';
import type { SourceDeps } from '../src/service/sources.ts';
import { runNow } from '../src/service/run-now.ts';
import { discoverSources } from '../src/service/discover.ts';
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
let deny: MockServer;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.text('/ok', jsonld3);
  deny = await startMockServer();
  deny.text('/robots.txt', 'User-agent: *\nDisallow: /');
});
after(async () => { await srv.close(); await deny.close(); });

function setup() {
  const db = openDb(':memory:');
  upsertRegion(db, 'r1', { name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷'] });
  const clock = new AutoClock();
  const net: FetchStageDeps = {
    clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: ['127.0.0.1'] },
  };
  const deps: SourceDeps = { net, config: { ...config, ssrf_allowlist: ['127.0.0.1'] } };
  return { db, deps };
}

async function withSource() {
  const s = setup();
  const { source } = await addSource(s.db, {
    url: `${srv.base}/ok`, region_id: 'r1', terms_note: 'n', allow_redistribute: true,
    spec: { kind: 'jsonld', region_policy: { mode: 'trust_source' } },
  }, s.deps);
  return { ...s, id: source.id };
}

test('runNow: unknown -> NOT_FOUND; quarantined -> CONFLICT', async () => {
  const { db, deps, id } = await withSource();
  await assert.rejects(runNow(db, 'nope', deps), code('NOT_FOUND'));
  db.prepare("UPDATE source SET state = 'quarantined' WHERE id = ?").run(id);
  await assert.rejects(runNow(db, id, deps), code('CONFLICT'));
  assert.equal(count(db, 'run'), 0);
});

test('runNow: active source returns run, outcome matches, events increase', async () => {
  const { db, deps, id } = await withSource();
  assert.equal(count(db, 'event'), 0);
  const { run } = await runNow(db, id, deps);
  assert.equal(run.source_id, id);
  assert.equal(run.outcome, 'ok');
  assert.equal(run.items_found, 3);
  assert.equal(count(db, 'event'), 3);
  const row = db.prepare('SELECT outcome FROM run WHERE id = ?').get(run.id) as { outcome: string };
  assert.equal(row.outcome, run.outcome);
});

test('discoverSources: provider none -> INVALID_ARGUMENT; unknown region -> NOT_FOUND', async () => {
  const { db, deps } = setup();
  await assert.rejects(discoverSources(db, 'r1', {}, deps), code('INVALID_ARGUMENT'));
  await assert.rejects(discoverSources(db, 'r1', { provider: 'none' }, deps), code('INVALID_ARGUMENT'));
  await assert.rejects(discoverSources(db, 'zz', { provider: async () => [] }, deps), code('NOT_FOUND'));
  assert.equal(count(db, 'source_candidate'), 0);
});

test('discoverSources: stub provider -> proposed candidates with robots_allowed; limit honoured', async () => {
  const { db, deps } = setup();
  const provider = async () => [{ url: `${srv.base}/ok` }, { url: `${deny.base}/events.ics` }];
  const r = await discoverSources(db, 'r1', { provider }, deps);
  assert.equal(r.candidates.length, 2);
  const rows = db.prepare('SELECT url, status, robots_allowed, kind_guess FROM source_candidate ORDER BY url').all() as
    { url: string; status: string; robots_allowed: number; kind_guess: string }[];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === 'proposed'));
  assert.equal(Number(rows.find((x) => x.url.startsWith(deny.base))!.robots_allowed), 0);
  assert.equal(Number(rows.find((x) => x.url.startsWith(srv.base))!.robots_allowed), 1);
  assert.equal(r.candidates.find((c) => c.url.startsWith(deny.base))!.kind_guess, 'ical');
  assert.equal(deny.requestCount('/events.ics'), 0);

  const b = setup();
  const r1 = await discoverSources(b.db, 'r1', { provider, limit: 1 }, b.deps);
  assert.equal(r1.candidates.length, 1);
  assert.equal(count(b.db, 'source_candidate'), 1);
});
