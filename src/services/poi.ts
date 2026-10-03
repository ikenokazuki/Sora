import { z } from 'zod';
import { PoiSearchRequestSchema } from '../types.js';
import { geocodeAddress, type GeocodingResult } from './geocoding.js';

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
  attribution: string;
}

export const OPENPOI_ATTRIBUTION = '出典: OpenPOI API (https://openpoiapi.com/attribution.html)';

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
export interface PoiCenterResolved {
  input: string;
  address?: string;
  lat: number;
  lon: number;
  source?: 'geocoding.jp';
  needsVerification: boolean;
  ambiguous: boolean;
  candidates: PoiCenterCandidate[];
}
export type PoiGeocode = (center: string, options?: { noCache?: boolean }) => Promise<Partial<GeocodingResult>>;

export async function searchOpenPoi(
  rawInput: z.input<typeof PoiSearchRequestSchema>,
  fetchFn: PoiFetch = fetch,
  timeoutMs = 10000,
  geocode: PoiGeocode = geocodeAddress,
): Promise<PoiSearchResult> {
  const input = PoiSearchRequestSchema.parse(rawInput);
  let lat = input.lat;
  let lon = input.lon;
  let centerResolved: PoiCenterResolved | undefined;
  // bboxを優先し、地名centerを使う場合は共有ジオコーダーで座標化する。
  if (input.center !== undefined && !input.bbox) {
    let coords: Partial<GeocodingResult>;
    try {
      coords = await geocode(input.center, { noCache: input.noCache });
    } catch (e) {
      throw new Error('POI center geocoding failed: ' + String((e as Error)?.message ?? e).slice(0, 160));
    }
    if (typeof coords.lat !== 'number' || typeof coords.lon !== 'number' ||
        !Number.isFinite(coords.lat) || !Number.isFinite(coords.lon) || Math.abs(coords.lat) > 90 || Math.abs(coords.lon) > 180) {
      throw new Error('POI center could not be resolved: ' + input.center);
    }
    lat = coords.lat;
    lon = coords.lon;
    centerResolved = {
      input: input.center, ...(coords.address ? { address: coords.address } : {}),
      lat: coords.lat, lon: coords.lon, source: coords.source,
      needsVerification: coords.needsVerification ?? false,
      ambiguous: coords.needsVerification ?? false, candidates: [],
    };
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
  return { ...(input.query ? { query: input.query } : {}), ...(centerResolved ? { centerResolved } : {}), count: record.count, pois, source: 'openpoi', attribution: OPENPOI_ATTRIBUTION };
}
