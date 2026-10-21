import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { validateInput } from '../validate.ts';

export interface EventRow {
  id: string; region_id: string; title: string; start_utc: string; end_utc: string | null;
  all_day: boolean; start_local_date: string | null; tz: string;
  venue_name: string | null; address: string | null; lat: number | null; lon: number | null;
  description: string | null; url: string | null; status: 'confirmed' | 'tentative' | 'cancelled';
  dedup_key: string | null; region_confidence: number | null;
  first_seen_at: string | null; last_seen_at: string | null; cancelled_at: string | null; seq: number;
}

/** Events of a region with from <= start_utc <= to (ISO UTC strings), ascending by start_utc. */
export function listEvents(db: DatabaseSync, q: { region_id: string; from: string; to: string }): EventRow[] {
  const rows = db.prepare(
    'SELECT * FROM event WHERE region_id = ? AND start_utc >= ? AND start_utc <= ? ORDER BY start_utc ASC, id ASC',
  ).all(q.region_id, q.from, q.to) as unknown as Array<Omit<EventRow, 'all_day'> & { all_day: number }>;
  return rows.map((r) => ({ ...r, all_day: r.all_day !== 0 }));
}

function toUtcIso(s: string): string {
  return new Date(s).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface SearchQuery { region_id: string; from: string; to: string; q?: string; source?: string }

/** events_search: validated range query with optional substring (title/venue/description) and source-id filters. */
export function searchEvents(db: DatabaseSync, input: unknown): { events: EventRow[]; count: number } {
  validateInput('events_search', input);
  const p = input as SearchQuery;
  const from = toUtcIso(p.from);
  const to = toUtcIso(p.to);
  if (Date.parse(from) > Date.parse(to)) {
    throw new AppError('INVALID_ARGUMENT', 'from must be <= to', { from: p.from, to: p.to });
  }
  let events = listEvents(db, { region_id: p.region_id, from, to });
  if (p.source !== undefined && p.source !== '') {
    const ids = new Set((db.prepare('SELECT event_id FROM event_source_ref WHERE source_id = ?').all(p.source) as Array<{ event_id: string }>)
      .map((r) => r.event_id));
    events = events.filter((e) => ids.has(e.id));
  }
  if (p.q !== undefined && p.q !== '') {
    const needle = p.q.toLowerCase();
    events = events.filter((e) => [e.title, e.venue_name, e.description].some((f) => f !== null && f.toLowerCase().includes(needle)));
  }
  return { events, count: events.length };
}
