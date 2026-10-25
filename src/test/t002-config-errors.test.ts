import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, loadConfig } from '../src/config.ts';
import { ERROR_CODES, ERROR_TABLE, errorEnvelope, httpStatus, exitCode, AppError } from '../src/errors.ts';

test('config defaults match design section 4 exactly', () => {
  assert.deepStrictEqual(defaultConfig(), {
    interval_sec: 21600, interval_min: 900, tick: 60, job_timeout: 120, lease: 600,
    connect_timeout: 10, total_timeout: 30, body_max: 5242880, global_concurrency: 4,
    redirect_max: 5, max_pages: 5, max_pages_limit: 20, degraded_after: 3, quarantine_after: 10,
    drift_ratio: 0.8, drift_min_prev: 5, disappear_runs: 3, cancelled_retention: 30,
    recurrence_horizon: 90, year_past_window: 30, year_future_window: 183, interval_jitter: 0.1,
    dedup_time_window: 60, dedup_jaccard: 0.8, keyword_full_hits: 2, min_confidence: 0.5, trust: 0.5,
    listen: '127.0.0.1:18787', busy_timeout: 5000, search_provider: 'none',
    search_providers: [], brave_api_key: '', x_search: false,
    x_search_base: 'https://search.yahoo.co.jp/realtime/search', discover_interval_sec: 86400, discover_limit: 10,
    jina_fallback: false, jina_base: 'https://r.jina.ai/', geocoder: 'none',
    redact_contact: true, ssrf_allowlist: [], contact_url: 'http://127.0.0.1:18787/about',
    host_rate: { requests: 1, per_sec: 5 },
    retry_backoff: { base_sec: 60, cap_sec: 600, jitter: 0.2, max_attempts: 5 },
    failure_stretch_cap_sec: 86400, robots_cache: 86400,
    require_approval: ['source_remove', 'enable_browser'], approval_token_ttl: 600, week_start: 'sunday',
    holiday_url: 'https://holidays-jp.github.io/api/v1/date.json', holiday_interval_sec: 604800,
  });
});

test('loadConfig merges overrides without mutating defaults', () => {
  const c = loadConfig({ tick: 1, host_rate: { requests: 2 } as never });
  assert.equal(c.tick, 1);
  assert.deepStrictEqual(c.host_rate, { requests: 2, per_sec: 5 });
  assert.equal(defaultConfig().tick, 60);
  c.ssrf_allowlist.push('x');
  assert.deepStrictEqual(defaultConfig().ssrf_allowlist, []);
});

test('error table maps code to http and cli exit', () => {
  const expected: Record<string, [number | null, number]> = {
    INVALID_ARGUMENT: [400, 2], FETCH_FAILED: [502, 1], NOT_FOUND: [404, 1], ZERO_ITEMS: [422, 3],
    SSRF_BLOCKED: [403, 1], ROBOTS_DISALLOWED: [403, 1], APPROVAL_REQUIRED: [403, 1],
    CONFLICT: [409, 1], DAEMON_UNAVAILABLE: [null, 4],
  };
  assert.equal(ERROR_CODES.length, 9);
  assert.deepStrictEqual([...ERROR_CODES].sort(), Object.keys(expected).sort());
  for (const [code, [http, exit]] of Object.entries(expected)) {
    assert.equal(ERROR_TABLE[code as keyof typeof ERROR_TABLE].http, http, code);
    assert.equal(httpStatus(code as never), http);
    assert.equal(exitCode(code as never), exit);
  }
});

test('error envelope shape', () => {
  const e = errorEnvelope('NOT_FOUND', 'nope', { id: 1 });
  assert.deepStrictEqual(Object.keys(e), ['error']);
  assert.deepStrictEqual(Object.keys(e.error), ['code', 'message', 'details']);
  assert.deepStrictEqual(Object.keys(new AppError('CONFLICT', 'm').toEnvelope().error), ['code', 'message', 'details']);
});
