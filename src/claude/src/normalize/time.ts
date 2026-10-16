import { AppError } from '../errors.ts';

export interface LocalDateTime { year: number; month: number; day: number; hour: number; minute: number; second?: number }

function checkTz(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new AppError('INVALID_ARGUMENT', `invalid timezone: ${tz}`, { tz });
  }
}

function partsInTz(ms: number, tz: string): LocalDateTime {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { year: o.year!, month: o.month!, day: o.day!, hour: o.hour!, minute: o.minute!, second: o.second! };
}

const asUtcMs = (l: LocalDateTime): number =>
  Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second ?? 0);

/** Interpret wall-clock time in tz, return UTC ISO string 'YYYY-MM-DDTHH:MM:SSZ'. */
export function localToUtc(local: LocalDateTime, tz: string): string {
  checkTz(tz);
  const naive = asUtcMs(local);
  if (Number.isNaN(naive)) throw new AppError('INVALID_ARGUMENT', 'invalid local datetime', { local });
  let ms = naive;
  for (let i = 0; i < 3; i++) {
    const off = asUtcMs(partsInTz(ms, tz)) - ms;
    ms = naive - off;
  }
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Convert UTC ISO string to wall-clock fields in tz. */
export function utcToLocal(utcIso: string, tz: string): LocalDateTime {
  checkTz(tz);
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) throw new AppError('INVALID_ARGUMENT', `invalid UTC time: ${utcIso}`, { utcIso });
  return partsInTz(ms, tz);
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** tz-based local date 'YYYY-MM-DD' of a UTC instant (for all_day events). */
export function startLocalDate(utcIso: string, tz: string): string {
  const l = utcToLocal(utcIso, tz);
  return `${String(l.year).padStart(4, '0')}-${p2(l.month)}-${p2(l.day)}`;
}
