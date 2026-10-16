import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { runJob } from '../pipeline/run-job.ts';
import type { SourceRow } from '../pipeline/run-job.ts';
import { cfgOf, nowOf } from './sources.ts';
import type { SourceDeps } from './sources.ts';

export interface RunRecord {
  id: string; source_id: string; job_id?: string; started_at: string | null; finished_at: string | null;
  outcome: string; http_status: number | null; items_found: number | null; items_upserted: number | null; error: string | null;
}

/** run_now: execute runJob immediately. NOT_FOUND for unknown source, CONFLICT while quarantined. */
export async function runNow(db: DatabaseSync, sourceId: string, deps: SourceDeps): Promise<{ run: RunRecord }> {
  const src = db.prepare('SELECT id,region_id,url,kind,spec_json,trust,state FROM source WHERE id = ?').get(sourceId) as
    | (SourceRow & { state: string }) | undefined;
  if (!src) throw new AppError('NOT_FOUND', `source not found: ${sourceId}`, { source_id: sourceId });
  if (src.state === 'quarantined') {
    throw new AppError('CONFLICT', 'source is quarantined; resume it before running', { source_id: sourceId, state: src.state });
  }
  const { state: _state, ...source } = src;
  const result = await runJob({ db, source, net: deps.net, now: nowOf(deps), config: cfgOf(deps) });
  const row = db.prepare('SELECT * FROM run WHERE id = ?').get(result.run_id) as Record<string, unknown>;
  const run: RunRecord = {
    id: row['id'] as string, source_id: row['source_id'] as string,
    ...(row['job_id'] != null ? { job_id: row['job_id'] as string } : {}),
    started_at: (row['started_at'] as string | null) ?? null, finished_at: (row['finished_at'] as string | null) ?? null,
    outcome: row['outcome'] as string,
    http_status: row['http_status'] == null ? null : Number(row['http_status']),
    items_found: row['items_found'] == null ? null : Number(row['items_found']),
    items_upserted: row['items_upserted'] == null ? null : Number(row['items_upserted']),
    error: (row['error'] as string | null) ?? null,
  };
  return { run };
}
