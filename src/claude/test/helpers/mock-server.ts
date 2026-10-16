import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Route = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface MockServer {
  port: number;
  base: string;
  route(path: string, handler: Route): void;
  redirect(path: string, location: string, status?: number): void;
  text(path: string, body: string, headers?: Record<string, string>): void;
  requestCount(path?: string): number;
  lastHeaders(path: string): IncomingMessage['headers'] | undefined;
  close(): Promise<void>;
}

export async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, Route>();
  const counts = new Map<string, number>();
  const headers = new Map<string, IncomingMessage['headers']>();
  let total = 0;
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    total++;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    headers.set(path, req.headers);
    const h = routes.get(path);
    if (!h) { res.statusCode = 404; res.end('not found'); return; }
    Promise.resolve(h(req, res)).catch(() => { res.destroy(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const self: MockServer = {
    port,
    base: `http://127.0.0.1:${port}`,
    route: (p, h) => { routes.set(p, h); },
    redirect: (p, location, status = 302) => {
      routes.set(p, (_q, res) => { res.statusCode = status; res.setHeader('location', location); res.end(); });
    },
    text: (p, body, hdrs = {}) => {
      routes.set(p, (_q, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
        res.end(body);
      });
    },
    requestCount: (p) => (p === undefined ? total : counts.get(p) ?? 0),
    lastHeaders: (p) => headers.get(p),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  return self;
}
