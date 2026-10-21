import * as cheerio from 'cheerio';
import type { ExtractResult, RawItem } from './types.ts';

/** RSS 2.0 / Atom -> RawItem. Never throws. */
export function extractRss(xml: string): ExtractResult {
  try {
    if (!/<\/(rss|feed|rdf:RDF)\s*>/i.test(xml)) {
      return { items: [], warnings: [], error: 'feed parse failed: no complete rss/feed root element' };
    }
    const $ = cheerio.load(xml, { xml: true });
    const items: RawItem[] = [];
    const warnings: string[] = [];
    const txt = (el: { children(sel: string): { first(): { text(): string } } }, sel: string): string | null => {
      const t = el.children(sel).first().text().trim();
      return t === '' ? null : t;
    };
    const nodes = $('item, entry').toArray();
    const seen = new Set<unknown>();
    for (const n of nodes) {
      if (seen.has(n)) continue;
      seen.add(n);
      const el = $(n);
      const title = txt(el, 'title');
      if (!title) { warnings.push('feed item without title skipped'); continue; }
      let url = txt(el, 'link');
      if (!url) {
        const links = el.children('link').toArray().map((l) => $(l));
        const alt = links.find((l) => (l.attr('rel') ?? 'alternate') === 'alternate') ?? links[0];
        url = alt?.attr('href')?.trim() || null;
      } else if (el.children('link').first().attr('href')) {
        url = el.children('link').first().attr('href')!.trim();
      }
      const pub = txt(el, 'pubDate');
      let start: string | null;
      if (pub) {
        const ms = Date.parse(pub);
        start = Number.isNaN(ms) ? pub : new Date(ms).toISOString().replace('.000Z', 'Z');
      } else {
        start = txt(el, 'published') ?? txt(el, 'updated');
      }
      const uid = txt(el, 'guid') ?? txt(el, 'id') ?? url ?? `${title}|${start ?? ''}`;
      const encoded = el.children('content\\:encoded').first().text().trim();
      const content = encoded === '' ? null : cheerio.load(encoded).root().text().replaceAll('\n', ' ').trim() || null;
      items.push({
        source_uid: uid, title, start, end: null, venue: null, address: null, url,
        description: txt(el, 'description') ?? txt(el, 'summary') ?? txt(el, 'content'),
        ...(content ? { content } : {}),
      });
    }
    return { items, warnings };
  } catch (e) {
    return { items: [], warnings: [], error: `feed parse failed: ${(e as Error).message}` };
  }
}
