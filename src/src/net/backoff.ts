import type { Clock } from '../clock.ts';
import { defaultConfig } from '../config.ts';

export type Rand = () => number;

const cfg = defaultConfig();

/** Maps r in [0,1] to a factor in [1-j, 1+j]; r=0.5 -> 1. */
function jitterFactor(rand: Rand, j: number): number {
  return 1 + (2 * rand() - 1) * j;
}

/**
 * retry_backoff: wait for the n-th retry (n>=1) =
 * max(Retry-After clamped to failure_stretch cap, min(base*2^(n-1), cap) * (1 +/- jitter)).
 */
export function retryWaitSec(n: number, retryAfterSec: number | null | undefined, rand: Rand = Math.random): number {
  const rb = cfg.retry_backoff;
  const base = Math.min(rb.base_sec * 2 ** (n - 1), rb.cap_sec) * jitterFactor(rand, rb.jitter);
  const ra = retryAfterSec !== null && retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? Math.min(retryAfterSec, cfg.failure_stretch_cap_sec)
    : 0;
  return Math.max(base, ra);
}

/** failure_stretch: interval after f consecutive failures = min(interval*2^f, 86400). */
export function nextRunAfterFailure(f: number, intervalSec: number = cfg.interval_sec): number {
  return Math.min(intervalSec * 2 ** f, cfg.failure_stretch_cap_sec);
}

/** interval_jitter: +/-10% on the next-run interval. */
export function jitteredNextRun(intervalSec: number, rand: Rand = Math.random): number {
  return intervalSec * jitterFactor(rand, cfg.interval_jitter);
}

export interface AttemptResult { status: number; retryAfterSec?: number | null }
export interface BackoffOutcome {
  outcome: 'ok' | 'failed';
  last: AttemptResult;
  attempts: number;
  waits: number[];
}

export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/** Calls attempt(); retries retryable results up to max_attempts (5) times, sleeping on `clock`. */
export async function retryWithBackoff(
  attempt: (n: number) => Promise<AttemptResult>,
  clock: Clock,
  rand: Rand = Math.random,
): Promise<BackoffOutcome> {
  const max = cfg.retry_backoff.max_attempts;
  const waits: number[] = [];
  let attempts = 0;
  for (;;) {
    const last = await attempt(attempts);
    attempts++;
    if (last.status >= 200 && last.status < 400) return { outcome: 'ok', last, attempts, waits };
    if (!isRetryableStatus(last.status) || waits.length >= max) return { outcome: 'failed', last, attempts, waits };
    const w = retryWaitSec(waits.length + 1, last.retryAfterSec, rand);
    waits.push(w);
    await clock.sleep(Math.ceil(w * 1000));
  }
}
