import { upsertRegion } from '../service/regions.ts';
import { approveCandidate } from '../service/sources.ts';
import { issueApproval } from '../service/approvals.ts';
import { discoverSources, listCandidates, rejectCandidate } from '../service/discover.ts';
import { validateInput } from '../validate.ts';
import type { Router } from './server.ts';

export function registerAdminRoutes(r: Router): void {
  r.add('PUT', '/regions/{id}', async ({ core, params, body }) => {
    const region = upsertRegion(core.db, params['id']!, await body());
    return { body: { region } };
  });

  r.add('POST', '/approvals', async ({ core, body }) => {
    const out = issueApproval(core.db, (await body()) as { action: string; source_id: string }, {
      clock: core.deps.net.clock, ...(core.deps.config ? { config: core.deps.config } : {}),
    });
    return { body: out };
  });

  r.add('POST', '/candidates/{id}/approve', async ({ core, params, body }) => {
    return { body: await approveCandidate(core.db, params['id']!, await body(), core.deps) };
  });

  r.add('GET', '/candidates', ({ core, query }) => {
    const region = query.get('region_id');
    const status = query.get('status');
    return { body: listCandidates(core.db, { ...(region !== null ? { region_id: region } : {}), ...(status !== null ? { status } : {}) }) };
  });

  r.add('POST', '/candidates/{id}/reject', ({ core, params }) => ({ body: rejectCandidate(core.db, params['id']!) }));

  r.add('POST', '/regions/{id}/discover', async ({ core, params, body }) => {
    const b = validateInput('source_discover', await body()) as { limit?: number };
    const provider = core.searchProvider ?? 'none';
    return {
      body: await discoverSources(core.db, params['id']!, { provider, ...(b.limit !== undefined ? { limit: b.limit } : {}) }, core.deps),
    };
  });
}
