import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../../src/cli/main.ts';
import { TOOL_NAMES } from '../../src/cli/client.ts';
import { isStaticPath } from '../../src/http/static.ts';
import { bootHttp } from '../helpers/http-helpers.ts';

type Boot = Awaited<ReturnType<typeof bootHttp>>;
let s: Boot;
let base = '';
before(async () => {
  s = await bootHttp();
  base = `http://127.0.0.1:${(s.h.server.address() as { port: number }).port}`;
});
after(async () => { await s.stop(); });

// Design section 5.4: the 13 API routes + candidate list/reject for the GUI (method + path pattern as registered in the router)
const SECTION_5_4: string[] = [
  'PUT /regions/{id}',
  'POST /regions/{id}/discover',
  'POST /sources:test',
  'POST /sources',
  'GET /sources',
  'PATCH /sources/{id}',
  'DELETE /sources/{id}',
  'POST /sources/{id}/run',
  'POST /candidates/{id}/approve',
  'GET /candidates',
  'POST /candidates/{id}/reject',
  'POST /approvals',
  'GET /events',
  'GET /calendar/{file}',
  'GET /health',
];

test('out-of-scope: server routes == 15 (section-5.4 + candidates) routes + static (GET /, GET /gui/*), no extras', async () => {
  const actual = s.h.router.routes.map((r) => `${r.method} /${r.segs.join('/')}`);
  assert.equal(new Set(actual).size, actual.length, 'no duplicate routes');
  assert.deepEqual([...actual].sort(), [...SECTION_5_4].sort());
  assert.equal(actual.length, 15);

  // static delivery is handled outside the router: exactly "/" and "/gui/*"
  assert.equal(isStaticPath('/'), true);
  assert.equal(isStaticPath('/gui/app.js'), true);
  for (const p of ['/gui', '/guix', '/index.html', '/health', '/tickets']) assert.equal(isStaticPath(p), false, p);

  const full = [...actual, 'GET /', 'GET /gui/*'].sort();
  assert.deepEqual(full, [...SECTION_5_4, 'GET /', 'GET /gui/*'].sort());
  assert.equal(full.length, 17);

  // and the static routes really are served: GET / and an existing GUI file
  const guiDir = fileURLToPath(new URL('../../gui/', import.meta.url));
  const files = readdirSync(guiDir).filter((f) => f.endsWith('.js') || f.endsWith('.css') || f.endsWith('.html'));
  assert.ok(files.length > 0);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/gui/${files[0]}`)).status, 200);
});

test('out-of-scope: /tickets /mcp /login /recommendations /users -> 404 NOT_FOUND for every method', async () => {
  for (const p of ['/tickets', '/mcp', '/login', '/recommendations', '/users']) {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await s.call(m, p, m === 'GET' ? undefined : {});
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(r.body.error.code, 'NOT_FOUND', `${m} ${p}`);
    }
  }
});

test('out-of-scope: `ec ticket` / `ec mcp` / `ec recommend` -> exit 2 INVALID_ARGUMENT', async () => {
  for (const cmd of ['ticket', 'mcp', 'recommend']) {
    assert.ok(!TOOL_NAMES.includes(cmd), cmd);
    let out = '';
    const code = await main([cmd], { out: (t) => { out += t; }, err: () => {} });
    assert.equal(code, 2, cmd);
    assert.equal(JSON.parse(out).error.code, 'INVALID_ARGUMENT', cmd);
  }
});
