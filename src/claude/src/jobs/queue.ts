import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock.ts';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { retryWaitSec } from '../net/backoff.ts';
import type { Rand } from '../net/backoff.ts';

export type JobStatus = 'queued' | 'leased' | 'ok' | 'failed' | 'not_modified';

export interface JobRow {
  id: string;
  source_id: string;
  status: JobStatus;
  lease_until: string | null;
  attempt: number;
  spec_snapshot_json: string | null;
  created_at: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();
let seq = 0;
const newJobId = (sourceId: string, clock: Clock): string => `job-${sourceId}-${clock.now()}-${++seq}`;

const SELECT = 'SELECT id, source_id, status, lease_until, CAST(attempt AS INTEGER) AS attempt, spec_snapshot_json, created_at FROM job';

export function getJob(db: DatabaseSync, jobId: string): JobRow | undefined {
  return db.prepare(`${SELECT} WHERE id = ?`).get(jobId) as JobRow | undefined;
}

/**
 * Enqueue a job for a source. Idempotent: if a queued/leased job already exists for the source, its id is returned.
 * spec_snapshot_json is frozen at enqueue (hot reload: running job keeps the old spec).
 */
export function enqueue(db: DatabaseSync, sourceId: string, clock: Clock, specSnapshotJson?: string | null): string {
  const ex = db.prepare("SELECT id FROM job WHERE source_id = ? AND status IN ('queued','leased') ORDER BY created_at LIMIT 1")
    .get(sourceId) as { id: string } | undefined;
  if (ex) return ex.id;
  const snap = specSnapshotJson !== undefined ? specSnapshotJson
    : ((db.prepare('SELECT spec_json FROM source WHERE id = ?').get(sourceId) as { spec_json: string | null } | undefined)?.spec_json ?? null);
  const id = newJobId(sourceId, clock);
  db.prepare("INSERT INTO job(id,source_id,status,lease_until,attempt,spec_snapshot_json,created_at) VALUES(?,?, 'queued', NULL, 0, ?, ?)")
    .run(id, sourceId, snap, iso(clock.now()));
  return id;
}

/**
 * Lease the oldest runnable queued job (queued jobs carry lease_until as "not before" after a backoff requeue).
 * Sets status='leased', lease_until=now+lease seconds.
 */
export function leaseNext(db: DatabaseSync, clock: Clock, config: Pick<Config, 'lease'> = defaultConfig()): JobRow | undefined {
  const now = iso(clock.now());
  const j = db.prepare(
    `SELECT id FROM job WHERE status = 'queued' AND (lease_until IS NULL OR lease_until <= ?) ORDER BY created_at, id LIMIT 1`,
  ).get(now) as { id: string } | undefined;
  if (!j) return undefined;
  db.prepare("UPDATE job SET status='leased', lease_until=? WHERE id=? AND status='queued'")
    .run(iso(clock.now() + config.lease * 1000), j.id);
  return getJob(db, j.id);
}

/** Finish a leased job. */
export function complete(db: DatabaseSync, jobId: string, status: 'ok' | 'failed' | 'not_modified'): void {
  db.prepare('UPDATE job SET status=?, lease_until=NULL WHERE id=?').run(status, jobId);
}

/** Return leased jobs whose lease expired to 'queued'. Returns the number reaped. */
export function reapExpired(db: DatabaseSync, clock: Clock): number {
  const r = db.prepare("UPDATE job SET status='queued', lease_until=NULL WHERE status='leased' AND lease_until < ?")
    .run(iso(clock.now()));
  return Number(r.changes);
}

/**
 * Retry: attempt+1; when the new attempt exceeds retry_backoff.max_attempts the job becomes 'failed',
 * otherwise 'queued' with a not-before time (lease_until) of now + retryWaitSec(attempt).
 */
export function requeueWithBackoff(
  db: DatabaseSync, jobId: string, clock: Clock, rand: Rand = Math.random,
  retryAfterSec?: number | null, config: Pick<Config, 'retry_backoff'> = defaultConfig(),
): JobRow {
  const job = getJob(db, jobId);
  if (!job) throw new Error(`unknown job: ${jobId}`);
  const attempt = job.attempt + 1;
  if (attempt > config.retry_backoff.max_attempts) {
    db.prepare("UPDATE job SET status='failed', attempt=?, lease_until=NULL WHERE id=?").run(attempt, jobId);
  } else {
    const wait = retryWaitSec(attempt, retryAfterSec, rand);
    db.prepare("UPDATE job SET status='queued', attempt=?, lease_until=? WHERE id=?")
      .run(attempt, iso(clock.now() + Math.ceil(wait * 1000)), jobId);
  }
  return getJob(db, jobId)!;
}
