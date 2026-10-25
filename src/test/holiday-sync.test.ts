import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { defaultConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { Clock } from '../src/clock.ts';
import { RateLimiter } from '../src/net/rate-limiter.ts';
import { RobotsCache } from '../src/net/robots.ts';
import type { FetchStageDeps } from '../src/pipeline/fetch-stage.ts';
import { holidaySyncDue, listHolidays, parseHolidayJson, syncHolidays } from '../src/service/holidays.ts';
import { createCore, unrefClock } from '../src/core.ts';
import { holidayLookup } from '../gui/holidays.js';
import { startMockServer } from './helpers/mock-server.ts';
import type { MockServer } from './helpers/mock-server.ts';

class AutoClock implements Clock {
  t = Date.parse('2026-10-01T00:00:00Z');
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

const DATA = { '2026-01-01': '元日', '2026-11-03': '文化の日', '2027-01-01': '元日', '2027-03-22': '振替休日' };
let srv: MockServer;
let hits = 0;
before(async () => {
  srv = await startMockServer();
  srv.text('/robots.txt', 'User-agent: *\nAllow: /');
  srv.route('/date.json', (req, res) => {
    hits++;
    if (req.headers['if-none-match'] === '"v1"') { res.statusCode = 304; res.end(); return; }
    res.setHeader('etag', '"v1"');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(DATA));
  });
  srv.text('/broken.json', '[1,2]');
});
after(async () => { await srv.close(); });

function setup(path = '/date.json') {
  const db = openDb(':memory:');
  const clock = new AutoClock();
  const config: Config = { ...defaultConfig(), ssrf_allowlist: ['127.0.0.1'], holiday_url: `${srv.base}${path}` };
  const net: FetchStageDeps = {
    clock, rand: () => 0.5, limiter: new RateLimiter(config.host_rate, clock), robotsCache: new RobotsCache(),
    config: { ssrf_allowlist: ['127.0.0.1'] },
  };
  return { db, clock, config, net };
}

test('parseHolidayJson rejects non-object / bad entries', () => {
  assert.throws(() => parseHolidayJson('[]'));
  assert.throws(() => parseHolidayJson('{"2026/01/01":"元日"}'));
  assert.throws(() => parseHolidayJson('{}'));
  assert.deepEqual(parseHolidayJson('{"2026-11-03":"文化の日","2026-01-01":"元日"}').map((h) => h.date), ['2026-01-01', '2026-11-03']);
});

test('syncHolidays stores data, then uses ETag (304) and respects the interval', async () => {
  const { db, clock, config, net } = setup();
  assert.equal(holidaySyncDue(db, clock, config), true);
  assert.deepEqual(await syncHolidays(db, net, config), { outcome: 'ok', count: 4 });
  const l = listHolidays(db, '2026-11-01', '2026-11-30');
  assert.deepEqual(l.holidays, [{ date: '2026-11-03', name: '文化の日' }]);
  assert.deepEqual(l.covered_years, [2026, 2027]);
  assert.equal(holidaySyncDue(db, clock, config), false);
  clock.t += config.holiday_interval_sec * 1000;
  assert.equal(holidaySyncDue(db, clock, config), true);
  assert.deepEqual(await syncHolidays(db, net, config), { outcome: 'not_modified' });
  assert.equal(holidaySyncDue(db, clock, config), false);
  assert.equal(listHolidays(db, '0000-01-01', '9999-12-31').holidays.length, 4);
  assert.equal(holidaySyncDue(db, clock, { holiday_interval_sec: 0 }), false);
});

test('syncHolidays failure keeps previous data and stays due', async () => {
  const { db, clock, config, net } = setup('/broken.json');
  const r = await syncHolidays(db, net, config);
  assert.equal(r.outcome, 'failed');
  assert.equal(listHolidays(db, '0000-01-01', '9999-12-31').covered_years, null);
  assert.equal(holidaySyncDue(db, clock, config), true);
});

test('GET /holidays returns stored data; bad range -> 400', async () => {
  const { db, config, net } = setup();
  await syncHolidays(db, net, config);
  const h = createCore(db, config, { worker: false, net });
  const ok = await h.dispatch('GET', '/holidays?from=2027-01-01&to=2027-12-31');
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body as { holidays: unknown[] }).holidays.length, 2);
  assert.equal((await h.dispatch('GET', '/holidays?from=2027/01/01')).status, 400);
});

test('core start runs the periodic holiday sync', async () => {
  const { db, config, net } = setup();
  hits = 0;
  const h = createCore(db, config, { worker: false, holidays: true, net, port: 0, clock: unrefClock });
  await h.start();
  try {
    for (let i = 0; i < 50 && listHolidays(db, '0000-01-01', '9999-12-31').covered_years === null; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(listHolidays(db, '0000-01-01', '9999-12-31').covered_years, [2026, 2027]);
    assert.ok(hits >= 1);
  } finally { await h.stop(); }
});

test('GUI holidayLookup prefers server data for covered years, computes others', () => {
  const look = holidayLookup({ covered_years: [2027, 2027], holidays: [{ date: '2027-03-22', name: '振替休日' }] });
  assert.equal(look('2027-03-22'), '振替休日');
  assert.equal(look('2027-03-21'), '');
  assert.equal(look('2026-11-03'), '文化の日');
  assert.equal(holidayLookup(null)('2026-11-03'), '文化の日');
});
