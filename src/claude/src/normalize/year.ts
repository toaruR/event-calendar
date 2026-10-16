import { AppError } from '../errors.ts';

export interface YearResult { date: string; status: 'confirmed' | 'tentative' }

const DAY = 86400000;
const p2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Infer year for a month/day without year. now is injected (UTC calendar date used).
 * Adopt earliest candidate >= now - pastWindow days; tentative if > now + futureWindow days.
 */
export function inferYear(
  month: number, day: number, now: Date, pastWindow: number, futureWindow: number,
): YearResult {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new AppError('INVALID_ARGUMENT', 'invalid month/day', { month, day });
  }
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startYear = now.getUTCFullYear() - 1;
  for (let y = startYear; y <= startYear + 8; y++) {
    const ms = Date.UTC(y, month - 1, day);
    const d = new Date(ms);
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) continue; // e.g. Feb 29 in non-leap year
    const diff = Math.round((ms - nowDay) / DAY);
    if (diff < -pastWindow) continue;
    return {
      date: `${String(y).padStart(4, '0')}-${p2(month)}-${p2(day)}`,
      status: diff > futureWindow ? 'tentative' : 'confirmed',
    };
  }
  throw new AppError('INVALID_ARGUMENT', 'no valid date', { month, day });
}
