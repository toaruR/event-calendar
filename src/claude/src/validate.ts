import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, Options } from 'ajv';
import type { Ajv2020 as Ajv2020Instance } from 'ajv/dist/2020.js';
import { AppError } from './errors.ts';
import { defaultConfig } from './config.ts';
import type { Config } from './config.ts';
import { SOURCE_SPEC_SCHEMA } from './schemas/source-spec.ts';
import { OUTPUT_SCHEMAS } from './schemas/output-types.ts';
import type { OutputTypeName } from './schemas/output-types.ts';
import { INPUT_SCHEMAS, regionInputToStored } from './schemas/input-schemas.ts';
import type { RegionInput } from './schemas/input-schemas.ts';

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Shared Ajv (2020-12) instance. Extra schemas are registered via addSchemas(). */
export const ajv = new (Ajv2020 as unknown as { default: new (opts: Options) => Ajv2020Instance }).default({ allErrors: true, strict: false });
ajv.addFormat('date-time', {
  validate: (s: string) => DATE_TIME_RE.test(s) && !Number.isNaN(Date.parse(s)),
});

const registered = new Set<string>();
export function addSchema(id: string, schema: object): void {
  if (registered.has(id)) return;
  ajv.addSchema(schema, id);
  registered.add(id);
}
addSchema('SourceSpec', SOURCE_SPEC_SCHEMA);
for (const [k, v] of Object.entries(OUTPUT_SCHEMAS)) addSchema('Out.' + k, v);
for (const [k, v] of Object.entries(INPUT_SCHEMAS)) addSchema('In.' + k, v);

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
    .join('; ');
}

/** Validate data against a registered schema key/ID; throw INVALID_ARGUMENT on violation. */
export function assertValid(schemaKeyRef: string, data: unknown): void {
  const validate = ajv.getSchema(schemaKeyRef);
  if (!validate) throw new Error(`unknown schema: ${schemaKeyRef}`);
  if (!validate(data)) {
    throw new AppError('INVALID_ARGUMENT', formatAjvErrors(validate.errors), { errors: validate.errors });
  }
}

export function validateSourceSpec(spec: unknown, config: Pick<Config, 'max_pages_limit'> = defaultConfig()): void {
  assertValid('SourceSpec', spec);
  const mp = (spec as { fetch?: { paging?: { max_pages?: unknown } } } | null | undefined)?.fetch?.paging?.max_pages;
  if (typeof mp === 'number' && mp > config.max_pages_limit) {
    throw new AppError('INVALID_ARGUMENT', `fetch.paging.max_pages ${mp} exceeds max_pages_limit ${config.max_pages_limit}`, {
      max_pages: mp, max_pages_limit: config.max_pages_limit,
    });
  }
}

export function validateOutput(type: OutputTypeName, data: unknown): void {
  assertValid('Out.' + type, data);
}

export function isValidTz(tz: unknown): boolean {
  if (typeof tz !== 'string' || tz === '') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Validate a tool request body. Throws AppError INVALID_ARGUMENT on violation.
 * Returns the (possibly converted) body: region_upsert yields the stored form (keywords_json = JSON string).
 */
export function validateInput(tool: string, body: unknown, config: Pick<Config, 'interval_min' | 'max_pages_limit'> = defaultConfig()): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(INPUT_SCHEMAS, tool)) {
    throw new AppError('INVALID_ARGUMENT', `unknown tool: ${tool}`);
  }
  assertValid('In.' + tool, body);
  const b = body as RegionInput & { spec?: unknown; interval_sec?: unknown };
  if (b.spec !== undefined) validateSourceSpec(b.spec, config);
  if ((tool === 'source_add' || tool === 'source_update') && typeof b.interval_sec === 'number' && b.interval_sec < config.interval_min) {
    throw new AppError('INVALID_ARGUMENT', `interval_sec ${b.interval_sec} < interval_min ${config.interval_min}`, {
      interval_sec: b.interval_sec, interval_min: config.interval_min,
    });
  }
  if (tool === 'region_upsert') {
    if (!isValidTz(b.tz)) throw new AppError('INVALID_ARGUMENT', `invalid tz: ${b.tz}`, { tz: b.tz });
    return regionInputToStored(b);
  }
  return body as Record<string, unknown>;
}
