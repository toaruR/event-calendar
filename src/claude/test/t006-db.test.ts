import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';

const val = (db: DatabaseSync, sql: string): unknown => Object.values(db.prepare(sql).get() as object)[0];

function seed(db: DatabaseSync): void {
  db.exec(`INSERT INTO region(id,name,tz) VALUES('r1','R','Asia/Tokyo')`);
  db.exec(`INSERT INTO source(id,region_id,url,kind,terms_note,allow_redistribute) VALUES('s1','r1','http://x/','ical','n',1)`);
}
const ev = (id: string, s: string, e: string | null, st = 'confirmed') =>
  `INSERT INTO event(id,region_id,title,start_utc,end_utc,tz,status) VALUES('${id}','r1','t','${s}',${e === null ? 'NULL' : `'${e}'`},'Asia/Tokyo','${st}')`;

test('file db: WAL, busy_timeout, idempotent, user_version', () => {
  const dir = mkdtempSync(join(tmpdir(), 't006-'));
  try {
    const p = join(dir, 'a.db');
    const db = openDb(p);
    assert.equal(val(db, 'PRAGMA journal_mode'), 'wal');
    assert.equal(val(db, 'PRAGMA busy_timeout'), 5000);
    assert.equal(val(db, 'PRAGMA user_version'), 1);
    db.close();
    const db2 = openDb(p);
    assert.equal(val(db2, 'PRAGMA user_version'), 1);
    db2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tables and indexes exist', () => {
  const db = openDb(':memory:');
  const names = (t: string) => (db.prepare(`SELECT name FROM sqlite_master WHERE type='${t}'`).all() as Array<{ name: string }>).map((r) => r.name);
  const tables = names('table');
  for (const t of ['region', 'source', 'job', 'source_candidate', 'event', 'event_source_ref', 'run', 'source_spec_history']) {
    assert.ok(tables.includes(t), t);
  }
  const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='event'`).all() as Array<{ sql: string | null }>;
  const sqls = idx.map((r) => r.sql ?? '');
  assert.ok(sqls.some((s) => /\(region_id, start_utc\)/.test(s)));
  assert.ok(sqls.some((s) => /\(dedup_key\)/.test(s)));
  db.close();
});

const CHECK_ERR = (e: unknown): boolean => /CHECK constraint/i.test(String((e as Error).message));

test('CHECK constraints', () => {
  const db = openDb(':memory:');
  seed(db);
  assert.throws(() => db.exec(`INSERT INTO source(id,region_id,url,kind,terms_note,allow_redistribute) VALUES('s2','r1','u','foo','n',1)`), CHECK_ERR);
  assert.throws(() => db.exec(`INSERT INTO source(id,region_id,url,kind,terms_note,allow_redistribute,state) VALUES('s3','r1','u','ical','n',1,'x')`), CHECK_ERR);
  assert.throws(() => db.exec(`INSERT INTO job(id,source_id,status) VALUES('j','s1','x')`), CHECK_ERR);
  assert.throws(() => db.exec(`INSERT INTO run(id,source_id,outcome) VALUES('u','s1','x')`), CHECK_ERR);
  assert.throws(() => db.exec(ev('e1', '2026-01-01T00:00:00Z', null, 'x')), CHECK_ERR);
  db.exec(`INSERT INTO run(id,source_id,outcome) VALUES('u','s1','ok')`);
  db.close();
});

test('start_utc > end_utc rejected', () => {
  const db = openDb(':memory:');
  seed(db);
  assert.throws(() => db.exec(ev('e1', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')));
  db.exec(ev('e2', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'));
  db.close();
});

test('event_source_ref unique + cascade', () => {
  const db = openDb(':memory:');
  seed(db);
  db.exec(ev('e1', '2026-01-01T00:00:00Z', null));
  db.exec(ev('e2', '2026-01-02T00:00:00Z', null));
  db.exec(`INSERT INTO event_source_ref(event_id,source_id,source_uid) VALUES('e1','s1','u1')`);
  assert.throws(() => db.exec(`INSERT INTO event_source_ref(event_id,source_id,source_uid) VALUES('e2','s1','u1')`));
  db.exec(`DELETE FROM event WHERE id='e1'`);
  assert.equal(val(db, 'SELECT COUNT(*) FROM event_source_ref'), 0);
  db.close();
});
