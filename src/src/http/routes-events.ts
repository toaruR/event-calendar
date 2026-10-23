import { searchEvents } from '../service/events.ts';
import { buildCalendar } from '../ics/calendar.ts';
import { AppError } from '../errors.ts';
import type { Router } from './server.ts';

const DAY_MS = 86_400_000;

export function registerEventRoutes(r: Router): void {
  r.add('GET', '/events', ({ core, query }) => {
    const input: Record<string, string> = {};
    for (const k of ['region_id', 'from', 'to', 'q', 'source']) {
      const v = query.get(k);
      if (v !== null) input[k] = v;
    }
    return { body: searchEvents(core.db, input) };
  });

  // The router only supports whole-segment parameters, so `{region}.ics` is handled as `{file}` + suffix check.
  r.add('GET', '/calendar/{file}', ({ core, req, params, query }) => {
    const file = params['file']!;
    if (!file.endsWith('.ics')) throw new AppError('NOT_FOUND', `no route: GET /calendar/${file}`, { path: `/calendar/${file}` });
    const regionId = file.slice(0, -4);
    const now = core.deps.net.clock.now();
    const input: Record<string, string> = {};
    for (const k of ['from', 'to']) {
      const v = query.get(k);
      if (v !== null) input[k] = v;
    }
    const from = input['from'] ?? new Date(now - 90 * DAY_MS).toISOString();
    const to = input['to'] ?? new Date(now + 365 * DAY_MS).toISOString();
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) > Date.parse(to)) {
      throw new AppError('INVALID_ARGUMENT', 'invalid from/to range', { from, to });
    }
    const eventId = query.get('event_id');
    const cal = buildCalendar(core.db, regionId, { from, to, now, ...(eventId ? { eventId } : {}), ...(core.deps.config ? { config: core.deps.config } : {}) });
    const headers = { 'content-type': 'text/calendar; charset=utf-8', etag: cal.etag };
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').some((t) => t.trim() === cal.etag || t.trim() === '*')) {
      return { status: 304, headers };
    }
    return { raw: cal.body, headers };
  });
}
