// Design §5.1 SourceSpec (JSON Schema 2020-12)
export const SOURCE_SPEC_SCHEMA = {
  $id: 'SourceSpec',
  type: 'object',
  required: ['kind', 'region_policy'],
  additionalProperties: false,
  if: { properties: { kind: { const: 'html' } }, required: ['kind'] },
  then: { required: ['extract'] },
  properties: {
    kind: { enum: ['ical', 'rss', 'jsonld', 'html', 'json_api'] },
    date_from: { enum: ['published', 'content'] },
    fetch: {
      type: 'object',
      properties: {
        render: { enum: ['none', 'browser'] },
        headers: { type: 'object' },
        paging: {
          type: 'object',
          properties: {
            type: { enum: ['next_link'] },
            selector: { type: 'string' },
            max_pages: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    extract: {
      type: 'object',
      required: ['item_selector', 'fields'],
      properties: {
        item_selector: { type: 'string' },
        fields: {
          type: 'object',
          required: ['title', 'date'],
          additionalProperties: {
            type: 'object',
            required: ['css'],
            properties: {
              css: { type: 'string' },
              attr: { type: 'string' },
              absolutize: { type: 'boolean' },
            },
          },
        },
        date_format_hints: { type: 'array', items: { type: 'string' } },
        default_tz: { type: 'string' },
        llm_fallback: { type: 'boolean' },
      },
    },
    region_policy: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { enum: ['trust_source', 'keyword', 'geo'] },
        min_confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  },
} as const;
