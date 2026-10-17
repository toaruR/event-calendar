import { AppError } from '../errors.ts';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { assertUrlAllowed } from '../net/ssrf.ts';
import { fetchSafe } from '../net/fetcher.ts';
import { RobotsCache, checkRobots } from '../net/robots.ts';
import { fetchStage } from '../pipeline/fetch-stage.ts';
import { fetchViaJina, isReadFailure, jinaApplies } from '../net/jina.ts';
import type { FetchStageDeps } from '../pipeline/fetch-stage.ts';
import { parseWhen } from '../pipeline/run-job.ts';
import { extract as runExtract } from '../extract/index.ts';
import type { ExtractSpec, SourceKind } from '../extract/index.ts';
import { startLocalDate } from '../normalize/time.ts';
import { sanitizeText } from '../normalize/sanitize.ts';
import { passesMinConfidence, regionConfidence } from '../normalize/region.ts';
import type { RegionPolicy } from '../normalize/region.ts';

export interface DryRunRegion {
  tz: string;
  center_lat: number | null; center_lon: number | null; radius_km: number | null;
  keywords_json: string;
}

export interface DryRunDeps {
  net: FetchStageDeps;
  config?: Config;
  now?: Date;
  /** when given, region_policy filtering and tz default apply (as in runJob) */
  region?: DryRunRegion | null;
}

export interface DrySample {
  source_uid: string; title: string; start_utc: string; end_utc: string | null; all_day: boolean;
  start_local_date: string; tz: string; venue_name: string | null; address: string | null;
  description: string | null; url: string | null; status: string;
}

export interface DryRunResult {
  ok: boolean;
  samples: DrySample[];
  warnings: string[];
  item_count: number;
  robots_allowed: boolean;
  /** the spec actually used (guessed from the body when none was given) */
  spec: Record<string, unknown>;
}

const KINDS = new Set(['ical', 'rss', 'jsonld', 'html', 'json_api']);

function guessKind(body: string): string {
  const head = body.trimStart().slice(0, 400).toLowerCase();
  if (head.startsWith('begin:vcalendar')) return 'ical';
  if (head.includes('<rss') || head.includes('<feed')) return 'rss';
  if (head.startsWith('{') || head.startsWith('[')) return 'json_api';
  return 'jsonld';
}

/**
 * Fetch -> Extract -> Normalize without writing to the DB.
 * Throws SSRF_BLOCKED (before any request) and FETCH_FAILED. robots Disallow returns robots_allowed=false
 * without fetching the body.
 */
export async function dryRun(url: string, spec: Record<string, unknown> | undefined, deps: DryRunDeps): Promise<DryRunResult> {
  const config: Config = deps.config ?? defaultConfig();
  const now = deps.now ?? new Date(deps.net.clock.now());
  const allowlist = deps.net.config?.ssrf_allowlist ?? config.ssrf_allowlist;
  await assertUrlAllowed(url, { resolve: deps.net.resolve, allowlist });

  const cache = deps.net.robotsCache ?? new RobotsCache(config.robots_cache);
  const net: FetchStageDeps = { ...deps.net, robotsCache: cache };
  const host = new URL(url).host.toLowerCase();
  const verdict = await checkRobots(url, {
    clock: net.clock, cache,
    fetch: async (u) => {
      await net.limiter.wait(host);
      const r = await fetchSafe(u, { resolve: net.resolve, config: net.config });
      return { status: r.status, text: r.body };
    },
  });
  if (verdict.decision === 'blocked') {
    return { ok: false, samples: [], warnings: ['blocked by robots.txt'], item_count: 0, robots_allowed: false, spec: spec ?? {} };
  }

  const warnings: string[] = [];
  // no spec yet: a page body guesses to 'jsonld', so treat it as such for the jina retry
  const kindHint = String(spec?.['kind'] ?? 'jsonld');
  const fr = await fetchStage(url, undefined, net);
  let body: string;
  let viaJina = false;
  if (fr.kind === 'ok') body = fr.text;
  else {
    if (fr.kind === 'blocked_robots') {
      return { ok: false, samples: [], warnings: ['blocked by robots.txt'], item_count: 0, robots_allowed: false, spec: spec ?? {} };
    }
    const text = fr.kind === 'failed' && isReadFailure(fr.status) && jinaApplies(kindHint, config)
      ? await fetchViaJina(url, net, config) : null;
    if (text === null) {
      const msg = 'error' in fr ? fr.error : fr.kind;
      throw new AppError('FETCH_FAILED', `fetch failed: ${msg}`, { kind: fr.kind });
    }
    body = text;
    viaJina = true;
    warnings.push('read via jina');
  }

  const usedSpec: Record<string, unknown> = spec ?? { kind: guessKind(body), region_policy: { mode: 'trust_source' } };
  const kind = String(usedSpec['kind']);
  if (!KINDS.has(kind)) throw new AppError('INVALID_ARGUMENT', `unsupported source kind: ${kind}`, { kind });
  const exSpec = usedSpec as ExtractSpec & { region_policy?: RegionPolicy; extract?: { default_tz?: string } };

  const fetchPage = async (u: string): Promise<string> => {
    const r = await fetchStage(u, undefined, net);
    if (r.kind !== 'ok') throw new Error(`page fetch failed: ${r.kind}`);
    return r.text;
  };
  let ex;
  try {
    ex = await runExtract(kind as SourceKind, body, exSpec, { now, config, baseUrl: url, fetchPage });
    if (ex.items.length === 0 && !viaJina && jinaApplies(kind, config)) {
      const text = await fetchViaJina(url, net, config);
      const ex2 = text === null ? null : await runExtract(kind as SourceKind, text, exSpec, { now, config, baseUrl: url, fetchPage });
      if (ex2 && ex2.items.length > 0) { ex = ex2; warnings.push('read via jina'); }
    }
  } catch (e) {
    warnings.push(`extract failed: ${(e as Error).message}`);
    return { ok: false, samples: [], warnings, item_count: 0, robots_allowed: true, spec: usedSpec };
  }
  warnings.push(...ex.warnings);
  if (ex.error) warnings.push(ex.error);

  const region = deps.region ?? null;
  const tz = exSpec.extract?.default_tz ?? region?.tz ?? 'Asia/Tokyo';
  const policy: RegionPolicy = exSpec.region_policy ?? { mode: 'trust_source' };
  const minConf = policy.min_confidence ?? config.min_confidence;
  const info = region
    ? {
        keywords: JSON.parse(region.keywords_json) as string[],
        center_lat: region.center_lat ?? 0, center_lon: region.center_lon ?? 0, radius_km: region.radius_km ?? 0,
      }
    : null;

  const samples: DrySample[] = [];
  let count = 0;
  let dropped = 0;
  const redact = config.redact_contact;
  for (const item of ex.items) {
    const title = sanitizeText(item.title, redact);
    const start = parseWhen(item.start, tz);
    if (!title || !start) { dropped++; continue; }
    const end = parseWhen(item.end, tz);
    const venue = item.venue === null ? null : sanitizeText(item.venue, redact) || null;
    const address = item.address === null ? null : sanitizeText(item.address, redact) || null;
    if (info) {
      const conf = regionConfidence({ title, venue, address }, policy, info, config.keyword_full_hits);
      if (!passesMinConfidence(conf, minConf)) { dropped++; continue; }
    }
    count++;
    if (samples.length < 5) {
      samples.push({
        source_uid: item.source_uid, title, start_utc: start.utc,
        end_utc: end && end.utc >= start.utc ? end.utc : null, all_day: start.allDay,
        start_local_date: startLocalDate(start.utc, tz), tz, venue_name: venue, address,
        description: item.description === null ? null : sanitizeText(item.description, redact) || null,
        url: item.url, status: item.status ?? 'confirmed',
      });
    }
  }
  if (dropped > 0) warnings.push(`${dropped} item(s) dropped (unparsable or outside region)`);
  return { ok: count > 0, samples, warnings, item_count: count, robots_allowed: true, spec: usedSpec };
}
