import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { validateInput } from '../validate.ts';

export interface RegionRow {
  id: string; name: string; tz: string;
  center_lat: number | null; center_lon: number | null; radius_km: number | null;
  keywords_json: string;
}

/** Validate (INVALID_ARGUMENT on bad body/tz) and insert-or-update a region by id. */
export function upsertRegion(db: DatabaseSync, id: string, input: unknown): RegionRow {
  const body = { ...(input as Record<string, unknown>), id };
  const s = validateInput('region_upsert', body) as unknown as RegionRow;
  db.prepare(
    `INSERT INTO region(id,name,tz,center_lat,center_lon,radius_km,keywords_json) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, tz=excluded.tz, center_lat=excluded.center_lat,
       center_lon=excluded.center_lon, radius_km=excluded.radius_km, keywords_json=excluded.keywords_json`,
  ).run(s.id, s.name, s.tz, s.center_lat, s.center_lon, s.radius_km, s.keywords_json);
  return getRegion(db, id);
}

export function getRegion(db: DatabaseSync, id: string): RegionRow {
  const r = db.prepare('SELECT * FROM region WHERE id = ?').get(id) as unknown as RegionRow | undefined;
  if (!r) throw new AppError('NOT_FOUND', `region not found: ${id}`, { id });
  return r;
}
