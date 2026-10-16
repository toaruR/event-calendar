import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config.ts';
import { shouldMerge, pickPrimary } from './dedup.ts';

export interface NormalizedItem {
  source_uid: string;
  title: string;
  start_utc: string;
  end_utc: string | null;
  all_day: boolean;
  start_local_date: string;
  tz: string;
  venue_name: string | null;
  address: string | null;
  description: string | null;
  url: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  dedup_key: string;
  region_confidence: number;
  raw_json: string;
}

export interface UpsertSource { id: string; region_id: string; trust?: number | null }
export type UpsertAction = 'created' | 'merged' | 'updated';
export interface UpsertResult { event_id: string; action: UpsertAction }

export function uuidv7(now: Date): string {
  const b = randomBytes(16);
  let ms = BigInt(now.getTime());
  for (let i = 5; i >= 0; i--) { b[i] = Number(ms & 0xffn); ms >>= 8n; }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const COLS = 'title,start_utc,end_utc,all_day,start_local_date,tz,venue_name,address,description,url,status,dedup_key,region_confidence';

function fieldsOf(it: NormalizedItem): unknown[] {
  return [it.title, it.start_utc, it.end_utc, it.all_day ? 1 : 0, it.start_local_date, it.tz, it.venue_name,
    it.address, it.description, it.url, it.status, it.dedup_key, it.region_confidence];
}

interface EventRow {
  id: string; title: string; start_utc: string; start_local_date: string; venue_name: string | null;
  description: string | null; address: string | null; url: string | null; end_utc: string | null;
  status: string; cancelled_at: string | null;
}

/** Highest trust among the sources referencing an event (default config.trust). */
function eventTrust(db: DatabaseSync, eventId: string, dflt: number): number {
  const rows = db.prepare(
    'SELECT s.trust AS t FROM event_source_ref r JOIN source s ON s.id = r.source_id WHERE r.event_id = ?',
  ).all(eventId) as Array<{ t: number | null }>;
  let m = -1;
  for (const r of rows) m = Math.max(m, r.t ?? dflt);
  return m < 0 ? dflt : m;
}

function cancelEvent(db: DatabaseSync, eventId: string, nowIso: string): void {
  db.prepare("UPDATE event SET status='cancelled', cancelled_at=COALESCE(cancelled_at,?), last_seen_at=?, seq=seq+1 WHERE id=? AND status!='cancelled'")
    .run(nowIso, nowIso, eventId);
}

function applyContent(db: DatabaseSync, eventId: string, it: NormalizedItem, nowIso: string): void {
  const cur = db.prepare(`SELECT ${COLS},cancelled_at FROM event WHERE id = ?`).get(eventId) as Record<string, unknown>;
  const fields = fieldsOf(it);
  const keys = COLS.split(',');
  const same = keys.every((k, i) => cur[k] === fields[i]);
  const cancelled = fields[10] === 'cancelled';
  const cancelledAt = cancelled ? ((cur['cancelled_at'] as string | null) ?? nowIso) : null;
  db.prepare(
    `UPDATE event SET ${keys.map((k) => `${k}=?`).join(',')}, last_seen_at=?, cancelled_at=?, seq = seq + ? WHERE id = ?`,
  ).run(...(fields as never[]), nowIso, cancelledAt, same && (cur['cancelled_at'] === null) === !cancelled ? 0 : 1, eventId);
}

/**
 * Idempotent upsert keyed by (source_id, source_uid); merges near-duplicates from other sources
 * into one event (adding an event_source_ref). seq +1 only when event content/status changes.
 */
export function upsertItem(
  db: DatabaseSync, item: NormalizedItem, source: UpsertSource, config: Config, now: Date = new Date(),
): UpsertResult {
  const nowIso = now.toISOString();
  const ref = db.prepare('SELECT event_id FROM event_source_ref WHERE source_id = ? AND source_uid = ?')
    .get(source.id, item.source_uid) as { event_id: string } | undefined;

  const touchRef = (eventId: string): void => {
    db.prepare('UPDATE event_source_ref SET raw_json=?, seen_at=?, miss_count=0 WHERE source_id=? AND source_uid=?')
      .run(item.raw_json, nowIso, source.id, item.source_uid);
    void eventId;
  };

  if (ref) {
    const refs = Number((db.prepare('SELECT COUNT(*) AS c FROM event_source_ref WHERE event_id = ?')
      .get(ref.event_id) as { c: number }).c);
    if (refs <= 1) {
      applyContent(db, ref.event_id, item, nowIso);
    } else {
      // merged event: only the primary (highest trust) source may rewrite content; any source may cancel
      const mine = source.trust ?? config.trust;
      const cur = db.prepare('SELECT status FROM event WHERE id = ?').get(ref.event_id) as { status: string };
      if (item.status === 'cancelled' && cur.status !== 'cancelled') cancelEvent(db, ref.event_id, nowIso);
      else if (mine >= eventTrust(db, ref.event_id, config.trust) && cur.status !== 'cancelled') applyContent(db, ref.event_id, item, nowIso);
      else db.prepare('UPDATE event SET last_seen_at=? WHERE id=?').run(nowIso, ref.event_id);
    }
    touchRef(ref.event_id);
    return { event_id: ref.event_id, action: 'updated' };
  }

  // exact dedup_key, then near-duplicate on same local date
  const cands = db.prepare(
    `SELECT id,title,start_utc,start_local_date,venue_name,description,address,url,end_utc,status,cancelled_at,dedup_key
     FROM event WHERE region_id = ? AND (dedup_key = ? OR start_local_date = ?)`,
  ).all(source.region_id, item.dedup_key, item.start_local_date) as unknown as Array<EventRow & { dedup_key: string }>;
  const asDedup = { title: item.title, start_utc: item.start_utc, start_local_date: item.start_local_date, venue_name: item.venue_name };
  const hit = cands.find((c) => c.dedup_key === item.dedup_key) ?? cands.find((c) => shouldMerge(c, asDedup, config));

  if (hit) {
    db.prepare('INSERT INTO event_source_ref(event_id,source_id,source_uid,raw_json,seen_at,miss_count) VALUES(?,?,?,?,?,0)')
      .run(hit.id, source.id, item.source_uid, item.raw_json, nowIso);
    const newer = { ...item, trust: source.trust ?? config.trust };
    const existing = { ...hit, trust: eventTrust(db, hit.id, config.trust) };
    const primary = pickPrimary(existing as never, newer as never) as unknown;
    if (primary === newer && hit.status !== 'cancelled') applyContent(db, hit.id, item, nowIso);
    else if (item.status === 'cancelled' && hit.status !== 'cancelled') cancelEvent(db, hit.id, nowIso);
    else db.prepare('UPDATE event SET last_seen_at=? WHERE id=?').run(nowIso, hit.id);
    return { event_id: hit.id, action: 'merged' };
  }

  const id = uuidv7(now);
  db.prepare(
    `INSERT INTO event(id,region_id,${COLS},first_seen_at,last_seen_at,cancelled_at,seq)
     VALUES(${new Array(18).fill('?').join(',')},0)`,
  ).run(id, source.region_id, ...(fieldsOf(item) as never[]), nowIso, nowIso, item.status === 'cancelled' ? nowIso : null);
  db.prepare('INSERT INTO event_source_ref(event_id,source_id,source_uid,raw_json,seen_at,miss_count) VALUES(?,?,?,?,?,0)')
    .run(id, source.id, item.source_uid, item.raw_json, nowIso);
  return { event_id: id, action: 'created' };
}

