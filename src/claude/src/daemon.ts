import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { openDb } from './db.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { createCore, unrefClock } from './core.ts';
import type { CoreDeps, CoreHandle } from './core.ts';

export interface DaemonOpts {
  /** SQLite path; default <dataDir>/event-calendar.db */
  dbPath?: string;
  /** listen port (0 = ephemeral); default from config.listen */
  port?: number;
  host?: string;
  dataDir?: string;
  config?: Partial<Config>;
  deps?: CoreDeps;
}

export interface Daemon {
  /** per-start X-GUI-Token; returned to the caller only, never written to disk */
  guiToken: string;
  port: number;
  handle: CoreHandle;
  stop(): Promise<void>;
}

export async function startDaemon(opts: DaemonOpts = {}): Promise<Daemon> {
  const config = loadConfig(opts.config ?? {});
  const dataDir = resolve(opts.dataDir ?? '.event-calendar');
  let dbPath = opts.dbPath;
  if (dbPath === undefined) {
    mkdirSync(dataDir, { recursive: true });
    dbPath = join(dataDir, 'event-calendar.db');
  }
  const db = openDb(dbPath, config.busy_timeout);
  const handle = createCore(db, config, {
    clock: unrefClock,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...opts.deps,
  });
  try {
    await handle.start();
  } catch (e) {
    handle.worker?.stop();
    db.close();
    throw e;
  }
  const port = (handle.http.server.address() as AddressInfo).port;
  let stopped = false;
  return {
    guiToken: handle.http.token, port, handle,
    async stop() {
      if (stopped) return;
      stopped = true;
      await handle.stop();
      try { db.close(); } catch (e) { process.stderr.write(`warn: db close failed (a running job may hold the handle): ${e instanceof Error ? e.message : String(e)}
`); }
    },
  };
}

/** CLI args: --port N --db PATH --data-dir DIR --host H [--stdin-shutdown] */
export function parseDaemonArgs(argv: string[]): DaemonOpts {
  const o: DaemonOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (a === '--port' && v !== undefined) { o.port = Number(v); i++; }
    else if (a === '--db' && v !== undefined) { o.dbPath = v; i++; }
    else if (a === '--data-dir' && v !== undefined) { o.dataDir = v; i++; }
    else if (a === '--host' && v !== undefined) { o.host = v; i++; }
  }
  return o;
}

async function main(): Promise<void> {
  const d = await startDaemon(parseDaemonArgs(process.argv.slice(2)));
  process.stdout.write(JSON.stringify({ event: 'listening', port: d.port }) + '\n');
  const shutdown = (): void => { void d.stop().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Windows cannot deliver SIGTERM gracefully: with --stdin-shutdown, a 'shutdown' line on stdin (or stdin EOF) stops the daemon.
  if (process.argv.includes('--stdin-shutdown')) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => { if (c.includes('shutdown')) shutdown(); });
    process.stdin.on('end', shutdown);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { process.stderr.write(String(e instanceof Error ? e.message : e) + '\n'); process.exit(1); });
}
