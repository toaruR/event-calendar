import { AppError, errorEnvelope, exitCode } from '../errors.ts';
import { callTool, TOOL_NAMES } from './client.ts';
import type { CallOpts } from './client.ts';
import { startDaemon, parseDaemonArgs } from '../daemon.ts';
import { readFileSync } from 'node:fs';
import { defaultConfig, loadConfig } from '../config.ts';
import type { Config } from '../config.ts';

export interface CliIo { out: (s: string) => void; err: (s: string) => void }

export interface Parsed { tool: string; input: Record<string, unknown>; opts: CallOpts; help: boolean; configPath?: string }

/** subcommand aliases -> tool name (tool names themselves are also accepted as `a b`). */
const ALIASES: Record<string, string> = {
  'region add': 'region_upsert', 'region set': 'region_upsert',
  'source rm': 'source_remove', 'source delete': 'source_remove',
  run: 'run_now', events: 'events_search', export: 'calendar_export', 'approval issue': 'approval_issue',
};

const GLOBAL_FLAGS = new Set(['embedded', 'base-url', 'data-dir', 'db', 'config', 'help']);

function coerce(key: string, v: string): unknown {
  if (key === 'id' || key.endsWith('_id')) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  const c = v.charAt(0);
  if (c === '[' || c === '{' || (v !== '' && Number.isFinite(Number(v)) && String(Number(v)) === v)) {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

/** Resolve the leading positional words to a tool name; returns [tool|undefined, rest]. */
export function resolveTool(words: string[]): [string | undefined, string[]] {
  for (let n = Math.min(2, words.length); n >= 1; n--) {
    const key = words.slice(0, n).join(' ');
    const name = ALIASES[key] ?? key.replaceAll(' ', '_');
    if (TOOL_NAMES.includes(name)) return [name, words.slice(n)];
  }
  return [undefined, words];
}

export function parseArgs(argv: string[]): Parsed {
  const words: string[] = [];
  const flags: Record<string, unknown> = {};
  const g: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--') || a === '--') { words.push(a); continue; }
    let key = a.slice(2);
    let val: string | undefined;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (key === 'embedded' || key === 'help') { g[key] = true; continue; }
    if (val === undefined) {
      const nx = argv[i + 1];
      if (nx !== undefined && !nx.startsWith('--')) { val = nx; i++; } else { val = 'true'; }
    }
    if (GLOBAL_FLAGS.has(key)) g[key] = val;
    else flags[key.replaceAll('-', '_')] = coerce(key.replaceAll('-', '_'), val);
  }
  const [tool, rest] = resolveTool(words);
  const input = { ...flags };
  // one remaining positional is the target id
  if (rest.length === 1 && input['id'] === undefined) input['id'] = rest[0]!;
  const opts: CallOpts = {};
  if (g['embedded'] === true) opts.embedded = true;
  if (typeof g['base-url'] === 'string') opts.baseUrl = g['base-url'];
  if (typeof g['data-dir'] === 'string') opts.dataDir = g['data-dir'];
  if (typeof g['db'] === 'string') opts.dbPath = g['db'];
  const parsed: Parsed = { tool: tool ?? words.join(' '), input, opts, help: g['help'] === true && tool === undefined };
  if (g['config'] !== undefined) parsed.configPath = g['config'] === true ? '' : g['config'];
  return parsed;
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
  return loadConfig(json as Partial<Config>);
}

const USAGE = `usage: ec <command> [--key value ...] [--embedded] [--base-url URL] [--data-dir DIR] [--config FILE (embedded only)]\ncommands: ${['daemon', ...TOOL_NAMES.map((t) => t.replaceAll('_', ' '))].join(', ')}\n`;

/** Run the CLI. Returns the process exit code (0 ok, 2 INVALID_ARGUMENT, 3 ZERO_ITEMS, 4 DAEMON_UNAVAILABLE, 1 others). */
export async function main(argv: string[], io: CliIo = {
  out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); },
}): Promise<number> {
  if (argv[0] === 'daemon') {
    const d = await startDaemon(parseDaemonArgs(argv.slice(1)));
    io.out(JSON.stringify({ event: 'listening', port: d.port }) + '\n');
    const stop = (): void => { void d.stop().finally(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return await new Promise<number>(() => { /* run until signalled */ });
  }
  const p = parseArgs(argv);
  if (p.help || argv.length === 0) { io.err(USAGE); return argv.length === 0 ? 2 : 0; }
  if (p.configPath !== undefined) {
    try {
      if (p.opts.embedded !== true) throw new AppError('INVALID_ARGUMENT', '--config is only supported together with --embedded', { config: p.configPath });
      p.opts.config = loadConfigFile(p.configPath);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      io.out(JSON.stringify(errorEnvelope(e.code, e.message, e.details)) + '\n');
      return exitCode(e.code);
    }
  }
  const r = await callTool(p.tool, p.input, p.opts);
  if (r.ok) {
    io.out(typeof r.body === 'string' ? r.body : JSON.stringify(r.body) + '\n');
    return r.exitCode;
  }
  if (r.code === 'INVALID_ARGUMENT' && r.message.startsWith('unknown tool')) io.err(USAGE);
  io.out(JSON.stringify(errorEnvelope(r.code, r.message, r.details)) + '\n');
  return r.exitCode;
}
