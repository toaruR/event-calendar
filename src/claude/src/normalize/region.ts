export interface RegionPolicy { mode: 'trust_source' | 'keyword' | 'geo'; min_confidence?: number }
export interface RegionInfo { keywords: string[]; center_lat: number; center_lon: number; radius_km: number }
export interface EventRegionInput {
  title?: string | null; venue?: string | null; address?: string | null;
  lat?: number | null; lon?: number | null;
}

export function keywordConfidence(texts: Array<string | null | undefined>, keywords: string[], fullHits: number): number {
  const hay = texts.filter((t): t is string => typeof t === 'string').join('\n');
  const hits = new Set(keywords.filter((k) => k !== '' && hay.includes(k))).size;
  if (!(fullHits > 0)) return hits > 0 ? 1 : 0;
  return Math.min(1, hits / fullHits);
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** geo confidence: 1 if within radius_km, else 0. No coordinates -> 0 (geocoder=none default). */
export function geoConfidence(lat: number | null | undefined, lon: number | null | undefined, region: RegionInfo): number {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return 0;
  return haversineKm(lat, lon, region.center_lat, region.center_lon) <= region.radius_km ? 1 : 0;
}

export function regionConfidence(
  ev: EventRegionInput, policy: RegionPolicy, region: RegionInfo, keywordFullHits: number,
): number {
  switch (policy.mode) {
    case 'trust_source': return 1;
    case 'geo': return geoConfidence(ev.lat, ev.lon, region);
    case 'keyword': return keywordConfidence([ev.title, ev.venue, ev.address], region.keywords, keywordFullHits);
  }
}

/** Adopt when confidence >= minConfidence and confidence > 0 (0 hits is always rejected). */
export function passesMinConfidence(confidence: number, minConfidence: number): boolean {
  return confidence > 0 && confidence >= minConfidence;
}
