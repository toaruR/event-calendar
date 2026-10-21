import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock.ts';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import type { Rand } from '../net/backoff.ts';
import { runJob } from '../pipeline/run-job.ts';
import type { FetchText, RunJobArgs, RunJobResult, SourceRow } from '../pipeline/run-job.ts';
import type { FetchStageDeps } from '../pipeline/fetch-stage.ts';
import { complete, getJob, leaseNext, reapExpired } from './queue.ts';
import type { JobRow } from './queue.ts';
import { scheduleTick, setNextRun } from './scheduler.ts';
import { applyRunOutcome, getSourceState } from './source-state.ts';

export interface WorkerDeps {
  db: DatabaseSync;
  clock: Clock;
  rand?: Rand;
  config?: Config;
  fetchText?: FetchText;
  net?: FetchStageDeps;
  /** injectable pipeline (tests); defaults to runJob */
  runJobFn?: (args: RunJobArgs) => Promise<RunJobResult>;
  /** run the periodic tick loop (sleeping on clock). Default true; false = drive manually with tick(). */
  autoRun?: boolean;
}

export interface Worker {
  /** scheduleTick + fill free slots (up to global_concurrency). */
  tick(): Promise<void>;
  /** resolves when no job is running (does not stop the worker). */
  idle(): Promise<void>;
  /** no new leaseNext after this returns; running jobs are not awaited (they may be hung). */
  stop(): void;
  runningCount(): number;
}

type Timeout = { timeout: true };

/**
 * Worker loop: startup reapExpired (crash recovery), then every `tick` seconds scheduleTick -> leaseNext up to
 * global_concurrency concurrent runJob calls. A run exceeding job_timeout marks the job failed.
 */
export function startWorker(deps: WorkerDeps): Worker {
  const { db, clock } = deps;
  const config = deps.config ?? defaultConfig();
  const rand = deps.rand ?? Math.random;
  const run = deps.runJobFn ?? runJob;
  let stopped = false;
  const running = new Set<Promise<void>>();

  reapExpired(db, clock);

  const execute = async (job: JobRow): Promise<void> => {
    const src = db.prepare('SELECT id, region_id, url, kind, spec_json, trust, enabled, state FROM source WHERE id = ?')
      .get(job.source_id) as (SourceRow & { enabled: number; state: string }) | undefined;
    if (!src || !src.enabled || (src.state !== 'active' && src.state !== 'degraded')) {
      complete(db, job.id, 'failed');
      return;
    }
    const source: SourceRow = { id: src.id, region_id: src.region_id, url: src.url, kind: src.kind, spec_json: src.spec_json, trust: src.trust };
    const args: RunJobArgs = {
      db, source, jobId: job.id, now: new Date(clock.now()), config,
      ...(deps.fetchText ? { fetchText: deps.fetchText } : {}), ...(deps.net ? { net: deps.net } : {}),
    };
    let result: RunJobResult | Timeout | { error: string };
    try {
      result = await Promise.race([
        run(args),
        clock.sleep(config.job_timeout * 1000).then((): Timeout => ({ timeout: true })),
      ]);
    } catch (e) { result = { error: (e as Error).message }; }

    if ('timeout' in result || 'error' in result) {
      complete(db, job.id, 'failed');
      applyRunOutcome(db, source.id, 'failed', { nowIso: new Date(clock.now()).toISOString(), config });
    } else {
      complete(db, job.id, result.outcome === 'not_modified' ? 'not_modified' : (result.outcome === 'ok' || result.outcome === 'partial') ? 'ok' : 'failed');
    }
    setNextRun(db, source.id, clock, rand, getSourceState(db, source.id).consecutive_failures, config);
  };

  const fill = (): void => {
    while (!stopped && running.size < config.global_concurrency) {
      const job = leaseNext(db, clock, config);
      if (!job) return;
      const p: Promise<void> = execute(job)
        .catch(() => { if (getJob(db, job.id)?.status === 'leased') complete(db, job.id, 'failed'); })
        .finally(() => { running.delete(p); fill(); });
      running.add(p);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    reapExpired(db, clock);
    scheduleTick(db, clock, rand, config);
    fill();
  };

  if (deps.autoRun !== false) {
    void (async () => {
      while (!stopped) {
        await tick();
        await clock.sleep(config.tick * 1000);
      }
    })();
  }

  return {
    tick,
    idle: async () => { while (running.size > 0) await Promise.allSettled([...running]); },
    stop: () => { stopped = true; },
    runningCount: () => running.size,
  };
}
