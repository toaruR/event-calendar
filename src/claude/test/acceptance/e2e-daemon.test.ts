import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startMockServer } from '../helpers/mock-server.ts';
import type { MockServer } from '../helpers/mock-server.ts';
import { bootDaemon } from '../helpers/daemon-fixture.ts';

const jsonld3 = readFileSync(new URL('../fixtures/jsonld-3.html', import.meta.url), 'utf8');
const spec = { kind: 'jsonld', region_policy: { mode: 'trust_source' } };
const RANGE = 'region_id=r1&from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z';

let srv: MockServer;
let deny: MockServer;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.text('/ok', jsonld3);
  srv.text('/empty', '<html><body>nothing</body></html>');
  srv.redirect('/to-meta', 'http://169.254.169.254/latest/meta-data');
  deny = await startMockServer();
  deny.text('/robots.txt', 'User-agent: *\nDisallow: /');
  deny.text('/body', jsonld3);
});
after(async () => { await srv.close(); await deny.close(); });

const addBody = (url: string) => ({ url, region_id: 'r1', terms_note: 'n', allow_redistribute: true, spec });

test('§10-T1: source added to a running daemon (tick=1s, no restart) yields 3 events within 2s', async () => {
  const f = await bootDaemon({ tick: 1, ssrf_allowlist: ['127.0.0.1'] });
  try {
    const before0 = await f.call('GET', `/events?${RANGE}`);
    assert.equal(before0.body.count, 0);
    const port = f.d.port;
    const add = await f.call('POST', '/sources', addBody(`${srv.base}/ok`));
    assert.equal(add.status, 200);
    const t0 = Date.now();
    let count = 0;
    while (Date.now() - t0 < 2000 && count !== 3) {
      count = (await f.call('GET', `/events?${RANGE}`)).body.count;
      if (count !== 3) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(count, 3);
    assert.ok(Date.now() - t0 <= 2500);
    assert.equal(f.d.port, port, 'same daemon instance (no restart)');
  } finally { await f.stop(); }
});

test('§10-T2: zero-item spec POST /sources -> 422 and GET /sources count unchanged', async () => {
  const f = await bootDaemon({ tick: 1, ssrf_allowlist: ['127.0.0.1'] });
  try {
    const n0 = (await f.call('GET', '/sources')).body.sources.length;
    const z = await f.call('POST', '/sources', addBody(`${srv.base}/empty`));
    assert.equal(z.status, 422);
    assert.equal((await f.call('GET', '/sources')).body.sources.length, n0);
  } finally { await f.stop(); }
});

test('§10-T3: robots Disallow -> POST /sources 403 ROBOTS_DISALLOWED, body never fetched', async () => {
  const f = await bootDaemon({ tick: 1, ssrf_allowlist: ['127.0.0.1'] });
  try {
    const r = await f.call('POST', '/sources', addBody(`${deny.base}/body`));
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'ROBOTS_DISALLOWED');
    assert.equal(deny.requestCount('/body'), 0);
    assert.equal((await f.call('GET', '/sources')).body.sources.length, 0);
  } finally { await f.stop(); }
});

test('§10-T4: POST /sources:test to 127.0.0.1 and to a 302 -> 169.254.169.254 are both 403 SSRF_BLOCKED', async () => {
  // loopback blocked: default (empty) allowlist
  const a = await bootDaemon({ tick: 1 });
  try {
    const r = await a.call('POST', '/sources:test', { url: 'http://127.0.0.1/', spec });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'SSRF_BLOCKED');
  } finally { await a.stop(); }
  // mock host allowlisted so the first hop is reachable; the redirect target must still be blocked
  const b = await bootDaemon({ tick: 1, ssrf_allowlist: ['127.0.0.1'] });
  try {
    const r = await b.call('POST', '/sources:test', { url: `${srv.base}/to-meta`, spec });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'SSRF_BLOCKED');
    assert.ok(srv.requestCount('/to-meta') >= 1, 'redirect hop was actually served');
  } finally { await b.stop(); }
});
