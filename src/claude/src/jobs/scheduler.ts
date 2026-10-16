import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock.ts';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { jitteredNextRun, nextRunAfterFailure } from '../net/backoff.ts';
import type { Rand } from '../net/backoff.ts';
import { enqueue } from './queue.ts';

/** Seconds until the next run: success (failures=0) -> interval*(1+U(-j,j)); failure f>=1 -> failure_stretch. */
export function nextRunDelaySec(intervalSec: number, failures: number, rand: Rand): number {
  return failures > 0 ? nextRunAfterFailure(failures, intervalSec) : jitteredNextRun(intervalSec, rand);
}

/** Sets source.next_run_at = now + delay. failures = consecutive_failures after the run (0 = success). Returns the delay in seconds. */
export function setNextRun(
  db: DatabaseSync, sourceId: string, clock: Clock, rand: Rand, failures: number,
  config: Pick<Config, 'interval_sec'> = defaultConfig(),
): number {
  const r = db.prepare('SELECT interval_sec FROM source WHERE id = ?').get(sourceId) as { interval_sec: number | null } | undefined;
  if (!r) throw new Error(`unknown source: ${sourceId}`);
  const delay = nextRunDelaySec(r.interval_sec ?? config.interval_sec, failures, rand);
  db.prepare('UPDATE source SET next_run_at = ? WHERE id = ?').run(new Date(clock.now() + Math.round(delay * 1000)).toISOString(), sourceId);
  return delay;
}

/**
 * One scheduler tick: every enabled, non-quarantined/disabled source with next_run_at null or <= now gets one job
 * (enqueue is idempotent) and its next_run_at is pushed into the future with jitter, so missed periods after a
 * downtime collapse into a single run (catch-up aggregation). Returns the enqueued job ids.
 */
export function scheduleTick(
  db: DatabaseSync, clock: Clock, rand: Rand = Math.random, config: Pick<Config, 'interval_sec'> = defaultConfig(),
): string[] {
  const nowIso = new Date(clock.now()).toISOString();
  const due = db.prepare(
    `SELECT id FROM source WHERE enabled = 1 AND state IN ('active','degraded')
     AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at, id`,
  ).all(nowIso) as { id: string }[];
  const ids: string[] = [];
  for (const s of due) {
    ids.push(enqueue(db, s.id, clock));
    setNextRun(db, s.id, clock, rand, 0, config);
  }
  return ids;
}
