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

const X_SEARCH_SPEC = { kind: 'html', parser: 'yahoo_realtime', date_from: 'content', region_policy: { mode: 'trust_source' } };

/** Yahoo! realtime search (X posts) URL for the region query (base: config.x_search_base). */
export function xSearchUrl(base: string, query: string): string {
  return `${base}?${new URLSearchParams({ p: query })}`;
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
  const cfg = cfgOf(deps);
  if (provider === 'none' && !cfg.x_search) throw new AppError('INVALID_ARGUMENT', 'search_provider is none', {});
  const region = getRegionRow(db, regionId) as unknown as { name: string; keywords_json: string };
  const net = { ...deps.net, robotsCache: deps.net.robotsCache ?? new RobotsCache(cfg.robots_cache) };
  const allowlist = net.config?.ssrf_allowlist ?? cfg.ssrf_allowlist;
  const keywords = JSON.parse(region.keywords_json) as string[];
  const query = `${region.name} ${keywords.join(' ')} イベント`.trim();
  const hits: Array<SearchHit & { spec?: Record<string, unknown> }> = provider === 'none' ? [] : (await provider(query, limit)).slice(0, limit);
  if (cfg.x_search) hits.push({ url: xSearchUrl(cfg.x_search_base, query), title: `X検索: ${query}`, kind_guess: 'html', spec: X_SEARCH_SPEC });
  const now = nowOf(deps);
  const out: CandidateDto[] = [];
  const registered = new Set((db.prepare('SELECT url FROM source WHERE region_id = ?').all(regionId) as Array<{ url: string }>).map((r) => r.url));
  for (const h of hits) {
    if (registered.has(h.url)) continue;
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
      "INSERT INTO source_candidate(id,region_id,url,kind_guess,robots_allowed,spec_guess_json,status,found_at) VALUES(?,?,?,?,?,?,'proposed',?)",
    ).run(id, regionId, h.url, kind, allowed ? 1 : 0, h.spec ? JSON.stringify(h.spec) : null, now.toISOString());
    out.push({ id, url: h.url, kind_guess: kind, robots_allowed: allowed, status: 'proposed' });
  }
  return { candidates: out };
}

export interface CandidateRow extends CandidateDto { region_id: string; found_at: string | null }

/** candidate list (GUI): optional region_id, status (default 'proposed'); newest first. */
export function listCandidates(db: DatabaseSync, filter: { region_id?: string; status?: string } = {}): { candidates: CandidateRow[] } {
  const status = filter.status ?? 'proposed';
  if (!['proposed', 'approved', 'rejected'].includes(status)) throw new AppError('INVALID_ARGUMENT', `invalid status: ${status}`, { status });
  const where = ['status = ?'];
  const args: string[] = [status];
  if (filter.region_id !== undefined) { where.push('region_id = ?'); args.push(filter.region_id); }
  const rows = db.prepare(`SELECT * FROM source_candidate WHERE ${where.join(' AND ')} ORDER BY found_at DESC, id DESC`).all(...args) as
    Array<{ id: string; region_id: string; url: string; kind_guess: string | null; robots_allowed: number | null; status: CandidateDto['status']; found_at: string | null }>;
  return {
    candidates: rows.map((r) => ({
      id: r.id, region_id: r.region_id, url: r.url, kind_guess: r.kind_guess ?? 'html',
      robots_allowed: r.robots_allowed === 1, status: r.status, found_at: r.found_at,
    })),
  };
}

/** Reject a proposed candidate (it stays recorded, so discover does not propose it again). */
export function rejectCandidate(db: DatabaseSync, candidateId: string): { candidate_id: string; status: 'rejected' } {
  const c = db.prepare('SELECT status FROM source_candidate WHERE id = ?').get(candidateId) as { status: string } | undefined;
  if (!c) throw new AppError('NOT_FOUND', `candidate not found: ${candidateId}`, { candidate_id: candidateId });
  if (c.status !== 'proposed') throw new AppError('CONFLICT', `candidate already ${c.status}`, { status: c.status });
  db.prepare("UPDATE source_candidate SET status = 'rejected' WHERE id = ?").run(candidateId);
  return { candidate_id: candidateId, status: 'rejected' };
}

/**
 * Periodic discover: each region whose last discover is older than discover_interval_sec (tracked in
 * discover_run, so a restart does not re-search) gets one discoverSources call. Errors are per region.
 */
export async function discoverDue(
  db: DatabaseSync, provider: 'none' | SearchProvider, deps: SourceDeps,
): Promise<Array<{ region_id: string; found?: number; error?: string }>> {
  const cfg = cfgOf(deps);
  if (cfg.discover_interval_sec <= 0 || (provider === 'none' && !cfg.x_search)) return [];
  const now = nowOf(deps);
  const cutoff = new Date(now.getTime() - cfg.discover_interval_sec * 1000).toISOString();
  const due = db.prepare(
    'SELECT r.id FROM region r LEFT JOIN discover_run d ON d.region_id = r.id WHERE d.last_at IS NULL OR d.last_at <= ? ORDER BY r.id',
  ).all(cutoff) as Array<{ id: string }>;
  const out: Array<{ region_id: string; found?: number; error?: string }> = [];
  for (const { id } of due) {
    db.prepare('INSERT INTO discover_run(region_id,last_at) VALUES(?,?) ON CONFLICT(region_id) DO UPDATE SET last_at = excluded.last_at')
      .run(id, now.toISOString());
    try {
      const r = await discoverSources(db, id, { provider, limit: cfg.discover_limit }, deps);
      out.push({ region_id: id, found: r.candidates.length });
    } catch (e) { out.push({ region_id: id, error: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}
