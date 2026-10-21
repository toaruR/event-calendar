import type { Config } from '../config.ts';
import { fetchSafe } from './fetcher.ts';
import type { FetchStageDeps } from '../pipeline/fetch-stage.ts';

/** Kinds whose body is HTML, so a jina-rendered page can stand in for it. */
const JINA_KINDS = new Set(['html', 'jsonld']);

/** Network error (status 0) or 5xx: a page that could not be read, not one the site refused (4xx/robots/captcha). */
export function isReadFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

export function jinaApplies(kind: string, config: Pick<Config, 'jina_fallback'>): boolean {
  return config.jina_fallback && JINA_KINDS.has(kind);
}

/**
 * Re-read `url` through the jina reader (config.jina_base + url) as rendered HTML.
 * Callers must have passed the target's robots check already. Returns null on any failure
 * (including a login/captcha page: never used to get past one).
 */
export async function fetchViaJina(url: string, net: FetchStageDeps, config: Pick<Config, 'jina_base'>): Promise<string | null> {
  const target = `${config.jina_base}${url}`;
  await net.limiter.wait(new URL(target).host.toLowerCase());
  try {
    const r = await fetchSafe(target, { resolve: net.resolve, config: net.config, headers: { 'x-return-format': 'html' } });
    return r.outcomeHint === 'ok' && !r.truncated && r.body !== '' ? r.body : null;
  } catch { return null; }
}
