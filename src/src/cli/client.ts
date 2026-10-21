import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { AppError, ERROR_CODES, exitCode } from '../errors.ts';
import type { ErrorCode } from '../errors.ts';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { openDb } from '../db.ts';
import { createCore } from '../core.ts';
import type { CoreDeps } from '../core.ts';

export interface CallOpts {
  /** true: load createCore in-process (no daemon needed). false/undefined: HTTP to the daemon. */
  embedded?: boolean;
  /** daemon base URL; default http://<config.listen> */
  baseUrl?: string;
  /** embedded data directory (default .event-calendar) */
  dataDir?: string;
  /** embedded SQLite path override (default <dataDir>/event-calendar.db) */
  dbPath?: string;
  config?: Config;
  /** embedded-mode deps (clock, net, searchProvider ...) */
  deps?: CoreDeps;
}

export type ToolResult =
  | { ok: true; exitCode: 0; status: number; body: unknown; etag?: string }
  | { ok: false; exitCode: number; code: ErrorCode; message: string; details: unknown };

interface Req { method: string; path: string; query?: Record<string, unknown>; body?: unknown }

type Input = Record<string, unknown>;
const pick = (i: Input, ...keys: string[]): Input => Object.fromEntries(keys.filter((k) => i[k] !== undefined).map((k) => [k, i[k]]));
const omit = (i: Input, ...keys: string[]): Input => Object.fromEntries(Object.entries(i).filter(([k]) => !keys.includes(k)));
function need(i: Input, ...keys: string[]): string {
  for (const k of keys) if (typeof i[k] === 'string' && i[k] !== '') return i[k] as string;
  throw new AppError('INVALID_ARGUMENT', `missing required argument: ${keys.join(' or ')}`, { missing: keys });
}
const seg = (s: string): string => encodeURIComponent(s);

/** tool name (= CLI subcommand operation) -> HTTP route. */
const TOOLS: Record<string, (i: Input) => Req> = {
  health: () => ({ method: 'GET', path: '/health' }),
  source_list: (i) => ({ method: 'GET', path: '/sources', query: pick(i, 'region_id', 'state') }),
  region_upsert: (i) => ({ method: 'PUT', path: `/regions/${seg(need(i, 'id', 'region_id'))}`, body: omit(i, 'id', 'region_id') }),
  source_test: (i) => ({ method: 'POST', path: '/sources:test', body: i }),
  source_add: (i) => ({ method: 'POST', path: '/sources', body: i }),
  source_update: (i) => ({ method: 'PATCH', path: `/sources/${seg(need(i, 'id', 'source_id'))}`, body: omit(i, 'id', 'source_id') }),
  source_remove: (i) => ({ method: 'DELETE', path: `/sources/${seg(need(i, 'id', 'source_id'))}`, body: omit(i, 'id', 'source_id') }),
  source_approve: (i) => ({ method: 'POST', path: `/candidates/${seg(need(i, 'id', 'candidate_id'))}/approve`, body: omit(i, 'id', 'candidate_id') }),
  approval_issue: (i) => ({ method: 'POST', path: '/approvals', body: i }),
  source_discover: (i) => ({ method: 'POST', path: `/regions/${seg(need(i, 'id', 'region_id'))}/discover`, body: omit(i, 'id', 'region_id') }),
  run_now: (i) => ({ method: 'POST', path: `/sources/${seg(need(i, 'id', 'source_id'))}/run`, body: {} }),
  events_search: (i) => ({ method: 'GET', path: '/events', query: i }),
  calendar_export: (i) => ({ method: 'GET', path: `/calendar/${seg(need(i, 'region_id', 'id'))}.ics`, query: pick(i, 'from', 'to') }),
};

export const TOOL_NAMES: readonly string[] = Object.keys(TOOLS);

function toQuery(q: Record<string, unknown> | undefined): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

export function failure(code: ErrorCode, message: string, details: unknown = {}): ToolResult {
  return { ok: false, exitCode: exitCode(code), code, message, details };
}

/** Map a raw {status, JSON body} response to a ToolResult (error envelope -> exit code per the design table). */
function fromResponse(status: number, body: unknown, raw: string | undefined, headers: Record<string, string>): ToolResult {
  if (status >= 200 && status < 300) {
    return { ok: true, exitCode: 0, status, body: raw !== undefined ? raw : body, ...(headers['etag'] ? { etag: headers['etag'] } : {}) };
  }
  if (status === 304) return { ok: true, exitCode: 0, status, body: '', ...(headers['etag'] ? { etag: headers['etag'] } : {}) };
  const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  const code = err?.code !== undefined && (ERROR_CODES as readonly string[]).includes(err.code) ? (err.code as ErrorCode) : 'FETCH_FAILED';
  return failure(code, err?.message ?? `HTTP ${status}`, err?.details ?? {});
}

async function callHttp(req: Req, opts: CallOpts, ifNoneMatch?: string): Promise<ToolResult> {
  const base = opts.baseUrl ?? `http://${(opts.config ?? defaultConfig()).listen}`;
  const hasBody = req.body !== undefined && req.method !== 'GET';
  const headers: Record<string, string> = {};
  if (hasBody) headers['content-type'] = 'application/json';
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
  let res: Response;
  let text: string;
  try {
    res = await fetch(base + req.path + toQuery(req.query), {
      method: req.method, headers, ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
    });
    text = await res.text();
  } catch (e) {
    return failure('DAEMON_UNAVAILABLE', `daemon unreachable at ${base} (start it with \`ec daemon\` or use --embedded)`, {
      base_url: base, cause: e instanceof Error ? ((e.cause as { code?: string } | undefined)?.code ?? e.message) : String(e),
    });
  }
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => { h[k] = v; });
  if ((h['content-type'] ?? '').startsWith('application/json')) {
    let parsed: unknown;
    try { parsed = text === '' ? {} : JSON.parse(text); } catch { return failure('FETCH_FAILED', 'daemon returned malformed JSON', {}); }
    return fromResponse(res.status, parsed, undefined, h);
  }
  return fromResponse(res.status, undefined, text, h);
}

async function callEmbedded(req: Req, opts: CallOpts, ifNoneMatch?: string): Promise<ToolResult> {
  const config = opts.config ?? defaultConfig();
  let dbPath = opts.dbPath;
  if (dbPath === undefined) {
    const dataDir = resolve(opts.dataDir ?? '.event-calendar');
    mkdirSync(dataDir, { recursive: true });
    dbPath = join(dataDir, 'event-calendar.db');
  }
  const db = openDb(dbPath, config.busy_timeout);
  try {
    const handle = createCore(db, config, { ...opts.deps, worker: false });
    const out = await handle.dispatch(req.method, req.path + toQuery(req.query), req.body, ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {});
    // round-trip through JSON so embedded bodies are byte-identical in shape to HTTP bodies
    const body = out.body === undefined ? undefined : JSON.parse(JSON.stringify(out.body));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.headers ?? {})) headers[k.toLowerCase()] = v;
    return fromResponse(out.status, body, out.raw, headers);
  } finally {
    try { db.close(); } catch (e) { process.stderr.write(`warn: db close failed: ${e instanceof Error ? e.message : String(e)}
`); }
  }
}

/**
 * Call a tool via the daemon HTTP API, or in-process (embedded). Never throws for domain errors:
 * returns {ok:false, code, exitCode} with exit codes INVALID_ARGUMENT=2, ZERO_ITEMS=3, DAEMON_UNAVAILABLE=4, others=1.
 * `input.if_none_match` (calendar_export) sends a conditional request.
 */
export async function callTool(name: string, input: Input = {}, opts: CallOpts = {}): Promise<ToolResult> {
  const build = Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name]! : undefined;
  if (!build) return failure('INVALID_ARGUMENT', `unknown tool: ${name}`, { tool: name });
  let req: Req;
  const ifNoneMatch = typeof input['if_none_match'] === 'string' ? (input['if_none_match'] as string) : undefined;
  try { req = build(omit(input, 'if_none_match')); } catch (e) {
    if (e instanceof AppError) return failure(e.code, e.message, e.details);
    throw e;
  }
  try {
    return opts.embedded ? await callEmbedded(req, opts, ifNoneMatch) : await callHttp(req, opts, ifNoneMatch);
  } catch (e) {
    if (e instanceof AppError) return failure(e.code, e.message, e.details);
    return failure('FETCH_FAILED', e instanceof Error ? e.message : 'internal error', {});
  }
}
