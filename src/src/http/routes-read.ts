import { listSources } from '../service/sources.ts';
import type { Router } from './server.ts';

export function registerReadRoutes(r: Router): void {
  r.add('GET', '/sources', ({ core, query }) => {
    const filter: { region_id?: string; state?: string } = {};
    const rid = query.get('region_id');
    const st = query.get('state');
    if (rid !== null) filter.region_id = rid;
    if (st !== null) filter.state = st;
    return { body: listSources(core.db, filter, core.deps.config) };
  });

  r.add('GET', '/health', ({ core }) => {
    const rows = core.db.prepare('SELECT id,state,last_success_at,consecutive_failures FROM source ORDER BY created_at, id').all() as
      Array<{ id: string; state: string; last_success_at: string | null; consecutive_failures: number }>;
    return {
      body: {
        sources: rows.map((s) => ({
          id: s.id, state: s.state, last_success_at: s.last_success_at ?? null, failures: Number(s.consecutive_failures),
        })),
      },
    };
  });
}
