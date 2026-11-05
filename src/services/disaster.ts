import { AreaInputError, TOWN_BY_CODE, prefectureOf, resolvePlace, wholeCityOf, type Municipality } from './life.js';
import { getFromCache, setToCache } from '../cache.js';
import { geocodeAddress, geocodingAttribution, type GeocodingResult } from './geocoding.js';
import { JMA_CLASS10, JMA_OFFICES } from '../jma_areas.js';

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

/**
 * 警報を返す範囲。codes の欄（市町村・予報区）を合わせる。区域に分かれた市はその区域すべて、気象台はその範囲の予報区。
 * code は応答の areaCode（区域に分かれた市は区域の番号をカンマでつなぐ）
 */
interface WarningTarget {
  code: string;
  name: string;
  office: string;
  codes: string[];
}

const townTarget = (town: Municipality): WarningTarget => ({
  code: town.codes.join(','), name: town.name, office: JMA_CLASS10[town.class10].office, codes: town.codes,
});

/** 7 桁（市町村）・6 桁（予報区・気象台）・2 桁（都道府県）の番号、または同じ市の区域の 7 桁をカンマでつないだものを、警報を返す範囲にする */
function warningTargetFromCode(input: string): WarningTarget {
  if (input.includes(',')) {
    const codes = [...new Set(input.split(',').map((c) => c.trim()))];
    const city = codes.every((c) => /^\d{7}$/.test(c)) ? wholeCityOf(codes) : undefined;
    if (!city) throw new AreaInputError(`エリアコード「${input}」: カンマでつなげるのは、同じ市の区域の 7 桁の番号だけです`);
    const parts = city.codes.filter((c) => codes.includes(c));
    if (parts.length === city.codes.length) return townTarget(city);
    return { code: parts.join(','), name: parts.map((c) => TOWN_BY_CODE.get(c)?.name).join('・'), office: JMA_CLASS10[city.class10].office, codes: parts };
  }
  if (!/^(\d{2}|\d{6}|\d{7})$/.test(input)) throw new AreaInputError(`エリアコード「${input}」は 7 桁・6 桁・2 桁の数字で指定してください`);
  const town = TOWN_BY_CODE.get(input);
  if (town) return { code: input, name: town.name, office: JMA_CLASS10[town.class10].office, codes: [input] };
  let code = input;
  if (code.length === 2) {
    // 北海道・鹿児島・沖縄は気象台が複数あり、XX0000 の気象台が無い
    const offices = Object.entries(JMA_OFFICES).filter(([c]) => c.startsWith(code));
    if (offices.length > 1) {
      throw new AreaInputError(`都道府県コード「${code}」には気象台が複数あります。6 桁の気象台の番号を指定してください: ${offices.map(([c, n]) => `${c}（${n}）`).join('、')}`);
    }
    code = `${code}0000`;
  }
  const area = JMA_CLASS10[code];
  if (area) return { code, name: area.name, office: area.office, codes: [code] };
  if (JMA_OFFICES[code]) {
    const areas = Object.keys(JMA_CLASS10).filter((c) => JMA_CLASS10[c].office === code);
    return { code, name: JMA_OFFICES[code], office: code, codes: areas };
  }
  throw new AreaInputError(`エリアコード「${input}」が見つかりません`);
}

/** areaCode があればそれ、無ければ city を天気と同じ順で解決する（市町村に当たれば市町村）。どちらも無ければ東京 */
function resolveWarningTarget(city?: string, areaCode?: string): WarningTarget {
  if (areaCode?.trim()) return warningTargetFromCode(areaCode.trim());
  const query = city?.trim() || '東京';
  if (/^\d{6}$/.test(query)) return warningTargetFromCode(query);
  const place = resolvePlace(query, { town: true });
  return place.town ? townTarget(place.town) : warningTargetFromCode(place.class10);
}

/** 気象庁 防災気象警報・注意報取得 */
export async function fetchWeatherWarnings(options: {
  city?: string;
  areaCode?: string;
  noCache?: boolean;
}): Promise<AreaWarnings> {
  const target = resolveWarningTarget(options.city, options.areaCode);
  // キャッシュには入力に依らない中身だけを入れ、ラベルは解決した番号から付ける
  const labels = { areaCode: target.code, areaName: target.name, prefecture: prefectureOf(target.code) };
  const cacheKey = `disaster:warning:v2:${target.code}`;

  if (!options.noCache) {
    const cached = getFromCache<Omit<AreaWarnings, keyof typeof labels>>(cacheKey);
    if (cached) return { ...labels, ...cached };
  }

  const jmaUrl = `https://www.jma.go.jp/bosai/warning/data/warning/${target.office}.json`;
  const res = await fetch(jmaUrl, {
    headers: { 'User-Agent': 'Sora-Disaster-Fetcher/1.0' },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`気象庁 防災情報APIへの接続に失敗しました (HTTP ${res.status}): ${target.office}`);
  }

  const json = await res.json() as any;
  const reportTime = json?.reportDatetime || new Date().toISOString();
  // areaTypes[0] は予報区、[1] は市町村の欄（番号は桁数で重ならない）
  const areas: any[] = (json?.areaTypes || []).flatMap((at: any) => at?.areas || []);
  const matched = areas.filter((a) => target.codes.includes(a.code));
  if (matched.length === 0) {
    throw new Error(`気象庁の警報データに ${target.name}（${target.code}）の欄がありません`);
  }

  const specialWarnings: WarningItem[] = [];
  const warnings: WarningItem[] = [];
  const advisories: WarningItem[] = [];
  // 区域や予報区を合わせるとき、同じ警報（番号と状態が同じ）は 1 つにする
  const seen = new Set<string>();

  for (const a of matched) {
    for (const w of a.warnings || []) {
      const wCode = String(w.code || '').padStart(2, '0');
      const meta = WARNING_CODE_MAP[wCode];
      const status = w.status || '発表';
      if (meta && !seen.has(`${wCode}:${status}`)) {
        seen.add(`${wCode}:${status}`);
        const item: WarningItem = {
          code: wCode,
          name: meta.name,
          level: meta.level,
          status,
        };
        if (meta.level === 'special') specialWarnings.push(item);
        else if (meta.level === 'warning') warnings.push(item);
        else advisories.push(item);
      }
    }
  }

  const content = {
    reportTime,
    specialWarnings,
    warnings,
    advisories,
    hasActiveAlerts: specialWarnings.length > 0 || warnings.length > 0 || advisories.length > 0,
  };

  if (!options.noCache) {
    setToCache(cacheKey, content, CACHE_TTL_DISASTER);
  }

  return { ...labels, ...content };
}

/** P2PQuake & 気象庁 リアルタイム地震履歴取得 */
export async function fetchRecentEarthquakes(options?: {
  limit?: number;
  minIntensity?: number;
  noCache?: boolean;
}): Promise<{ count: number; earthquakes: EarthquakeItem[] }> {
  const limit = Math.min(Math.max(options?.limit ?? 5, 1), 20);
  const minScaleRaw = options?.minIntensity ?? 10; // デフォルト震度1以上
  const cacheKey = `disaster:earthquake:v2:${limit}:${minScaleRaw}`;

  if (!options?.noCache) {
    const cached = getFromCache<{ count: number; earthquakes: EarthquakeItem[] }>(cacheKey);
    if (cached) return cached;
  }

  // 震度で絞るときは、絞ってから limit 件に切れるよう上限の 100 件を取る。失敗は 0 件にせずエラーにする
  const p2pUrl = `https://api.p2pquake.net/v2/history?codes=551&limit=${minScaleRaw > 10 ? 100 : Math.min(limit * 2, 40)}`;
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
}

export const CACHE_TTL_ELEVATION = 24 * 60 * 60 * 1000; // 標高・ジオコーディングは24時間キャッシュ

export interface ElevationResult {
  query?: string;
  address?: string;
  matchedTitle?: string;
  geocodingSource?: GeocodingResult['source'];
  geocodingAttribution?: string;
  needsVerification?: boolean;
  lat: number;
  lon: number;
  elevationMeters: number | null;
  dataAccuracy?: string;
  formatted: string;
  source: 'gsi';
}

/** Nominatimによる住所・地名解決と国土地理院の標高（海抜）取得。 */
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
  let geocoding: GeocodingResult | undefined;

  if (!rawAddress && (lat === undefined || lon === undefined)) {
    throw new Error('address または (lat, lon) のいずれかを指定してください');
  }

  const cacheKey = `geo:elevation:v2:${rawAddress || ''}:${lat ?? ''}:${lon ?? ''}`;
  if (!options.noCache) {
    const cached = getFromCache<ElevationResult>(cacheKey);
    if (cached) return cached;
  }

  // 1. 住所・地名の解決はPOI検索と同じレート制御・キャッシュを共有する。
  if (rawAddress) {
    geocoding = await geocodeAddress(rawAddress, { noCache: options.noCache });
    lat = geocoding.lat;
    lon = geocoding.lon;
    matchedTitle = geocoding.address;
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
    ...(geocoding ? { geocodingSource: geocoding.source, geocodingAttribution: geocodingAttribution(geocoding), needsVerification: geocoding.needsVerification } : {}),
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
