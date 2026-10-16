// GUI app: same-origin calls to the HTTP API with X-GUI-Token, rendered via render.js.
import { renderSources, renderHealth, renderMonth } from './render.js';

export function readToken(doc) {
  const m = doc.querySelector('meta[name="gui-token"]');
  return m ? m.getAttribute('content') || '' : '';
}

export async function api(fetchFn, token, method, path, body) {
  const init = { method, headers: { 'X-GUI-Token': token } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetchFn(path, init);
  return res.json();
}

// Spec update: PATCH with expected_version (optimistic concurrency).
export function patchSpec(fetchFn, token, id, spec, expectedVersion) {
  return api(fetchFn, token, 'PATCH', `/sources/${encodeURIComponent(id)}`, {
    spec,
    expected_version: expectedVersion,
  });
}

export async function loadAll(fetchFn, token, root, now = new Date()) {
  const [src, ev, health] = await Promise.all([
    api(fetchFn, token, 'GET', '/sources'),
    api(fetchFn, token, 'GET', '/events'),
    api(fetchFn, token, 'GET', '/health'),
  ]);
  const sources = src.sources || [];
  const events = ev.events || [];
  const byId = new Map((health.sources || []).map((h) => [h.id, h]));
  const merged = sources.map((s) => ({ ...s, ...(byId.get(s.id) || {}), name: s.name ?? s.id }));
  root.health.innerHTML = renderHealth(merged);
  root.sources.innerHTML = renderSources(sources);
  root.events.innerHTML = renderMonth(now.getUTCFullYear(), now.getUTCMonth() + 1, events);
  return { sources, events, health: health.sources || [] };
}

if (typeof document !== 'undefined') {
  const root = {
    health: document.getElementById('health'),
    sources: document.getElementById('sources'),
    events: document.getElementById('events'),
  };
  loadAll((p, i) => fetch(p, i), readToken(document), root);
}
