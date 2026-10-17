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
// 令和8年 / 2026年 (optional), M月D日, optional (曜日), optional time, optional range end
const DATE_RE = new RegExp(
  `(?:(令和|R)\\s*(${NUM}{1,2}|元)\\s*年|(${NUM}{4})\\s*年)?\\s*(${NUM}{1,2})\\s*月\\s*(${NUM}{1,2})\\s*日` +
  `(?:\\s*[(（][^)）]{1,6}[)）])?` +
  `(?:\\s*(?:(午前|午後))?\\s*(${NUM}{1,2})\\s*(?:[:：]|時)\\s*(${NUM}{2})?)?` +
  `(?:\\s*[〜～~\\-ー－]\\s*(?:(${NUM}{1,2})\\s*月\\s*)?(${NUM}{1,2})\\s*日)?`,
  'u',
);

function toHalf(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function validYmd(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Find the first event date mentioned in text (Japanese notation). Returns null when none. */
export function findEventDate(text: string | null | undefined, opts: EventDateOpts): EventDate | null {
  if (!text) return null;
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const n = (s: string | undefined): number | undefined => (s === undefined ? undefined : Number(toHalf(s)));
  const month = n(m[4])!;
  const day = n(m[5])!;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year: number;
  let status: EventDate['status'] = 'confirmed';
  if (m[1] !== undefined) year = 2018 + (m[2] === '元' ? 1 : n(m[2])!);
  else if (m[3] !== undefined) year = n(m[3])!;
  else {
    try {
      const r = inferYear(month, day, opts.ref, opts.pastWindow, opts.futureWindow);
      year = Number(r.date.slice(0, 4));
      status = r.status;
    } catch { return null; }
  }
  if (!validYmd(year, month, day)) return null;
  let start = `${year}-${p2(month)}-${p2(day)}`;
  if (m[7] !== undefined) {
    let h = n(m[7])!;
    if (m[6] === '午後' && h < 12) h += 12;
    const mi = n(m[8]) ?? 0;
    if (h <= 23 && mi <= 59) start += `T${p2(h)}:${p2(mi)}`;
  }
  let end: string | null = null;
  if (m[10] !== undefined) {
    const em = n(m[9]) ?? month;
    const ed = n(m[10])!;
    const ey = em < month ? year + 1 : year;
    if (validYmd(ey, em, ed)) {
      const e = `${ey}-${p2(em)}-${p2(ed)}`;
      if (e > start.slice(0, 10)) end = e;
    }
  }
  return { start, end, status };
}

/** Search title, then description, then body content; first hit wins. */
export function findEventDateIn(
  parts: Array<string | null | undefined>, opts: EventDateOpts,
): EventDate | null {
  for (const p of parts) {
    const r = findEventDate(p, opts);
    if (r) return r;
  }
  return null;
}
