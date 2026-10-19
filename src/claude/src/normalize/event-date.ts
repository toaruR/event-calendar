import { inferYear } from './year.ts';

export interface EventDate {
  /** "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (local, offset-less) */
  start: string;
  end: string | null;
  status: 'confirmed' | 'tentative';
}

export interface EventDateOpts {
  /** reference for year-less dates (article publish time, else now) */
  ref: Date;
  pastWindow: number;
  futureWindow: number;
}

const p2 = (n: number): string => String(n).padStart(2, '0');
const NUM = '[0-9０-９]';
// D日 / D、D+1日 / D日、D+1日 (list of two days)
const DAY = `(${NUM}{1,2})\\s*日?\\s*(?:[、・，,]\\s*(${NUM}{1,2})\\s*)?日`;
// optional (曜日), optional time, optional range end
const TAIL =
  `(?:\\s*[(（][^)）]{1,6}[)）])?` +
  `(?:\\s*(?:(午前|午後))?\\s*(${NUM}{1,2})\\s*(?:[:：]|時)\\s*(${NUM}{2})?)?` +
  `(?:\\s*[〜～~\\-ー－]\\s*(?:(${NUM}{1,2})\\s*月\\s*)?(${NUM}{1,2})\\s*日)?`;
// 令和8年 / 2026年 (optional), M月D日 + tail
const DATE_RE = new RegExp(
  `(?:(令和|R)\\s*(${NUM}{1,2}|元)\\s*年|(${NUM}{4})\\s*年)?\\s*(${NUM}{1,2})\\s*月\\s*${DAY}${TAIL}`,
  'u',
);
// month-less "24、25日" (newspaper style: month of the article); not 3日間 / 1日現在 etc.
const DAY_RE = new RegExp(
  `(?<![0-9０-９月年/／.．第])${DAY}(?!間|目|付|現在|以内|以降|ぶり|連続)${TAIL}`,
  'u',
);
const JST_MS = 9 * 3600000;

function toHalf(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function validYmd(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const num = (s: string | undefined): number | undefined => (s === undefined ? undefined : Number(toHalf(s)));

/** groups after the day: [list2, 午前/午後, hour, minute, range month, range day] */
function build(
  year: number, month: number, day: number, g: Array<string | undefined>, status: EventDate['status'],
): EventDate | null {
  const [list2, ampm, hour, minute, rMonth, rDay] = g;
  if (!validYmd(year, month, day)) return null;
  let start = `${year}-${p2(month)}-${p2(day)}`;
  if (hour !== undefined) {
    let h = num(hour)!;
    if (ampm === '午後' && h < 12) h += 12;
    const mi = num(minute) ?? 0;
    if (h <= 23 && mi <= 59) start += `T${p2(h)}:${p2(mi)}`;
  }
  let end: string | null = null;
  if (rDay !== undefined) {
    const em = num(rMonth) ?? month;
    const ed = num(rDay)!;
    const ey = em < month ? year + 1 : year;
    if (validYmd(ey, em, ed)) {
      const e = `${ey}-${p2(em)}-${p2(ed)}`;
      if (e > start.slice(0, 10)) end = e;
    }
  } else if (list2 !== undefined && num(list2) === day + 1 && validYmd(year, month, day + 1)) {
    // "24、25日" = two consecutive days; "3、10日" stays a single start
    end = `${year}-${p2(month)}-${p2(day + 1)}`;
  }
  return { start, end, status };
}

/** Find the first event date mentioned in text (Japanese notation). Returns null when none. */
export function findEventDate(text: string | null | undefined, opts: EventDateOpts): EventDate | null {
  if (!text) return null;
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const month = num(m[4])!;
  const day = num(m[5])!;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year: number;
  let status: EventDate['status'] = 'confirmed';
  if (m[1] !== undefined) year = 2018 + (m[2] === '元' ? 1 : num(m[2])!);
  else if (m[3] !== undefined) year = num(m[3])!;
  else {
    try {
      const r = inferYear(month, day, opts.ref, opts.pastWindow, opts.futureWindow);
      year = Number(r.date.slice(0, 4));
      status = r.status;
    } catch { return null; }
  }
  return build(year, month, day, m.slice(6), status);
}

/** Month-less "D日" resolved to the year/month of opts.ref (JST). Returns null when none. */
export function findDayOnlyDate(text: string | null | undefined, opts: EventDateOpts): EventDate | null {
  if (!text) return null;
  const m = DAY_RE.exec(text);
  if (!m) return null;
  const day = num(m[1])!;
  if (day < 1 || day > 31) return null;
  const ref = new Date(opts.ref.getTime() + JST_MS);
  return build(ref.getUTCFullYear(), ref.getUTCMonth() + 1, day, m.slice(2), 'confirmed');
}

/** Search title, then description, then body content for a full date; then the same for a month-less day. */
export function findEventDateIn(
  parts: Array<string | null | undefined>, opts: EventDateOpts,
): EventDate | null {
  for (const find of [findEventDate, findDayOnlyDate]) {
    for (const p of parts) {
      const r = find(p, opts);
      if (r) return r;
    }
  }
  return null;
}
