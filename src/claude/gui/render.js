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

function eventsOn(events, date) {
  return (events || []).filter((e) => String(e.start ?? e.start_at ?? '').slice(0, 10) === date);
}

function dayCell(date, events) {
  const items = eventsOn(events, date)
    .map((e) => `<li class="event">${esc(e.title)}</li>`)
    .join('');
  return `<div class="day" data-date="${esc(date)}"><span class="date">${esc(date)}</span><ul>${items}</ul></div>`;
}

export function renderSources(sources) {
  const rows = (sources || [])
    .map(
      (s) =>
        `<li class="source" data-id="${esc(s.id)}"><span class="name">${esc(s.name ?? s.id)}</span> <span class="state">${esc(s.state)}</span> <span class="version">v${esc(s.spec_version)}</span></li>`,
    )
    .join('');
  return `<ul class="sources">${rows}</ul>`;
}

export function renderSpecEditor(source) {
  const s = source || {};
  const spec = typeof s.spec_json === 'string' ? s.spec_json : JSON.stringify(s.spec_json ?? {}, null, 2);
  return `<form class="spec-editor" data-source-id="${esc(s.id)}" data-expected-version="${esc(s.expected_version ?? s.spec_version)}"><textarea name="spec_json">${esc(spec)}</textarea><button type="submit">save</button></form>`;
}

export function renderMonth(year, month, events) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let cells = '';
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

export function renderHealth(sources) {
  const rows = (sources || [])
    .map(
      (s) =>
        `<tr data-id="${esc(s.id)}"><td>${esc(s.name ?? s.id)}</td><td class="state">${esc(s.state)}</td><td>${esc(s.last_error ?? '')}</td></tr>`,
    )
    .join('');
  return `<table class="health"><tbody>${rows}</tbody></table>`;
}
