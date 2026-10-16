import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface RunResult { pid: number; status: number | null; stdout: string; stderr: string }
export interface Proc {
  child: ChildProcess;
  pid: number;
  exited: Promise<number | null>;
  stdout(): string;
  stderr(): string;
  /** resolves with the first stdout line that satisfies pred (rejects on exit / timeout) */
  waitLine(pred: (line: string) => boolean, ms?: number): Promise<string>;
}

const pids = new Set<number>();
/** every pid spawned through this helper (for the leftover-process check) */
export const spawnedPids = (): number[] => [...pids];

export function startProc(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Proc {
  const child = spawn(process.execPath, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid as number;
  pids.add(pid);
  let out = ''; let err = '';
  let done = false;
  const listeners: (() => void)[] = [];
  child.stdout!.on('data', (d) => { out += d; listeners.forEach((l) => l()); });
  child.stderr!.on('data', (d) => { err += d; });
  const exited = new Promise<number | null>((res) => {
    child.on('close', (code) => { done = true; listeners.forEach((l) => l()); res(code); });
  });
  return {
    child, pid, exited, stdout: () => out, stderr: () => err,
    waitLine(pred, ms = 15000) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for line; stdout=${out} stderr=${err}`)), ms);
        const check = (): void => {
          const hit = out.split('\n').find((l) => l !== '' && pred(l));
          if (hit !== undefined) { clearTimeout(timer); resolve(hit); }
          else if (done) { clearTimeout(timer); reject(new Error(`process exited; stdout=${out} stderr=${err}`)); }
        };
        listeners.push(check);
        check();
      });
    },
  };
}

export async function runProc(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  const p = startProc(args, opts);
  p.child.stdin!.end();
  const status = await p.exited;
  return { pid: p.pid, status, stdout: p.stdout(), stderr: p.stderr() };
}

/** true when the pid no longer exists (process.kill(pid, 0) throws ESRCH) */
export function isGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}
