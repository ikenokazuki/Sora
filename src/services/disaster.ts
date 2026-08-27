import { resolveCityId } from './life.js';
import { MUNICIPALITY_CITY_MAP } from '../city_map.js';
import { getFromCache, setToCache } from '../cache.js';

export const CACHE_TTL_DISASTER = 5 * 60 * 1000;   // 5分
export const CACHE_TTL_EARTHQUAKE = 60 * 1000;     // 1分

export interface WarningItem {
  code: string;
  name: string;
  level: 'special' | 'warning' | 'advisory';
  status?: string;
}

export interface AreaWarnings {
  areaCode: string;
  areaName: string;
  prefecture: string;
  reportTime: string;
  specialWarnings: WarningItem[];
  warnings: WarningItem[];
  advisories: WarningItem[];
  hasActiveAlerts: boolean;
}

export interface EarthquakeItem {
  id: string;
  time: string;
  hypocenter: {
    name: string;
    magnitude: number;
    depthKm?: number;
    latitude?: number;
    longitude?: number;
  };
  maxScale: string;
  maxScaleRaw: number;
  tsunami: string;
  source: 'p2pquake' | 'jma';
  points?: Array<{ pref: string; addr: string; scale: string }>;
}

/** 震度スケール数値 -> 表示名変換 (P2PQuake / JMA 互換) */
export function formatScale(scale: number): string {
  switch (scale) {
    case 10: return '震度1';
    case 20: return '震度2';
    case 30: return '震度3';
    case 40: return '震度4';
    case 45: return '震度5弱';
    case 50: return '震度5強';
    case 55: return '震度6弱';
    case 60: return '震度6強';
    case 70: return '震度7';
    default: return scale > 0 ? `震度${scale}` : '震度不明';
  }
}

/** 気象庁 警報コード -> 警報名・種別マッピング */
const WARNING_CODE_MAP: Record<string, { name: string; level: 'special' | 'warning' | 'advisory' }> = {
  '02': { name: '暴風雪警報', level: 'warning' },
  '03': { name: '大雨警報', level: 'warning' },
  '04': { name: '洪水警報', level: 'warning' },
  '05': { name: '暴風警報', level: 'warning' },
  '06': { name: '大雪警報', level: 'warning' },
  '07': { name: '波浪警報', level: 'warning' },
  '08': { name: '高潮警報', level: 'warning' },
  '10': { name: '大雨注意報', level: 'advisory' },
  '12': { name: '大雪注意報', level: 'advisory' },
  '13': { name: '風雪注意報', level: 'advisory' },
  '14': { name: '雷注意報', level: 'advisory' },
  '15': { name: '強風注意報', level: 'advisory' },
  '16': { name: '波浪注意報', level: 'advisory' },
  '17': { name: '融雪注意報', level: 'advisory' },
  '18': { name: '洪水注意報', level: 'advisory' },
  '19': { name: '高潮注意報', level: 'advisory' },
  '20': { name: '濃霧注意報', level: 'advisory' },
  '21': { name: '乾燥注意報', level: 'advisory' },
  '22': { name: 'なだれ注意報', level: 'advisory' },
  '23': { name: '低温注意報', level: 'advisory' },
  '24': { name: '霜注意報', level: 'advisory' },
  '25': { name: '着氷注意報', level: 'advisory' },
  '26': { name: '着雪注意報', level: 'advisory' },
  '32': { name: '暴風雪特別警報', level: 'special' },
  '33': { name: '大雨特別警報', level: 'special' },
  '35': { name: '暴風特別警報', level: 'special' },
  '36': { name: '大雪特別警報', level: 'special' },
  '37': { name: '波浪特別警報', level: 'special' },
  '38': { name: '高潮特別警報', level: 'special' },
};

/** 気象庁 防災気象警報・注意報取得 */
export async function fetchWeatherWarnings(options: {
  city?: string;
  areaCode?: string;
  noCache?: boolean;
}): Promise<AreaWarnings> {
  const rawCity = options.city || '東京';
  let targetAreaCode: string = options.areaCode || '';

  if (!targetAreaCode) {
    const resolved = resolveCityId(rawCity);
    // 気象庁 warning エンドポイント用 6桁/2桁コード (例: 130000 / 130010)
    targetAreaCode = resolved || '130000';
  }

  // 都道府県2桁プレフィックスを取得 (例: "130010" -> "130000")
  const prefCode = targetAreaCode.length >= 6 ? `${targetAreaCode.slice(0, 2)}0000` : targetAreaCode;
  const cacheKey = `disaster:warning:${targetAreaCode}`;

  if (!options.noCache) {
    const cached = getFromCache<AreaWarnings>(cacheKey);
    if (cached) return cached;
  }

  const jmaUrl = `https://www.jma.go.jp/bosai/warning/data/warning/${prefCode}.json`;
  const res = await fetch(jmaUrl, {
    headers: { 'User-Agent': 'Sora-Disaster-Fetcher/1.0' },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`気象庁 防災情報APIへの接続に失敗しました (HTTP ${res.status}): ${prefCode}`);
  }

  const json = await res.json() as any;
  const reportTime = json?.reportDatetime || new Date().toISOString();
  const areaTypes = json?.areaTypes || [];

  const specialWarnings: WarningItem[] = [];
  const warnings: WarningItem[] = [];
  const advisories: WarningItem[] = [];

  let matchedAreaName = rawCity;

  // 地域警告リストの走査
  for (const at of areaTypes) {
    const areas = at?.areas || [];
    for (const a of areas) {
      if (a.code === targetAreaCode || a.code === prefCode || targetAreaCode.startsWith(a.code.slice(0, 4))) {
        matchedAreaName = a.name || matchedAreaName;
        const wList = a.warnings || [];
        for (const w of wList) {
          const wCode = String(w.code || '').padStart(2, '0');
          const meta = WARNING_CODE_MAP[wCode];
          if (meta) {
            const item: WarningItem = {
              code: wCode,
              name: meta.name,
              level: meta.level,
              status: w.status || '発表',
            };
            if (meta.level === 'special') specialWarnings.push(item);
            else if (meta.level === 'warning') warnings.push(item);
            else advisories.push(item);
          }
        }
      }
    }
  }

  const result: AreaWarnings = {
    areaCode: targetAreaCode,
    areaName: matchedAreaName,
    prefecture: rawCity,
    reportTime,
    specialWarnings,
    warnings,
    advisories,
    hasActiveAlerts: specialWarnings.length > 0 || warnings.length > 0 || advisories.length > 0,
  };

  if (!options.noCache) {
    setToCache(cacheKey, result, CACHE_TTL_DISASTER);
  }

  return result;
}

/** P2PQuake & 気象庁 リアルタイム地震履歴取得 */
export async function fetchRecentEarthquakes(options?: {
  limit?: number;
  minIntensity?: number;
  noCache?: boolean;
}): Promise<{ count: number; earthquakes: EarthquakeItem[] }> {
  const limit = Math.min(Math.max(options?.limit ?? 5, 1), 20);
  const minScaleRaw = options?.minIntensity ?? 10; // デフォルト震度1以上
  const cacheKey = `disaster:earthquake:${limit}:${minScaleRaw}`;

  if (!options?.noCache) {
    const cached = getFromCache<{ count: number; earthquakes: EarthquakeItem[] }>(cacheKey);
    if (cached) return cached;
  }

  try {
    const p2pUrl = `https://api.p2pquake.net/v2/history?codes=551&limit=${Math.min(limit * 2, 40)}`;
    const res = await fetch(p2pUrl, {
      headers: { 'User-Agent': 'Sora-Disaster-Fetcher/1.0' },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      throw new Error(`P2PQuake API HTTP ${res.status}`);
    }

    const data = await res.json() as any[];
    const items: EarthquakeItem[] = [];

    for (const d of data) {
      if (d.code !== 551 || !d.earthquake) continue;
      const eq = d.earthquake;
      const maxScaleNum = eq.maxScale || 0;
      if (maxScaleNum < minScaleRaw) continue;

      const tsunamiMap: Record<string, string> = {
        None: '津波の心配なし',
        Unknown: '津波の有無は調査中',
        Checking: '津波の影響を調査中',
        NonEffective: '若干の海面変動の可能性あり',
        Watch: '津波注意報発表中',
        Warning: '津波警報・大津波警報発表中',
      };

      const points = (d.points || [])
        .filter((p: any) => p.scale >= 30)
        .slice(0, 10)
        .map((p: any) => ({
          pref: p.pref || '',
          addr: p.addr || '',
          scale: formatScale(p.scale),
        }));

      items.push({
        id: d.id || d._id || String(d.time),
        time: eq.time || d.time,
        hypocenter: {
          name: eq.hypocenter?.name || '震源地不明',
          magnitude: eq.hypocenter?.magnitude >= 0 ? eq.hypocenter.magnitude : -1,
          depthKm: eq.hypocenter?.depth >= 0 ? eq.hypocenter.depth : undefined,
          latitude: eq.hypocenter?.latitude,
          longitude: eq.hypocenter?.longitude,
        },
        maxScale: formatScale(maxScaleNum),
        maxScaleRaw: maxScaleNum,
        tsunami: tsunamiMap[eq.domesticTsunami] || '津波の心配なし',
        source: 'p2pquake',
        points: points.length > 0 ? points : undefined,
      });

      if (items.length >= limit) break;
    }

    const result = {
      count: items.length,
      earthquakes: items,
    };

    if (!options?.noCache) {
      setToCache(cacheKey, result, CACHE_TTL_EARTHQUAKE);
    }

    return result;
  } catch (err: any) {
    console.warn('[Sora/Disaster] P2PQuake fetch failed, returning fallback empty set:', err?.message);
    return {
      count: 0,
      earthquakes: [],
    };
  }
}

export const CACHE_TTL_ELEVATION = 24 * 60 * 60 * 1000; // 標高・ジオコーディングは24時間キャッシュ

export interface ElevationResult {
  query?: string;
  address?: string;
  matchedTitle?: string;
  lat: number;
  lon: number;
  elevationMeters: number | null;
  dataAccuracy?: string;
  formatted: string;
  source: 'gsi';
}

/** 国土地理院 ジオコーディング & 標高（海抜）取得 API */
export async function fetchElevationAndCoordinates(options: {
  address?: string;
  lat?: number;
  lon?: number;
  noCache?: boolean;
}): Promise<ElevationResult> {
  const rawAddress = options.address?.trim();
  let lat = options.lat;
  let lon = options.lon;
  let matchedTitle: string | undefined;

  if (!rawAddress && (lat === undefined || lon === undefined)) {
    throw new Error('address または (lat, lon) のいずれかを指定してください');
  }

  const cacheKey = `geo:elevation:${rawAddress || ''}:${lat ?? ''}:${lon ?? ''}`;
  if (!options.noCache) {
    const cached = getFromCache<ElevationResult>(cacheKey);
    if (cached) return cached;
  }

  // 1. 住所が指定されている場合は国土地理院住所検索 API でジオコーディング
  if (rawAddress) {
    const geocodeUrl = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(rawAddress)}`;
    const geoRes = await fetch(geocodeUrl, {
      headers: {
        'User-Agent': 'Sora-Gsi-Fetcher/1.0',
        'Accept': 'application/json, text/plain, */*',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (geoRes.ok) {
      const geoJson = (await geoRes.json()) as any[];
      if (Array.isArray(geoJson) && geoJson.length > 0) {
        const first = geoJson[0];
        const coords = first.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
          lon = coords[0];
          lat = coords[1];
          matchedTitle = first.properties?.title || rawAddress;
        }
      }
    }
  }

  if (lat === undefined || lon === undefined) {
    throw new Error(`住所から座標を特定できませんでした: ${rawAddress}`);
  }

  // 2. 座標から国土地理院標高 API を呼び出し
  const elevUrl = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon}&lat=${lat}&outtype=JSON`;
  const elevRes = await fetch(elevUrl, {
    headers: {
      'User-Agent': 'Sora-Gsi-Fetcher/1.0',
      'Accept': 'application/json, text/plain, */*',
    },
    signal: AbortSignal.timeout(10000),
  });

  let elevationMeters: number | null = null;
  let dataAccuracy: string | undefined;

  if (elevRes.ok) {
    const elevJson = (await elevRes.json()) as any;
    if (typeof elevJson?.elevation === 'number') {
      elevationMeters = elevJson.elevation;
      dataAccuracy = elevJson.hsrc;
    } else if (elevJson?.elevation === '-----') {
      elevationMeters = 0;
      dataAccuracy = '海水面・データ外';
    }
  }

  const elevStr = elevationMeters !== null ? `${elevationMeters}m` : '測定不能';
  const accStr = dataAccuracy ? ` (精度: ${dataAccuracy})` : '';
  const locationLabel = matchedTitle || rawAddress || `緯度: ${lat}, 経度: ${lon}`;
  const formatted = `${locationLabel} の標高 (海抜): ${elevStr}${accStr}`;

  const result: ElevationResult = {
    query: rawAddress,
    address: rawAddress,
    matchedTitle,
    lat,
    lon,
    elevationMeters,
    dataAccuracy,
    formatted,
    source: 'gsi',
  };

  if (!options.noCache) {
    setToCache(cacheKey, result, CACHE_TTL_ELEVATION);
  }

  return result;
}

