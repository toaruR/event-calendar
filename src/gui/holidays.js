// Japanese national holidays (国民の祝日に関する法律), computed offline. Equinox formula valid 1980-2099.
const p2 = (n) => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;
const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
// n-th Monday of the month.
const nthMonday = (y, m, n) => 1 + ((8 - dowOf(y, m, 1)) % 7) + (n - 1) * 7;
const equinox = (y, base) => Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

// Tokyo Olympics special moves (2020, 2021).
const OLYMPIC = {
  2020: { umi: [7, 23], sports: [7, 24], yama: [8, 10] },
  2021: { umi: [7, 22], sports: [7, 23], yama: [8, 8] },
};

function baseHolidays(y) {
  const h = new Map();
  const add = (m, d, name) => h.set(key(y, m, d), name);
  const o = OLYMPIC[y];
  add(1, 1, '元日');
  add(1, nthMonday(y, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (y >= 2020) add(2, 23, '天皇誕生日');
  add(3, equinox(y, 20.8431), '春分の日');
  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  if (o) add(...o.umi, '海の日');
  else add(7, nthMonday(y, 7, 3), '海の日');
  if (o) add(...o.yama, '山の日');
  else if (y >= 2016) add(8, 11, '山の日');
  add(9, nthMonday(y, 9, 3), '敬老の日');
  add(9, equinox(y, 23.2488), '秋分の日');
  if (o) add(...o.sports, 'スポーツの日');
  else add(10, nthMonday(y, 10, 2), y >= 2020 ? 'スポーツの日' : '体育の日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');
  if (y < 2019) add(12, 23, '天皇誕生日');
  return h;
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

const cache = new Map();

// Map of 'YYYY-MM-DD' -> holiday name for the year, including 国民の休日 and 振替休日.
export function holidaysOf(year) {
  if (cache.has(year)) return cache.get(year);
  const base = baseHolidays(year);
  // Adjacent years so substitutes/sandwiches across year boundaries resolve.
  const all = new Map([...baseHolidays(year - 1), ...base, ...baseHolidays(year + 1)]);
  const out = new Map(base);
  for (const date of base.keys()) {
    const next = addDays(date, 1);
    const [y, m, d] = next.split('-').map(Number);
    if (!all.has(next) && all.has(addDays(next, 1)) && dowOf(y, m, d) !== 0) out.set(next, '国民の休日');
  }
  for (const date of base.keys()) {
    const [y, m, d] = date.split('-').map(Number);
    if (dowOf(y, m, d) !== 0) continue;
    let sub = addDays(date, 1);
    while (out.has(sub) || all.has(sub)) sub = addDays(sub, 1);
    out.set(sub, '振替休日');
  }
  cache.set(year, out);
  return out;
}

// Holiday name for 'YYYY-MM-DD', or '' if not a holiday.
export function holidayName(date) {
  const y = Number(String(date).slice(0, 4));
  if (!Number.isInteger(y)) return '';
  return holidaysOf(y).get(date) ?? '';
}

// Lookup preferring server data (GET /holidays) for the years it covers; other years fall back to holidayName.
export function holidayLookup(remote) {
  const span = remote?.covered_years;
  if (!Array.isArray(span)) return holidayName;
  const byDate = new Map((remote.holidays || []).map((h) => [h.date, h.name]));
  return (date) => {
    const y = Number(String(date).slice(0, 4));
    return y >= span[0] && y <= span[1] ? (byDate.get(date) ?? '') : holidayName(date);
  };
}
