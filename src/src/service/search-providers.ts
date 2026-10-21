import * as cheerio from 'cheerio';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { fetchSafe } from '../net/fetcher.ts';
import { RobotsCache, checkRobots } from '../net/robots.ts';
import type { FetchStageDeps } from '../pipeline/fetch-stage.ts';
import type { SearchHit, SearchProvider } from './discover.ts';

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const DDG_URL = 'https://html.duckduckgo.com/html/';
/** after a DuckDuckGo bot challenge, skip it for this long instead of retrying */
const DDG_COOLDOWN_MS = 6 * 3600 * 1000;

/** Brave Search API (web). Needs an API key; robots.txt does not apply to the API. */
export function braveProvider(apiKey: string, net: FetchStageDeps): SearchProvider {
  return async (query, limit) => {
    const u = `${BRAVE_URL}?${new URLSearchParams({ q: query, count: String(Math.min(limit, 20)) })}`;
    await net.limiter.wait(new URL(u).host);
    const r = await fetchSafe(u, {
      resolve: net.resolve, config: net.config,
      headers: { accept: 'application/json', 'x-subscription-token': apiKey },
    });
    if (r.outcomeHint !== 'ok') throw new AppError('FETCH_FAILED', `brave search failed: ${r.error ?? r.outcomeHint}`, { status: r.status });
    const j = JSON.parse(r.body) as { web?: { results?: Array<{ url?: string; title?: string }> } };
    return (j.web?.results ?? []).filter((x) => typeof x.url === 'string')
      .map((x) => ({ url: x.url!, ...(x.title ? { title: x.title } : {}) }));
  };
}

/** DuckDuckGo result links are //duckduckgo.com/l/?uddg=<target>; ads go through y.js and are dropped. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const $ = cheerio.load(html);
  const out: SearchHit[] = [];
  for (const a of $('a.result__a').toArray()) {
    const href = $(a).attr('href') ?? '';
    let target: string | null;
    try {
      const u = new URL(href, 'https://duckduckgo.com/');
      target = u.hostname.endsWith('duckduckgo.com') ? u.searchParams.get('uddg') : u.toString();
    } catch { continue; }
    if (!target || !/^https?:\/\//.test(target)) continue;
    const title = $(a).text().trim();
    out.push({ url: target, ...(title ? { title } : {}) });
  }
  return out;
}

/**
 * DuckDuckGo HTML endpoint (robots.txt checked). A bot challenge (login_or_captcha) is never worked around:
 * the provider returns no hits and stays off for DDG_COOLDOWN_MS.
 */
export function duckDuckGoProvider(net: FetchStageDeps, robotsCache?: RobotsCache): SearchProvider {
  let blockedUntil = 0;
  return async (query, limit) => {
    if (net.clock.now() < blockedUntil) return [];
    const u = `${DDG_URL}?${new URLSearchParams({ q: query })}`;
    const host = new URL(u).host;
    const fetchRobots = async (x: string) => {
      await net.limiter.wait(host);
      const r = await fetchSafe(x, { resolve: net.resolve, config: net.config });
      return { status: r.status, text: r.body };
    };
    const v = await checkRobots(u, { clock: net.clock, ...(robotsCache ? { cache: robotsCache } : {}), fetch: fetchRobots });
    if (v.decision !== 'allowed') return [];
    await net.limiter.wait(host, { crawlDelay: v.crawlDelay });
    const r = await fetchSafe(u, { resolve: net.resolve, config: net.config });
    if (r.outcomeHint === 'login_or_captcha' || /anomaly-modal|confirm this search was made by a human/i.test(r.body)) {
      blockedUntil = net.clock.now() + DDG_COOLDOWN_MS;
      return [];
    }
    if (r.outcomeHint !== 'ok') throw new AppError('FETCH_FAILED', `duckduckgo search failed: ${r.error ?? r.outcomeHint}`, { status: r.status });
    return parseDuckDuckGo(r.body).slice(0, limit);
  };
}

/** Ask each provider in order, merging unique URLs up to limit; one provider failing does not stop the rest. */
export function combineProviders(providers: SearchProvider[]): SearchProvider {
  return async (query, limit) => {
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    let lastErr: unknown = null;
    let anyOk = false;
    for (const p of providers) {
      if (out.length >= limit) break;
      try {
        for (const h of await p(query, limit - out.length)) {
          if (seen.has(h.url)) continue;
          seen.add(h.url);
          out.push(h);
        }
        anyOk = true;
      } catch (e) { lastErr = e; }
    }
    if (!anyOk && lastErr) throw lastErr;
    return out.slice(0, limit);
  };
}

/** config.search_providers -> one provider, or 'none' when nothing usable is configured. */
export function buildSearchProvider(config: Config, net: FetchStageDeps): 'none' | SearchProvider {
  const robots = net.robotsCache ?? new RobotsCache(config.robots_cache);
  const list: SearchProvider[] = [];
  for (const name of config.search_providers) {
    if (name === 'brave' && config.brave_api_key !== '') list.push(braveProvider(config.brave_api_key, net));
    else if (name === 'duckduckgo') list.push(duckDuckGoProvider(net, robots));
  }
  return list.length === 0 ? 'none' : combineProviders(list);
}
