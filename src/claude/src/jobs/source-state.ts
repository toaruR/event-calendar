import type { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';

export type SourceState = 'active' | 'degraded' | 'quarantined' | 'disabled';
export type RunOutcome =
  | 'ok' | 'not_modified' | 'partial' | 'failed' | 'blocked_robots' | 'rate_limited' | 'schema_drift' | 'login_or_captcha';

export interface SourceStateInfo { state: SourceState; consecutive_failures: number; zero_item_streak: number }

const ZERO_STREAK_DEGRADE = 3;

export function getSourceState(db: DatabaseSync, sourceId: string): SourceStateInfo {
  const r = db.prepare('SELECT state, consecutive_failures, zero_item_streak FROM source WHERE id = ?').get(sourceId) as
    | { state: SourceState; consecutive_failures: number; zero_item_streak: number } | undefined;
  if (!r) throw new Error(`unknown source: ${sourceId}`);
  return { state: r.state, consecutive_failures: Number(r.consecutive_failures), zero_item_streak: Number(r.zero_item_streak) };
}

function set(db: DatabaseSync, id: string, state: SourceState, failures: number, zero: number, nowIso?: string): void {
  db.prepare('UPDATE source SET state=?, consecutive_failures=?, zero_item_streak=?, updated_at=COALESCE(?, updated_at) WHERE id=?')
    .run(state, failures, zero, nowIso ?? null, id);
}

/**
 * Applies a run outcome to the source state machine (design section 7).
 * - blocked_robots / login_or_captcha: immediate quarantine.
 * - failed / rate_limited / schema_drift: consecutive_failures+1; >= quarantine_after -> quarantined,
 *   >= degraded_after (or schema_drift) -> degraded.
 * - ok / not_modified / partial: consecutive_failures=0; degraded -> active, unless zero_item_streak >= 3 (stays degraded).
 * - quarantined / disabled never change here (no auto recovery).
 * itemsFound (optional): when given on a successful outcome, zero_item_streak is updated here
 * (0 items -> +1, else reset). Do not pass it if the pipeline already recorded the count.
 */
export function applyRunOutcome(
  db: DatabaseSync, sourceId: string, outcome: RunOutcome,
  opts: { itemsFound?: number | null; nowIso?: string; config?: Pick<Config, 'degraded_after' | 'quarantine_after'> } = {},
): SourceStateInfo {
  const cfg = opts.config ?? defaultConfig();
  const cur = getSourceState(db, sourceId);
  if (cur.state === 'quarantined' || cur.state === 'disabled') return cur;
  let failures = cur.consecutive_failures;
  let zero = cur.zero_item_streak;
  let state: SourceState = cur.state;
  if (outcome === 'blocked_robots' || outcome === 'login_or_captcha') {
    state = 'quarantined';
  } else if (outcome === 'failed' || outcome === 'rate_limited' || outcome === 'schema_drift') {
    failures += 1;
    if (failures >= cfg.quarantine_after) state = 'quarantined';
    else if (failures >= cfg.degraded_after || outcome === 'schema_drift') state = 'degraded';
  } else {
    failures = 0;
    if (opts.itemsFound !== undefined && opts.itemsFound !== null) zero = opts.itemsFound === 0 ? zero + 1 : 0;
    state = zero >= ZERO_STREAK_DEGRADE ? 'degraded' : 'active';
  }
  set(db, sourceId, state, failures, zero, opts.nowIso);
  return { state, consecutive_failures: failures, zero_item_streak: zero };
}

/** Manual recovery only: quarantined -> active (counters reset). No-op for other states. */
export function resumeSource(db: DatabaseSync, sourceId: string, nowIso?: string): SourceStateInfo {
  const cur = getSourceState(db, sourceId);
  if (cur.state !== 'quarantined') return cur;
  set(db, sourceId, 'active', 0, 0, nowIso);
  return { state: 'active', consecutive_failures: 0, zero_item_streak: 0 };
}

/** Any state -> disabled. */
export function disableSource(db: DatabaseSync, sourceId: string, nowIso?: string): SourceStateInfo {
  const cur = getSourceState(db, sourceId);
  db.prepare('UPDATE source SET state=?, enabled=0, updated_at=COALESCE(?, updated_at) WHERE id=?').run('disabled', nowIso ?? null, sourceId);
  return { ...cur, state: 'disabled' };
}

/** disabled -> active. quarantined stays quarantined (needs resumeSource). Other states unchanged. */
export function enableSource(db: DatabaseSync, sourceId: string, nowIso?: string): SourceStateInfo {
  const cur = getSourceState(db, sourceId);
  if (cur.state === 'disabled') {
    db.prepare('UPDATE source SET state=?, enabled=1, consecutive_failures=0, updated_at=COALESCE(?, updated_at) WHERE id=?')
      .run('active', nowIso ?? null, sourceId);
    return { ...cur, state: 'active', consecutive_failures: 0 };
  }
  if (cur.state !== 'quarantined') db.prepare('UPDATE source SET enabled=1 WHERE id=?').run(sourceId);
  return cur;
}
