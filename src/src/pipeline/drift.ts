import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';

export interface DriftEval { drift: boolean; ratio: number | null }

/** Drift iff prev >= drift_min_prev and (prev-new)/prev >= drift_ratio. prev null/small never drifts. */
export function evaluateDrift(
  prevCount: number | null | undefined, newCount: number, config: Pick<Config, 'drift_ratio' | 'drift_min_prev'>,
): DriftEval {
  if (prevCount == null || prevCount < config.drift_min_prev || prevCount <= 0) return { drift: false, ratio: null };
  const ratio = (prevCount - newCount) / prevCount;
  return { drift: ratio >= config.drift_ratio, ratio };
}

/** Record a non-drift successful count: last_item_count=new; zero_item_streak +1 on 0 items else reset to 0. */
export function recordItemCount(db: DatabaseSync, sourceId: string, newCount: number): void {
  db.prepare(
    'UPDATE source SET last_item_count = ?, zero_item_streak = CASE WHEN ? = 0 THEN zero_item_streak + 1 ELSE 0 END WHERE id = ?',
  ).run(newCount, newCount, sourceId);
}

export function getPrevCount(db: DatabaseSync, sourceId: string): number | null {
  const r = db.prepare('SELECT last_item_count AS n FROM source WHERE id = ?').get(sourceId) as { n: number | null } | undefined;
  return r?.n ?? null;
}
