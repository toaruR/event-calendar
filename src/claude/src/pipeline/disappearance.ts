import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';

/**
 * Apply after a successful run: refs of this source whose UID was seen get miss_count=0, others +1.
 * A future event whose refs all reached miss_count >= disappear_runs becomes cancelled.
 * Returns the number of events newly cancelled.
 */
export function applyDisappearance(
  db: DatabaseSync, sourceId: string, seenUids: Iterable<string>, now: Date, config: Config,
): number {
  const seen = new Set(seenUids);
  const refs = db.prepare('SELECT source_uid FROM event_source_ref WHERE source_id = ?').all(sourceId) as Array<{ source_uid: string }>;
  const reset = db.prepare('UPDATE event_source_ref SET miss_count = 0 WHERE source_id = ? AND source_uid = ?');
  const bump = db.prepare('UPDATE event_source_ref SET miss_count = miss_count + 1 WHERE source_id = ? AND source_uid = ?');
  for (const r of refs) (seen.has(r.source_uid) ? reset : bump).run(sourceId, r.source_uid);

  const nowIso = now.toISOString();
  const res = db.prepare(
    `UPDATE event SET status='cancelled', cancelled_at=COALESCE(cancelled_at,?), seq=seq+1
     WHERE status != 'cancelled' AND start_utc >= ?
       AND id IN (SELECT event_id FROM event_source_ref WHERE source_id = ? AND miss_count >= ?)
       AND NOT EXISTS (SELECT 1 FROM event_source_ref r WHERE r.event_id = event.id AND r.miss_count < ?)`,
  ).run(nowIso, nowIso, sourceId, config.disappear_runs, config.disappear_runs);
  return Number(res.changes);
}
