import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Static module-load check (no tsc/eslint available): every source module must parse and evaluate its imports.
// src/daemon.ts is excluded: it is a bin entry that starts a server.
const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const files = globSync('src/' + '**/*.ts', { cwd: ROOT })
  .map((f) => f.split(String.fromCharCode(92)).join('/'))
  .filter((f) => f !== 'src/daemon.ts')
  .sort();

test('modules-load: src/**/*.ts discovered (count > 0)', () => {
  assert.ok(files.length > 0, 'no source files found');
  assert.ok(files.includes('src/config.ts'));
  assert.ok(files.includes('src/net/ssrf.ts'));
});

for (const f of files) {
  test(`modules-load: ${f}`, async () => {
    const mod = await import(pathToFileURL(resolve(ROOT, f)).href);
    assert.equal(typeof mod, 'object', relative(ROOT, f));
  });
}

test('modules-load: daemon.ts is the only excluded module and exists', () => {
  assert.equal(globSync('src/daemon.ts', { cwd: ROOT }).length, 1);
});
