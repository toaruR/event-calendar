import * as cheerio from 'cheerio';
import type { ExtractResult, RawItem } from './types.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function isEvent(o: Json): boolean {
  const t = o['@type'];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === 'string' && /Event$/.test(x));
}

function collect(node: unknown, out: Json[]): void {
  if (Array.isArray(node)) { for (const n of node) collect(n, out); return; }
  if (!isObj(node)) return;
  if (isEvent(node)) out.push(node);
  if (node['@graph'] !== undefined) collect(node['@graph'], out);
}

function placeName(loc: unknown): string | null {
  if (Array.isArray(loc)) return placeName(loc[0]);
  if (typeof loc === 'string') return str(loc);
  return isObj(loc) ? str(loc['name']) : null;
}

function placeAddress(loc: unknown): string | null {
  if (Array.isArray(loc)) return placeAddress(loc[0]);
  if (!isObj(loc)) return null;
  const a = loc['address'];
  if (typeof a === 'string') return str(a);
  if (isObj(a)) {
    const parts = ['addressRegion', 'addressLocality', 'streetAddress']
      .map((k) => str(a[k])).filter((x): x is string => x !== null);
    return parts.length ? parts.join('') : null;
  }
  return null;
}

function statusOf(v: unknown): RawItem['status'] | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (/Cancel/i.test(s)) return 'cancelled';
  if (/Scheduled/i.test(s)) return 'confirmed';
  return undefined;
}

export function extractJsonLd(html: string): ExtractResult {
  const result: ExtractResult = { items: [], warnings: [] };
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch (e) {
    return { items: [], warnings: [], error: `html parse failed: ${(e as Error).message}` };
  }
  const events: Json[] = [];
  const errors: string[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const text = $(el).text();
    try {
      collect(JSON.parse(text), events);
    } catch (e) {
      errors.push(`invalid JSON-LD: ${(e as Error).message}`);
    }
  });
  if (errors.length) result.error = errors.join('; ');
  for (const ev of events) {
    const title = str(ev['name']);
    if (!title) { result.warnings.push('event without name skipped'); continue; }
    const start = str(ev['startDate']);
    const url = str(ev['url']);
    const uid = str(ev['@id']) ?? str(ev['identifier']) ?? url ?? `${title}|${start ?? ''}`;
    const item: RawItem = {
      source_uid: uid, title, start, end: str(ev['endDate']),
      venue: placeName(ev['location']), address: placeAddress(ev['location']),
      url, description: str(ev['description']),
    };
    const st = statusOf(ev['eventStatus']);
    if (st) item.status = st;
    result.items.push(item);
  }
  return result;
}
