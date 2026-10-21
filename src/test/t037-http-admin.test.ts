import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startMockServer } from './helpers/mock-server.ts';
import type { MockServer } from './helpers/mock-server.ts';
import { bootHttp } from './helpers/http-helpers.ts';

const jsonld3 = readFileSync(new URL('./fixtures/jsonld-3.html', import.meta.url), 'utf8');
let srv: MockServer;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.text('/ok', jsonld3);
  srv.text('/empty', '<html><body>nothing</body></html>');
});
after(async () => { await srv.close(); });

const spec = { kind: 'jsonld', region_policy: { mode: 'trust_source' } };

function addCandidate(db: any, id: string, url: string) {
  db.prepare("INSERT INTO source_candidate(id,region_id,url,kind_guess,robots_allowed,spec_guess_json,status,found_at) VALUES(?,?,?,?,?,NULL,'proposed',?)")
    .run(id, 'r1', url, 'html', 1, new Date().toISOString());
}

test('PUT /regions/{id}: 200 {region}; bad tz -> 400', async () => {
  const s = await bootHttp();
  try {
    const ok = await s.call('PUT', '/regions/r2', { name: '渋谷', tz: 'Asia/Tokyo', keywords: ['渋谷'] });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.region.id, 'r2');
    assert.equal(ok.body.region.tz, 'Asia/Tokyo');
    const bad = await s.call('PUT', '/regions/r3', { name: 'x', tz: 'Not/AZone', keywords: [] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_ARGUMENT');
  } finally { await s.stop(); }
});

test('POST /approvals: 200 token; unknown source -> 404', async () => {
  const s = await bootHttp();
  try {
    s.db.prepare('INSERT INTO source(id,region_id,url,kind,spec_json,terms_note,allow_redistribute) VALUES(?,?,?,?,?,?,?)')
      .run('s1', 'r1', `${srv.base}/ok`, 'jsonld', JSON.stringify(spec), 'n', 1);
    const sid = 's1';
    const ok = await s.call('POST', '/approvals', { action: 'source_remove', source_id: sid });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body).sort(), ['approval_token', 'expires_at']);
    const nf = await s.call('POST', '/approvals', { action: 'source_remove', source_id: 'nope' });
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, 'NOT_FOUND');
  } finally { await s.stop(); }
});

test('POST /candidates/{id}/approve: 200 {source}; missing 404; zero items 422', async () => {
  const s = await bootHttp();
  try {
    addCandidate(s.db, 'c1', `${srv.base}/ok`);
    addCandidate(s.db, 'c2', `${srv.base}/empty`);
    const body = { terms_note: 'n', allow_redistribute: true, spec };
    const ok = await s.call('POST', '/candidates/c1/approve', body);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.source.url, `${srv.base}/ok`);
    const nf = await s.call('POST', '/candidates/nope/approve', body);
    assert.equal(nf.status, 404);
    const z = await s.call('POST', '/candidates/c2/approve', body);
    assert.equal(z.status, 422);
    assert.equal(z.body.error.code, 'ZERO_ITEMS');
  } finally { await s.stop(); }
});

test('POST /regions/{id}/discover: none -> 400; stub provider -> 200 candidates with 5 keys', async () => {
  const none = await bootHttp();
  try {
    const r = await none.call('POST', '/regions/r1/discover', {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_ARGUMENT');
  } finally { await none.stop(); }
  const s = await bootHttp(async () => [{ url: `${srv.base}/ok` }]);
  try {
    const r = await s.call('POST', '/regions/r1/discover', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.candidates.length, 1);
    assert.deepEqual(Object.keys(r.body.candidates[0]).sort(), ['id', 'kind_guess', 'robots_allowed', 'status', 'url']);
    assert.equal((await s.call('POST', '/regions/zz/discover', {})).status, 404);
  } finally { await s.stop(); }
});

