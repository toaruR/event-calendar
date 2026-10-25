import type { DatabaseSync } from 'node:sqlite';
import { AppError, errorEnvelope, httpStatus } from './errors.ts';
import { defaultConfig } from './config.ts';
import type { Config } from './config.ts';
import { systemClock } from './clock.ts';
import type { Clock } from './clock.ts';
import { RateLimiter } from './net/rate-limiter.ts';
import { RobotsCache } from './net/robots.ts';
import type { FetchStageDeps } from './pipeline/fetch-stage.ts';
import type { SourceDeps } from './service/sources.ts';
import { startWorker } from './jobs/worker.ts';
import type { Worker } from './jobs/worker.ts';
import { createServer } from './http/server.ts';
import type { Core, HttpCore } from './http/server.ts';
import type { Rand } from './net/backoff.ts';
import { discoverDue } from './service/discover.ts';
import { buildSearchProvider } from './service/search-providers.ts';
import { holidaySyncDue, syncHolidays } from './service/holidays.ts';

export interface CoreDeps {
  clock?: Clock;
  rand?: Rand;
  net?: FetchStageDeps;
  searchProvider?: Core['searchProvider'];
  /** HTTP listen options (default: config.listen, 127.0.0.1) */
  port?: number;
  host?: string;
  token?: string;
  /** run the background worker on start(). Default true. */
  worker?: boolean;
  /** worker periodic loop (false = drive manually via handle.worker.tick()). Default true. */
  autoRun?: boolean;
  /** periodic discover loop (config.discover_interval_sec). Default: same as worker. */
  discover?: boolean;
  /** periodic holiday data refresh (config.holiday_interval_sec). Default: same as worker. */
  holidays?: boolean;
}

export interface DispatchResult { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }

export interface CoreHandle {
  core: Core;
  http: HttpCore;
  readonly worker: Worker | null;
  /** start worker (unless disabled) and HTTP listener */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** in-process route dispatch (embedded mode): same router/handlers/error mapping as HTTP, no socket, no token check. */
  dispatch(method: string, pathAndQuery: string, body?: unknown, headers?: Record<string, string>): Promise<DispatchResult>;
}

/** Clock whose sleep timers do not keep the process alive (so a stopped worker cannot delay exit). */
export const unrefClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref(); }),
};

export function createCore(db: DatabaseSync, config: Config = defaultConfig(), deps: CoreDeps = {}): CoreHandle {
  const clock = deps.clock ?? systemClock;
  const net: FetchStageDeps = deps.net ?? {
    clock, ...(deps.rand ? { rand: deps.rand } : {}),
    limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: config.ssrf_allowlist },
  };
  const sourceDeps: SourceDeps = { net, config };
  const core: Core = { db, deps: sourceDeps, searchProvider: deps.searchProvider ?? buildSearchProvider(config, net) };
  const http = createServer(core, {
    ...(deps.port !== undefined ? { port: deps.port } : {}),
    ...(deps.host !== undefined ? { host: deps.host } : {}),
    ...(deps.token !== undefined ? { token: deps.token } : {}),
  });
  let worker: Worker | null = null;
  let discoverStopped = false;

  const handle: CoreHandle = {
    core, http,
    get worker() { return worker; },
    async start() {
      if (deps.worker !== false && worker === null) {
        worker = startWorker({
          db, clock, config, net, ...(deps.rand ? { rand: deps.rand } : {}),
          ...(deps.autoRun !== undefined ? { autoRun: deps.autoRun } : {}),
        });
      }
      if ((deps.discover ?? (deps.worker !== false && deps.autoRun !== false)) && config.discover_interval_sec > 0
        && (core.searchProvider !== 'none' || config.x_search)) {
        // checks hourly; discover_run decides which regions are due
        void (async () => {
          while (!discoverStopped) {
            try {
              for (const r of await discoverDue(db, core.searchProvider ?? 'none', sourceDeps)) {
                if (r.error) process.stderr.write(`warn: discover ${r.region_id} failed: ${r.error}
`);
              }
            } catch (e) { process.stderr.write(`warn: discover loop: ${e instanceof Error ? e.message : String(e)}
`); }
            await clock.sleep(Math.min(config.discover_interval_sec, 3600) * 1000);
          }
        })();
      }
      if ((deps.holidays ?? (deps.worker !== false && deps.autoRun !== false)) && config.holiday_interval_sec > 0) {
        // checks hourly; holiday_sync.last_at decides whether a refresh is due
        void (async () => {
          while (!discoverStopped) {
            try {
              if (holidaySyncDue(db, clock, config)) {
                const r = await syncHolidays(db, net, config);
                if (r.outcome === 'failed') process.stderr.write(`warn: holiday sync failed: ${r.error}
`);
              }
            } catch (e) { process.stderr.write(`warn: holiday loop: ${e instanceof Error ? e.message : String(e)}
`); }
            await clock.sleep(Math.min(config.holiday_interval_sec, 3600) * 1000);
          }
        })();
      }
      await http.start();
    },
    async stop() {
      discoverStopped = true;
      worker?.stop();
      await http.stop();
    },
    async dispatch(method, pathAndQuery, body, headers = {}) {
      try {
        const u = new URL(pathAndQuery, 'http://localhost');
        const m = http.router.match(method, u.pathname);
        if (m === null) throw new AppError('NOT_FOUND', `no route: ${method} ${u.pathname}`, { path: u.pathname, method });
        const req = { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
        const out = await m.handler({
          core, req: req as never, params: m.params, query: u.searchParams, body: async () => body ?? {},
        });
        return {
          status: out.status ?? 200,
          ...(out.raw !== undefined ? { raw: out.raw } : { body: out.body ?? {} }),
          ...(out.headers ? { headers: out.headers } : {}),
        };
      } catch (e) {
        if (e instanceof AppError) return { status: httpStatus(e.code) ?? 503, body: errorEnvelope(e.code, e.message, e.details) };
        return { status: 500, body: errorEnvelope('FETCH_FAILED', e instanceof Error ? e.message : 'internal error', {}) };
      }
    },
  };
  return handle;
}
