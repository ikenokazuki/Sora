import { ADDRESS_ATTRIBUTION } from './address_attribution.js';
import { getFromCache, runWithSingleFlight, setToCache } from '../cache.js';

export const CACHE_TTL_GEOCODING = 24 * 60 * 60 * 1000;
// Nominatim 利用規約: 最大1リクエスト/秒。余裕を持たせる。
const MIN_INTERVAL_MS = 1100;

export interface GeocodingResult {
  address: string;
  lat: number;
  lon: number;
  source: 'nominatim' | 'gsi' | 'abr';
  needsVerification: boolean;
  /** この結果に固有の出典表示。省略時は source の既定（GEOCODING_ATTRIBUTIONS）。 */
  attribution?: string;
}

// 座標解決結果を表示・公開する際に必要な出典表示（OSM は ODbL）。
export const GEOCODING_ATTRIBUTIONS: Record<GeocodingResult['source'], string> = {
  nominatim: '出典: © OpenStreetMap contributors (ODbL) https://www.openstreetmap.org/copyright',
  gsi: '出典: 国土地理院 (https://msearch.gsi.go.jp/address-search/AddressSearch)',
  abr: ADDRESS_ATTRIBUTION,
};

/** 結果を表示・公開する際に併記する出典。地番を使った住所の結果のように、取得元の既定より多く必要な結果は attribution を持つ。 */
export function geocodingAttribution(result: Pick<GeocodingResult, 'source' | 'attribution'>): string {
  return result.attribution ?? GEOCODING_ATTRIBUTIONS[result.source];
}

interface GeocoderOptions {
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 住所・郵便番号をローカルデータで解決する。解決しなければ null。既定は住所モジュール。 */
  local?: (query: string) => Promise<GeocodingResult | null>;
}

// 住所モジュールは最初に使われるまで読み込まない。待たず、失敗は「解決しない」として扱う。
async function defaultLocal(query: string): Promise<GeocodingResult | null> {
  try {
    const { addressEnabled } = await import('./address_config.js');
    if (!addressEnabled()) return null;
    const { getAddressContext } = await import('./address_context.js');
    const { localGeocode } = await import('./address_local_geocoder.js');
    return await localGeocode(getAddressContext(), query);
  } catch {
    return null;
  }
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

// 番地まである住所（「1-5-1」「3丁目4番」）。ハイフン類は ASCII・全角・長音・各種ダッシュを許す。「国道246号」のような道路は含めない。
const BLOCK_NUMBER = /[0-9０-９]+\s*[-‐‑‒–—―−ー－]\s*[0-9０-９]+|[0-9０-９一二三四五六七八九十]+\s*(?:丁目|番)/;

/** 番地まである住所か。OSM は番地レベルの住所に弱く、国土地理院の住所検索のほうが当たるので、これに当たる問い合わせは国土地理院を先に引く。 */
export function looksLikeStreetAddress(query: string): boolean {
  return BLOCK_NUMBER.test(query);
}

// 国土地理院の住所検索。施設名や駅名は当たらず、部分一致で別の地名を返すので、番地まである住所か、Nominatim が該当なしのときに使う。該当なしは null。
function parseGsiLocation(data: unknown, query: string): GeocodingResult | null {
  if (!Array.isArray(data)) throw new Error('gsi address search returned an unexpected response');
  if (data.length === 0) return null;
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
  const local = options.local ?? defaultLocal;
  let gate: Promise<void> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  // 1 秒に 1 回の決まりがあるのは Nominatim だけなので、順番待ちと間隔はその問い合わせにだけかける。該当なしは null。
  async function viaNominatim(query: string): Promise<GeocodingResult | null> {
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
      return parseLocation(data, query);
    } finally {
      release();
    }
  }

  async function viaGsi(query: string): Promise<GeocodingResult | null> {
    const url = 'https://msearch.gsi.go.jp/address-search/AddressSearch?' + new URLSearchParams({ q: query });
    return parseGsiLocation(await fetchJson(fetchFn, url, 'gsi address search'), query);
  }

  async function requestLocation(query: string): Promise<GeocodingResult> {
    if (looksLikeStreetAddress(query)) {
      // 番地まである住所は、公的な索引（国土地理院）を先に引く。使えない間は、従来どおり Nominatim で探す。
      try {
        const found = await viaGsi(query);
        if (found) return found;
      } catch {
        // 国土地理院の不調は、Nominatim の答えがあれば隠す
      }
      const found = await viaNominatim(query);
      if (found) return found;
    } else {
      // 施設名・駅名・地名は Nominatim が当たる。該当なしのときだけ国土地理院へ。Nominatim が使えない間は、部分一致の別の地名を返さずエラーにする。
      const found = (await viaNominatim(query)) ?? (await viaGsi(query));
      if (found) return found;
    }
    throw new Error(`nominatim and gsi found no match: ${query}`);
  }

  return async (rawQuery: string, request: { noCache?: boolean } = {}): Promise<GeocodingResult> => {
    const query = rawQuery.trim();
    if (!query) throw new Error('nominatim requires a non-empty place or address');
    // ローカルで解決できれば、外部問い合わせの 1.1 秒間隔にも、キャッシュにも関わらない。
    const resolvedLocally = await local(query);
    if (resolvedLocally) return resolvedLocally;
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
