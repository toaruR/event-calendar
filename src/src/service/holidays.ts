import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock.ts';
import type { Config } from '../config.ts';
import { fetchStage } from '../pipeline/fetch-stage.ts';
import type { FetchStageDeps } from '../pipeline/fetch-stage.ts';

export interface Holiday { date: string; name: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** holidays-jp format: {"YYYY-MM-DD": "name", ...}. Throws on anything else. */
export function parseHolidayJson(text: string): Holiday[] {
  const json: unknown = JSON.parse(text);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('holiday data must be a JSON object');
  const out: Holiday[] = [];
  for (const [date, name] of Object.entries(json)) {
    if (!DATE_RE.test(date) || typeof name !== 'string' || name === '') throw new Error(`bad holiday entry: ${date}`);
    out.push({ date, name });
  }
  if (out.length === 0) throw new Error('holiday data is empty');
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function syncState(db: DatabaseSync): { last_at: string; etag: string | null; last_modified: string | null } | undefined {
  return db.prepare('SELECT last_at, etag, last_modified FROM holiday_sync WHERE id = 1').get() as
    { last_at: string; etag: string | null; last_modified: string | null } | undefined;
}

/** Due when never synced or last sync is older than holiday_interval_sec (0 disables). */
export function holidaySyncDue(db: DatabaseSync, clock: Clock, config: Pick<Config, 'holiday_interval_sec'>): boolean {
  if (config.holiday_interval_sec <= 0) return false;
  const s = syncState(db);
  return !s || Date.parse(s.last_at) + config.holiday_interval_sec * 1000 <= clock.now();
}

export type HolidaySyncResult = { outcome: 'ok'; count: number } | { outcome: 'not_modified' } | { outcome: 'failed'; error: string };

/** Fetch holiday_url and replace the holiday table atomically. last_at advances only on ok / not_modified. */
export async function syncHolidays(
  db: DatabaseSync, net: FetchStageDeps, config: Pick<Config, 'holiday_url'>,
): Promise<HolidaySyncResult> {
  const s = syncState(db);
  const nowIso = (): string => new Date(net.clock.now()).toISOString();
  let r;
  try {
    r = await fetchStage(config.holiday_url, s ? { etag: s.etag, lastModified: s.last_modified } : undefined, net);
  } catch (e) {
    return { outcome: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
  if (r.kind === 'not_modified') {
    db.prepare('UPDATE holiday_sync SET last_at = ? WHERE id = 1').run(nowIso());
    return { outcome: 'not_modified' };
  }
  if (r.kind !== 'ok') return { outcome: 'failed', error: r.error };
  let list: Holiday[];
  try { list = parseHolidayJson(r.text); } catch (e) {
    return { outcome: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM holiday');
    const ins = db.prepare('INSERT INTO holiday (date, name) VALUES (?, ?)');
    for (const h of list) ins.run(h.date, h.name);
    db.prepare(
      `INSERT INTO holiday_sync (id, last_at, etag, last_modified) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_at = excluded.last_at, etag = excluded.etag, last_modified = excluded.last_modified`,
    ).run(nowIso(), r.etag, r.lastModified);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { outcome: 'ok', count: list.length };
}

export interface HolidayList {
  holidays: Holiday[];
  /** years the stored data covers ([first, last]); null when never synced */
  covered_years: [number, number] | null;
  updated_at: string | null;
}

/** Stored holidays in [from, to] (YYYY-MM-DD, inclusive), the covered year span and the last successful sync time. */
export function listHolidays(db: DatabaseSync, from: string, to: string): HolidayList {
  const rows = db.prepare('SELECT date, name FROM holiday WHERE date >= ? AND date <= ? ORDER BY date').all(from, to) as unknown as Holiday[];
  const span = db.prepare('SELECT MIN(date) AS lo, MAX(date) AS hi FROM holiday').get() as { lo: string | null; hi: string | null };
  return {
    holidays: rows.map((h) => ({ date: h.date, name: h.name })),
    covered_years: span.lo && span.hi ? [Number(span.lo.slice(0, 4)), Number(span.hi.slice(0, 4))] : null,
    updated_at: syncState(db)?.last_at ?? null,
  };
}
