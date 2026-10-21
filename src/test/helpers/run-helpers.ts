import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/db.ts';
import type { FetchText, SourceRow } from '../../src/pipeline/run-job.ts';

export interface JsonLdEv { uid: string; name: string; start?: string; venue?: string; status?: string }

export function jsonLdPage(evs: JsonLdEv[]): string {
  const arr = evs.map((e) => ({
    '@context': 'https://schema.org', '@type': 'Event', '@id': e.uid, name: e.name,
    startDate: e.start ?? '2026-11-03T19:00:00+09:00',
    location: { '@type': 'Place', name: e.venue ?? '世田谷公園' },
    ...(e.status ? { eventStatus: e.status } : {}),
  }));
  return `<html><head><script type="application/ld+json">${JSON.stringify(arr)}</script></head></html>`;
}

export const staticFetch = (text: string, status = 200): FetchText => async () => ({ status, text });

export function setupDb(sources: Array<{ id: string; trust?: number }> = [{ id: 's1' }]): { db: DatabaseSync; sources: SourceRow[] } {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO region(id,name,tz,keywords_json) VALUES(?,?,?,?)').run('r1', '世田谷', 'Asia/Tokyo', '["世田谷"]');
  const spec = JSON.stringify({ kind: 'jsonld', region_policy: { mode: 'trust_source' } });
  const rows: SourceRow[] = [];
  for (const s of sources) {
    const url = `http://${s.id}.test/`;
    db.prepare('INSERT INTO source(id,region_id,url,kind,spec_json,trust,terms_note,allow_redistribute) VALUES(?,?,?,?,?,?,?,?)')
      .run(s.id, 'r1', url, 'jsonld', spec, s.trust ?? null, 'n', 1);
    rows.push({ id: s.id, region_id: 'r1', url, kind: 'jsonld', spec_json: spec, trust: s.trust ?? null });
  }
  return { db, sources: rows };
}

export const count = (db: DatabaseSync, t: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
