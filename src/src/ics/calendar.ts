import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { listEvents } from '../service/events.ts';
import { redactContactText } from '../normalize/sanitize.ts';
import { eventToVevent, escapeText } from './generate.ts';
import { foldLine } from './fold.ts';
import { computeEtag } from './etag.ts';

export interface CalendarOpts {
  from: string;
  to: string;
  now: Date | number;
  /** Restrict the output to this one event (per-event ICS). */
  eventId?: string;
  config?: Pick<Config, 'cancelled_retention' | 'redact_contact'>;
}

const DAY_MS = 86_400_000;

/** Build the VCALENDAR for a region's events in [from, to]. Deterministic for identical DB content. */
export function buildCalendar(db: DatabaseSync, regionId: string, opts: CalendarOpts): { body: string; etag: string } {
  const cfg = opts.config ?? defaultConfig();
  const region = db.prepare('SELECT id,name FROM region WHERE id = ?').get(regionId) as { id: string; name: string } | undefined;
  if (!region) throw new AppError('NOT_FOUND', `region not found: ${regionId}`, { region_id: regionId });
  const nowMs = typeof opts.now === 'number' ? opts.now : opts.now.getTime();
  const cutoff = nowMs - cfg.cancelled_retention * DAY_MS;

  const restricted = new Set(
    (db.prepare(
      `SELECT DISTINCT r.event_id AS id FROM event_source_ref r JOIN source s ON s.id = r.source_id
       WHERE s.allow_redistribute = 0`,
    ).all() as Array<{ id: string }>).map((r) => r.id),
  );

  const parts: string[] = [];
  for (const e of listEvents(db, { region_id: regionId, from: opts.from, to: opts.to })) {
    if (opts.eventId !== undefined && e.id !== opts.eventId) continue;
    if (e.status === 'cancelled') {
      const at = Date.parse(e.cancelled_at ?? e.last_seen_at ?? '');
      if (!Number.isNaN(at) && at < cutoff) continue;
    }
    const clean = {
      ...e,
      description: e.description && cfg.redact_contact ? redactContactText(e.description) : e.description,
      address: e.address && cfg.redact_contact ? redactContactText(e.address) : e.address,
    };
    parts.push(eventToVevent(clean, { dtstamp: e.first_seen_at ?? e.start_utc, minimal: restricted.has(e.id) }));
  }

  const head = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//event-calendar//EC//EN', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(region.name)}`].map(foldLine);
  const body = [...head, ...parts, 'END:VCALENDAR'].join('\r\n') + '\r\n';
  return { body, etag: computeEtag(body) };
}
