import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { createServer } from '../src/http/server.ts';
import { makeCore } from './t036-http-core.test.ts';
import { renderHealth } from '../gui/render.js';
import { patchEnabled } from '../gui/app.js';

test('renderHealth: enabled checkbox reflects enabled and carries id/version', () => {
  const $ = cheerio.load(renderHealth([
    { id: 's1', state: 'active', enabled: true, spec_version: 2 },
    { id: 's2', state: 'disabled', enabled: false, spec_version: 5 },
  ]));
  const boxes = $('input.enabled');
  assert.equal(boxes.length, 2);
  assert.equal($(boxes[0]).attr('checked'), 'checked');
  assert.equal($(boxes[1]).attr('checked'), undefined);
  assert.equal($(boxes[1]).attr('data-id'), 's2');
  assert.equal($(boxes[1]).attr('data-version'), '5');
});

test('patchEnabled toggles source off/on via PATCH with X-GUI-Token; stale version -> CONFLICT', async () => {
  const h = createServer(makeCore(), { port: 0 });
  await h.start();
  const base = `http://127.0.0.1:${(h.server.address() as { port: number }).port}`;
  const f = (p: string, init: RequestInit) => fetch(base + p, init);
  try {
    const off = await patchEnabled(f, h.token, 's1', false, 1);
    assert.equal(off.source.enabled, false);
    assert.equal(off.source.state, 'disabled');
    const on = await patchEnabled(f, h.token, 's1', true, off.spec_version);
    assert.equal(on.source.enabled, true);
    assert.equal(on.source.state, 'active');
    const stale = await patchEnabled(f, h.token, 's1', false, 1);
    assert.equal(stale.error.code, 'CONFLICT');
  } finally { await h.stop(); }
});
