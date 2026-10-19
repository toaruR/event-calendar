// GUI app: same-origin calls to the HTTP API with X-GUI-Token, rendered via render.js.
import { esc, renderSources, renderHealth, renderCandidates, renderMonth, renderEventList } from './render.js';

export function readToken(doc) {
  const m = doc.querySelector('meta[name="gui-token"]');
  return m ? m.getAttribute('content') || '' : '';
}

// 'monday' | 'sunday' from the server-embedded <meta name="week-start"> (config week_start).
export function readWeekStart(doc) {
  const m = doc.querySelector('meta[name="week-start"]');
  return m && m.getAttribute('content') === 'monday' ? 'monday' : 'sunday';
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

// Enable/disable toggle: PATCH enabled with expected_version (bumps spec_version).
export function patchEnabled(fetchFn, token, id, enabled, expectedVersion) {
  return api(fetchFn, token, 'PATCH', `/sources/${encodeURIComponent(id)}`, {
    enabled,
    expected_version: expectedVersion,
  });
}

// Candidate approval from the GUI: no redistribution (excluded from ICS export).
export function approveCandidate(fetchFn, token, id) {
  return api(fetchFn, token, 'POST', `/candidates/${encodeURIComponent(id)}/approve`, {
    terms_note: 'GUIで承認',
    allow_redistribute: false,
  });
}

export function rejectCandidate(fetchFn, token, id) {
  return api(fetchFn, token, 'POST', `/candidates/${encodeURIComponent(id)}/reject`, {});
}

// Query window for a month: one day of slack on each side covers tz offsets.
export function monthRange(year, month) {
  const from = new Date(Date.UTC(year, month - 1, 1) - 86400000).toISOString();
  const to = new Date(Date.UTC(year, month, 1) + 86400000).toISOString();
  return { from, to };
}

export function regionsOf(sources) {
  return [...new Set((sources || []).map((s) => s.region_id).filter(Boolean))].sort();
}

// view: { year, month, region, weekStart } — region defaults to the first region that has sources.
export async function loadAll(fetchFn, token, root, now = new Date(), view = {}) {
  const [src, health, cand] = await Promise.all([
    api(fetchFn, token, 'GET', '/sources'),
    api(fetchFn, token, 'GET', '/health'),
    api(fetchFn, token, 'GET', '/candidates'),
  ]);
  const sources = src.sources || [];
  const regions = regionsOf(sources);
  const year = view.year ?? now.getFullYear();
  const month = view.month ?? now.getMonth() + 1;
  const region = view.region && regions.includes(view.region) ? view.region : regions[0];
  let events = [];
  if (region) {
    const { from, to } = monthRange(year, month);
    const qs = new URLSearchParams({ region_id: region, from, to }).toString();
    const ev = await api(fetchFn, token, 'GET', `/events?${qs}`);
    events = ev.events || [];
  }
  const mm = String(month).padStart(2, '0');
  const inMonth = events.filter((e) => String(e.start_local_date ?? '').startsWith(`${year}-${mm}`));
  const byId = new Map((health.sources || []).map((h) => [h.id, h]));
  const merged = sources.map((s) => ({ ...s, ...(byId.get(s.id) || {}), name: s.name ?? s.url ?? s.id }));
  root.health.innerHTML = renderHealth(merged);
  root.sources.innerHTML = renderSources(sources);
  if (root.candidates) root.candidates.innerHTML = renderCandidates(cand.candidates);
  root.events.innerHTML = renderMonth(year, month, inMonth, view.weekStart, now);
  if (root.list) root.list.innerHTML = renderEventList(inMonth);
  if (root.title) root.title.textContent = `${year}年${month}月`;
  if (root.region) {
    root.region.innerHTML = regions.map((r) => `<option${r === region ? ' selected' : ''} value="${esc(r)}">${esc(r)}</option>`).join('');
  }
  return { sources, events, health: health.sources || [], view: { year, month, region, weekStart: view.weekStart } };
}

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const root = {
    health: $('health'),
    sources: $('sources'),
    events: $('events'),
    list: $('event-list'),
    title: $('month-title'),
    region: $('region'),
    candidates: $('candidates'),
    message: $('candidate-message'),
  };
  const token = readToken(document);
  const fetchFn = (p, i) => fetch(p, i);
  const weekStart = readWeekStart(document);
  let view = { weekStart };
  const reload = async () => {
    view = (await loadAll(fetchFn, token, root, new Date(), view)).view;
  };
  const shift = (delta) => {
    const d = new Date(view.year, view.month - 1 + delta, 1);
    view = { ...view, year: d.getFullYear(), month: d.getMonth() + 1 };
    reload();
  };
  $('prev').addEventListener('click', () => shift(-1));
  $('next').addEventListener('click', () => shift(1));
  $('today').addEventListener('click', () => {
    view = { region: view.region, weekStart };
    reload();
  });
  root.health.addEventListener('change', async (ev) => {
    const el = ev.target;
    if (!el.classList || !el.classList.contains('enabled')) return;
    el.disabled = true;
    const r = await patchEnabled(fetchFn, token, el.dataset.id, el.checked, Number(el.dataset.version));
    if (r.error) console.error('source toggle failed', r.error);
    reload();
  });
  root.candidates.addEventListener('change', async (ev) => {
    const el = ev.target;
    if (!el.classList || !el.classList.contains('approve') || !el.checked) return;
    el.disabled = true;
    root.message.textContent = '試し取得して追加しています…';
    const r = await approveCandidate(fetchFn, token, el.dataset.id);
    root.message.textContent = r.error ? `追加できませんでした: ${r.error.code} ${r.error.message}` : '';
    reload();
  });
  root.candidates.addEventListener('click', async (ev) => {
    const el = ev.target;
    if (!el.classList || !el.classList.contains('reject')) return;
    el.disabled = true;
    const r = await rejectCandidate(fetchFn, token, el.dataset.id);
    root.message.textContent = r.error ? `却下できませんでした: ${r.error.code} ${r.error.message}` : '';
    reload();
  });
  root.region.addEventListener('change', () => {
    view = { ...view, region: root.region.value };
    reload();
  });
  reload();
}
