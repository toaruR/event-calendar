import { createHash } from 'node:crypto';
import { defaultConfig } from '../config.ts';

export interface DedupEvent {
  title: string;
  start_utc: string;
  start_local_date: string;
  venue_name?: string | null;
  description?: string | null;
  address?: string | null;
  url?: string | null;
  end_utc?: string | null;
  lat?: number | null;
  lon?: number | null;
  trust?: number;
}

export interface DedupParams { dedup_time_window: number; dedup_jaccard: number }

export function normalizeTitle(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function normalizeVenue(v: string | null | undefined): string {
  return (v ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** dedup_key = sha1(NFKC title | start_local_date | normalized venue) */
export function dedupKey(title: string, startLocalDate: string, venue: string | null | undefined): string {
  return createHash('sha1')
    .update(`${normalizeTitle(title)}|${startLocalDate}|${normalizeVenue(venue)}`)
    .digest('hex');
}

function bigrams(s: string): Set<string> {
  const t = normalizeTitle(s);
  const out = new Set<string>();
  const chars = Array.from(t);
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** Character bi-gram Jaccard similarity (set-based). */
export function bigramJaccard(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 && B.size === 0) return normalizeTitle(a) === normalizeTitle(b) ? 1 : 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function shouldMerge(
  a: DedupEvent,
  b: DedupEvent,
  params: DedupParams = defaultConfig(),
): boolean {
  if (a.start_local_date !== b.start_local_date) return false;
  const diffMin = Math.abs(Date.parse(a.start_utc) - Date.parse(b.start_utc)) / 60000;
  if (!(diffMin <= params.dedup_time_window)) return false;
  const va = normalizeVenue(a.venue_name);
  const vb = normalizeVenue(b.venue_name);
  if (va !== '' && vb !== '' && va !== vb) return false;
  return bigramJaccard(a.title, b.title) >= params.dedup_jaccard;
}

function infoScore(e: DedupEvent): number {
  return (
    (e.description?.length ?? 0) +
    (e.venue_name ? 1 : 0) + (e.address ? 1 : 0) + (e.url ? 1 : 0) + (e.end_utc ? 1 : 0) +
    (e.lat != null && e.lon != null ? 1 : 0)
  );
}

/** Higher trust wins; on tie, more information wins; on tie, a. */
export function pickPrimary<T extends DedupEvent>(a: T, b: T): T {
  const ta = a.trust ?? 0;
  const tb = b.trust ?? 0;
  if (ta !== tb) return ta > tb ? a : b;
  return infoScore(b) > infoScore(a) ? b : a;
}
