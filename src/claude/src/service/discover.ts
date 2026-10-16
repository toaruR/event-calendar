import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { assertUrlAllowed } from '../net/ssrf.ts';
import { fetchSafe } from '../net/fetcher.ts';
import { RobotsCache, checkRobots } from '../net/robots.ts';
import { uuidv7 } from '../pipeline/upsert.ts';
import { cfgOf, getRegionRow, nowOf } from './sources.ts';
import type { SourceDeps } from './sources.ts';

export interface SearchHit { url: string; title?: string; kind_guess?: string }
/** Injected search provider: (query, limit) -> candidate URLs. */
export type SearchProvider = (query: string, limit: number) => Promise<SearchHit[]>;

export interface DiscoverOpts {
  limit?: number;
  /** 'none' (default, = search_provider config 'none') or an injected provider */
  provider?: 'none' | SearchProvider;
}

export interface CandidateDto {
  id: string; url: string; kind_guess: string; robots_allowed: boolean; status: 'proposed' | 'approved' | 'rejected';
}

function guessKind(url: string): string {
  const p = new URL(url).pathname.toLowerCase();
  if (p.endsWith('.ics')) return 'ical';
  if (p.endsWith('.rss') || p.endsWith('.xml') || p.endsWith('.atom')) return 'rss';
  if (p.endsWith('.json')) return 'json_api';
  return 'html';
}

/**
 * source_discover: ask the injected search provider for candidates in the region, record each as a 'proposed'
 * source_candidate with robots_allowed. SSRF-blocked URLs are skipped. Only robots.txt is fetched, never the page.
 */
export async function discoverSources(
  db: DatabaseSync, regionId: string, opts: DiscoverOpts, deps: SourceDeps,
): Promise<{ candidates: CandidateDto[] }> {
  const limit = opts.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1) throw new AppError('INVALID_ARGUMENT', 'limit must be an integer >= 1', { limit });
  const provider = opts.provider ?? 'none';
  if (provider === 'none') throw new AppError('INVALID_ARGUMENT', 'search_provider is none', {});
  const region = getRegionRow(db, regionId) as unknown as { name: string; keywords_json: string };
  const cfg = cfgOf(deps);
  const net = { ...deps.net, robotsCache: deps.net.robotsCache ?? new RobotsCache(cfg.robots_cache) };
  const allowlist = net.config?.ssrf_allowlist ?? cfg.ssrf_allowlist;
  const keywords = JSON.parse(region.keywords_json) as string[];
  const query = `${region.name} ${keywords.join(' ')} イベント`.trim();
  const hits = (await provider(query, limit)).slice(0, limit);
  const now = nowOf(deps);
  const out: CandidateDto[] = [];
  for (const h of hits) {
    try { await assertUrlAllowed(h.url, { resolve: net.resolve, allowlist }); } catch (e) {
      if (e instanceof AppError && e.code === 'SSRF_BLOCKED') continue;
      throw e;
    }
    const host = new URL(h.url).host.toLowerCase();
    let allowed: boolean;
    try {
      const v = await checkRobots(h.url, {
        clock: net.clock, cache: net.robotsCache,
        fetch: async (u) => {
          await net.limiter.wait(host);
          const r = await fetchSafe(u, { resolve: net.resolve, config: net.config });
          return { status: r.status, text: r.body };
        },
      });
      allowed = v.decision === 'allowed';
    } catch { allowed = false; /* fail closed: robots check error => not allowed */ }
    const kind = h.kind_guess ?? guessKind(h.url);
    const dup = db.prepare('SELECT id,status FROM source_candidate WHERE region_id = ? AND url = ?').get(regionId, h.url) as
      { id: string; status: CandidateDto['status'] } | undefined;
    if (dup) {
      db.prepare('UPDATE source_candidate SET robots_allowed = ? WHERE id = ?').run(allowed ? 1 : 0, dup.id);
      out.push({ id: dup.id, url: h.url, kind_guess: kind, robots_allowed: allowed, status: dup.status });
      continue;
    }
    const id = uuidv7(now);
    db.prepare(
      "INSERT INTO source_candidate(id,region_id,url,kind_guess,robots_allowed,spec_guess_json,status,found_at) VALUES(?,?,?,?,?,NULL,'proposed',?)",
    ).run(id, regionId, h.url, kind, allowed ? 1 : 0, now.toISOString());
    out.push({ id, url: h.url, kind_guess: kind, robots_allowed: allowed, status: 'proposed' });
  }
  return { candidates: out };
}
