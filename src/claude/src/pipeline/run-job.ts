import type { DatabaseSync } from 'node:sqlite';
import { upsertItem, uuidv7 } from './upsert.ts';
import { applyDisappearance } from './disappearance.ts';
import { evaluateDrift, getPrevCount, recordItemCount } from './drift.ts';
import { dedupKey } from './dedup.ts';
import type { Config } from '../config.ts';
import { extract as runExtract } from '../extract/index.ts';
import type { ExtractSpec, SourceKind } from '../extract/index.ts';
import { applyRunOutcome } from '../jobs/source-state.ts';
import type { ExtractResult, RawItem } from '../extract/types.ts';
import { localToUtc, startLocalDate } from '../normalize/time.ts';
import { sanitizeText } from '../normalize/sanitize.ts';
import { passesMinConfidence, regionConfidence } from '../normalize/region.ts';
import type { RegionPolicy } from '../normalize/region.ts';
import { fetchStage } from './fetch-stage.ts';
import type { FetchStageDeps } from './fetch-stage.ts';

export interface SourceRow {
  id: string;
  region_id: string;
  url: string;
  kind: string;
  spec_json: string | null;
  trust?: number | null;
}

export interface FetchResult { status: number; text: string }
export type FetchText = (url: string) => Promise<FetchResult>;

export interface RunJobArgs {
  db: DatabaseSync;
  source: SourceRow;
  /** injected fetch (legacy/test path). Ignored when `net` is given. */
  fetchText?: FetchText;
  /** queue job id: spec_snapshot_json is frozen at start and used instead of source.spec_json (hot reload) */
  jobId?: string;
  /** robots + host_rate + fetchSafe + retry_backoff fetch stage */
  net?: FetchStageDeps;
  now: Date;
  config: Config;
}

export interface RunJobResult {
  run_id: string;
  outcome: 'ok' | 'failed' | 'partial' | 'schema_drift' | 'not_modified' | 'blocked_robots' | 'rate_limited' | 'login_or_captcha';
  items_found: number;
  items_upserted: number;
  error?: string;
  /** seconds hinted by the server (rate_limited) */
  retryAfterSec?: number;
}

interface Spec extends ExtractSpec {
  kind?: string;
  region_policy?: RegionPolicy;
  extract?: ExtractSpec['extract'] & { default_tz?: string };
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// Japanese "2026年12月13日(日) 10:00" (first date wins for ranges like "A〜B")
const JA_DATE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*[(（][^)）]*[)）])?(?:\s*(\d{1,2})[:：時](\d{2})?)?/;

interface Parsed { utc: string; allDay: boolean }

function jaToIso(s: string): string | null {
  const j = JA_DATE.exec(s);
  if (!j) return null;
  const p2 = (v: string) => v.padStart(2, '0');
  const date = `${j[1]}-${p2(j[2])}-${p2(j[3])}`;
  return j[4] === undefined ? date : `${date}T${p2(j[4])}:${p2(j[5] ?? '0')}`;
}

/** Parse an ISO-like (or Japanese 年月日) date/datetime. Offset-less values are interpreted in tz. Returns null if unparsable. */
export function parseWhen(s: string | null, tz: string): Parsed | null {
  if (!s) return null;
  const ja = ISO.test(s.trim()) ? null : jaToIso(s);
  if (ja) s = ja;
  const m = ISO.exec(s.trim());
  if (!m) {
    // RFC 822 style (RSS pubDate) etc.: only accepted when it carries an explicit zone
    if (!/(?:GMT|UTC|[+-]\d{4})\s*$/.test(s.trim())) return null;
    const t = Date.parse(s.trim());
    return Number.isNaN(t) ? null : { utc: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), allDay: false };
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) {
    return { utc: localToUtc({ year: y, month: mo, day: d, hour: 0, minute: 0 }, tz), allDay: true };
  }
  const [h, mi, se] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (m[7] === undefined) {
    return { utc: localToUtc({ year: y, month: mo, day: d, hour: h, minute: mi, second: se }, tz), allDay: false };
  }
  const ms = Date.parse(s.trim().replace(' ', 'T'));
  if (Number.isNaN(ms)) return null;
  return { utc: new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'), allDay: false };
}

const KINDS = new Set(['ical', 'rss', 'jsonld', 'html', 'json_api']);

const nz = (s: string | null, redact: boolean): string | null => (s === null ? null : sanitizeText(s, redact) || null);

function recordRun(
  db: DatabaseSync, id: string, source: SourceRow, started: string, finished: string,
  outcome: string, http: number | null, found: number, upserted: number, error: string | null,
): void {
  db.prepare(
    `INSERT INTO run(id,source_id,job_id,started_at,finished_at,outcome,http_status,items_found,items_upserted,error)
     VALUES(?,?,NULL,?,?,?,?,?,?,?)`,
  ).run(id, source.id, started, finished, outcome === 'login_or_captcha' ? 'failed' : outcome, http, found, upserted,
    outcome === 'login_or_captcha' ? (error ?? 'login_or_captcha') : error);
}

/** Fixed-order pipeline: Fetch -> Extract -> Normalize -> RegionFilter -> Dedup/Upsert. */
export async function runJob(args: RunJobArgs): Promise<RunJobResult> {
  const { db, source, jobId } = args;
  let snapshot: string | null = null;
  if (jobId) {
    const j = db.prepare('SELECT spec_snapshot_json FROM job WHERE id = ?').get(jobId) as { spec_snapshot_json: string | null } | undefined;
    if (j) {
      snapshot = j.spec_snapshot_json;
      if (snapshot === null && source.spec_json !== null) {
        snapshot = source.spec_json;
        db.prepare('UPDATE job SET spec_snapshot_json = ? WHERE id = ?').run(snapshot, jobId);
      }
    }
  }
  const eff: RunJobArgs = snapshot !== null ? { ...args, source: { ...source, spec_json: snapshot } } : args;
  const result = await runJobCore(eff);
  if (jobId) db.prepare('UPDATE run SET job_id = ? WHERE id = ?').run(jobId, result.run_id);
  if (db.prepare('SELECT 1 FROM source WHERE id = ?').get(source.id)) {
    // zero_item_streak is already recorded by the pipeline (recordItemCount): do not pass itemsFound.
    applyRunOutcome(db, source.id, result.outcome, { nowIso: args.now.toISOString(), config: args.config });
  }
  return result;
}

async function runJobCore(args: RunJobArgs): Promise<RunJobResult> {
  const { db, source, net, now, config } = args;
  const fetchText = args.fetchText;
  const started = now.toISOString();
  const runId = uuidv7(now);
  const fail = (http: number | null, found: number, err: string): RunJobResult => {
    recordRun(db, runId, source, started, now.toISOString(), 'failed', http, found, 0, err);
    return { run_id: runId, outcome: 'failed', items_found: found, items_upserted: 0, error: err };
  };

  const region = db.prepare('SELECT * FROM region WHERE id = ?').get(source.region_id) as
    | { id: string; tz: string; center_lat: number | null; center_lon: number | null; radius_km: number | null; keywords_json: string }
    | undefined;
  if (!region) return fail(null, 0, `region not found: ${source.region_id}`);
  let spec: Spec;
  try { spec = source.spec_json ? (JSON.parse(source.spec_json) as Spec) : {}; } catch { return fail(null, 0, 'invalid spec_json'); }
  const policy: RegionPolicy = spec.region_policy ?? { mode: 'trust_source' };
  const minConf = policy.min_confidence ?? config.min_confidence;
  const tz = spec.extract?.default_tz ?? region.tz;

  let res: FetchResult;
  let validators: { etag: string | null; lastModified: string | null } | null = null;
  if (net) {
    const cond = db.prepare('SELECT etag, last_modified FROM source WHERE id = ?').get(source.id) as
      | { etag: string | null; last_modified: string | null } | undefined;
    let fr;
    try {
      fr = await fetchStage(source.url, { etag: cond?.etag ?? null, lastModified: cond?.last_modified ?? null }, net);
    } catch (e) { return fail(null, 0, `fetch failed: ${(e as Error).message}`); }
    const stop = (outcome: RunJobResult['outcome'], http: number | null, err: string | null, extra: Partial<RunJobResult> = {}): RunJobResult => {
      recordRun(db, runId, source, started, now.toISOString(), outcome, http, 0, 0, err);
      return { run_id: runId, outcome, items_found: 0, items_upserted: 0, ...(err ? { error: err } : {}), ...extra };
    };
    switch (fr.kind) {
      case 'not_modified': return stop('not_modified', 304, null);
      case 'partial': return stop('partial', fr.status, fr.error);
      case 'blocked_robots': return stop('blocked_robots', null, fr.error);
      case 'robots_deferred': return stop('failed', null, fr.error);
      case 'login_or_captcha': return stop('login_or_captcha', fr.status, fr.error);
      case 'rate_limited': return stop('rate_limited', fr.status, fr.error, fr.retryAfterSec !== null ? { retryAfterSec: fr.retryAfterSec } : {});
      case 'failed': return stop('failed', fr.status || null, fr.error);
      case 'ok': res = { status: fr.status, text: fr.text }; validators = { etag: fr.etag, lastModified: fr.lastModified }; break;
    }
  } else {
    if (!fetchText) return fail(null, 0, 'no fetch configured');
    try { res = await fetchText(source.url); } catch (e) { return fail(null, 0, `fetch failed: ${(e as Error).message}`); }
    if (res.status < 200 || res.status >= 300) return fail(res.status, 0, `http ${res.status}`);
  }

  if (!KINDS.has(source.kind)) return fail(res.status, 0, `unsupported source kind: ${source.kind}`);
  const fetchPage = async (u: string): Promise<string> => {
    if (net) {
      const r = await fetchStage(u, undefined, net);
      if (r.kind !== 'ok') throw new Error(`page fetch failed: ${r.kind}`);
      return r.text;
    }
    const r = await fetchText!(u);
    if (r.status < 200 || r.status >= 300) throw new Error(`http ${r.status}`);
    return r.text;
  };
  let ex: ExtractResult;
  try {
    ex = await runExtract(source.kind as SourceKind, res.text, spec, { now, config, baseUrl: source.url, fetchPage });
  } catch (e) { return fail(res.status, 0, (e as Error).message); }
  const found = ex.items.length;
  if (ex.error && found === 0) return fail(res.status, 0, ex.error);

  const drift = evaluateDrift(getPrevCount(db, source.id), found, config);
  if (drift.drift) {
    const msg = `schema drift: ${found} items vs previous ${getPrevCount(db, source.id)}`;
    recordRun(db, runId, source, started, now.toISOString(), 'schema_drift', res.status, found, 0, msg);
    return { run_id: runId, outcome: 'schema_drift', items_found: found, items_upserted: 0, error: msg };
  }

  const regionInfo = {
    keywords: JSON.parse(region.keywords_json) as string[],
    center_lat: region.center_lat ?? 0, center_lon: region.center_lon ?? 0, radius_km: region.radius_km ?? 0,
  };
  const nowIso = now.toISOString();
  let upserted = 0;

  const upsert = (item: RawItem): void => {
    const redact = config.redact_contact;
    const title = sanitizeText(item.title, redact);
    const start = parseWhen(item.start, tz);
    if (!title || !start) return;
    const end = parseWhen(item.end, tz);
    const endUtc = end && end.utc >= start.utc ? end.utc : null;
    const venue = nz(item.venue, redact);
    const address = nz(item.address, redact);
    const conf = regionConfidence({ title, venue, address }, policy, regionInfo, config.keyword_full_hits);
    if (!passesMinConfidence(conf, minConf)) return;
    const localDate = startLocalDate(start.utc, tz);
    const description = nz(item.description, redact);
    upsertItem(db, {
      source_uid: item.source_uid, title, start_utc: start.utc, end_utc: endUtc, all_day: start.allDay,
      start_local_date: localDate, tz, venue_name: venue, address, description, url: item.url,
      status: item.status ?? 'confirmed', dedup_key: dedupKey(title, localDate, venue),
      region_confidence: conf, raw_json: JSON.stringify(item),
    }, source, config, now);
    upserted++;
  };

  db.exec('BEGIN');
  try {
    for (const item of ex.items) upsert(item);
    if (!ex.error) {
      applyDisappearance(db, source.id, ex.items.map((i) => i.source_uid), now, config);
      recordItemCount(db, source.id, found);
    }
    if (validators) {
      db.prepare('UPDATE source SET etag = ?, last_modified = ? WHERE id = ?').run(validators.etag, validators.lastModified, source.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res.status, found, `upsert failed: ${(e as Error).message}`);
  }
  const outcome = ex.error ? 'partial' : 'ok';
  recordRun(db, runId, source, started, nowIso, outcome, res.status, found, upserted, ex.error ?? null);
  return { run_id: runId, outcome, items_found: found, items_upserted: upserted, ...(ex.error ? { error: ex.error } : {}) };
}
