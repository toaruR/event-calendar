import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startMockServer } from './helpers/mock-server.ts';
import type { MockServer } from './helpers/mock-server.ts';
import { bootHttp } from './helpers/http-helpers.ts';

const jsonld3 = readFileSync(new URL('./fixtures/jsonld-3.html', import.meta.url), 'utf8');
let srv: MockServer;
let deny: MockServer;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.text('/ok', jsonld3);
  srv.text('/empty', '<html><body>nothing</body></html>');
  deny = await startMockServer();
  deny.text('/robots.txt', 'User-agent: *\nDisallow: /');
});
after(async () => { await srv.close(); await deny.close(); });

const spec = { kind: 'jsonld', region_policy: { mode: 'trust_source' } };
const addBody = (path = '/ok') => ({ url: `${srv.base}${path}`, region_id: 'r1', terms_note: 'n', allow_redistribute: true, spec });

test('POST /sources:test: 5 keys; SSRF 403; robots 403', async () => {
  const s = await bootHttp();
  try {
    const ok = await s.call('POST', '/sources:test', { url: `${srv.base}/ok`, spec });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body).sort(), ['item_count', 'ok', 'robots_allowed', 'samples', 'warnings']);
    assert.equal(ok.body.item_count, 3);
    const ssrf = await s.call('POST', '/sources:test', { url: 'http://169.254.169.254/latest', spec });
    assert.equal(ssrf.status, 403);
    assert.equal(ssrf.body.error.code, 'SSRF_BLOCKED');
    const rb = await s.call('POST', '/sources:test', { url: `${deny.base}/x`, spec });
    assert.equal(rb.status, 403);
    assert.equal(rb.body.error.code, 'ROBOTS_DISALLOWED');
  } finally { await s.stop(); }
});

test('POST /sources: 200 {source,samples}; zero items 422; unknown region 404; interval 899 -> 400', async () => {
  const s = await bootHttp();
  try {
    const ok = await s.call('POST', '/sources', addBody());
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body).sort(), ['samples', 'source']);
    assert.equal(ok.body.source.region_id, 'r1');
    const z = await s.call('POST', '/sources', addBody('/empty'));
    assert.equal(z.status, 422);
    assert.equal(z.body.error.code, 'ZERO_ITEMS');
    const nf = await s.call('POST', '/sources', { ...addBody(), region_id: 'zz' });
    assert.equal(nf.status, 404);
    const iv = await s.call('POST', '/sources', { ...addBody(), interval_sec: 899 });
    assert.equal(iv.status, 400);
    assert.equal(iv.body.error.code, 'INVALID_ARGUMENT');
    const list = await s.call('GET', '/sources');
    assert.equal(list.body.sources.length, 1);
  } finally { await s.stop(); }
});

test('PATCH /sources/{id}: 200; version mismatch 409; browser needs approval 403', async () => {
  const s = await bootHttp();
  try {
    const id = (await s.call('POST', '/sources', addBody())).body.source.id;
    const ok = await s.call('PATCH', `/sources/${id}`, { expected_version: 1, interval_sec: 1800 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.spec_version, 2);
    assert.equal(ok.body.source.interval_sec, 1800);
    const cf = await s.call('PATCH', `/sources/${id}`, { expected_version: 1, interval_sec: 1900 });
    assert.equal(cf.status, 409);
    assert.equal(cf.body.error.code, 'CONFLICT');
    const br = await s.call('PATCH', `/sources/${id}`, {
      expected_version: 2, spec: { ...spec, fetch: { render: 'browser' } },
    });
    assert.equal(br.status, 403);
    assert.equal(br.body.error.code, 'APPROVAL_REQUIRED');
    assert.equal((await s.call('PATCH', '/sources/nope', { expected_version: 1 })).status, 404);
  } finally { await s.stop(); }
});

test('DELETE /sources/{id}: 403 without approval; 200 with token', async () => {
  const s = await bootHttp();
  try {
    const id = (await s.call('POST', '/sources', addBody())).body.source.id;
    const no = await s.call('DELETE', `/sources/${id}`);
    assert.equal(no.status, 403);
    assert.equal(no.body.error.code, 'APPROVAL_REQUIRED');
    const tok = (await s.call('POST', '/approvals', { action: 'source_remove', source_id: id })).body.approval_token;
    const ok = await s.call('DELETE', `/sources/${id}`, { approval_token: tok });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body).sort(), ['events_affected', 'removed']);
    assert.equal(ok.body.removed, true);
    assert.equal((await s.call('GET', '/sources')).body.sources.length, 0);
  } finally { await s.stop(); }
});

test('POST /sources/{id}/run: 200 {run}; unknown 404; quarantined 409', async () => {
  const s = await bootHttp();
  try {
    const id = (await s.call('POST', '/sources', addBody())).body.source.id;
    const ok = await s.call('POST', `/sources/${id}/run`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.run.source_id, id);
    assert.equal(ok.body.run.items_found, 3);
    assert.equal((await s.call('POST', '/sources/nope/run')).status, 404);
    s.db.prepare("UPDATE source SET state = 'quarantined' WHERE id = ?").run(id);
    const q = await s.call('POST', `/sources/${id}/run`);
    assert.equal(q.status, 409);
    assert.equal(q.body.error.code, 'CONFLICT');
  } finally { await s.stop(); }
});
