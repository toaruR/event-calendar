import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig, loadConfigFile } from '../src/config.ts';
import { parseDaemonArgs } from '../src/daemon.ts';
import { serveStatic } from '../src/http/static.ts';
import { AppError } from '../src/errors.ts';

const dir = mkdtempSync(join(tmpdir(), 'ec-ws-'));
const file = (name: string, body: unknown): string => {
  const p = join(dir, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
};

test('week_start defaults to sunday', () => {
  assert.equal(defaultConfig().week_start, 'sunday');
});

test('loadConfigFile accepts monday, rejects other values', () => {
  assert.equal(loadConfigFile(file('m.json', { week_start: 'monday' })).week_start, 'monday');
  assert.throws(() => loadConfigFile(file('bad.json', { week_start: 'tuesday' })),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_ARGUMENT');
});

test('daemon --config loads file; invalid file throws INVALID_ARGUMENT', () => {
  const o = parseDaemonArgs(['--port', '0', '--config', file('d.json', { week_start: 'monday' })]);
  assert.equal(o.config?.week_start, 'monday');
  assert.equal(o.port, 0);
  assert.throws(() => parseDaemonArgs(['--config', join(dir, 'missing.json')]),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_ARGUMENT');
});

test('index.html embeds week-start meta (monday / default sunday)', () => {
  const tok = 'a'.repeat(64);
  assert.ok(String(serveStatic('/', tok, { weekStart: 'monday' }).raw).includes('<meta name="week-start" content="monday">'));
  assert.ok(String(serveStatic('/', tok).raw).includes('<meta name="week-start" content="sunday">'));
  assert.ok(String(serveStatic('/', tok, { weekStart: '"><script>' }).raw).includes('<meta name="week-start" content="sunday">'));
});
