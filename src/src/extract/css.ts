import * as cheerio from 'cheerio';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import type { RawItem } from './types.ts';

export interface CssField { css: string; attr?: string; absolutize?: boolean }
export interface CssSpec {
  fetch?: { paging?: { type?: 'next_link'; selector?: string; max_pages?: number } };
  /** year_from: page-level element whose "YYYY年" is prefixed to year-less item dates (e.g. a monthly calendar heading) */
  extract: { item_selector: string; fields: Record<string, CssField>; year_from?: { css: string } };
}
export interface CssDeps {
  /** fetches a follow-up page (absolute URL) and returns HTML; may throw. */
  fetchPage: (url: string) => Promise<string>;
  baseUrl: string;
  config?: Partial<Config>;
}
/** RawItem plus `date`, the raw value of the spec's `date` field (also mapped to `start`). */
export type CssItem = RawItem & { date: string | null };
export interface CssResult {
  items: CssItem[];
  warnings: string[];
  error?: { code: 'INVALID_ARGUMENT'; message: string };
}

const norm = (v: string | undefined | null): string | null => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
};

function abs(v: string, base: string): string {
  try { return new URL(v, base).href; } catch { return v; }
}

function pageItems(html: string, spec: CssSpec, base: string): { items: CssItem[]; $: cheerio.CheerioAPI } {
  const $ = cheerio.load(html);
  const items: CssItem[] = [];
  const { item_selector, fields, year_from } = spec.extract;
  const pageYear = year_from ? /(\d{4})\s*年/.exec($(year_from.css).first().text())?.[1] : undefined;
  const withYear = (v: string | null): string | null =>
    v && pageYear && !/\d{4}\s*[年\-/]/.test(v) && /^\D{0,3}\d{1,2}\s*月/.test(v) ? `${pageYear}年${v}` : v;
  $(item_selector).each((_i, el) => {
    const root = $(el);
    const get = (name: string): string | null => {
      const f = fields[name];
      if (!f) return null;
      const node = root.find(f.css).first();
      const target = node.length ? node : (root.is(f.css) ? root : node);
      if (!target.length) return null;
      let v = f.attr ? norm(target.attr(f.attr)) : norm(target.text());
      if (v && f.absolutize) v = abs(v, base);
      return v;
    };
    const title = get('title');
    if (!title) return;
    const date = withYear(get('date'));
    const url = get('url');
    const start = date ?? get('start');
    items.push({
      source_uid: url ?? `${title}|${start ?? ''}`,
      title, date, start, end: get('end'), venue: get('venue'), address: get('address'),
      url, description: get('description'),
    });
  });
  return { items, $ };
}

export async function extractCss(html: string, spec: CssSpec, deps: CssDeps): Promise<CssResult> {
  const cfg = { ...defaultConfig(), ...(deps.config ?? {}) };
  const paging = spec.fetch?.paging;
  const maxPages = paging?.max_pages ?? cfg.max_pages;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > cfg.max_pages_limit) {
    return { items: [], warnings: [], error: { code: 'INVALID_ARGUMENT', message: `max_pages must be an integer in 1..${cfg.max_pages_limit}` } };
  }
  const items: CssItem[] = [];
  const warnings: string[] = [];
  let curHtml = html;
  let curUrl = deps.baseUrl;
  try {
    for (let page = 1; ; page++) {
      const r = pageItems(curHtml, spec, curUrl);
      items.push(...r.items);
      if (paging?.type !== 'next_link' || !paging.selector) break;
      const href = r.$(paging.selector).first().attr('href');
      if (!href) break;
      if (page >= maxPages) {
        warnings.push(`max_pages (${maxPages}) reached; remaining pages not followed`);
        break;
      }
      const next = abs(href, curUrl);
      try {
        curHtml = await deps.fetchPage(next);
      } catch (e) {
        warnings.push(`next page fetch failed: ${(e as Error).message}`);
        break;
      }
      curUrl = next;
    }
  } catch (e) {
    return { items, warnings, error: { code: 'INVALID_ARGUMENT', message: `css extraction failed: ${(e as Error).message}` } };
  }
  return { items, warnings };
}
