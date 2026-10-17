import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { validateInput, validateSourceSpec } from '../validate.ts';
import { consumeApproval } from './approvals.ts';
import { disableSource, enableSource } from '../jobs/source-state.ts';
import { cfgOf, dryRunOrThrow, getSourceDto, nowOf } from './sources.ts';
import type { SourceDeps, SourceDto } from './sources.ts';

interface Row {
  id: string; region_id: string; url: string; spec_json: string | null; spec_version: number;
}

function loadRow(db: DatabaseSync, id: string): Row {
  const r = db.prepare('SELECT id,region_id,url,spec_json,spec_version FROM source WHERE id = ?').get(id) as unknown as Row | undefined;
  if (!r) throw new AppError('NOT_FOUND', `source not found: ${id}`, { source_id: id });
  return r;
}

const renderOf = (specJson: string | null): string => {
  if (!specJson) return 'none';
  try { return (JSON.parse(specJson) as { fetch?: { render?: string } }).fetch?.render ?? 'none'; } catch { return 'none'; }
};

function approvalRequired(action: string, id: string): AppError {
  return new AppError('APPROVAL_REQUIRED', `approval_token required for ${action}`, { action, source_id: id });
}

function recordHistory(db: DatabaseSync, id: string, version: number, specJson: string | null, by: string, at: string): void {
  db.prepare('INSERT INTO source_spec_history(source_id,spec_version,spec_json,changed_by,changed_at) VALUES(?,?,?,?,?)')
    .run(id, version, specJson, by, at);
}

/**
 * source_update with optimistic locking. spec_version is bumped by 1 and the new version is recorded in
 * source_spec_history (older versions stay). A spec change is dry-run first (ZERO_ITEMS, ROBOTS/SSRF);
 * switching render to 'browser' needs a single-use 'enable_browser' approval token.
 */
export async function updateSource(
  db: DatabaseSync, sourceId: string, input: unknown, deps: SourceDeps,
): Promise<{ source: SourceDto; spec_version: number }> {
  const cfg = cfgOf(deps);
  const b = validateInput('source_update', input, cfg) as {
    spec?: Record<string, unknown>; interval_sec?: number; enabled?: boolean; trust?: number;
    expected_version: number; approval_token?: string;
  };
  const cur = loadRow(db, sourceId);
  if (b.expected_version !== cur.spec_version) {
    throw new AppError('CONFLICT', `spec_version mismatch: expected ${b.expected_version}, current ${cur.spec_version}`, {
      expected_version: b.expected_version, current_version: cur.spec_version,
    });
  }
  const newSpecJson = b.spec !== undefined ? JSON.stringify(b.spec) : cur.spec_json;
  const needsBrowserApproval = b.spec !== undefined && renderOf(newSpecJson) === 'browser' && renderOf(cur.spec_json) !== 'browser';
  if (needsBrowserApproval && !b.approval_token) throw approvalRequired('enable_browser', sourceId);

  if (b.spec !== undefined) await dryRunOrThrow(db, cur.url, b.spec, cur.region_id, deps, false);

  if (needsBrowserApproval && !consumeApproval(db, b.approval_token!, {
    action: 'enable_browser', source_id: sourceId, clock: deps.net.clock,
  })) throw approvalRequired('enable_browser', sourceId);

  const nowIso = nowOf(deps).toISOString();
  const version = cur.spec_version + 1;
  db.exec('BEGIN');
  try {
    const r = db.prepare('UPDATE source SET spec_version = ?, updated_at = ? WHERE id = ? AND spec_version = ?')
      .run(version, nowIso, sourceId, cur.spec_version);
    if (Number(r.changes) !== 1) throw new AppError('CONFLICT', 'concurrent update', { source_id: sourceId });
    // spec changed: drop conditional-GET validators so the next run re-extracts instead of 304
    if (b.spec !== undefined) {
      db.prepare('UPDATE source SET spec_json = ?, kind = ?, etag = NULL, last_modified = NULL WHERE id = ?').run(newSpecJson, String(b.spec['kind']), sourceId);
    }
    if (b.interval_sec !== undefined) db.prepare('UPDATE source SET interval_sec = ? WHERE id = ?').run(b.interval_sec, sourceId);
    if (b.trust !== undefined) db.prepare('UPDATE source SET trust = ? WHERE id = ?').run(b.trust, sourceId);
    recordHistory(db, sourceId, version, newSpecJson, 'source_update', nowIso);
    if (b.enabled === false) disableSource(db, sourceId, nowIso);
    else if (b.enabled === true) enableSource(db, sourceId, nowIso);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { source: getSourceDto(db, sourceId, cfg), spec_version: version };
}

/**
 * source rollback: restore spec from history `version` as a NEW version (spec_version + 1).
 * Restoring a render=browser spec from a non-browser one needs the enable_browser approval too.
 */
export function rollbackSource(
  db: DatabaseSync, sourceId: string, version: number, deps: SourceDeps, opts: { approval_token?: string } = {},
): { source: SourceDto; spec_version: number } {
  const cfg = cfgOf(deps);
  if (!Number.isInteger(version) || version < 1) throw new AppError('INVALID_ARGUMENT', 'version must be a positive integer', { version });
  const cur = loadRow(db, sourceId);
  const h = db.prepare('SELECT spec_json FROM source_spec_history WHERE source_id = ? AND spec_version = ?')
    .get(sourceId, version) as { spec_json: string | null } | undefined;
  if (!h) throw new AppError('NOT_FOUND', `spec version not found: ${version}`, { source_id: sourceId, version });
  if (h.spec_json) validateSourceSpec(JSON.parse(h.spec_json), cfg);
  if (renderOf(h.spec_json) === 'browser' && renderOf(cur.spec_json) !== 'browser') {
    if (!opts.approval_token || !consumeApproval(db, opts.approval_token, {
      action: 'enable_browser', source_id: sourceId, clock: deps.net.clock,
    })) throw approvalRequired('enable_browser', sourceId);
  }
  const nowIso = nowOf(deps).toISOString();
  const next = cur.spec_version + 1;
  const kind = h.spec_json ? (JSON.parse(h.spec_json) as { kind?: string }).kind : undefined;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE source SET spec_json = ?, spec_version = ?, updated_at = ?, etag = NULL, last_modified = NULL WHERE id = ?')
      .run(h.spec_json, next, nowIso, sourceId);
    if (kind) db.prepare('UPDATE source SET kind = ? WHERE id = ?').run(kind, sourceId);
    recordHistory(db, sourceId, next, h.spec_json, `rollback:v${version}`, nowIso);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { source: getSourceDto(db, sourceId, cfg), spec_version: next };
}

/**
 * source_remove: needs a single-use 'source_remove' approval token. dry_run=true only reports events_affected
 * (events linked to this source) and consumes nothing. event_source_ref rows are removed by FK CASCADE.
 */
export function removeSource(
  db: DatabaseSync, sourceId: string, opts: { dry_run?: boolean; approval_token?: string }, deps: SourceDeps,
): { removed: boolean; events_affected: number } {
  if (opts.dry_run !== undefined && typeof opts.dry_run !== 'boolean') {
    throw new AppError('INVALID_ARGUMENT', 'dry_run must be boolean', {});
  }
  loadRow(db, sourceId);
  const n = db.prepare('SELECT COUNT(DISTINCT event_id) AS c FROM event_source_ref WHERE source_id = ?').get(sourceId) as { c: number };
  const affected = Number(n.c);
  if (opts.dry_run === true) return { removed: false, events_affected: affected };
  if (!opts.approval_token || !consumeApproval(db, opts.approval_token, {
    action: 'source_remove', source_id: sourceId, clock: deps.net.clock,
  })) throw approvalRequired('source_remove', sourceId);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM job WHERE source_id = ?').run(sourceId);
    db.prepare('DELETE FROM source_spec_history WHERE source_id = ?').run(sourceId);
    db.prepare('DELETE FROM source WHERE id = ?').run(sourceId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { removed: true, events_affected: affected };
}
