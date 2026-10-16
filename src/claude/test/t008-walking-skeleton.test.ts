import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { defaultConfig } from '../src/config.ts';
import { runJob } from '../src/pipeline/run-job.ts';
import type { FetchText, SourceRow } from '../src/pipeline/run-job.ts';
import { listEvents } from '../src/service/events.ts';

const html = readFileSync(new URL('./fixtures/jsonld-3.html', import.meta.url), 'utf8');
const cfg = defaultConfig();
const now = new Date('2026-10-16T00:00:00Z');
const range = { from: '2026-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' };

const fetchText: FetchText = async (url) => {
  const r = await fetch(url);
  return { status: r.status, text: await r.text() };
};

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((_q, s) => { s.setHeader('content-type', 'text/html; charset=utf-8'); s.end(html); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`); }
  finally { await new Promise<void>((r) => server.close(() => r())); }
}

function setup(url: string, mode: string): { db: DatabaseSync; source: SourceRow } {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO region(id,name,tz,keywords_json) VALUES(?,?,?,?)')
    .run('r1', '世田谷', 'Asia/Tokyo', JSON.stringify(['世田谷', '三軒茶屋']));
  const spec = JSON.stringify({ kind: 'jsonld', region_policy: { mode, min_confidence: 0.5 } });
  db.prepare('INSERT INTO source(id,region_id,url,kind,spec_json,terms_note,allow_redistribute) VALUES(?,?,?,?,?,?,?)')
    .run('s1', 'r1', url, 'jsonld', spec, 'n', 1);
  return { db, source: { id: 's1', region_id: 'r1', url, kind: 'jsonld', spec_json: spec } };
}
const count = (db: DatabaseSync, t: string): number => Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);

test('fetch -> extract -> normalize -> upsert -> list; idempotent', async () => {
  await withServer(async (url) => {
    const { db, source } = setup(url, 'trust_source');
    const r = await runJob({ db, source, fetchText, now, config: cfg });
    assert.equal(r.outcome, 'ok');
    const evs = listEvents(db, { region_id: 'r1', ...range });
    assert.deepEqual(evs.map((e) => e.title), ['世田谷夏祭り', '三軒茶屋盆踊り', '渋谷ヨガ教室']);
    assert.equal(evs[0]!.start_utc, '2026-11-03T10:00:00Z');
    assert.equal(evs[0]!.start_local_date, '2026-11-03');
    await runJob({ db, source, fetchText, now, config: cfg });
    assert.equal(count(db, 'event'), 3);
    assert.equal(count(db, 'event_source_ref'), 3);
    db.close();
  });
});

test('single run leaves exactly one ok run row with items_found=3', async () => {
  await withServer(async (url) => {
    const { db, source } = setup(url, 'trust_source');
    await runJob({ db, source, fetchText, now, config: cfg });
    const runs = db.prepare('SELECT outcome, items_found FROM run').all() as Array<{ outcome: string; items_found: number }>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.outcome, 'ok');
    assert.equal(runs[0]!.items_found, 3);
    db.close();
  });
});

test('keyword region policy excludes 0-hit event', async () => {
  await withServer(async (url) => {
    const { db, source } = setup(url, 'keyword');
    await runJob({ db, source, fetchText, now, config: cfg });
    const evs = listEvents(db, { region_id: 'r1', ...range });
    assert.equal(evs.length, 2);
    assert.deepEqual(evs.map((e) => e.title), ['世田谷夏祭り', '三軒茶屋盆踊り']);
    db.close();
  });
});

test('fetch failure records failed run without throwing', async () => {
  const { db, source } = setup('http://x.invalid/', 'trust_source');
  const r = await runJob({ db, source, fetchText: async () => { throw new Error('boom'); }, now, config: cfg });
  assert.equal(r.outcome, 'failed');
  assert.equal(count(db, 'event'), 0);
  db.close();
});
