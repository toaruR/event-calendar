import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertUrlAllowed } from '../src/net/ssrf.ts';
import { startMockServer } from './helpers/mock-server.ts';

const rejects = (p: Promise<unknown>) => assert.rejects(p, (e: any) => e.code === 'SSRF_BLOCKED');
const resolveTo = (ip: string) => async () => [ip];

test('F4 scheme: file and ftp blocked', async () => {
  await rejects(assertUrlAllowed('file:///etc/passwd', { resolve: resolveTo('93.184.216.34') }));
  await rejects(assertUrlAllowed('ftp://x', { resolve: resolveTo('93.184.216.34') }));
});

for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '::1', 'fe80::1']) {
  test(`resolved ${ip} blocked`, async () => {
    await rejects(assertUrlAllowed('http://example.test/', { resolve: resolveTo(ip) }));
  });
}

test('literal private IP blocked without resolve', async () => {
  await rejects(assertUrlAllowed('http://127.0.0.1/'));
  await rejects(assertUrlAllowed('http://[::1]/'));
});

test('public passes; allowlist permits private', async () => {
  const u = await assertUrlAllowed('http://example.test/', { resolve: resolveTo('93.184.216.34') });
  assert.equal(u.hostname, 'example.test');
  await rejects(assertUrlAllowed('http://intra.example/', { resolve: resolveTo('10.0.0.1') }));
  await assertUrlAllowed('http://intra.example/', { resolve: resolveTo('10.0.0.1'), allowlist: ['intra.example'] });
});

test('mock server requestCount', async () => {
  const s = await startMockServer();
  try {
    s.text('/a', 'hi');
    assert.equal(s.requestCount(), 0);
    const r = await fetch(`${s.base}/a`);
    await r.text();
    assert.equal(s.requestCount(), 1);
  } finally { await s.close(); }
});
