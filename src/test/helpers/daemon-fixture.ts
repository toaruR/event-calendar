import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon.ts';
import type { Daemon } from '../../src/daemon.ts';
import type { Config } from '../../src/config.ts';

export interface DaemonFixture {
  d: Daemon;
  base: string;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  stop(): Promise<void>;
}

/** In-process daemon (real worker, real clock, real HTTP) on an ephemeral port with region r1 registered. */
export async function bootDaemon(config: Partial<Config> = {}): Promise<DaemonFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'ecd-e2e-'));
  // generous host rate so the dry run at add time does not delay the first scheduled fetch of the same host
  config = { host_rate: { requests: 1000, per_sec: 1 }, ...config };
  const d = await startDaemon({ dbPath: ':memory:', port: 0, dataDir: dir, config });
  const base = `http://127.0.0.1:${d.port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-gui-token': d.guiToken },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const put = await call('PUT', '/regions/r1', { name: '世田谷', tz: 'Asia/Tokyo', keywords: ['世田谷'] });
  if (put.status !== 200) throw new Error(`region setup failed: ${put.status}`);
  return {
    d, base, call,
    async stop() { await d.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}
