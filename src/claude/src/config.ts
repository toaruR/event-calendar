import { readFileSync } from 'node:fs';
import { AppError } from './errors.ts';

export interface HostRate { requests: number; per_sec: number }
export interface RetryBackoff { base_sec: number; cap_sec: number; jitter: number; max_attempts: number }

export type WeekStart = 'sunday' | 'monday';

export interface Config {
  interval_sec: number;
  interval_min: number;
  tick: number;
  job_timeout: number;
  lease: number;
  connect_timeout: number;
  total_timeout: number;
  body_max: number;
  global_concurrency: number;
  redirect_max: number;
  max_pages: number;
  max_pages_limit: number;
  degraded_after: number;
  quarantine_after: number;
  drift_ratio: number;
  drift_min_prev: number;
  disappear_runs: number;
  cancelled_retention: number;
  recurrence_horizon: number;
  year_past_window: number;
  year_future_window: number;
  interval_jitter: number;
  dedup_time_window: number;
  dedup_jaccard: number;
  keyword_full_hits: number;
  min_confidence: number;
  trust: number;
  listen: string;
  busy_timeout: number;
  search_provider: string;
  geocoder: string;
  redact_contact: boolean;
  ssrf_allowlist: string[];
  contact_url: string;
  host_rate: HostRate;
  retry_backoff: RetryBackoff;
  failure_stretch_cap_sec: number;
  robots_cache: number;
  require_approval: string[];
  approval_token_ttl: number;
  /** GUI calendar first day of week */
  week_start: WeekStart;
}

export function defaultConfig(): Config {
  return {
    interval_sec: 21600,
    interval_min: 900,
    tick: 60,
    job_timeout: 120,
    lease: 600,
    connect_timeout: 10,
    total_timeout: 30,
    body_max: 5242880,
    global_concurrency: 4,
    redirect_max: 5,
    max_pages: 5,
    max_pages_limit: 20,
    degraded_after: 3,
    quarantine_after: 10,
    drift_ratio: 0.8,
    drift_min_prev: 5,
    disappear_runs: 3,
    cancelled_retention: 30,
    recurrence_horizon: 90,
    year_past_window: 30,
    year_future_window: 183,
    interval_jitter: 0.1,
    dedup_time_window: 60,
    dedup_jaccard: 0.8,
    keyword_full_hits: 2,
    min_confidence: 0.5,
    trust: 0.5,
    listen: '127.0.0.1:18787',
    busy_timeout: 5000,
    search_provider: 'none',
    geocoder: 'none',
    redact_contact: true,
    ssrf_allowlist: [],
    contact_url: 'http://127.0.0.1:18787/about',
    host_rate: { requests: 1, per_sec: 5 },
    retry_backoff: { base_sec: 60, cap_sec: 600, jitter: 0.2, max_attempts: 5 },
    failure_stretch_cap_sec: 86400,
    robots_cache: 86400,
    require_approval: ['source_remove', 'enable_browser'],
    approval_token_ttl: 600,
    week_start: 'sunday',
  };
}

/** Shallow merge of overrides over defaults (nested objects are merged one level). */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const base = defaultConfig();
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    const b = (base as unknown as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object'
      ? { ...b, ...v }
      : v;
  }
  return out as unknown as Config;
}

const HOST_RE = /^[a-z0-9]([a-z0-9.:_-]*[a-z0-9])?$/i;

/**
 * Load the operator-supplied `--config <file>` (embedded mode only): a JSON object of Config overrides.
 * Throws AppError(INVALID_ARGUMENT) for a missing file, invalid JSON, unknown keys or invalid ssrf_allowlist entries.
 */
export function loadConfigFile(path: string): Config {
  const bad = (m: string, details: Record<string, unknown> = {}): AppError => new AppError('INVALID_ARGUMENT', m, { config: path, ...details });
  if (path === '') throw bad('--config requires a file path');
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    throw bad(`cannot read config file: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw bad('config file is not valid JSON'); }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw bad('config file must contain a JSON object');
  const known = Object.keys(defaultConfig());
  const unknown = Object.keys(json).filter((k) => !known.includes(k));
  if (unknown.length > 0) throw bad(`unknown config keys: ${unknown.join(', ')}`, { unknown });
  const allow = (json as Record<string, unknown>)['ssrf_allowlist'];
  if (allow !== undefined) {
    if (!Array.isArray(allow)) throw bad('ssrf_allowlist must be an array of hostnames');
    for (const h of allow) {
      if (typeof h !== 'string' || !HOST_RE.test(h)) throw bad('invalid ssrf_allowlist entry (hostname or IP only, no scheme/port/path)', { entry: h });
    }
  }
  const ws = (json as Record<string, unknown>)['week_start'];
  if (ws !== undefined && ws !== 'sunday' && ws !== 'monday') throw bad('week_start must be "sunday" or "monday"', { week_start: ws });
  return loadConfig(json as Partial<Config>);
}
