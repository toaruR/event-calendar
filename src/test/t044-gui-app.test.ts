import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from '../src/http/server.ts';
import { makeCore } from './t036-http-core.test.ts';
import { loadAll } from '../gui/app.js';

async function boot() {
  const h = createServer(makeCore(), { port: 0 });
  await h.start();
  const addr = h.server.address() as { port: number };
  return { h, base: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('GET / embeds current 64-hex gui_token; /gui/app.js is javascript', async () => {
  const { h, base } = await boot();
  try {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    const body = await r.text();
    const m = new RegExp('<meta name="gui-token" content="([0-9a-f]{64})"').exec(body);
    assert.ok(m);
    assert.equal(m[1], h.token);
    const js = await fetch(`${base}/gui/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
  } finally { await h.stop(); }
});

test('path traversal /gui/../package.json does not return package.json', async () => {
  const { h, port } = await boot();
  try {
    for (const p of ['/gui/../package.json', '/gui/%2e%2e/package.json', '/gui/..%2fpackage.json']) {
      const r = await rawGet(port, p);
      assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
      assert.ok(!r.body.includes('"type"'));
    }
  } finally { await h.stop(); }
});

test('gui/ files contain no http(s):// references', () => {
  const dir = new URL('../gui/', import.meta.url);
  const files = readdirSync(dir);
  assert.ok(files.includes('index.html') && files.includes('app.js') && files.includes('render.js'));
  let n = 0;
  for (const f of files) n += (readFileSync(new URL(f, dir), 'utf8').match(new RegExp('https?://', 'g')) ?? []).length;
  assert.equal(n, 0);
});

test('app.js calls /sources /events /health with X-GUI-Token; wrong token -> 400', async () => {
  const { h, base } = await boot();
  try {
    const calls: Array<{ path: string; token: string }> = [];
    const spy = (p: string, init: any) => {
      calls.push({ path: p, token: init.headers['X-GUI-Token'] });
      return fetch(base + p, init);
    };
    const el = () => ({ innerHTML: '' });
    const root = { health: el(), sources: el(), events: el() };
    await loadAll(spy, h.token, root, new Date('2026-10-01T00:00:00Z'));
    assert.deepEqual(calls.map((c) => c.path.split('?')[0]).sort(), ['/candidates', '/events', '/health', '/holidays', '/sources']);
    const evPath = calls.find((c) => c.path.startsWith('/events'))!.path;
    assert.match(evPath, /region_id=r1/);
    assert.match(evPath, /from=/);
    assert.match(evPath, /to=/);
    for (const c of calls) assert.equal(c.token, h.token);
    assert.ok(root.sources.innerHTML.includes('class="source"'));
    for (const p of ['/sources', '/events', '/health']) {
      const r = await fetch(base + p, { headers: { 'X-GUI-Token': 'wrong' } });
      assert.equal(r.status, 400);
      assert.equal(((await r.json()) as any).error.code, 'INVALID_ARGUMENT');
    }
  } finally { await h.stop(); }
});
