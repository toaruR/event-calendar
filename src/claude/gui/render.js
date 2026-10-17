// Pure string renderers for the GUI (browser + Node). All values are HTML-escaped (F9).
export function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

// Local calendar date of an event: start_local_date (API) first, else the ISO prefix of start.
export function eventDate(e) {
  return String(e.start_local_date ?? e.start ?? e.start_utc ?? e.start_at ?? '').slice(0, 10);
}

// "HH:MM" in the event's tz, or '' for all-day / unknown.
export function eventTime(e) {
  if (e.all_day || !e.start_utc) return '';
  const ms = Date.parse(e.start_utc);
  if (Number.isNaN(ms)) return '';
  try {
    return new Intl.DateTimeFormat('ja-JP', { timeZone: e.tz || 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  } catch {
    return '';
  }
}

// Only http(s) links are rendered as anchors (no javascript: etc.).
function safeUrl(u) {
  return typeof u === 'string' && /^https?:/i.test(u) ? u : '';
}

function eventsOn(events, date) {
  return (events || []).filter((e) => eventDate(e) === date);
}

function eventLabel(e) {
  const t = eventTime(e);
  const title = esc(e.title);
  const url = safeUrl(e.url);
  const tip = esc([e.title, e.venue_name].filter(Boolean).join(' / '));
  const body = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
  return `<li class="event" title="${tip}">${t ? `<span class="time">${esc(t)}</span> ` : ''}${body}</li>`;
}

function dayCell(date, events) {
  const items = eventsOn(events, date).map(eventLabel).join('');
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return `<div class="day dow${dow}" data-date="${esc(date)}"><span class="date">${esc(Number(date.slice(8, 10)))}</span><ul>${items}</ul></div>`;
}

export function renderSources(sources) {
  const rows = (sources || [])
    .map(
      (s) =>
        `<li class="source" data-id="${esc(s.id)}"><span class="name">${esc(s.name ?? s.url ?? s.id)}</span> <span class="kind">${esc(s.kind ?? '')}</span> <span class="state">${esc(s.state)}</span> <span class="version">v${esc(s.spec_version)}</span></li>`,
    )
    .join('');
  return `<ul class="sources">${rows}</ul>`;
}

export function renderSpecEditor(source) {
  const s = source || {};
  const spec = typeof s.spec_json === 'string' ? s.spec_json : JSON.stringify(s.spec_json ?? {}, null, 2);
  return `<form class="spec-editor" data-source-id="${esc(s.id)}" data-expected-version="${esc(s.expected_version ?? s.spec_version)}"><textarea name="spec_json">${esc(spec)}</textarea><button type="submit">save</button></form>`;
}

// Month grid; weekStart 'monday' starts on Monday, otherwise Sunday.
// Leading blanks are .pad (not .day), so .day count == days in month.
export function renderMonth(year, month, events, weekStart = 'sunday') {
  const ws = weekStart === 'monday' ? 1 : 0;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() - ws + 7) % 7;
  let cells = '';
  for (let k = 0; k < 7; k++) {
    const i = (k + ws) % 7;
    cells += `<div class="dow-head dow${i}">${DOW[i]}</div>`;
  }
  for (let i = 0; i < lead; i++) cells += '<div class="pad"></div>';
  for (let d = 1; d <= days; d++) {
    cells += dayCell(`${year}-${p2(month)}-${p2(d)}`, events);
  }
  return `<div class="month" data-month="${esc(year)}-${p2(month)}">${cells}</div>`;
}

export function renderWeek(startDate, events) {
  const [y, m, d] = String(startDate).split('-').map(Number);
  const start = Date.UTC(y, m - 1, d);
  let cells = '';
  for (let i = 0; i < 7; i++) {
    cells += dayCell(ymd(new Date(start + i * 86400000)), events);
  }
  return `<div class="week" data-start="${esc(startDate)}">${cells}</div>`;
}

// Chronological list of events with date, time, title (linked), venue.
export function renderEventList(events) {
  const list = [...(events || [])].sort((a, b) => String(a.start_utc ?? eventDate(a)).localeCompare(String(b.start_utc ?? eventDate(b))));
  if (list.length === 0) return '<p class="empty">この月のイベントはありません</p>';
  const rows = list
    .map((e) => {
      const d = eventDate(e);
      const dow = d ? DOW[new Date(`${d}T00:00:00Z`).getUTCDay()] : '';
      const url = safeUrl(e.url);
      const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>` : esc(e.title);
      const desc = e.description ? `<div class="desc">${esc(e.description)}</div>` : '';
      return `<tr><td class="when">${esc(d)}(${esc(dow)}) ${esc(eventTime(e) || '終日')}</td><td>${title}${desc}</td><td class="venue">${esc(e.venue_name ?? '')}</td></tr>`;
    })
    .join('');
  return `<table class="event-list"><thead><tr><th>日時</th><th>イベント</th><th>会場</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Proposed candidates: checking the box approves (adds) the source; robots-disallowed ones cannot be checked.
export function renderCandidates(candidates) {
  const list = candidates || [];
  if (list.length === 0) return '<p class="empty">候補はありません</p>';
  const rows = list
    .map((c) => {
      const off = c.robots_allowed ? '' : ' disabled';
      const note = c.robots_allowed ? '' : 'robots.txt で禁止';
      return `<tr data-id="${esc(c.id)}"><td class="toggle"><label><input type="checkbox" class="approve" data-id="${esc(c.id)}"${off}> 有効</label></td><td>${esc(c.url)}</td><td class="state">${esc(c.kind_guess ?? '')}</td><td class="note">${esc(note)}</td><td><button type="button" class="reject" data-id="${esc(c.id)}">却下</button></td></tr>`;
    })
    .join('');
  return `<table class="health candidates"><tbody>${rows}</tbody></table>`;
}

export function renderHealth(sources) {
  const rows = (sources || [])
    .map(
      (s) =>
        `<tr data-id="${esc(s.id)}"><td class="toggle"><label><input type="checkbox" class="enabled" data-id="${esc(s.id)}" data-version="${esc(s.spec_version)}"${s.enabled === false ? '' : ' checked'}> 有効</label></td><td>${esc(s.name ?? s.id)}</td><td class="state">${esc(s.state)}</td><td>${esc(s.last_error ?? '')}</td></tr>`,
    )
    .join('');
  return `<table class="health"><tbody>${rows}</tbody></table>`;
}
