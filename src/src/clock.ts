export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Manually advanced clock; sleep() resolves when advance()/set() passes the deadline. */
export class FakeClock implements Clock {
  private t: number;
  private waiters: { at: number; resolve: () => void }[] = [];
  constructor(startMs = 0) { this.t = startMs; }
  now(): number { return this.t; }
  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push({ at: this.t + ms, resolve }); });
  }
  set(ms: number): void {
    this.t = ms;
    const due = this.waiters.filter((w) => w.at <= this.t);
    this.waiters = this.waiters.filter((w) => w.at > this.t);
    for (const w of due) w.resolve();
  }
  advance(ms: number): void { this.set(this.t + ms); }
}
