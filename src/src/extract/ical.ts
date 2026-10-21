import ICAL from 'ical.js';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import type { ExtractResult, RawItem } from './types.ts';

export interface IcalOptions {
  /** epoch ms (or Date); recurring series are expanded from here to now + recurrence_horizon days. */
  now: number | Date;
  config?: Partial<Config>;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function toIso(t: ICAL.Time): string {
  const d = `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
  if (t.isDate) return d;
  const local = `${d}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
  const zone = t.zone?.tzid;
  if (zone === 'UTC' || zone === 'Z') return `${local}Z`;
  if (!zone || zone === 'floating') return local;
  // zoned time with known VTIMEZONE: convert to UTC
  return new Date(t.toUnixTime() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function statusOf(v: unknown): RawItem['status'] | undefined {
  const s = text(v)?.toUpperCase();
  if (s === 'CANCELLED') return 'cancelled';
  if (s === 'TENTATIVE') return 'tentative';
  if (s === 'CONFIRMED') return 'confirmed';
  return undefined;
}

export function extractIcal(src: string, opts: IcalOptions): ExtractResult {
  const horizonDays = { ...defaultConfig(), ...(opts.config ?? {}) }.recurrence_horizon;
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : opts.now;
  const horizonMs = nowMs + horizonDays * 86400_000;
  const items: RawItem[] = [];
  const warnings: string[] = [];
  try {
    const root = new ICAL.Component(ICAL.parse(src));
    if (root.name !== 'vcalendar') throw new Error('not a VCALENDAR');
    const tzs = root.getAllSubcomponents('vtimezone');
    for (const tz of tzs) ICAL.TimezoneService.register(tz);
    try {
      for (const comp of root.getAllSubcomponents('vevent')) {
        const ev = new ICAL.Event(comp);
        const uid = text(ev.uid) ?? text(ev.summary) ?? 'unknown';
        const base = {
          title: text(ev.summary) ?? '',
          venue: text(ev.location),
          address: null,
          url: text(comp.getFirstPropertyValue('url')),
          description: text(ev.description),
          ...(statusOf(comp.getFirstPropertyValue('status')) ? { status: statusOf(comp.getFirstPropertyValue('status')) } : {}),
        };
        const hasEnd = comp.hasProperty('dtend') || comp.hasProperty('duration');
        const mk = (uidv: string, s: ICAL.Time | null, e: ICAL.Time | null): RawItem => ({
          source_uid: uidv, ...base,
          start: s ? toIso(s) : null,
          end: e && hasEnd ? toIso(e) : null,
        });
        if (!ev.isRecurring()) {
          items.push(mk(uid, ev.startDate ?? null, ev.endDate ?? null));
          continue;
        }
        const dur = ev.duration;
        const it = ev.iterator();
        let truncated = false;
        for (let guard = 0; guard < 100000; guard++) {
          const occ = it.next();
          if (!occ) break;
          const ms = occ.toJSDate().getTime();
          if (ms >= horizonMs) { truncated = true; break; }
          if (ms < nowMs) continue;
          const end = occ.clone();
          end.addDuration(dur);
          items.push(mk(`${uid}@${toIso(occ)}`, occ, end));
        }
        if (truncated) {
          warnings.push(`recurrence_horizon exceeded: ${uid} truncated at ${horizonDays} days`);
        }
      }
    } finally {
      for (const tz of tzs) ICAL.TimezoneService.remove(String(tz.getFirstPropertyValue('tzid')));
    }
  } catch (e) {
    return { items: [], warnings: [], error: `ical parse failed: ${(e as Error).message}` };
  }
  return { items, warnings };
}
