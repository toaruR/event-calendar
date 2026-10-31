// GUI app: same-origin calls to the HTTP API with X-GUI-Token, rendered via render.js.
import { esc, renderSources, renderHealth, renderCandidates, renderMonth, renderEventList } from './render.js';
import { holidayLookup } from './holidays.js';

export function readToken(doc) {
  const m = doc.querySelector('meta[name="gui-token"]');
  return m ? m.getAttribute('content') || '' : '';
}

// 'monday' | 'sunday' from the server-embedded <meta name="week-start"> (config week_start).
export function readWeekStart(doc) {
  const m = doc.querySelector('meta[name="week-start"]');
  return m && m.getAttribute('content') === 'monday' ? 'monday' : 'sunday';
}

// Initial region_id from the server-embedded <meta name="default-region"> (config default_region); '' = none.
export function readDefaultRegion(doc) {
  const m = doc.querySelector('meta[name="default-region"]');
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

function candidateError(error) {
  const detail = error.message || String(error);
  if (error.code === 'ZERO_ITEMS') return 'イベントを抽出できませんでした。取得設定が必要か、掲載イベントがありません。';
  if (error.code === 'ROBOTS_DISALLOWED') return 'robots.txtで取得が禁止されています。';
  if (error.code === 'FETCH_FAILED') return `ページを取得できませんでした。${detail}`;
  return `${error.code ? `${error.code}: ` : ''}${detail}`;
}

// Keep feedback beside the checkbox, including after network failures.
export function bindCandidateActions(root, fetchFn, token, reload) {
  const handle = async (ev, action) => {
    const el = ev.target;
    if (!el.classList?.contains(action) || el.disabled || (action === 'approve' && !el.checked)) return;
    const row = el.closest('tr');
    const controls = [...row.querySelectorAll('input, button')];
    const previous = controls.map((c) => c.disabled);
    const note = row.querySelector('.note');
    const message = (text, failed = false) => {
      note.textContent = text;
      note.classList.toggle('error', failed);
      root.message.textContent = text;
    };
    controls.forEach((c) => { c.disabled = true; });
    message(action === 'approve' ? '試し取得して追加しています…' : '却下しています…');
    let changed = false;
    try {
      const r = await (action === 'approve' ? approveCandidate : rejectCandidate)(fetchFn, token, el.dataset.id);
      if (r.error) {
        message(`${action === 'approve' ? '追加' : '却下'}できませんでした: ${candidateError(r.error)}`, true);
        return;
      }
      changed = true;
      message(action === 'approve' ? '追加しました。ソース状態で確認できます。' : '却下しました。');
      try { await reload(); } catch (e) {
        message(`保存済みですが、一覧を更新できませんでした。再読み込みしてください: ${e.message}`, true);
      }
    } catch (e) {
      message(`通信に失敗しました。再読み込みして保存状態を確認してください: ${candidateError(e)}`, true);
    } finally {
      if (action === 'approve' && !changed) el.checked = false;
      controls.forEach((c, i) => { c.disabled = changed || previous[i]; });
    }
  };
  root.candidates.addEventListener('change', (ev) => handle(ev, 'approve'));
  root.candidates.addEventListener('click', (ev) => handle(ev, 'reject'));
}

// Query window for a month: one day of slack on each side covers tz offsets.
export function monthRange(year, month) {
  const from = new Date(Date.UTC(year, month - 1, 1) - 86400000).toISOString();
  const to = new Date(Date.UTC(year, month, 1) + 86400000).toISOString();
  return { from, to };
}

// ICS export of exactly one local-time month (the endpoint's `to` is inclusive, so stop 1ms before next month).
export function icsUrl(region, year, month) {
  const from = new Date(year, month - 1, 1).toISOString();
  const to = new Date(new Date(year, month, 1).getTime() - 1).toISOString();
  const qs = new URLSearchParams({ from, to }).toString();
  return `/calendar/${encodeURIComponent(region)}.ics?${qs}`;
}

export function icsFileName(region, year, month) {
  return `${region}-${year}-${String(month).padStart(2, '0')}.ics`;
}

export const GOOGLE_IMPORT_URL = 'https://calendar.google.com/calendar/r/settings/export';

export function regionsOf(sources) {
  return [...new Set((sources || []).map((s) => s.region_id).filter(Boolean))].sort();
}

// view: { year, month, region, weekStart } — unknown/empty region falls back to the first region that has sources.
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
  // Holiday data failures must not break the calendar: fall back to offline computation.
  let remoteHolidays = null;
  try {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const qs = new URLSearchParams({ from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}` }).toString();
    const h = await api(fetchFn, token, 'GET', `/holidays?${qs}`);
    if (!h.error) remoteHolidays = h;
  } catch { /* offline fallback */ }
  const inMonth = events.filter((e) => String(e.start_local_date ?? '').startsWith(`${year}-${mm}`));
  const byId = new Map((health.sources || []).map((h) => [h.id, h]));
  const merged = sources.map((s) => ({ ...s, ...(byId.get(s.id) || {}), name: s.name ?? s.url ?? s.id }));
  root.health.innerHTML = renderHealth(merged);
  root.sources.innerHTML = renderSources(sources);
  if (root.candidates) root.candidates.innerHTML = renderCandidates(cand.candidates);
  root.events.innerHTML = renderMonth(year, month, inMonth, view.weekStart, now, holidayLookup(remoteHolidays));
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
  let view = { weekStart, region: readDefaultRegion(document) || undefined };
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
  // Download the shown month's ICS, then open Google Calendar's import page (both sync in the click to avoid popup blocking).
  $('ics').addEventListener('click', () => {
    if (!view.region) return;
    const a = document.createElement('a');
    a.href = icsUrl(view.region, view.year, view.month);
    a.download = icsFileName(view.region, view.year, view.month);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.open(GOOGLE_IMPORT_URL, '_blank', 'noopener');
  });
  root.health.addEventListener('change', async (ev) => {
    const el = ev.target;
    if (!el.classList || !el.classList.contains('enabled')) return;
    el.disabled = true;
    const r = await patchEnabled(fetchFn, token, el.dataset.id, el.checked, Number(el.dataset.version));
    if (r.error) console.error('source toggle failed', r.error);
    reload();
  });
  bindCandidateActions(root, fetchFn, token, reload);
  root.region.addEventListener('change', () => {
    view = { ...view, region: root.region.value };
    reload();
  });
  reload();
}
