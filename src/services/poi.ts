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

export async function searchOpenPoi(
  rawInput: z.input<typeof PoiSearchRequestSchema>,
  fetchFn: PoiFetch = fetch,
  timeoutMs = 10000,
): Promise<PoiSearchResult> {
  const input = PoiSearchRequestSchema.parse(rawInput);
  const params = new URLSearchParams();
  if (input.query) params.set('q', input.query);
  if (input.bbox) params.set('bbox', input.bbox);
  else if (input.lat !== undefined && input.lon !== undefined) {
    params.set('center', `${input.lon},${input.lat}`);
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
  return { ...(input.query ? { query: input.query } : {}), count: record.count, pois, source: 'openpoi' };
}
