import { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from './config.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS region (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tz TEXT NOT NULL,
  center_lat REAL, center_lon REAL, radius_km REAL, keywords_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES region(id),
  name TEXT, url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ical','rss','jsonld','html','json_api')),
  spec_json TEXT, spec_version INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
  interval_sec INTEGER, trust REAL,
  terms_note TEXT NOT NULL, allow_redistribute INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','degraded','quarantined','disabled')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0, zero_item_streak INTEGER NOT NULL DEFAULT 0,
  last_item_count INTEGER,
  next_run_at TEXT, last_success_at TEXT, etag TEXT, last_modified TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  status TEXT NOT NULL CHECK (status IN ('queued','leased','ok','failed','not_modified')),
  lease_until TEXT, attempt INTEGER NOT NULL DEFAULT 0, spec_snapshot_json TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS source_candidate (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES region(id),
  url TEXT NOT NULL, kind_guess TEXT, robots_allowed INTEGER, spec_guess_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected')),
  found_at TEXT
);
CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES region(id),
  title TEXT NOT NULL,
  start_utc TEXT NOT NULL, end_utc TEXT,
  all_day INTEGER NOT NULL DEFAULT 0, start_local_date TEXT,
  tz TEXT NOT NULL, venue_name TEXT, address TEXT, lat REAL, lon REAL, description TEXT, url TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed','tentative','cancelled')),
  dedup_key TEXT, region_confidence REAL,
  first_seen_at TEXT, last_seen_at TEXT, cancelled_at TEXT, seq INTEGER NOT NULL DEFAULT 0,
  CHECK (end_utc IS NULL OR start_utc <= end_utc)
);
CREATE TABLE IF NOT EXISTS event_source_ref (
  event_id TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  source_uid TEXT NOT NULL, raw_json TEXT, seen_at TEXT,
  miss_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, source_uid)
);
CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, job_id TEXT, started_at TEXT, finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','not_modified','partial','failed','blocked_robots','rate_limited','schema_drift')),
  http_status INTEGER, items_found INTEGER, items_upserted INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS source_spec_history (
  source_id TEXT NOT NULL, spec_version INTEGER NOT NULL, spec_json TEXT, changed_by TEXT, changed_at TEXT,
  PRIMARY KEY (source_id, spec_version)
);
CREATE INDEX IF NOT EXISTS idx_event_region_start ON event(region_id, start_utc);
CREATE INDEX IF NOT EXISTS idx_event_dedup_key ON event(dedup_key);
`;

/** Open (and idempotently initialise) the database. path may be ':memory:'. */
export function openDb(path: string, busyTimeoutMs: number = defaultConfig().busy_timeout): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=${Math.trunc(busyTimeoutMs)}`);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  const uv = db.prepare('PRAGMA user_version').get() as Record<string, unknown>;
  if (Number(uv['user_version']) === 0) db.exec('PRAGMA user_version=1');
  return db;
}
