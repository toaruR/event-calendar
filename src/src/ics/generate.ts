import { foldLine } from './fold.ts';
import { stripControl } from '../normalize/sanitize.ts';
import { utcToLocal } from '../normalize/time.ts';

export interface IcsEvent {
  id: string; title: string; start_utc: string; end_utc: string | null;
  all_day: boolean; start_local_date: string | null; tz: string;
  venue_name: string | null; address: string | null;
  description: string | null; url: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled'; seq: number;
  first_seen_at?: string | null;
}

export interface VeventOpts {
  /** ISO timestamp used for DTSTAMP (kept stable by caller for deterministic output). */
  dtstamp: string;
  /** Redistribution-restricted: only SUMMARY and URL are emitted. */
  minimal?: boolean;
}

const p2 = (n: number): string => String(n).padStart(2, '0');

export function escapeText(s: string): string {
  return stripControl(s).replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,');
}

function utcStamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}

function dateOnly(s: string): string { return s.replace(/-/g, '').slice(0, 8); }

function nextDay(ymd: string): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + 1));
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
}

/** Returns folded VEVENT block lines joined by CRLF (no trailing CRLF). */
export function eventToVevent(event: IcsEvent, opts: VeventOpts): string {
  const lines: string[] = ['BEGIN:VEVENT'];
  lines.push(`UID:${stripControl(event.id).replace(/[\s;,:]/g, '_')}@ec.local`);
  lines.push(`DTSTAMP:${utcStamp(opts.dtstamp)}`);
  if (event.all_day && event.start_local_date) {
    const s = dateOnly(event.start_local_date);
    lines.push(`DTSTART;VALUE=DATE:${s}`);
    if (event.end_utc) {
      const l = utcToLocal(event.end_utc, event.tz);
      const e = nextDay(`${l.year}${p2(l.month)}${p2(l.day)}`);
      if (e > nextDay(s)) lines.push(`DTEND;VALUE=DATE:${e}`);
    }
  } else {
    lines.push(`DTSTART:${utcStamp(event.start_utc)}`);
    if (event.end_utc) lines.push(`DTEND:${utcStamp(event.end_utc)}`);
  }
  lines.push(`SEQUENCE:${Math.trunc(event.seq)}`);
  lines.push(`STATUS:${event.status.toUpperCase()}`);
  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (!opts.minimal) {
    const loc = [event.venue_name, event.address].filter((x): x is string => !!x).join(' ');
    if (loc) lines.push(`LOCATION:${escapeText(loc)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }
  if (event.url) lines.push(`URL:${stripControl(event.url).replace(/\s/g, '%20')}`);
  lines.push('END:VEVENT');
  return lines.map(foldLine).join('\r\n');
}
