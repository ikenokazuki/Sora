import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { getFromCache, runWithSingleFlight, setToCache } from '../cache.js';

export const CACHE_TTL_GEOCODING = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 10000;
const parser = new XMLParser({ parseTagValue: false, trimValues: true });

export interface GeocodingResult {
  address: string;
  lat: number;
  lon: number;
  source: 'geocoding.jp';
  needsVerification: boolean;
}

interface GeocoderOptions {
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function parseLocation(xml: string, query: string): GeocodingResult {
  if (XMLValidator.validate(xml) !== true) throw new Error('geocoding.jp returned invalid XML');
  const result = parser.parse(xml)?.result;
  if (result?.error !== undefined) throw new Error(`geocoding.jp API error ${result.error}: ${query}`);
  const coordinate = (value: unknown): number =>
    typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  const lat = coordinate(result?.coordinate?.lat);
  const lon = coordinate(result?.coordinate?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error('geocoding.jp returned missing or invalid coordinates');
  }
  return {
    address: typeof result.google_maps === 'string' && result.google_maps ? result.google_maps : query,
    lat, lon, source: 'geocoding.jp', needsVerification: result.needs_to_verify !== 'no',
  };
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
      const url = 'https://www.geocoding.jp/api/?' + new URLSearchParams({ q: query });
      const res = await fetchFn(url, {
        headers: { 'User-Agent': 'Sora-Geocoding-Fetcher/1.0', Accept: 'application/xml, text/xml' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`geocoding.jp HTTP ${res.status}`);
      return parseLocation(await res.text(), query);
    } finally {
      release();
    }
  }

  return async (rawQuery: string, request: { noCache?: boolean } = {}): Promise<GeocodingResult> => {
    const query = rawQuery.trim();
    if (!query) throw new Error('geocoding.jp requires a non-empty place or address');
    const key = `geo:geocoding.jp:v1:${query}`;
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

// MCP・REST・標高取得はこのインスタンスを共有し、外部問い合わせを10秒間隔に制限する。
export const geocodeAddress = createGeocoder();
