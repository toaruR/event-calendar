import type { ExtractResult, RawItem } from './types.ts';

interface Entry { id?: string; url?: string; displayText?: string; createdAt?: number }

const NEXT_DATA = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
const TITLE_MAX = 80;

/** Yahoo! realtime search marks query hits as "\tSTART\t...\tEND\t"; drop the markers. */
function clean(s: string): string {
  return s.replaceAll('\tSTART\t', '').replaceAll('\tEND\t', '').trim();
}

/** Strip Yahoo's utm_* tracking params from the post URL. */
function postUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (k.startsWith('utm_')) url.searchParams.delete(k);
    return url.toString();
  } catch { return null; }
}

/**
 * Yahoo! realtime search (X posts) page -> RawItem. Reads __NEXT_DATA__ timeline entries; start is the post time
 * (use date_from:'content' to take the event date from the text). Never throws.
 */
export function extractYahooRealtime(html: string): ExtractResult {
  const m = NEXT_DATA.exec(html);
  if (!m) return { items: [], warnings: [], error: 'yahoo_realtime: __NEXT_DATA__ not found' };
  let entries: Entry[];
  try {
    const j = JSON.parse(m[1]!) as { props?: { pageProps?: { pageData?: { timeline?: { entry?: Entry[] } } } } };
    entries = j.props?.pageProps?.pageData?.timeline?.entry ?? [];
  } catch (e) {
    return { items: [], warnings: [], error: `yahoo_realtime: __NEXT_DATA__ parse failed: ${(e as Error).message}` };
  }
  const items: RawItem[] = [];
  const warnings: string[] = [];
  for (const e of entries) {
    const text = clean(e.displayText ?? '');
    if (!e.id || text === '') { warnings.push('yahoo_realtime entry without id/text skipped'); continue; }
    const line = text.split('\n')[0]!.trim();
    const title = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
    const start = typeof e.createdAt === 'number' ? new Date(e.createdAt * 1000).toISOString().replace('.000Z', 'Z') : null;
    items.push({
      source_uid: e.id, title, start, end: null, venue: null, address: null,
      url: postUrl(e.url), description: text,
    });
  }
  return { items, warnings };
}
