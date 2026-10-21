import { openDb } from '../../src/db.ts';
import { defaultConfig } from '../../src/config.ts';
import type { Clock } from '../../src/clock.ts';
import { RateLimiter } from '../../src/net/rate-limiter.ts';
import { RobotsCache } from '../../src/net/robots.ts';
import type { FetchStageDeps } from '../../src/pipeline/fetch-stage.ts';
import type { SourceDeps } from '../../src/service/sources.ts';
import { upsertRegion } from '../../src/service/regions.ts';
import { createServer } from '../../src/http/server.ts';
import type { Core } from '../../src/http/server.ts';

export class AutoClock implements Clock {
  t = Date.parse('2026-10-01T00:00:00Z');
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

export async function bootHttp(searchProvider?: Core['searchProvider']) {
  const config = { ...defaultConfig(), ssrf_allowlist: ['127.0.0.1'] };
  const db = openDb(':memory:');
  upsertRegion(db, 'r1', { name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷'] });
  const clock = new AutoClock();
  const net: FetchStageDeps = {
    clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: ['127.0.0.1'] },
  };
  const deps: SourceDeps = { net, config };
  const core: Core = { db, deps, ...(searchProvider ? { searchProvider } : {}) };
  const h = createServer(core, { port: 0 });
  await h.start();
  const port = (h.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-gui-token': h.token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { h, db, deps, core, call, stop: () => h.stop() };
}
