// Design §5.3 input schemas (In.<tool>)
const spec = { $ref: 'SourceSpec' };

export const INPUT_SCHEMAS = {
  region_upsert: {
    type: 'object',
    required: ['id', 'name', 'tz', 'keywords'],
    properties: {
      id: { type: 'string' }, name: { type: 'string' }, tz: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
      center: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
      radius_km: { type: 'number' },
    },
  },
  source_test: {
    type: 'object', required: ['url'],
    properties: { url: { type: 'string' }, spec },
  },
  source_add: {
    type: 'object', required: ['url', 'region_id', 'terms_note', 'allow_redistribute'],
    properties: {
      url: { type: 'string' }, region_id: { type: 'string' }, spec,
      terms_note: { type: 'string' }, allow_redistribute: { type: 'boolean' },
      interval_sec: { type: 'integer' }, trust: { type: 'number', minimum: 0, maximum: 1 },
      force: { type: 'boolean' },
    },
  },
  source_update: {
    type: 'object', required: ['expected_version'],
    properties: {
      spec, interval_sec: { type: 'integer' }, enabled: { type: 'boolean' }, trust: { type: 'number' },
      expected_version: { type: 'integer' }, approval_token: { type: 'string' },
    },
  },
  source_approve: {
    type: 'object', required: ['terms_note', 'allow_redistribute'],
    properties: { spec, terms_note: { type: 'string' }, allow_redistribute: { type: 'boolean' } },
  },
  approval_issue: {
    type: 'object', required: ['action', 'source_id'],
    properties: { action: { enum: ['source_remove', 'enable_browser'] }, source_id: { type: 'string' } },
  },
  source_discover: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1 } },
  },
  events_search: {
    type: 'object', required: ['region_id', 'from', 'to'],
    properties: {
      region_id: { type: 'string' }, from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' }, q: { type: 'string' }, source: { type: 'string' },
    },
  },
} as const;

export type ToolName = keyof typeof INPUT_SCHEMAS;

export interface RegionInput {
  id?: unknown; name?: unknown; tz?: unknown; keywords?: unknown; radius_km?: unknown;
  center?: { lat?: unknown; lon?: unknown };
}

/** Region input (keywords, center, radius_km) -> stored form (keywords_json as JSON string). */
export function regionInputToStored(body: RegionInput): Record<string, unknown> {
  return {
    id: body.id, name: body.name, tz: body.tz,
    center_lat: body.center?.lat ?? null, center_lon: body.center?.lon ?? null,
    radius_km: body.radius_km ?? null,
    keywords_json: JSON.stringify(body.keywords),
  };
}
