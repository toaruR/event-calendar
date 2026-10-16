import type { Config } from '../config.ts';
import { defaultConfig } from '../config.ts';
import { assertUrlAllowed } from './ssrf.ts';
import type { Resolver } from './ssrf.ts';
import type { FetchResult } from '../pipeline/run-job.ts';


/**
 * Cancel a stream/reader and ignore any rejection. A cancel failure after a deliberate
 * abort/stop is irrelevant because the response is being discarded.
 */
async function cancelQuietly(target: { cancel(): Promise<void> } | null | undefined): Promise<void> {
  try {
    await target?.cancel();
  } catch {
    // intentionally ignored: see doc comment
  }
}

export type OutcomeHint = 'ok' | 'not_modified' | 'failed' | 'login_or_captcha';

export interface Conditional { etag?: string | null; lastModified?: string | null }

export interface FetchSafeOptions {
  conditional?: Conditional;
  resolve?: Resolver;
  config?: Partial<Config>;
}

export interface FetchSafeResult {
  status: number;
  body: string;
  truncated: boolean;
  outcomeHint: OutcomeHint;
  bytes: number;
  redirects: number;
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
  retryAfterSec?: number | null;
  error?: string;
}

const CAPTCHA_RE = /g-recaptcha|h-captcha|hcaptcha|cf-turnstile|captcha|<input[^>]+type\s*=\s*["']?password/i;

/** Retry-After: delta-seconds or HTTP-date. Returns seconds (>=0) or null. */
export function parseRetryAfter(v: string | null, nowMs: number = Date.now()): number | null {
  if (!v) return null;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : Math.max(0, Math.ceil((ms - nowMs) / 1000));
}

export function looksLikeLoginOrCaptcha(html: string): boolean {
  return CAPTCHA_RE.test(html);
}

/** SSRF-checked on every hop (initial + each redirect). Throws AppError SSRF_BLOCKED. */
export async function fetchSafe(url: string, opts: FetchSafeOptions = {}): Promise<FetchSafeResult> {
  const cfg: Config = { ...defaultConfig(), ...(opts.config ?? {}) } as Config;
  const ssrf = { resolve: opts.resolve, allowlist: cfg.ssrf_allowlist };
  const headers: Record<string, string> = {
    'user-agent': `event-calendar-bot/0.1 (+${cfg.contact_url})`,
    accept: 'text/html,application/xhtml+xml,application/json,text/calendar,*/*;q=0.5',
  };
  if (opts.conditional?.etag) headers['if-none-match'] = opts.conditional.etag;
  if (opts.conditional?.lastModified) headers['if-modified-since'] = opts.conditional.lastModified;

  const fail = (current: string, redirects: number, error: string, status = 0): FetchSafeResult => ({
    status, body: '', truncated: false, outcomeHint: 'failed', bytes: 0, redirects,
    finalUrl: current, etag: null, lastModified: null, error,
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.total_timeout * 1000);
  let current = url;
  let redirects = 0;
  try {
    for (;;) {
      await assertUrlAllowed(current, ssrf);
      let res: Response;
      try {
        res = await fetch(current, { headers, redirect: 'manual', signal: ctl.signal });
      } catch (e) {
        return fail(current, redirects, `network: ${(e as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers.get('location');
        await cancelQuietly(res.body);
        if (!loc) return fail(current, redirects, 'redirect without location', res.status);
        if (redirects >= cfg.redirect_max) return fail(current, redirects, 'too many redirects', res.status);
        redirects++;
        current = new URL(loc, current).toString();
        continue;
      }
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      const base = { redirects, finalUrl: current, etag, lastModified };
      if (res.status === 304) {
        await cancelQuietly(res.body);
        return { status: 304, body: '', truncated: false, outcomeHint: 'not_modified', bytes: 0, ...base };
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let truncated = false;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            bytes += value.byteLength;
            if (bytes >= cfg.body_max) { truncated = true; await cancelQuietly(reader); break; }
          }
        } catch (e) {
          return fail(current, redirects, `read: ${(e as Error).message}`, res.status);
        }
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const ok = res.status >= 200 && res.status < 300;
      if (ok && looksLikeLoginOrCaptcha(body)) {
        return { status: res.status, body: '', truncated, outcomeHint: 'login_or_captcha', bytes, ...base };
      }
      return {
        status: res.status, body, truncated, outcomeHint: ok ? 'ok' : 'failed', bytes, ...base,
        ...(ok ? {} : { error: `http ${res.status}`, retryAfterSec: parseRetryAfter(res.headers.get('retry-after')) }),
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Adapter to run-job's FetchText ({status,text}). Failures yield status 0 / non-2xx status with empty text. */
export function makeFetchText(opts: FetchSafeOptions = {}): (url: string) => Promise<FetchResult> {
  return async (url) => {
    const r = await fetchSafe(url, opts);
    return { status: r.status, text: r.body };
  };
}
