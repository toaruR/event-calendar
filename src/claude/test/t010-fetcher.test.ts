import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSafe } from '../src/net/fetcher.ts';
import { startMockServer } from './helpers/mock-server.ts';

const blocked = (e: any) => e.code === 'SSRF_BLOCKED';
const allow = { ssrf_allowlist: ['127.0.0.1'] };

test('§10-T4 SSRF: direct private and redirect to metadata blocked, no external reach', async () => {
  const s = await startMockServer();
  try {
    s.text('/x', 'hi');
    s.redirect('/meta', 'http://169.254.169.254/latest/meta-data');
    await assert.rejects(fetchSafe(`${s.base}/x`), blocked);
    assert.equal(s.requestCount(), 0);
    await assert.rejects(fetchSafe(`${s.base}/meta`, { config: allow }), blocked);
    assert.equal(s.requestCount('/meta'), 1); // only the allowlisted mock itself; metadata host never contacted
    // redirect to a second, non-allowlisted mock (hostname localhost): blocked and never reached
    const t = await startMockServer();
    try {
      t.text('/z', 'z');
      s.redirect('/toother', `http://localhost:${new URL(t.base).port}/z`);
      await assert.rejects(fetchSafe(`${s.base}/toother`, { config: allow }), blocked);
      assert.equal(t.requestCount(), 0);
    } finally { await t.close(); }
  } finally { await s.close(); }
});

test('§10-T25 redirect limit', async () => {
  const s = await startMockServer();
  try {
    for (let i = 0; i < 8; i++) s.redirect(`/r${i}`, `/r${i + 1}`);
    s.text('/r8', 'end');
    const r = await fetchSafe(`${s.base}/r0`, { config: allow });
    assert.equal(r.outcomeHint, 'failed');
    assert.ok(r.redirects <= 5);
    assert.equal(s.requestCount('/r6'), 0);
  } finally { await s.close(); }
});

test('body_max truncates mid-stream', async () => {
  const s = await startMockServer();
  try {
    const chunk = Buffer.alloc(65536, 0x61);
    s.route('/big', async (_q, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain'); res.setMaxListeners(0);
      for (let i = 0; i < 96; i++) { // 6MB
        if (res.destroyed) return;
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r).once('close', r));
      }
      res.end();
    });
    const r = await fetchSafe(`${s.base}/big`, { config: allow });
    assert.equal(r.truncated, true);
    assert.ok(r.bytes >= 5242880 && r.bytes <= 5242880 + 65536, `bytes ${r.bytes}`);
  } finally { await s.close(); }
});

test('§10-T24 conditional GET 304 -> not_modified', async () => {
  const s = await startMockServer();
  try {
    s.route('/c', (q, res) => {
      if (q.headers['if-none-match'] === '"v1"' && q.headers['if-modified-since']) { res.statusCode = 304; res.end(); return; }
      res.end('x');
    });
    const r = await fetchSafe(`${s.base}/c`, {
      conditional: { etag: '"v1"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' },
      config: allow,
    });
    assert.equal(r.status, 304);
    assert.equal(r.outcomeHint, 'not_modified');
  } finally { await s.close(); }
});

test('User-Agent contains contact_url', async () => {
  const s = await startMockServer();
  try {
    s.text('/ua', 'ok');
    const r = await fetchSafe(`${s.base}/ua`, { config: allow });
    assert.equal(r.outcomeHint, 'ok');
    assert.ok(String(s.lastHeaders('/ua')?.['user-agent']).includes('http://127.0.0.1:8787/about'));
  } finally { await s.close(); }
});

test('captcha page aborts with login_or_captcha', async () => {
  const s = await startMockServer();
  try {
    s.text('/cap', readFileSync(new URL('./fixtures/captcha.html', import.meta.url), 'utf8'));
    const r = await fetchSafe(`${s.base}/cap`, { config: allow });
    assert.equal(r.outcomeHint, 'login_or_captcha');
    assert.equal(r.body, '');
  } finally { await s.close(); }
});
