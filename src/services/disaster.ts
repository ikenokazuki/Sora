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
  /** 段階（レベル２〜５）。大雨・土砂災害・高潮だけ */
  alertLevel?: number;
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

/**
 * 気象庁 警報・注意報の番号 → 種類の名前と段階（20 注意報・30 警報・40 危険警報・50 特別警報）。
 * 気象庁の警報のページ（https://www.jma.go.jp/bosai/warning/、2026-11-06）のスクリプトの code2WarningInfo の表から。
 * 氾濫の警報は別のデータ（flood）にあり、ここには無い
 */
const WARNING_KINDS: Record<string, [string, number]> = {
  '33': ['大雨', 50], '43': ['大雨', 40], '03': ['大雨', 30], '10': ['大雨', 20],
  '39': ['土砂災害', 50], '49': ['土砂災害', 40], '09': ['土砂災害', 30], '29': ['土砂災害', 20],
  '38': ['高潮', 50], '48': ['高潮', 40], '08': ['高潮', 30], '19': ['高潮', 20],
  '35': ['暴風', 50], '05': ['暴風', 30], '15': ['強風', 20],
  '32': ['暴風雪', 50], '02': ['暴風雪', 30], '13': ['風雪', 20],
  '36': ['大雪', 50], '06': ['大雪', 30], '12': ['大雪', 20],
  '37': ['波浪', 50], '07': ['波浪', 30], '16': ['波浪', 20],
  '14': ['雷', 20], '17': ['融雪', 20], '20': ['濃霧', 20], '21': ['乾燥', 20], '22': ['なだれ', 20],
  '23': ['低温', 20], '24': ['霜', 20], '25': ['着氷', 20], '26': ['着雪', 20],
};
/** 名前は気象庁のページと同じく、種類の名前に段階の名前をつなぐ（例: 大雨危険警報） */
const LEVEL_NAMES: Record<number, string> = { 20: '注意報', 30: '警報', 40: '危険警報', 50: '特別警報' };
/** 気象庁のページが「レベル２」〜「レベル５」を付ける種類 */
const LEVELED_KINDS = new Set(['大雨', '土砂災害', '高潮']);
/** 今出ていない状態（「発表警報・注意報はなし」は番号も無い） */
const INACTIVE_STATUSES = new Set(['解除', '発表警報・注意報はなし']);

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
  const cacheKey = `disaster:warning:v3:${target.code}`;

  if (!options.noCache) {
    const cached = getFromCache<Omit<AreaWarnings, keyof typeof labels>>(cacheKey);
    if (cached) return { ...labels, ...cached };
  }

  const jmaUrl = `https://www.jma.go.jp/bosai/warning/data/r8/${target.office}.json`;
  const res = await fetch(jmaUrl, {
    headers: { 'User-Agent': 'Sora-Disaster-Fetcher/1.0' },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`気象庁 防災情報APIへの接続に失敗しました (HTTP ${res.status}): ${target.office}`);
  }

  const json = await res.json() as any;
  // 報は種類（大雨・土砂災害・風など）ごとに分かれ、どの報にも気象台のすべての予報区（class10Items）と市町村（class20Items）の欄がある。
  // 番号は桁数で重ならない。その地域の欄が無い報は使わない
  const used = (Array.isArray(json) ? json : [])
    .map((r: any) => ({
      time: r?.reportDatetime,
      items: [...(r?.warning?.class10Items || []), ...(r?.warning?.class20Items || [])].filter((i: any) => target.codes.includes(i?.areaCode)),
    }))
    .filter((r) => r.items.length > 0);
  // 欄が無いのは表と気象庁のデータが食い違うときなので、警報なしとせずエラーにする
  if (used.length === 0) {
    throw new Error(`気象庁の警報データに ${target.name}（${target.code}）の欄がありません`);
  }
  // 読める発表日時が無ければ、前と同じく今の時刻
  const times: string[] = used.map((r) => r.time).filter((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)));
  const reportTime = times.length > 0 ? times.reduce((latest, t) => (Date.parse(t) > Date.parse(latest) ? t : latest)) : new Date().toISOString();

  const specialWarnings: WarningItem[] = [];
  const warnings: WarningItem[] = [];
  const advisories: WarningItem[] = [];
  // 区域や予報区を合わせるとき、同じ警報（番号と状態が同じ）は 1 つにする
  const seen = new Set<string>();

  for (const kind of used.flatMap((r) => r.items).flatMap((i: any) => i.kinds || [])) {
    const meta = WARNING_KINDS[kind?.code];
    const status = kind?.status || '発表';
    const key = `${kind?.code}:${status}`;
    if (!meta || INACTIVE_STATUSES.has(status) || seen.has(key)) continue;
    seen.add(key);
    const [kindName, level] = meta;
    const item: WarningItem = {
      code: kind.code,
      name: kindName + LEVEL_NAMES[level],
      level: level === 50 ? 'special' : level === 20 ? 'advisory' : 'warning',
      ...(LEVELED_KINDS.has(kindName) ? { alertLevel: level / 10 } : {}),
      status,
    };
    (level === 50 ? specialWarnings : level === 20 ? advisories : warnings).push(item);
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
