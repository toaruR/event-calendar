import type { ExtractResult, RawItem } from './types.ts';

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** json_api standard mapping: top-level array; each element's same-named keys (§3 event columns) map to RawItem. */
export function extractJsonApi(body: string): ExtractResult {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return { items: [], warnings: [], error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(data)) {
    return { items: [], warnings: [], error: 'json_api body must be a top-level array' };
  }
  const items: RawItem[] = [];
  const warnings: string[] = [];
  for (const o of data) {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) { warnings.push('non-object element skipped'); continue; }
    const r = o as Record<string, unknown>;
    const title = s(r['title']);
    if (!title) { warnings.push('element without title skipped'); continue; }
    const start = s(r['start_utc']);
    const url = s(r['url']);
    const item: RawItem = {
      source_uid: s(r['source_uid']) ?? url ?? `${title}|${start ?? ''}`,
      title, start, end: s(r['end_utc']), venue: s(r['venue_name']), address: s(r['address']),
      url, description: s(r['description']),
    };
    const st = r['status'];
    if (st === 'confirmed' || st === 'tentative' || st === 'cancelled') item.status = st;
    items.push(item);
  }
  return { items, warnings };
}
