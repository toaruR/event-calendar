import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { HostRate } from '../config.ts';

export interface AcquireOptions { crawlDelay?: number | null }

/**
 * Capacity-1 per-host token bucket. Interval = max(per_sec/requests, crawlDelay) seconds.
 * acquire() returns 0 when permitted (and consumes the token), else the seconds to wait (not consumed).
 */
export class RateLimiter {
  private last = new Map<string, number>();
  private rate: HostRate;
  private clock: Clock;
  constructor(rate: HostRate = { requests: 1, per_sec: 5 }, clock: Clock = systemClock) {
    this.rate = rate;
    this.clock = clock;
  }

  acquire(host: string, opts: AcquireOptions = {}): number {
    const base = this.rate.per_sec / this.rate.requests;
    const interval = Math.max(base, opts.crawlDelay ?? 0) * 1000;
    const key = host.toLowerCase();
    const now = this.clock.now();
    const prev = this.last.get(key);
    if (prev === undefined || now - prev >= interval) {
      this.last.set(key, now);
      return 0;
    }
    return (interval - (now - prev)) / 1000;
  }

  /** Waits until permitted, then consumes the token. */
  async wait(host: string, opts: AcquireOptions = {}): Promise<void> {
    for (;;) {
      const w = this.acquire(host, opts);
      if (w === 0) return;
      await this.clock.sleep(Math.ceil(w * 1000));
    }
  }
}
