import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { validateInput } from '../validate.ts';
import { uuidv7 } from '../pipeline/upsert.ts';
import { dryRun } from './dry-run.ts';
import type { DryRunDeps, DryRunRegion, DryRunResult, DrySample } from './dry-run.ts';
import type { FetchStageDeps } from '../pipeline/fetch-stage.ts';

export interface SourceDeps {
  net: FetchStageDeps;
  config?: Config;
  now?: Date;
}

export const cfgOf = (d: SourceDeps): Config => d.config ?? defaultConfig();
export const nowOf = (d: SourceDeps): Date => d.now ?? new Date(d.net.clock.now());

export function getRegionRow(db: DatabaseSync, id: string): DryRunRegion & { id: string } {
  const r = db.prepare('SELECT * FROM region WHERE id = ?').get(id) as unknown as (DryRunRegion & { id: string }) | undefined;
  if (!r) throw new AppError('NOT_FOUND', `region not found: ${id}`, { region_id: id });
  return r;
}

/** Run the dry run and map its verdict to errors: ROBOTS_DISALLOWED / ZERO_ITEMS (unless force). */
export async function dryRunOrThrow(
  db: DatabaseSync, url: string, spec: Record<string, unknown> | undefined, regionId: string | null,
  deps: SourceDeps, force = false,
): Promise<DryRunResult> {
  const region = regionId ? getRegionRow(db, regionId) : null;
  const dd: DryRunDeps = { net: deps.net, config: cfgOf(deps), now: nowOf(deps), region };
  const r = await dryRun(url, spec, dd);
  if (!r.robots_allowed) throw new AppError('ROBOTS_DISALLOWED', 'blocked by robots.txt', { url });
  if (r.item_count === 0 && !force) {
    throw new AppError('ZERO_ITEMS', 'dry run extracted 0 items', { url, warnings: r.warnings });
  }
  return r;
}

/** source_test: dry run only; the DB is never written. */
export async function testSource(
  db: DatabaseSync, input: unknown, deps: SourceDeps,
): Promise<{ ok: boolean; samples: DrySample[]; warnings: string[]; item_count: number; robots_allowed: boolean }> {
  const b = validateInput('source_test', input, cfgOf(deps)) as { url: string; spec?: Record<string, unknown> };
  const r = await dryRunOrThrow(db, b.url, b.spec, null, deps, true);
  return { ok: r.ok, samples: r.samples, warnings: r.warnings, item_count: r.item_count, robots_allowed: r.robots_allowed };
}

export interface SourceDto {
  id: string; region_id: string; name?: string; url: string; kind: string; spec_json: unknown;
  state: string; spec_version: number; interval_sec: number; trust: number; enabled: boolean;
  terms_note: string; allow_redistribute: boolean; consecutive_failures: number; zero_item_streak: number;
  last_item_count: number | null; next_run_at: string | null; last_success_at: string | null;
  etag: string | null; last_modified: string | null; created_at: string; updated_at: string;
}

export function rowToSource(r: Record<string, unknown>, config: Config = defaultConfig()): SourceDto {
  return {
    id: r['id'] as string, region_id: r['region_id'] as string,
    ...(r['name'] != null ? { name: r['name'] as string } : {}),
    url: r['url'] as string, kind: r['kind'] as string,
    spec_json: r['spec_json'] ? JSON.parse(r['spec_json'] as string) : null,
    state: r['state'] as string, spec_version: Number(r['spec_version']),
    interval_sec: Number(r['interval_sec'] ?? config.interval_sec), trust: Number(r['trust'] ?? config.trust),
    enabled: Number(r['enabled']) === 1, terms_note: r['terms_note'] as string,
    allow_redistribute: Number(r['allow_redistribute']) === 1,
    consecutive_failures: Number(r['consecutive_failures']), zero_item_streak: Number(r['zero_item_streak']),
    last_item_count: r['last_item_count'] == null ? null : Number(r['last_item_count']),
    next_run_at: (r['next_run_at'] as string | null) ?? null,
    last_success_at: (r['last_success_at'] as string | null) ?? null,
    etag: (r['etag'] as string | null) ?? null, last_modified: (r['last_modified'] as string | null) ?? null,
    created_at: (r['created_at'] as string | null) ?? '', updated_at: (r['updated_at'] as string | null) ?? '',
  };
}

export function getSourceDto(db: DatabaseSync, id: string, config?: Config): SourceDto {
  const r = db.prepare('SELECT * FROM source WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) throw new AppError('NOT_FOUND', `source not found: ${id}`, { source_id: id });
  return rowToSource(r, config);
}

interface NewSource {
  url: string; region_id: string; spec: Record<string, unknown>; terms_note: string; allow_redistribute: boolean;
  interval_sec?: number; trust?: number;
}

function insertSource(db: DatabaseSync, s: NewSource, deps: SourceDeps, changedBy: string): string {
  const cfg = cfgOf(deps);
  const now = nowOf(deps);
  const nowIso = now.toISOString();
  const id = uuidv7(now);
  const specJson = JSON.stringify(s.spec);
  db.exec('BEGIN');
  try {
    // next_run_at = now: picked up by the next scheduler tick (no restart needed)
    db.prepare(
      `INSERT INTO source(id,region_id,url,kind,spec_json,spec_version,enabled,interval_sec,trust,terms_note,allow_redistribute,
        state,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,1,1,?,?,?,?,'active',?,?,?)`,
    ).run(id, s.region_id, s.url, String(s.spec['kind']), specJson, s.interval_sec ?? cfg.interval_sec,
      s.trust ?? cfg.trust, s.terms_note, s.allow_redistribute ? 1 : 0, nowIso, nowIso, nowIso);
    db.prepare('INSERT INTO source_spec_history(source_id,spec_version,spec_json,changed_by,changed_at) VALUES(?,?,?,?,?)')
      .run(id, 1, specJson, changedBy, nowIso);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return id;
}

function requireTerms(b: { terms_note: string }): void {
  if (b.terms_note.trim() === '') throw new AppError('INVALID_ARGUMENT', 'terms_note must not be empty', {});
}

/**
 * source_add: validate -> region exists -> SSRF/robots/dry run -> (ZERO_ITEMS unless force) -> insert source + spec history v1.
 * The DB is untouched on any failure.
 */
export async function addSource(
  db: DatabaseSync, input: unknown, deps: SourceDeps,
): Promise<{ source: SourceDto; samples: DrySample[] }> {
  const cfg = cfgOf(deps);
  const b = validateInput('source_add', input, cfg) as {
    url: string; region_id: string; spec?: Record<string, unknown>; terms_note: string; allow_redistribute: boolean;
    interval_sec?: number; trust?: number; force?: boolean;
  };
  requireTerms(b);
  getRegionRow(db, b.region_id);
  const r = await dryRunOrThrow(db, b.url, b.spec, b.region_id, deps, b.force === true);
  const id = insertSource(db, {
    url: b.url, region_id: b.region_id, spec: r.spec, terms_note: b.terms_note, allow_redistribute: b.allow_redistribute,
    ...(b.interval_sec !== undefined ? { interval_sec: b.interval_sec } : {}),
    ...(b.trust !== undefined ? { trust: b.trust } : {}),
  }, deps, 'source_add');
  return { source: getSourceDto(db, id, cfg), samples: r.samples };
}

/** source_approve: promote a proposed candidate to a source (dry run required; no force). */
export async function approveCandidate(
  db: DatabaseSync, candidateId: string, input: unknown, deps: SourceDeps,
): Promise<{ source: SourceDto }> {
  const cfg = cfgOf(deps);
  const b = validateInput('source_approve', input, cfg) as {
    spec?: Record<string, unknown>; terms_note: string; allow_redistribute: boolean;
  };
  requireTerms(b);
  const c = db.prepare('SELECT * FROM source_candidate WHERE id = ?').get(candidateId) as
    | { id: string; region_id: string; url: string; status: string; spec_guess_json: string | null } | undefined;
  if (!c) throw new AppError('NOT_FOUND', `candidate not found: ${candidateId}`, { candidate_id: candidateId });
  if (c.status !== 'proposed') throw new AppError('CONFLICT', `candidate already ${c.status}`, { status: c.status });
  const spec = b.spec ?? (c.spec_guess_json ? (JSON.parse(c.spec_guess_json) as Record<string, unknown>) : undefined);
  const r = await dryRunOrThrow(db, c.url, spec, c.region_id, deps, false);
  const id = insertSource(db, {
    url: c.url, region_id: c.region_id, spec: r.spec, terms_note: b.terms_note, allow_redistribute: b.allow_redistribute,
  }, deps, 'source_approve');
  db.prepare("UPDATE source_candidate SET status = 'approved' WHERE id = ?").run(candidateId);
  return { source: getSourceDto(db, id, cfg) };
}

const STATES = new Set(['active', 'degraded', 'quarantined', 'disabled']);

/** source_list: optional region_id / state filters. */
export function listSources(
  db: DatabaseSync, filter: { region_id?: string; state?: string } = {}, config?: Config,
): { sources: SourceDto[] } {
  if (filter.state !== undefined && !STATES.has(filter.state)) {
    throw new AppError('INVALID_ARGUMENT', `invalid state: ${filter.state}`, { state: filter.state });
  }
  const where: string[] = [];
  const args: string[] = [];
  if (filter.region_id !== undefined) { where.push('region_id = ?'); args.push(filter.region_id); }
  if (filter.state !== undefined) { where.push('state = ?'); args.push(filter.state); }
  const rows = db.prepare(`SELECT * FROM source ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, id`)
    .all(...args) as Record<string, unknown>[];
  return { sources: rows.map((r) => rowToSource(r, config)) };
}
