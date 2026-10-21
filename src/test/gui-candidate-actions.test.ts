import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindCandidateActions } from '../gui/app.js';

function ui(fetchFn: any, reload = async () => {}) {
  const listeners = new Map<string, (ev: any) => Promise<void>>();
  const note = { textContent: '', classList: { toggle() {} } };
  const box = { checked: true, disabled: false, dataset: { id: 'c1' }, classList: { contains: (v: string) => v === 'approve' }, closest: () => row };
  const reject = { disabled: false };
  const row = { querySelectorAll: () => [box, reject], querySelector: () => note };
  const root = { message: { textContent: '' }, candidates: { addEventListener: (type: string, fn: any) => listeners.set(type, fn) } };
  bindCandidateActions(root, fetchFn, 'token', reload);
  return { root, box, reject, note, change: () => listeners.get('change')!({ target: box }) };
}

test('approval failure is visible beside the checkbox, resets it and permits a retry', async () => {
  let reloads = 0;
  const h = ui(async () => ({ json: async () => ({ error: { code: 'ZERO_ITEMS', message: 'dry run extracted 0 items' } }) }), async () => { reloads++; });
  await h.change();
  assert.equal(h.box.checked, false);
  assert.equal(h.box.disabled, false);
  assert.equal(h.reject.disabled, false);
  assert.match(h.note.textContent, /イベントを抽出できませんでした/);
  assert.equal(reloads, 0, 'failed row must stay visible instead of being replaced');
});

test('network rejection is caught and restores controls', async () => {
  const h = ui(async () => { throw new TypeError('Failed to fetch'); });
  await h.change();
  assert.equal(h.box.checked, false);
  assert.equal(h.box.disabled, false);
  assert.match(h.note.textContent, /通信に失敗.*再読み込み/);
});

test('approval disables both actions while pending; success reloads saved source state', async () => {
  let finish: (r: any) => void = () => {};
  let reloads = 0;
  const h = ui(() => new Promise((resolve) => { finish = resolve; }), async () => { reloads++; });
  const pending = h.change();
  assert.equal(h.box.disabled, true);
  assert.equal(h.reject.disabled, true);
  assert.match(h.note.textContent, /追加しています/);
  await h.change(); // duplicate event while disabled does not submit twice
  finish({ json: async () => ({ source: { id: 's1' } }) });
  await pending;
  assert.equal(reloads, 1);
  assert.match(h.root.message.textContent, /追加しました/);
});

test('a failed refresh after successful approval reports saved state instead of offering duplicate approval', async () => {
  const h = ui(async () => ({ json: async () => ({ source: { id: 's1' } }) }), async () => { throw new Error('offline'); });
  await h.change();
  assert.match(h.note.textContent, /保存済み.*再読み込み/);
  assert.equal(h.box.checked, true);
  assert.equal(h.box.disabled, true);
});
