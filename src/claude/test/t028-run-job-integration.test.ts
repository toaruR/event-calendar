import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runJob } from '../src/pipeline/run-job.ts';
import type { SourceRow } from '../src/pipeline/run-job.ts';
import type { FetchStageDeps } from '../src/pipeline/fetch-stage.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { RobotsCache } from '../src/net/robots.ts';
import { defaultConfig } from '../src/config.ts';
import type { Clock } from '../src/clock.ts';
import { enqueue, getJob } from '../src/jobs/queue.ts';
import { getSourceState } from '../src/jobs/source-state.ts';
import { startMockServer } from './helpers/mock-server.ts';
import type { MockServer } from './helpers/mock-server.ts';
import { count, setupDb } from './helpers/run-helpers.ts';

const config = defaultConfig();
const captcha = readFileSync(new URL('./fixtures/captcha.html', import.meta.url), 'utf8');
const jsonld3 = readFileSync(new URL('./fixtures/jsonld-3.html', import.meta.url), 'utf8');

class AutoClock implements Clock {
  t = 1_000_000;
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

let srv: MockServer;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
});
after(async () => { await srv.close(); });

function mk(path: string, kind = 'jsonld', specObj: object = { region_policy: { mode: 'trust_source' } }) {
  const { db, sources } = setupDb();
  const spec = JSON.stringify({ kind, ...specObj });
  const url = `${srv.base}${path}`;
  db.prepare('UPDATE source SET url = ?, kind = ?, spec_json = ? WHERE id = ?').run(url, kind, spec, 's1');
  const source: SourceRow = { ...sources[0]!, url, kind, spec_json: spec };
  const clock = new AutoClock();
  const net: FetchStageDeps = {
    clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: ['127.0.0.1'] },
  };
  return { db, source, net };
}
const now = new Date('2026-10-01T00:00:00Z');
const run = (a: ReturnType<typeof mk>, jobId?: string) => runJob({ db: a.db, source: a.source, net: a.net, now, config, ...(jobId ? { jobId } : {}) });
const lastRun = (db: ReturnType<typeof mk>['db']) =>
  db.prepare('SELECT outcome, finished_at FROM run ORDER BY rowid DESC LIMIT 1').get() as { outcome: string; finished_at: string | null };

test('robots Disallow -> quarantined + blocked_robots', async () => {
  const gsrv = await startMockServer();
  try {
    gsrv.text('/robots.txt', 'User-agent: *\nDisallow: /');
    gsrv.text('/e', jsonld3);
    const a = mk('/e');
    const url = `${gsrv.base}/e`;
    a.db.prepare('UPDATE source SET url = ? WHERE id = ?').run(url, 's1');
    const r = await run({ ...a, source: { ...a.source, url } });
    assert.equal(r.outcome, 'blocked_robots');
    assert.equal(lastRun(a.db).outcome, 'blocked_robots');
    assert.equal(getSourceState(a.db, 's1').state, 'quarantined');
  } finally { await gsrv.close(); }
});

test('captcha body -> quarantined', async () => {
  srv.text('/cap', captcha);
  const a = mk('/cap');
  const r = await run(a);
  assert.equal(r.outcome, 'login_or_captcha');
  assert.equal(getSourceState(a.db, 's1').state, 'quarantined');
});

test('hot reload: job keeps spec snapshot (.t1) although source spec changes to .t2', async () => {
  srv.text('/hot', '<ul><li class="ev"><span class="t1">タイトルONE世田谷</span><span class="t2">タイトルTWO</span><time>2026-11-03T10:00:00+09:00</time></li></ul>');
  const mkSpec = (sel: string) => ({
    region_policy: { mode: 'trust_source' },
    extract: { item_selector: 'li.ev', fields: { title: { css: sel }, date: { css: 'time' } } },
  });
  const a = mk('/hot', 'html', mkSpec('.t1'));
  const clock = new AutoClock();
  const jobId = enqueue(a.db, 's1', clock);
  const snap = getJob(a.db, jobId)!.spec_snapshot_json;
  assert.ok(snap!.includes('.t1'));
  const t2 = JSON.stringify({ kind: 'html', ...mkSpec('.t2') });
  a.db.prepare('UPDATE source SET spec_json = ? WHERE id = ?').run(t2, 's1');
  const r = await run({ ...a, source: { ...a.source, spec_json: t2 } }, jobId);
  assert.equal(r.outcome, 'ok');
  const t = a.db.prepare('SELECT title FROM event').all() as { title: string }[];
  assert.deepEqual(t.map((x) => x.title), ['タイトルONE世田谷']);
  assert.equal(getJob(a.db, jobId)!.spec_snapshot_json, snap);
  assert.ok(!getJob(a.db, jobId)!.spec_snapshot_json!.includes('.t2'));
});

test('500 x3 -> degraded (failures 3); then success -> active (failures 0)', async () => {
  let ok = false;
  srv.route('/flaky', (_q, res) => {
    if (!ok) { res.statusCode = 500; res.end('err'); return; }
    res.statusCode = 200; res.end(jsonld3);
  });
  const a = mk('/flaky');
  for (let i = 0; i < 3; i++) assert.equal((await run(a)).outcome, 'failed');
  const s = getSourceState(a.db, 's1');
  assert.equal(s.state, 'degraded');
  assert.equal(s.consecutive_failures, 3);
  ok = true;
  assert.equal((await run(a)).outcome, 'ok');
  const s2 = getSourceState(a.db, 's1');
  assert.equal(s2.state, 'active');
  assert.equal(s2.consecutive_failures, 0);
});

test('orchestrator: rss 2 items -> 2 events; jsonld-3 -> 3 events; run row per call with finished_at', async () => {
  const item = (n: string) => `<item><title>世田谷 ${n}</title><link>http://x.test/${n}</link><guid>${n}</guid><pubDate>2026-11-03T10:00:00+09:00</pubDate></item>`;
  srv.route('/feed', (_q, res) => { res.statusCode = 200; res.setHeader('content-type', 'application/rss+xml'); res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${item('a')}${item('b')}</channel></rss>`); });
  const a = mk('/feed', 'rss');
  const r0 = count(a.db, 'run');
  assert.equal((await run(a)).outcome, 'ok');
  assert.equal(count(a.db, 'event'), 2);
  assert.equal(count(a.db, 'run'), r0 + 1);
  assert.ok(lastRun(a.db).finished_at);

  srv.text('/ld', jsonld3);
  const b = mk('/ld');
  assert.equal((await run(b)).outcome, 'ok');
  assert.equal(count(b.db, 'event'), 3);
  assert.equal(count(b.db, 'run'), 1);
  assert.ok(lastRun(b.db).finished_at);
});
