import { z } from 'zod';
import { PoiSearchRequestSchema } from '../types.js';

export interface PoiItem {
  name: string;
  nameKana?: string;
  prefecture?: string;
  city?: string;
  address?: string;
  category?: string;
  lat?: number;
  lng?: number;
  level?: number | null;
  source?: string;
  licenses: string[];
  attributions: string[];
}

export interface PoiSearchResult {
  query?: string;
  centerResolved?: PoiCenterResolved;
  count: number;
  pois: PoiItem[];
  source: 'openpoi';
}

export type PoiFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function openPoiBaseUrl(): string {
  return (process.env.SORA_OPENPOI_BASE_URL ?? 'https://api.openpoiapi.com').replace(/\/$/, '');
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function normalizePoiItem(raw: Record<string, unknown>): PoiItem | undefined {
  if (typeof raw?.name !== 'string' || !raw.name.trim()) return undefined;
  const str = (key: string): string | undefined => {
    const v = raw[key];
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
  };
  const levelRaw = raw.level;
  const level = typeof levelRaw === 'number' && Number.isInteger(levelRaw) ? levelRaw : null;
  return {
    name: raw.name.trim(),
    ...(str('name_kana') ? { nameKana: str('name_kana') } : {}),
    ...(str('prefecture') ? { prefecture: str('prefecture') } : {}),
    ...(str('city') ? { city: str('city') } : {}),
    ...(str('address') ? { address: str('address') } : {}),
    ...(str('category') ? { category: str('category') } : {}),
    ...(toNumber(raw.lat) !== undefined ? { lat: toNumber(raw.lat) } : {}),
    ...(toNumber(raw.lng) !== undefined ? { lng: toNumber(raw.lng) } : {}),
    ...(level !== null ? { level } : {}),
    ...(str('source') ? { source: str('source') } : {}),
    licenses: toStringArray(raw.licenses),
    attributions: toStringArray(raw.attributions),
  };
}

export interface PoiCenterCandidate { address: string; lat: number; lon: number }
export interface PoiCenterResolved { input: string; address?: string; lat: number; lon: number; ambiguous: boolean; candidates: PoiCenterCandidate[] }
export type PoiGeocode = (center: string) => Promise<{ lat?: number; lon?: number; address?: string }>;

async function defaultGeocode(center: string): Promise<{ lat?: number; lon?: number; address?: string; matchedTitle?: string }> {
  const { fetchElevationAndCoordinates } = await import('./disaster.js');
  const r = await fetchElevationAndCoordinates({ address: center }) as { lat?: number; lon?: number; address?: string; matchedTitle?: string }; return { lat: r.lat, lon: r.lon, address: r.matchedTitle ?? r.address };
}

/** GSI候補を取得する。情報提供のみで失敗しても検索は止めない。 */
export async function fetchCenterCandidates(center: string, fetchFn: PoiFetch, timeoutMs: number): Promise<PoiCenterCandidate[] | undefined> {
  try {
    const res = await fetchFn('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(center), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as Array<{ geometry?: { coordinates?: unknown }; properties?: { title?: unknown } }>;
    if (!Array.isArray(data)) return undefined;
    const seen = new Set<string>();
    const out: PoiCenterCandidate[] = [];
    for (const item of data) {
      if (out.length >= 5) break;
      const title = item?.properties?.title;
      const xy = item?.geometry?.coordinates;
      if (typeof title !== 'string' || !Array.isArray(xy) || typeof xy[0] !== 'number' || typeof xy[1] !== 'number') continue;
      if (seen.has(title)) continue;
      seen.add(title);
      out.push({ address: title, lat: xy[1] as number, lon: xy[0] as number });
    }
    return out;
  } catch {
    return undefined;
  }
}

function prefectureOf(title: string): string {
  const m = /^(北海道|[^都府]+[都府]|[^県]+県)/.exec(title);
  return m ? m[1] : 'unknown';
}

export async function searchOpenPoi(
  rawInput: z.input<typeof PoiSearchRequestSchema>,
  fetchFn: PoiFetch = fetch,
  timeoutMs = 10000,
  geocode: PoiGeocode = defaultGeocode,
): Promise<PoiSearchResult> {
  const input = PoiSearchRequestSchema.parse(rawInput);
  let lat = input.lat;
  let lon = input.lon;
  let centerResolved: PoiCenterResolved | undefined;
  // 地名centerは国土地理院で座標化する。特定不能は黙って広域検索に落とさない。
  if (input.center !== undefined) {
    let coords: { lat?: number; lon?: number; address?: string };
    try {
      coords = await geocode(input.center);
    } catch (e) {
      throw new Error('POI center geocoding failed: ' + String((e as Error)?.message ?? e).slice(0, 160));
    }
    if (typeof coords.lat !== 'number' || typeof coords.lon !== 'number') {
      throw new Error('POI center could not be resolved: ' + input.center);
    }
    lat = coords.lat;
    lon = coords.lon;
    centerResolved = { input: input.center, ...(coords.address ? { address: coords.address } : {}), lat: coords.lat, lon: coords.lon, ambiguous: false, candidates: [] };
    const candidates = await fetchCenterCandidates(input.center, fetchFn, timeoutMs);
    if (candidates && candidates.length > 0) {
      centerResolved.candidates = candidates;
      centerResolved.ambiguous = new Set(candidates.map((c) => prefectureOf(c.address))).size > 1;
    }
  }
  const params = new URLSearchParams();
  if (input.query) params.set('q', input.query);
  if (input.bbox) params.set('bbox', input.bbox);
  else if (lat !== undefined && lon !== undefined) {
    params.set('center', `${lon},${lat}`);
    params.set('radius', String(input.radiusMeters ?? 5000));
  }
  params.set('limit', String(input.limit ?? 10));
  const url = openPoiBaseUrl() + '/v1/search?' + params.toString();
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error('OpenPOI request failed: ' + String((e as Error)?.message ?? e).slice(0, 160));
  }
  if (!res.ok) throw new Error(`OpenPOI HTTP ${res.status}`);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('OpenPOI returned unparseable JSON');
  }
  const record = data as Record<string, unknown>;
  if (!record || typeof record.count !== 'number' || !Array.isArray(record.results)) {
    throw new Error('OpenPOI envelope missing count/results');
  }
  const pois = (record.results as unknown[])
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .flatMap((r) => {
      const item = normalizePoiItem(r);
      return item ? [item] : [];
    });
  return { ...(input.query ? { query: input.query } : {}), ...(centerResolved ? { centerResolved } : {}), count: record.count, pois, source: 'openpoi' };
}
