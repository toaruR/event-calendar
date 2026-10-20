import * as cheerio from 'cheerio';
import type { ExtractResult, RawItem } from './types.ts';

/** The official monthly table identifies event cells as eventidx-{day}-{index}. */
export function extractSaitamaCalendar(html: string, baseUrl: string): ExtractResult {
  const $ = cheerio.load(html);
  const year = Number($('input[name="year"]').first().val());
  const month = Number($('input[name="month"]').first().val());
  if (!Number.isInteger(year) || year < 1900 || !Number.isInteger(month) || month < 1 || month > 12) {
    return { items: [], warnings: [], error: 'calendar year/month missing or invalid' };
  }
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  $('table.calendar_tbl td[id^="eventidx-"]').each((_, cell) => {
    const day = Number(/^eventidx-(\d+)-/.exec($(cell).attr('id') ?? '')?.[1]);
    if (!Number.isInteger(day) || day < 1 || day > days) return;
    const start = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    $(cell).find('a[href]').each((_, el) => {
      const title = ($(el).attr('title') || $(el).text()).replace(/\s+/g, ' ').trim();
      let url: string;
      try { url = new URL($(el).attr('href')!, baseUrl).href; } catch { return; }
      if (!title || !/^https?:/.test(url)) return;
      const uid = `${url}|${start}`;
      if (seen.has(uid)) return;
      seen.add(uid);
      items.push({ source_uid: uid, title, start, end: null, venue: null, address: null, url, description: null });
    });
  });
  return { items, warnings: [] };
}
