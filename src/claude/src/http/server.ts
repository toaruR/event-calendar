import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, errorEnvelope, httpStatus } from '../errors.ts';
import type { SourceDeps } from '../service/sources.ts';
import type { SearchProvider } from '../service/discover.ts';
import { checkGuiToken, generateGuiToken, isAuthExempt } from './auth.ts';
import { registerReadRoutes } from './routes-read.ts';
import { registerAdminRoutes } from './routes-admin.ts';
import { registerSourceRoutes } from './routes-sources.ts';
import { registerEventRoutes } from './routes-events.ts';
import { isStaticPath, serveStatic } from './static.ts';

export interface Core {
  db: DatabaseSync;
  deps: SourceDeps;
  /** injected search provider for discover; default 'none' */
  searchProvider?: 'none' | SearchProvider;
}

export interface RouteCtx {
  core: Core;
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  /** parsed JSON body ({} when empty); INVALID_ARGUMENT on malformed JSON */
  body(): Promise<unknown>;
}
export interface RouteResult { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> }
export type Handler = (ctx: RouteCtx) => RouteResult | Promise<RouteResult>;

interface RouteDef { method: string; segs: string[]; handler: Handler }

export class Router {
  routes: RouteDef[] = [];
  /** pattern segments: literal text (may contain ':'), or `{name}` for a path parameter */
  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segs: pattern.split('/').filter((s) => s !== ''), handler });
  }
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter((s) => s !== '');
    for (const r of this.routes) {
      if (r.method !== method || r.segs.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const s = r.segs[i]!;
        if (s.startsWith('{') && s.endsWith('}')) {
          try { params[s.slice(1, -1)] = decodeURIComponent(parts[i]!); } catch { ok = false; break; }
        } else if (s !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
}

const BODY_MAX = 1_048_576;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) { reject(new AppError('INVALID_ARGUMENT', 'request body too large', {})); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch { reject(new AppError('INVALID_ARGUMENT', 'malformed JSON body', {})); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, raw?: string, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  if (raw === undefined) res.setHeader('content-type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (status === 304) { res.end(); return; }
  res.end(raw !== undefined ? raw : JSON.stringify(body ?? {}));
}

export interface HttpCore {
  server: Server;
  token: string;
  router: Router;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ServerOpts {
  port?: number;
  /** default '127.0.0.1' (never 0.0.0.0) */
  host?: string;
  token?: string;
  /** extra route registration hook (later route groups) */
  register?: (r: Router) => void;
}

function defaultPort(core: Core): number {
  const listen = core.deps.config?.listen ?? '127.0.0.1:8787';
  const p = Number(listen.split(':').pop());
  return Number.isInteger(p) ? p : 8787;
}

export function createServer(core: Core, opts: ServerOpts = {}): HttpCore {
  const token = opts.token ?? generateGuiToken();
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? defaultPort(core);
  const router = new Router();
  registerReadRoutes(router);
  registerAdminRoutes(router);
  registerSourceRoutes(router);
  registerEventRoutes(router);
  opts.register?.(router);

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const u = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const rawPath = (req.url ?? '/').split('?')[0]!;
        if (method === 'GET' && (isStaticPath(rawPath) || isStaticPath(u.pathname))) {
          const o = serveStatic(isStaticPath(rawPath) ? rawPath : u.pathname, token);
          send(res, 200, undefined, o.raw, o.headers);
          return;
        }
        if (!isAuthExempt(method, u.pathname)) checkGuiToken(req.headers['x-gui-token'], token);
        const m = router.match(method, u.pathname);
        if (m === null) throw new AppError('NOT_FOUND', `no route: ${method} ${u.pathname}`, { path: u.pathname, method });
        let cached: Promise<unknown> | undefined;
        const out = await m.handler({
          core, req, params: m.params, query: u.searchParams,
          body: () => (cached ??= readBody(req)),
        });
        send(res, out.status ?? 200, out.body, out.raw, out.headers);
      } catch (e) {
        if (e instanceof AppError) {
          send(res, httpStatus(e.code) ?? 503, errorEnvelope(e.code, e.message, e.details));
        } else {
          // no dedicated internal-error code in the design table: reuse FETCH_FAILED with status 500
          send(res, 500, errorEnvelope('FETCH_FAILED', e instanceof Error ? e.message : 'internal error', {}));
        }
      }
    })();
  });

  return {
    server, token, router,
    start: () => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    }),
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
