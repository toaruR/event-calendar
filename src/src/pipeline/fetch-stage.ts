import type { Clock } from '../clock.ts';
import type { Config } from '../config.ts';
import { fetchSafe } from '../net/fetcher.ts';
import type { Conditional, FetchSafeResult } from '../net/fetcher.ts';
import { RateLimiter } from '../net/rate-limiter.ts';
import { RobotsCache, checkRobots } from '../net/robots.ts';
import { retryWithBackoff } from '../net/backoff.ts';
import type { Rand } from '../net/backoff.ts';
import type { Resolver } from '../net/ssrf.ts';

export interface FetchStageDeps {
  clock: Clock;
  rand?: Rand;
  /** shared across jobs so host_rate applies between them */
  limiter: RateLimiter;
  robotsCache?: RobotsCache;
  resolve?: Resolver;
  config?: Partial<Config>;
}

export type FetchStageResult =
  | { kind: 'ok'; status: number; text: string; etag: string | null; lastModified: string | null }
  | { kind: 'not_modified'; status: 304 }
  | { kind: 'partial'; status: number; error: string }
  | { kind: 'blocked_robots'; error: string }
  | { kind: 'robots_deferred'; error: string }
  | { kind: 'login_or_captcha'; status: number; error: string }
  | { kind: 'rate_limited'; status: number; retryAfterSec: number | null; error: string }
  | { kind: 'failed'; status: number; error: string };

/** robots check -> host_rate wait -> fetchSafe -> retry_backoff. Throws AppError(SSRF_BLOCKED) from the SSRF guard. */
export async function fetchStage(url: string, conditional: Conditional | undefined, deps: FetchStageDeps): Promise<FetchStageResult> {
  const { clock, limiter } = deps;
  const host = new URL(url).host.toLowerCase();
  const safeOpts = { resolve: deps.resolve, config: deps.config };

  const verdict = await checkRobots(url, {
    clock,
    cache: deps.robotsCache,
    fetch: async (u) => {
      await limiter.wait(host);
      const r = await fetchSafe(u, safeOpts);
      return { status: r.status, text: r.body };
    },
  });
  if (verdict.decision === 'blocked') return { kind: 'blocked_robots', error: 'blocked by robots.txt' };
  if (verdict.decision === 'deferred') return { kind: 'robots_deferred', error: 'robots.txt unavailable (5xx/network); deferred' };

  let last: FetchSafeResult | undefined;
  const r = await retryWithBackoff(async () => {
    await limiter.wait(host, { crawlDelay: verdict.crawlDelay });
    last = await fetchSafe(url, { ...safeOpts, conditional });
    return { status: last.status, retryAfterSec: last.retryAfterSec ?? null };
  }, clock, deps.rand);
  const f = last!;

  if (r.outcome === 'failed') {
    if (f.status === 429) {
      return { kind: 'rate_limited', status: 429, retryAfterSec: f.retryAfterSec ?? null, error: 'http 429' };
    }
    return { kind: 'failed', status: f.status, error: f.error ?? `http ${f.status}` };
  }
  if (f.outcomeHint === 'not_modified') return { kind: 'not_modified', status: 304 };
  if (f.status >= 300) return { kind: 'failed', status: f.status, error: f.error ?? `http ${f.status}` };
  if (f.outcomeHint === 'login_or_captcha') return { kind: 'login_or_captcha', status: f.status, error: 'login or captcha page' };
  if (f.truncated) return { kind: 'partial', status: f.status, error: 'body exceeded body_max; truncated' };
  return { kind: 'ok', status: f.status, text: f.body, etag: f.etag, lastModified: f.lastModified };
}

export { RateLimiter, RobotsCache };
