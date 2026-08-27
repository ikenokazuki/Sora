import * as cheerio from 'cheerio';
import { getFromCache, setToCache } from '../cache.js';

export const CACHE_TTL_TRAFFIC = 180; // 3分 (リアルタイム更新)

export interface TrafficItem {
  roadName: string;
  direction: string;
  status: string;
  section?: string;
  cause?: string;
  detail?: string;
}

export interface RoadTrafficResult {
  pref?: string;
  prefCode?: number;
  road?: string;
  updatedAt: string;
  hasIssues: boolean;
  summary: string;
  items: TrafficItem[];
  source: 'jartic';
}

const PREF_MAP: Record<string, { code: number; name: string }> = {
  '北海道': { code: 1, name: '北海道' }, 'hokkaido': { code: 1, name: '北海道' },
  '青森': { code: 2, name: '青森県' }, '青森県': { code: 2, name: '青森県' }, 'aomori': { code: 2, name: '青森県' },
  '岩手': { code: 3, name: '岩手県' }, '岩手県': { code: 3, name: '岩手県' }, 'iwate': { code: 3, name: '岩手県' },
  '宮城': { code: 4, name: '宮城県' }, '宮城県': { code: 4, name: '宮城県' }, 'miyagi': { code: 4, name: '宮城県' }, '仙台': { code: 4, name: '宮城県' },
  '秋田': { code: 5, name: '秋田県' }, '秋田県': { code: 5, name: '秋田県' }, 'akita': { code: 5, name: '秋田県' },
  '山形': { code: 6, name: '山形県' }, '山形県': { code: 6, name: '山形県' }, 'yamagata': { code: 6, name: '山形県' },
  '福島': { code: 7, name: '福島県' }, '福島県': { code: 7, name: '福島県' }, 'fukushima': { code: 7, name: '福島県' },
  '茨城': { code: 8, name: '茨城県' }, '茨城県': { code: 8, name: '茨城県' }, 'ibaraki': { code: 8, name: '茨城県' },
  '栃木': { code: 9, name: '栃木県' }, '栃木県': { code: 9, name: '栃木県' }, 'tochigi': { code: 9, name: '栃木県' },
  '群馬': { code: 10, name: '群馬県' }, '群馬県': { code: 10, name: '群馬県' }, 'gunma': { code: 10, name: '群馬県' },
  '埼玉': { code: 11, name: '埼玉県' }, '埼玉県': { code: 11, name: '埼玉県' }, 'saitama': { code: 11, name: '埼玉県' },
  '千葉': { code: 12, name: '千葉県' }, '千葉県': { code: 12, name: '千葉県' }, 'chiba': { code: 12, name: '千葉県' },
  '東京': { code: 13, name: '東京都' }, '東京都': { code: 13, name: '東京都' }, 'tokyo': { code: 13, name: '東京都' },
  '神奈川': { code: 14, name: '神奈川県' }, '神奈川県': { code: 14, name: '神奈川県' }, 'kanagawa': { code: 14, name: '神奈川県' }, '横浜': { code: 14, name: '神奈川県' },
  '新潟': { code: 15, name: '新潟県' }, '新潟県': { code: 15, name: '新潟県' }, 'niigata': { code: 15, name: '新潟県' },
  '富山': { code: 16, name: '富山県' }, '富山県': { code: 16, name: '富山県' }, 'toyama': { code: 16, name: '富山県' },
  '石川': { code: 17, name: '石川県' }, '石川県': { code: 17, name: '石川県' }, 'ishikawa': { code: 17, name: '石川県' }, '金沢': { code: 17, name: '石川県' },
  '福井': { code: 18, name: '福井県' }, '福井県': { code: 18, name: '福井県' }, 'fukui': { code: 18, name: '福井県' },
  '山梨': { code: 19, name: '山梨県' }, '山梨県': { code: 19, name: '山梨県' }, 'yamanashi': { code: 19, name: '山梨県' },
  '長野': { code: 20, name: '長野県' }, '長野県': { code: 20, name: '長野県' }, 'nagano': { code: 20, name: '長野県' },
  '岐阜': { code: 21, name: '岐阜県' }, '岐阜県': { code: 21, name: '岐阜県' }, 'gifu': { code: 21, name: '岐阜県' },
  '静岡': { code: 22, name: '静岡県' }, '静岡県': { code: 22, name: '静岡県' }, 'shizuoka': { code: 22, name: '静岡県' },
  '愛知': { code: 23, name: '愛知県' }, '愛知県': { code: 23, name: '愛知県' }, 'aichi': { code: 23, name: '愛知県' }, '名古屋': { code: 23, name: '愛知県' },
  '三重': { code: 24, name: '三重県' }, '三重県': { code: 24, name: '三重県' }, 'mie': { code: 24, name: '三重県' },
  '滋賀': { code: 25, name: '滋賀県' }, '滋賀県': { code: 25, name: '滋賀県' }, 'shiga': { code: 25, name: '滋賀県' },
  '京都': { code: 26, name: '京都府' }, '京都府': { code: 26, name: '京都府' }, 'kyoto': { code: 26, name: '京都府' },
  '大阪': { code: 27, name: '大阪府' }, '大阪府': { code: 27, name: '大阪府' }, 'osaka': { code: 27, name: '大阪府' },
  '兵庫': { code: 28, name: '兵庫県' }, '兵庫県': { code: 28, name: '兵庫県' }, 'hyogo': { code: 28, name: '兵庫県' }, '神戸': { code: 28, name: '兵庫県' },
  '奈良': { code: 29, name: '奈良県' }, '奈良県': { code: 29, name: '奈良県' }, 'nara': { code: 29, name: '奈良県' },
  '和歌山': { code: 30, name: '和歌山県' }, '和歌山県': { code: 30, name: '和歌山県' }, 'wakayama': { code: 30, name: '和歌山県' },
  '鳥取': { code: 31, name: '鳥取県' }, '鳥取県': { code: 31, name: '鳥取県' }, 'tottori': { code: 31, name: '鳥取県' },
  '島根': { code: 32, name: '島根県' }, '島根県': { code: 32, name: '島根県' }, 'shimane': { code: 32, name: '島根県' },
  '岡山': { code: 33, name: '岡山県' }, '岡山県': { code: 33, name: '岡山県' }, 'okayama': { code: 33, name: '岡山県' },
  '広島': { code: 34, name: '広島県' }, '広島県': { code: 34, name: '広島県' }, 'hiroshima': { code: 34, name: '広島県' },
  '山口': { code: 35, name: '山口県' }, '山口県': { code: 35, name: '山口県' }, 'yamaguchi': { code: 35, name: '山口県' },
  '徳島': { code: 36, name: '徳島県' }, '徳島県': { code: 36, name: '徳島県' }, 'tokushima': { code: 36, name: '徳島県' },
  '香川': { code: 37, name: '香川県' }, '香川県': { code: 37, name: '香川県' }, 'kagawa': { code: 37, name: '香川県' }, '高松': { code: 37, name: '香川県' },
  '愛媛': { code: 38, name: '愛媛県' }, '愛媛県': { code: 38, name: '愛媛県' }, 'ehime': { code: 38, name: '愛媛県' }, '松山': { code: 38, name: '愛媛県' },
  '高知': { code: 39, name: '高知県' }, '高知県': { code: 39, name: '高知県' }, 'kochi': { code: 39, name: '高知県' },
  '福岡': { code: 40, name: '福岡県' }, '福岡県': { code: 40, name: '福岡県' }, 'fukuoka': { code: 40, name: '福岡県' }, '博多': { code: 40, name: '福岡県' },
  '佐賀': { code: 41, name: '佐賀県' }, '佐賀県': { code: 41, name: '佐賀県' }, 'saga': { code: 41, name: '佐賀県' },
  '長崎': { code: 42, name: '長崎県' }, '長崎県': { code: 42, name: '長崎県' }, 'nagasaki': { code: 42, name: '長崎県' },
  '熊本': { code: 43, name: '熊本県' }, '熊本県': { code: 43, name: '熊本県' }, 'kumamoto': { code: 43, name: '熊本県' },
  '大分': { code: 44, name: '大分県' }, '大分県': { code: 44, name: '大分県' }, 'oita': { code: 44, name: '大分県' },
  '宮崎': { code: 45, name: '宮崎県' }, '宮崎県': { code: 45, name: '宮崎県' }, 'miyazaki': { code: 45, name: '宮崎県' },
  '鹿児島': { code: 46, name: '鹿児島県' }, '鹿児島県': { code: 46, name: '鹿児島県' }, 'kagoshima': { code: 46, name: '鹿児島県' },
  '沖縄': { code: 47, name: '沖縄県' }, '沖縄県': { code: 47, name: '沖縄県' }, 'okinawa': { code: 47, name: '沖縄県' }, '那覇': { code: 47, name: '沖縄県' },
};

const ROAD_CODE_MAP: Record<string, string> = {
  '東名': '1031008', '東名高速': '1031008', '東名高速道路': '1031008',
  '中央道': '1033006', '中央自動車道': '1033006',
  '関越道': '1035005', '関越自動車道': '1035005',
  '東北道': '1017003', '東北自動車道': '1017003',
  '常磐道': '1021004', '常磐自動車道': '1021004',
  '圏央道': '3120010', '首都圏中央連絡自動車道': '3120010',
  'アクアライン': '3120190', '東京湾アクアライン': '3120190',
  '上信越道': '1037005', '上信越自動車道': '1037005',
  '北陸道': '1043011', '北陸自動車道': '1043011',
  '名神': '1041009', '名神高速': '1041009', '名神高速道路': '1041009',
  '東名阪': '1047010', '東名阪道': '1047010', '東名阪自動車道': '1047010',
  '山陽道': '1063013', '山陽自動車道': '1063013',
  '中国道': '1061013', '中国自動車道': '1061013',
  '九州道': '1083017', '九州自動車道': '1083017',
  '道央道': '1001001', '道央自動車道': '1001001',
};

/** 都道府県名またはコードを解決 */
export function resolvePrefecture(prefInput?: string | number): { code: number; name: string } | null {
  if (!prefInput) return null;
  const str = String(prefInput).trim().toLowerCase();
  const num = parseInt(str, 10);
  if (!isNaN(num) && num >= 1 && num <= 47) {
    const entry = Object.values(PREF_MAP).find(p => p.code === num);
    return entry || { code: num, name: `都道府県コード ${num}` };
  }
  return PREF_MAP[str] || null;
}

/** 道路名から主要高速道路コードを解決 */
export function resolveRoadCode(roadInput?: string): string | null {
  if (!roadInput) return null;
  const clean = roadInput.trim().replace(/\s+/g, '');
  return ROAD_CODE_MAP[clean] || null;
}

/** 道路交通情報（JARTIC/Yahoo! 道路交通情報）を取得 */
export async function fetchRoadTraffic(options: {
  pref?: string | number;
  road?: string;
  noCache?: boolean;
}): Promise<RoadTrafficResult> {
  const prefInfo = resolvePrefecture(options.pref);
  const roadCode = resolveRoadCode(options.road);
  const targetRoadName = options.road?.trim();

  // キャッシュキーの構築
  const cacheKey = `traffic:${prefInfo?.code || 'all'}:${roadCode || targetRoadName || 'all'}`;
  if (!options.noCache) {
    const cached = getFromCache<RoadTrafficResult>(cacheKey);
    if (cached) return cached;
  }

  // 1. 主要高速道路の個別コードがある場合、区間詳細ページを取得
  if (roadCode) {
    const url = `https://roadway.yahoo.co.jp/traffic/road/${roadCode}/list`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Sora-Traffic-Fetcher/1.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Yahoo Roadway API failed (HTTP ${res.status}): ${url}`);
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const titleText = $('title').text().trim();
    const resolvedRoadName = targetRoadName || titleText.split('の')[0] || '高速道路';
    const timeMatch = $('body').text().match(/(\d+月\d+日\s+\d+時\d+分\s+現在)/);
    const updatedAt = timeMatch ? timeMatch[1] : new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    const items: TrafficItem[] = [];
    const directions = ['上り', '下り'];

    $('table').each((i, table) => {
      const dir = directions[i] || (i === 0 ? '上り' : '下り');
      // 接続道路のテーブル（table 2など）は除外
      if (i > 1) return;

      $(table).find('tr').each((_, tr) => {
        const tds = $(tr).find('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
        if (tds.length >= 2) {
          const section = tds[0];
          const status = tds[1];
          const cause = tds[2] || undefined;
          const detail = `${section} ${status}${cause ? ' (' + cause + ')' : ''}`.trim();

          items.push({
            roadName: resolvedRoadName,
            direction: dir,
            status,
            section,
            cause,
            detail,
          });
        }
      });
    });

    const hasIssues = items.some(it => !it.status.includes('規制情報はありません') && !it.status.includes('順調'));
    const summary = hasIssues
      ? `${resolvedRoadName}にて ${items.length} 件の規制・事故等の情報があります。`
      : `${resolvedRoadName}は現在、規制情報はなく順調です。`;

    const result: RoadTrafficResult = {
      road: resolvedRoadName,
      updatedAt,
      hasIssues,
      summary,
      items,
      source: 'jartic',
    };

    if (!options.noCache) {
      setToCache(cacheKey, result, CACHE_TTL_TRAFFIC);
    }
    return result;
  }

  // 2. 都道府県別ページまたはデフォルト（東京: 13）の全道路規制リストを取得
  const prefCode = prefInfo ? prefInfo.code : 13;
  const prefName = prefInfo ? prefInfo.name : '東京都';
  const url = `https://roadway.yahoo.co.jp/traffic/pref/${prefCode}/list`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Sora-Traffic-Fetcher/1.0' },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`Yahoo Roadway API failed (HTTP ${res.status}): ${url}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const timeMatch = $('body').text().match(/(\d+月\d+日\s+\d+時\d+分\s+現在)/);
  const updatedAt = timeMatch ? timeMatch[1] : new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const allItems: TrafficItem[] = [];
  let currentRoadName = '';

  // Table 0 (規制情報がある道路) & Table 1 (全道路一覧) からパース
  // Table 1 に全情報が含まれる
  const targetTable = $('table').length > 1 ? $('table').eq(1) : $('table').first();

  targetTable.find('tr').each((_, tr) => {
    const tds = $(tr).find('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    if (tds.length === 3) {
      currentRoadName = tds[0];
      const direction = tds[1];
      const status = tds[2];
      allItems.push({
        roadName: currentRoadName,
        direction,
        status,
        detail: `${currentRoadName}（${direction}）: ${status}`,
      });
    } else if (tds.length === 2 && currentRoadName) {
      const direction = tds[0];
      const status = tds[1];
      allItems.push({
        roadName: currentRoadName,
        direction,
        status,
        detail: `${currentRoadName}（${direction}）: ${status}`,
      });
    }
  });

  // もし道路名フィルタが指定されていればフィルタリング
  let filteredItems = allItems;
  if (targetRoadName) {
    filteredItems = allItems.filter(it => it.roadName.toLowerCase().includes(targetRoadName.toLowerCase()));
  }

  const hasIssues = filteredItems.some(it => !it.status.includes('規制情報はありません') && !it.status.includes('順調'));
  const issueCount = filteredItems.filter(it => !it.status.includes('規制情報はありません')).length;
  const summary = hasIssues
    ? `${prefName}${targetRoadName ? ' (' + targetRoadName + ')' : ''}にて ${issueCount} 件の規制・事故情報があります。`
    : `${prefName}${targetRoadName ? ' (' + targetRoadName + ')' : ''}の道路は現在、規制情報はなく順調です。`;

  const result: RoadTrafficResult = {
    pref: prefName,
    prefCode,
    ...(targetRoadName ? { road: targetRoadName } : {}),
    updatedAt,
    hasIssues,
    summary,
    items: filteredItems,
    source: 'jartic',
  };

  if (!options.noCache) {
    setToCache(cacheKey, result, CACHE_TTL_TRAFFIC);
  }
  return result;
}

export const CACHE_TTL_FLIGHT = 180; // 3分 (リアルタイム運航情報)

export interface FlightItem {
  scheduledTime: string;
  estimatedTime?: string;
  airline: string;
  flightNumber: string;
  isCodeshare?: boolean;
  destinationOrOrigin: string;
  status: string;
  detail?: string;
}

export interface FlightStatusResult {
  airportName: string;
  airportCode: string;
  type: 'departure' | 'arrival';
  category: 'domestic' | 'international';
  updatedAt: string;
  count: number;
  hasDelaysOrCancellations: boolean;
  summary: string;
  flights: FlightItem[];
  source: 'yahoo-transit';
}

const AIRPORT_MAP: Record<string, { id: number; name: string; code: string }> = {
  '羽田': { id: 2, name: '東京国際空港(羽田空港)', code: 'HND' },
  '羽田空港': { id: 2, name: '東京国際空港(羽田空港)', code: 'HND' },
  '東京国際空港': { id: 2, name: '東京国際空港(羽田空港)', code: 'HND' },
  'hnd': { id: 2, name: '東京国際空港(羽田空港)', code: 'HND' },
  'tokyo': { id: 2, name: '東京国際空港(羽田空港)', code: 'HND' },
  '成田': { id: 1, name: '成田国際空港', code: 'NRT' },
  '成田空港': { id: 1, name: '成田国際空港', code: 'NRT' },
  '成田国際空港': { id: 1, name: '成田国際空港', code: 'NRT' },
  'nrt': { id: 1, name: '成田国際空港', code: 'NRT' },
  '伊丹': { id: 3, name: '大阪国際空港(伊丹空港)', code: 'ITM' },
  '伊丹空港': { id: 3, name: '大阪国際空港(伊丹空港)', code: 'ITM' },
  '大阪国際空港': { id: 3, name: '大阪国際空港(伊丹空港)', code: 'ITM' },
  'itm': { id: 3, name: '大阪国際空港(伊丹空港)', code: 'ITM' },
  '関西': { id: 4, name: '関西国際空港', code: 'KIX' },
  '関西空港': { id: 4, name: '関西国際空港', code: 'KIX' },
  '関西国際空港': { id: 4, name: '関西国際空港', code: 'KIX' },
  '関空': { id: 4, name: '関西国際空港', code: 'KIX' },
  'kix': { id: 4, name: '関西国際空港', code: 'KIX' },
  '中部': { id: 5, name: '中部国際空港(セントレア)', code: 'NGO' },
  '中部空港': { id: 5, name: '中部国際空港(セントレア)', code: 'NGO' },
  'セントレア': { id: 5, name: '中部国際空港(セントレア)', code: 'NGO' },
  '中部国際空港': { id: 5, name: '中部国際空港(セントレア)', code: 'NGO' },
  'ngo': { id: 5, name: '中部国際空港(セントレア)', code: 'NGO' },
};

/** 空港名またはコードから空港情報を解決 */
export function resolveAirport(airportInput?: string): { id: number; name: string; code: string } {
  if (!airportInput) {
    return { id: 2, name: '東京国際空港(羽田空港)', code: 'HND' };
  }
  const key = airportInput.trim().toLowerCase();
  const direct = AIRPORT_MAP[key];
  if (direct) return direct;

  for (const [k, v] of Object.entries(AIRPORT_MAP)) {
    if (key.includes(k) || k.includes(key)) return v;
  }

  return { id: 2, name: '東京国際空港(羽田空港)', code: 'HND' };
}

/** フライト運航状況・欠航・遅延情報取得 (Yahoo! 路線情報) */
export async function fetchFlightStatus(options: {
  airport?: string;
  type?: 'departure' | 'arrival';
  category?: 'domestic' | 'international';
  flightNumber?: string;
  keyword?: string;
  noCache?: boolean;
}): Promise<FlightStatusResult> {
  const airportInfo = resolveAirport(options.airport);
  const type = options.type === 'arrival' ? 'arrival' : 'departure';
  const category = options.category === 'international' ? 'international' : 'domestic';
  const flightNumberFilter = options.flightNumber?.trim().toUpperCase().replace(/\s+/g, '');
  const keywordFilter = options.keyword?.trim().toLowerCase();

  const fac = category === 'international' ? 2 : 1;
  const ad = type === 'arrival' ? 2 : 1;

  const cacheKey = `traffic:flight:${airportInfo.id}:${fac}:${ad}:${flightNumberFilter || ''}:${keywordFilter || ''}`;

  if (!options.noCache) {
    const cached = getFromCache<FlightStatusResult>(cacheKey);
    if (cached) return cached;
  }

  const url = `https://transit.yahoo.co.jp/diainfo/flight/${airportInfo.id}/?fac=${fac}&ad=${ad}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`フライト運航情報の取得に失敗しました (HTTP ${res.status}): ${url}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const timeMatch = $('body').text().match(/(\d+月\d+日\s+\d+時\d+分\s+時点)/);
  const updatedAt = timeMatch ? timeMatch[1] : new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const allFlights: FlightItem[] = [];

  $('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length >= 6) {
      const scheduledTime = $(tds[0]).text().trim();
      const rawEstimated = $(tds[1]).text().trim();
      const estimatedTime = rawEstimated === '---' || !rawEstimated ? undefined : rawEstimated;
      const airline = $(tds[2]).text().trim();
      const rawFlightNum = $(tds[3]).text().replace(/\s+/g, '').trim();
      const isCodeshare = rawFlightNum.includes('※');
      const flightNumber = rawFlightNum.replace(/※/g, '');
      const rawDest = $(tds[4]).text().trim();
      const destinationOrOrigin = rawDest.replace(/行$|発$/, '');
      const status = $(tds[5]).find('span').first().text().trim() || $(tds[5]).text().trim();
      const detail = $(tds[5]).find('p').first().text().trim() || undefined;

      allFlights.push({
        scheduledTime,
        estimatedTime,
        airline,
        flightNumber,
        isCodeshare: isCodeshare ? true : undefined,
        destinationOrOrigin,
        status,
        detail,
      });
    }
  });

  let filtered = allFlights;
  if (flightNumberFilter) {
    filtered = filtered.filter(f => f.flightNumber.toUpperCase().includes(flightNumberFilter));
  }
  if (keywordFilter) {
    filtered = filtered.filter(f =>
      f.airline.toLowerCase().includes(keywordFilter) ||
      f.destinationOrOrigin.toLowerCase().includes(keywordFilter) ||
      (f.detail && f.detail.toLowerCase().includes(keywordFilter)) ||
      f.status.toLowerCase().includes(keywordFilter)
    );
  }

  const hasDelaysOrCancellations = filtered.some(f => f.status.includes('欠航') || f.status.includes('遅れ') || f.status.includes('見合わせ'));
  const cancelledCount = filtered.filter(f => f.status.includes('欠航')).length;
  const delayedCount = filtered.filter(f => f.status.includes('遅れ')).length;

  let summary = `${airportInfo.name} ${category === 'domestic' ? '国内線' : '国際線'} ${type === 'departure' ? '出発' : '到着'}: 対象便数 ${filtered.length}便。`;
  if (hasDelaysOrCancellations) {
    summary += ` (欠航: ${cancelledCount}便, 遅延: ${delayedCount}便)`;
  } else {
    summary += ' 現在、目立った欠航や遅延はなく順調に運航されています。';
  }

  const result: FlightStatusResult = {
    airportName: airportInfo.name,
    airportCode: airportInfo.code,
    type,
    category,
    updatedAt,
    count: filtered.length,
    hasDelaysOrCancellations,
    summary,
    flights: filtered,
    source: 'yahoo-transit',
  };

  if (!options.noCache) {
    setToCache(cacheKey, result, CACHE_TTL_FLIGHT);
  }

  return result;
}

