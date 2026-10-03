import { getFromCache, runWithSingleFlight, setToCache } from '../cache.js';

export const CACHE_TTL_GEOCODING = 24 * 60 * 60 * 1000;
// Nominatim 利用規約: 最大1リクエスト/秒。余裕を持たせる。
const MIN_INTERVAL_MS = 1100;

export interface GeocodingResult {
  address: string;
  lat: number;
  lon: number;
  source: 'nominatim' | 'gsi';
  needsVerification: boolean;
}

// 座標解決結果を表示・公開する際に必要な出典表示（OSM は ODbL）。
export const GEOCODING_ATTRIBUTIONS: Record<GeocodingResult['source'], string> = {
  nominatim: '出典: © OpenStreetMap contributors (ODbL) https://www.openstreetmap.org/copyright',
  gsi: '出典: 国土地理院 (https://msearch.gsi.go.jp/address-search/AddressSearch)',
};

interface GeocoderOptions {
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface NominatimHit { display_name?: unknown; lat?: unknown; lon?: unknown; address?: Record<string, unknown> }

function validCoordinates(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

// 該当なしは null を返し、呼び出し側で国土地理院へフォールバックする。
function parseLocation(data: unknown, query: string): GeocodingResult | null {
  if (!Array.isArray(data)) throw new Error('nominatim returned an unexpected response');
  const hits = data as NominatimHit[];
  if (hits.length === 0) return null;
  const coordinate = (value: unknown): number =>
    typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  const top = hits[0];
  const lat = coordinate(top?.lat);
  const lon = coordinate(top?.lon);
  if (!validCoordinates(lat, lon)) {
    throw new Error('nominatim returned missing or invalid coordinates');
  }
  // 上位候補が複数の都道府県にまたがる場合だけ、意図した場所か確認を求める。
  const prefectures = new Set(hits.map((h) => h?.address?.['ISO3166-2-lvl4']).filter((v) => typeof v === 'string'));
  return {
    address: typeof top.display_name === 'string' && top.display_name ? top.display_name : query,
    lat, lon, source: 'nominatim', needsVerification: prefectures.size > 1,
  };
}

// OSM は番地レベルの住所に弱いため、該当なしのときだけ国土地理院の住所検索を使う。
function parseGsiLocation(data: unknown, query: string): GeocodingResult {
  if (!Array.isArray(data)) throw new Error('gsi address search returned an unexpected response');
  if (data.length === 0) throw new Error(`nominatim and gsi found no match: ${query}`);
  const top = data[0] as { geometry?: { coordinates?: unknown }; properties?: { title?: unknown } };
  const coords = Array.isArray(top?.geometry?.coordinates) ? top.geometry.coordinates : [];
  const lon = typeof coords[0] === 'number' ? coords[0] : NaN;
  const lat = typeof coords[1] === 'number' ? coords[1] : NaN;
  if (!validCoordinates(lat, lon)) throw new Error('gsi address search returned missing or invalid coordinates');
  const title = top.properties?.title;
  return {
    address: typeof title === 'string' && title ? title : query,
    lat, lon, source: 'gsi', needsVerification: data.length > 1,
  };
}

async function fetchJson(fetchFn: NonNullable<GeocoderOptions['fetchFn']>, url: string, name: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetchFn(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${name} returned unparseable JSON`);
  }
}

export function createGeocoder(options: GeocoderOptions = {}) {
  const fetchFn = options.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let gate: Promise<void> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  async function requestLocation(query: string): Promise<GeocodingResult> {
    const previous = gate;
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      let remaining = lastStart + MIN_INTERVAL_MS - now();
      while (remaining > 0) {
        await sleep(remaining);
        remaining = lastStart + MIN_INTERVAL_MS - now();
      }
      lastStart = now();
      const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
        q: query, format: 'jsonv2', countrycodes: 'jp', limit: '3', addressdetails: '1', 'accept-language': 'ja',
      });
      const data = await fetchJson(fetchFn, url, 'nominatim', { 'User-Agent': 'Sora-Geocoding-Fetcher/1.0 (https://github.com/ikenokazuki/Sora)' });
      const found = parseLocation(data, query);
      if (found) return found;
      const gsiUrl = 'https://msearch.gsi.go.jp/address-search/AddressSearch?' + new URLSearchParams({ q: query });
      return parseGsiLocation(await fetchJson(fetchFn, gsiUrl, 'gsi address search'), query);
    } finally {
      release();
    }
  }

  return async (rawQuery: string, request: { noCache?: boolean } = {}): Promise<GeocodingResult> => {
    const query = rawQuery.trim();
    if (!query) throw new Error('nominatim requires a non-empty place or address');
    const key = `geo:nominatim:v1:${query}`;
    if (!request.noCache) {
      const cached = getFromCache<GeocodingResult>(key);
      if (cached) return cached;
    }
    return runWithSingleFlight(key, async () => {
      if (!request.noCache) {
        const cached = getFromCache<GeocodingResult>(key);
        if (cached) return cached;
      }
      const result = await requestLocation(query);
      if (!request.noCache) setToCache(key, result, CACHE_TTL_GEOCODING);
      return result;
    });
  };
}

// MCP・REST・標高取得はこのインスタンスを共有し、外部問い合わせを1.1秒間隔に制限する。
export const geocodeAddress = createGeocoder();
