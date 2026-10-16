import { addSource, testSource } from '../service/sources.ts';
import { removeSource, updateSource } from '../service/sources-mutate.ts';
import { runNow } from '../service/run-now.ts';
import { AppError } from '../errors.ts';
import type { Router } from './server.ts';

export function registerSourceRoutes(r: Router): void {
  r.add('POST', '/sources:test', async ({ core, body }) => ({ body: await testSource(core.db, await body(), core.deps) }));

  r.add('POST', '/sources', async ({ core, body }) => ({ body: await addSource(core.db, await body(), core.deps) }));

  r.add('PATCH', '/sources/{id}', async ({ core, params, body }) => ({
    body: await updateSource(core.db, params['id']!, await body(), core.deps),
  }));

  // DELETE: approval_token / dry_run from the JSON body, or from the query string (?dry_run=true&approval_token=...)
  r.add('DELETE', '/sources/{id}', async ({ core, params, query, body }) => {
    const raw = await body();
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AppError('INVALID_ARGUMENT', 'body must be an object', {});
    }
    const b = raw as { dry_run?: unknown; approval_token?: unknown };
    const opts: { dry_run?: boolean; approval_token?: string } = {};
    const dry = b.dry_run ?? (query.has('dry_run') ? query.get('dry_run') === 'true' : undefined);
    if (dry !== undefined) opts.dry_run = dry as boolean;
    const tok = b.approval_token ?? query.get('approval_token') ?? undefined;
    if (tok !== undefined) {
      if (typeof tok !== 'string') throw new AppError('INVALID_ARGUMENT', 'approval_token must be a string', {});
      opts.approval_token = tok;
    }
    return { body: removeSource(core.db, params['id']!, opts, core.deps) };
  });

  r.add('POST', '/sources/{id}/run', async ({ core, params }) => ({ body: await runNow(core.db, params['id']!, core.deps) }));
}
