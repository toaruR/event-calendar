import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import { defaultConfig } from '../config.ts';
import type { FetchResult } from '../pipeline/run-job.ts';

export type RobotsVerdict =
  | { decision: 'allowed'; crawlDelay: number | null }
  | { decision: 'deferred'; crawlDelay: null }
  | { decision: 'blocked'; crawlDelay: number | null };

export interface RobotsRules { disallow: string[]; allow: string[]; crawlDelay: number | null }

interface Entry { at: number; rules: RobotsRules }

/** robots_cache: per-host rules (only definitive fetches) kept for ttlSec (default 24h). */
export class RobotsCache {
  private map = new Map<string, Entry>();
  ttlMs: number;
  constructor(ttlSec: number = defaultConfig().robots_cache) { this.ttlMs = ttlSec * 1000; }
  get(host: string, now: number): RobotsRules | undefined {
    const e = this.map.get(host);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) { this.map.delete(host); return undefined; }
    return e.rules;
  }
  set(host: string, rules: RobotsRules, now: number): void { this.map.set(host, { at: now, rules }); }
}

export interface RobotsDeps {
  fetch: (url: string) => Promise<FetchResult>;
  clock?: Clock;
  cache?: RobotsCache;
  agent?: string;
}

/** Parse robots.txt; picks groups naming `agent` (substring match), else `*`. */
export function parseRobots(text: string, agent = 'event-calendar-bot'): RobotsRules {
  type G = { agents: string[]; rules: { allow: boolean; path: string }[]; delay: number | null };
  const groups: G[] = [];
  let cur: G | null = null;
  let lastWasAgent = false;
  for (const raw of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'disallow') cur.rules.push({ allow: false, path: val });
    else if (key === 'allow') cur.rules.push({ allow: true, path: val });
    else if (key === 'crawl-delay') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) cur.delay = n;
    }
  }
  const a = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  const picked = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const disallow: string[] = [];
  const allow: string[] = [];
  let crawlDelay: number | null = null;
  for (const g of picked) {
    for (const r of g.rules) if (r.path !== '') (r.allow ? allow : disallow).push(r.path);
    if (g.delay !== null) crawlDelay = g.delay;
  }
  return { disallow, allow, crawlDelay };
}

function pathMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const p = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

/** Longest matching rule wins; Allow wins ties. */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  let best = -1;
  let allowed = true;
  for (const [list, isAllow] of [[rules.disallow, false], [rules.allow, true]] as const) {
    for (const p of list) {
      if (pathMatches(p, path) && (p.length > best || (p.length === best && isAllow))) {
        best = p.length;
        allowed = isAllow;
      }
    }
  }
  return allowed;
}

/**
 * 5xx / network failure -> deferred (not cached, body not fetched, retried next time);
 * 4xx -> allowed; 2xx -> parsed rules. Definitive results are cached for robots_cache seconds.
 */
export async function checkRobots(url: string, deps: RobotsDeps): Promise<RobotsVerdict> {
  const clock = deps.clock ?? systemClock;
  const u = new URL(url);
  const host = u.host.toLowerCase();
  let rules = deps.cache?.get(host, clock.now());
  if (!rules) {
    const r = await deps.fetch(`${u.protocol}//${u.host}/robots.txt`);
    if (r.status >= 200 && r.status < 300) rules = parseRobots(r.text, deps.agent);
    else if (r.status >= 400 && r.status < 500) rules = { disallow: [], allow: [], crawlDelay: null };
    else return { decision: 'deferred', crawlDelay: null };
    deps.cache?.set(host, rules, clock.now());
  }
  return isPathAllowed(rules, u.pathname + u.search)
    ? { decision: 'allowed', crawlDelay: rules.crawlDelay }
    : { decision: 'blocked', crawlDelay: rules.crawlDelay };
}
