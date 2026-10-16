import type { Config } from '../config.ts';
import { extractIcal } from './ical.ts';
import { extractJsonLd } from './jsonld.ts';
import { extractRss } from './rss.ts';
import { extractJsonApi } from './json-api.ts';
import { extractCss } from './css.ts';
import type { CssSpec } from './css.ts';
import { extractWithLlm } from './llm-fallback.ts';
import type { LlmClient, LlmValidate } from './llm-fallback.ts';
import type { ExtractResult } from './types.ts';

export type SourceKind = 'ical' | 'rss' | 'jsonld' | 'html' | 'json_api';

export interface ExtractSpec {
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
  via: 'ical' | 'jsonld' | 'rss' | 'json_api' | 'css' | 'llm' | 'none';
  /** structured error from CSS extraction (e.g. INVALID_ARGUMENT) */
  errorCode?: string;
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
