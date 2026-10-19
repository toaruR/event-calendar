import type { Config } from '../config.ts';
import { extractIcal } from './ical.ts';
import { extractJsonLd } from './jsonld.ts';
import { extractRss } from './rss.ts';
import { extractJsonApi } from './json-api.ts';
import { extractCss } from './css.ts';
import { extractYahooRealtime } from './yahoo-realtime.ts';
import type { CssSpec } from './css.ts';
import { extractWithLlm } from './llm-fallback.ts';
import type { LlmClient, LlmValidate } from './llm-fallback.ts';
import type { ExtractResult, RawItem } from './types.ts';
import { findEventDateIn } from '../normalize/event-date.ts';

export type SourceKind = 'ical' | 'rss' | 'jsonld' | 'html' | 'json_api';

export interface ExtractSpec {
  /** 'content': take the event date from title/description/body instead of the feed/page date; undated items are dropped */
  date_from?: 'published' | 'content';
  /** keep only items whose title/description/body contains one of these (e.g. 開催, 実施) */
  include_keywords?: string[];
  /** html only: site-specific parser used instead of JSON-LD/CSS */
  parser?: 'yahoo_realtime';
  fetch?: CssSpec['fetch'];
  extract?: CssSpec['extract'] & { llm_fallback?: boolean };
}

export interface ExtractDeps {
  now: number | Date;
  config?: Partial<Config>;
  baseUrl?: string;
  fetchPage?: (url: string) => Promise<string>;
  llmClient?: LlmClient;
  llmValidate?: LlmValidate;
  /** overridable extractors (test spies) */
  extractors?: Partial<{
    ical: typeof extractIcal;
    jsonld: typeof extractJsonLd;
    rss: typeof extractRss;
    jsonApi: typeof extractJsonApi;
    css: typeof extractCss;
    llm: typeof extractWithLlm;
  }>;
}

export interface ExtractOutcome extends ExtractResult {
  /** which extractor produced the items ('none' when empty) */
  via: 'ical' | 'jsonld' | 'rss' | 'json_api' | 'css' | 'llm' | 'yahoo_realtime' | 'none';
  /** structured error from CSS extraction (e.g. INVALID_ARGUMENT) */
  errorCode?: string;
}

/**
 * date_from:'content' — replace each item's start/end with the first event date found in
 * title -> description -> content (year-less dates are resolved against the published date).
 */
export function applyContentDates(items: RawItem[], deps: Pick<ExtractDeps, 'now' | 'config'>): { items: RawItem[]; dropped: number } {
  const now = deps.now instanceof Date ? deps.now : new Date(deps.now);
  const pastWindow = deps.config?.year_past_window ?? 30;
  const futureWindow = deps.config?.year_future_window ?? 183;
  const out: RawItem[] = [];
  let dropped = 0;
  for (const it of items) {
    const pub = it.start ? Date.parse(it.start) : Number.NaN;
    const ref = Number.isNaN(pub) ? now : new Date(pub);
    const d = findEventDateIn([it.title, it.description, it.content], { ref, pastWindow, futureWindow });
    if (!d) { dropped++; continue; }
    const { content: _content, ...rest } = it;
    out.push({ ...rest, start: d.start, end: d.end, ...(d.status === 'tentative' ? { status: 'tentative' } : {}) });
  }
  return { items: out, dropped };
}

/**
 * Dispatch by kind. Priority: iCal -> JSON-LD -> RSS/Atom -> CSS -> LLM.
 * The first extractor that yields >=1 item wins; later ones are not called.
 * LLM runs only when spec.extract.llm_fallback === true and nothing else yielded items.
 */
export async function extract(
  kind: SourceKind,
  body: string,
  spec: ExtractSpec,
  deps: ExtractDeps,
): Promise<ExtractOutcome> {
  const raw = await extractRaw(kind, body, spec, deps);
  const r = filterKeywords(raw, spec.include_keywords);
  if (spec.date_from !== 'content' || r.items.length === 0) return r;
  const { items, dropped } = applyContentDates(r.items, deps);
  const warnings = dropped > 0 ? [...r.warnings, `${dropped} item(s) without event date in content dropped`] : r.warnings;
  return { ...r, items, warnings, ...(items.length === 0 ? { via: 'none' as const } : {}) };
}

function filterKeywords(r: ExtractOutcome, keywords: string[] | undefined): ExtractOutcome {
  if (!keywords || keywords.length === 0 || r.items.length === 0) return r;
  const items = r.items.filter((it) =>
    [it.title, it.description, it.content].some((t) => t && keywords.some((k) => t.includes(k))));
  const dropped = r.items.length - items.length;
  if (dropped === 0) return r;
  const warnings = [...r.warnings, `${dropped} item(s) without include_keywords dropped`];
  return { ...r, items, warnings, ...(items.length === 0 ? { via: 'none' as const } : {}) };
}

async function extractRaw(
  kind: SourceKind,
  body: string,
  spec: ExtractSpec,
  deps: ExtractDeps,
): Promise<ExtractOutcome> {
  const x = deps.extractors ?? {};
  const ical = x.ical ?? extractIcal;
  const jsonld = x.jsonld ?? extractJsonLd;
  const rss = x.rss ?? extractRss;
  const jsonApi = x.jsonApi ?? extractJsonApi;
  const css = x.css ?? extractCss;
  const llm = x.llm ?? extractWithLlm;
  const warnings: string[] = [];
  let error: string | undefined;
  let errorCode: string | undefined;

  const take = (r: ExtractResult, via: ExtractOutcome['via']): ExtractOutcome | null => {
    warnings.push(...r.warnings);
    if (r.items.length > 0) return { items: r.items, warnings, via };
    if (r.error) error = r.error;
    return null;
  };

  let hit: ExtractOutcome | null = null;
  if (kind === 'ical') hit = take(ical(body, { now: deps.now, ...(deps.config ? { config: deps.config } : {}) }), 'ical');
  else if (kind === 'json_api') hit = take(jsonApi(body), 'json_api');
  else if (kind === 'rss') hit = take(rss(body), 'rss');
  else if (kind === 'jsonld') hit = take(jsonld(body), 'jsonld');
  else if (kind === 'html' && spec.parser === 'yahoo_realtime') hit = take(extractYahooRealtime(body), 'yahoo_realtime');
  else if (kind === 'html') {
    hit = take(jsonld(body), 'jsonld');
    if (!hit && spec.extract?.item_selector) {
      const r = await css(body, { fetch: spec.fetch, extract: spec.extract } as CssSpec, {
        fetchPage: deps.fetchPage ?? (async () => { throw new Error('fetchPage not provided'); }),
        baseUrl: deps.baseUrl ?? 'http://localhost/',
        ...(deps.config ? { config: deps.config } : {}),
      });
      warnings.push(...r.warnings);
      if (r.items.length > 0) hit = { items: r.items, warnings, via: 'css' };
      else if (r.error) { error = r.error.message; errorCode = r.error.code; }
    }
  }
  if (hit) return hit;

  if (spec.extract?.llm_fallback === true && deps.llmClient) {
    const r = await llm(body, {
      client: deps.llmClient,
      ...(deps.llmValidate ? { validate: deps.llmValidate } : {}),
    });
    warnings.push(...r.warnings);
    if (r.items.length > 0) return { items: r.items, warnings, via: 'llm' };
    if (r.error) error = r.error;
  }
  return { items: [], warnings, via: 'none', ...(error ? { error } : {}), ...(errorCode ? { errorCode } : {}) };
}
