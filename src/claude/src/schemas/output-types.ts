// Design §5.2 output types (JSON Schema 2020-12)
const nullable = (t: string) => ({ type: [t, 'null'] });

export const OUTPUT_SCHEMAS = {
  Event: {
    type: 'object',
    required: ['id', 'region_id', 'title', 'start_utc', 'tz', 'status'],
    properties: {
      id: { type: 'string' }, region_id: { type: 'string' }, title: { type: 'string' },
      start_utc: { type: 'string', format: 'date-time' }, end_utc: nullable('string'),
      all_day: { type: 'boolean' }, start_local_date: { type: 'string' }, tz: { type: 'string' },
      venue_name: nullable('string'), address: nullable('string'),
      lat: nullable('number'), lon: nullable('number'),
      description: nullable('string'), url: nullable('string'),
      status: { enum: ['confirmed', 'tentative', 'cancelled'] },
      dedup_key: { type: 'string' }, region_confidence: { type: 'number' },
      first_seen_at: { type: 'string' }, last_seen_at: { type: 'string' },
      cancelled_at: nullable('string'), seq: { type: 'integer' },
    },
  },
  Region: {
    type: 'object',
    required: ['id', 'name', 'tz', 'keywords_json'],
    properties: {
      id: { type: 'string' }, name: { type: 'string' }, tz: { type: 'string' },
      center_lat: nullable('number'), center_lon: nullable('number'), radius_km: nullable('number'),
      keywords_json: { type: 'array', items: { type: 'string' } },
    },
  },
  Candidate: {
    type: 'object',
    required: ['id', 'url', 'robots_allowed', 'status'],
    properties: {
      id: { type: 'string' }, region_id: { type: 'string' }, url: { type: 'string' },
      kind_guess: { type: 'string' }, robots_allowed: { type: 'boolean' },
      spec_guess_json: nullable('object'),
      status: { enum: ['proposed', 'approved', 'rejected'] }, found_at: { type: 'string' },
    },
  },
  Source: {
    type: 'object',
    required: ['id', 'region_id', 'url', 'kind', 'state', 'spec_version', 'interval_sec', 'trust', 'enabled'],
    properties: {
      id: { type: 'string' }, region_id: { type: 'string' }, name: { type: 'string' },
      url: { type: 'string' }, kind: { type: 'string' }, spec_json: { $ref: 'SourceSpec' },
      state: { enum: ['active', 'degraded', 'quarantined', 'disabled'] },
      spec_version: { type: 'integer' }, interval_sec: { type: 'integer' }, trust: { type: 'number' },
      enabled: { type: 'boolean' }, terms_note: { type: 'string' }, allow_redistribute: { type: 'boolean' },
      consecutive_failures: { type: 'integer' }, zero_item_streak: { type: 'integer' },
      last_item_count: nullable('integer'), next_run_at: nullable('string'),
      last_success_at: nullable('string'), etag: nullable('string'), last_modified: nullable('string'),
      created_at: { type: 'string' }, updated_at: { type: 'string' },
    },
  },
  Run: {
    type: 'object',
    required: ['id', 'source_id', 'outcome'],
    properties: {
      id: { type: 'string' }, source_id: { type: 'string' }, job_id: { type: 'string' },
      started_at: { type: 'string' }, finished_at: nullable('string'),
      outcome: { enum: ['ok', 'not_modified', 'partial', 'failed', 'blocked_robots', 'rate_limited', 'schema_drift'] },
      http_status: nullable('integer'), items_found: { type: 'integer' },
      items_upserted: { type: 'integer' }, error: nullable('string'),
    },
  },
} as const;

export type OutputTypeName = keyof typeof OUTPUT_SCHEMAS;
