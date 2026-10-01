import {
  type Hotel,
  type HotelFailureCode,
  type HotelPriceBasis,
  type HotelSearchInput,
  type HotelSearchResult,
  type HotelTaxStatus,
} from './types.js';

export type RakutenLocationId = 'tokyo' | 'kyoto' | 'kusatsu';

export interface ResolvedRakutenLocation {
  id: RakutenLocationId;
  /** Observed Japanese label, echoed back in results. */
  label: string;
  /** Observed search URL. Only the dated conditions are rewritten on encode. */
  templateUrl: string;
}

/**
 * Exact-match table from docs/evaluations/rakuten-travel/observed-cases.json.
 * General place resolution over HTTP is not established, so anything outside
 * this table is rejected instead of guessed.
 */
const OBSERVED_LOCATIONS: Array<ResolvedRakutenLocation & { keys: string[] }> = [
  {
    id: 'tokyo',
    label: '東京駅',
    keys: ['tokyo', '東京駅'],
    templateUrl:
      'https://search.travel.rakuten.co.jp/ds/hotellist/Japan-Tokyo-Tokyo-Tokyo_Station_Area' +
      '?f_hi1=20&f_tuki1=10&f_nen1=2026&f_hi2=21&f_tuki2=10&f_nen2=2026' +
      '&f_otona_su=1&f_heya_su=1&f_s1=0&f_s2=0&f_y1=0&f_y2=0&f_y3=0&f_y4=0&f_kin2=0',
  },
  {
    id: 'kyoto',
    label: '京都駅',
    keys: ['kyoto', '京都駅'],
    templateUrl:
      'https://search.travel.rakuten.co.jp/ds/hotellist/Japan-Kyoto-Kyoto-Kyoto_Station_Area' +
      '?f_hi1=20&f_tuki1=10&f_nen1=2026&f_hi2=21&f_tuki2=10&f_nen2=2026' +
      '&f_otona_su=2&f_heya_su=1&f_s1=0&f_s2=0&f_y1=0&f_y2=0&f_y3=0&f_y4=0&f_kin2=0',
  },
  {
    id: 'kusatsu',
    label: '草津温泉',
    keys: ['kusatsu', '草津温泉'],
    templateUrl:
      'https://search.travel.rakuten.co.jp/ds/vacant/searchOnsen' +
      '?f_nen1=2026&f_tuki1=10&f_hi1=20&f_nen2=2026&f_tuki2=10&f_hi2=21' +
      '&f_otona_su=2&f_s1=0&f_s2=0&f_y1=0&f_y2=0&f_y3=0&f_y4=0' +
      '&f_chu=gunma&f_shou=kusatsu&f_heya_su=1&f_page_style=&f_teikei=&f_cok=OK00259&lid=jparea_dated_onsen',
  },
];

export class RakutenHotelError extends Error {
  readonly code: HotelFailureCode;
  constructor(code: HotelFailureCode, message: string) {
    super(message);
    this.name = 'RakutenHotelError';
    this.code = code;
  }
}

export function resolveRakutenLocation(input: string): ResolvedRakutenLocation {
  const key = input.trim().toLowerCase();
  const found = OBSERVED_LOCATIONS.find((entry) => entry.keys.includes(key));
  if (!found) {
    throw new RakutenHotelError(
      'UNSUPPORTED_CONDITION',
      '対応していない場所です（観測済み: 東京駅, 京都駅, 草津温泉）: ' + input.trim().slice(0, 50),
    );
  }
  return { id: found.id, label: found.label, templateUrl: found.templateUrl };
}

function setDateParams(url: URL, date: string, side: '1' | '2'): void {
  const [year, month, day] = date.split('-');
  url.searchParams.set('f_nen' + side, year);
  url.searchParams.set('f_tuki' + side, String(Number(month)));
  url.searchParams.set('f_hi' + side, String(Number(day)));
}

export function encodeRakutenSearch(
  input: HotelSearchInput,
  resolved: ResolvedRakutenLocation,
): URL {
  const url = new URL(resolved.templateUrl);
  if (url.origin !== 'https://search.travel.rakuten.co.jp') {
    throw new RakutenHotelError('SCHEMA_CHANGED', '観測済み送信先ではありません');
  }
  setDateParams(url, input.checkIn, '1');
  setDateParams(url, input.checkOut, '2');
  url.searchParams.set('f_otona_su', String(input.adults));
  url.searchParams.set('f_heya_su', String(input.rooms));
  return url;
}

/** Raw upstream response handed to the parser. HTTP mapping stays in index.ts. */
export interface RakutenRawResponse {
  status: number;
  html: string;
  url: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Condition keys read from `ds.conditions`. Unknown keys are dropped, never stored. */
const CONDITION_KEYS = new Set([
  'f_dai',
  'f_chu',
  'f_shou',
  'f_sai',
  'f_cok',
  'f_latitude',
  'f_longitude',
  'f_km',
  'f_nen1',
  'f_tuki1',
  'f_hi1',
  'f_nen2',
  'f_tuki2',
  'f_hi2',
  'f_otona_su',
  'f_heya_su',
  'f_sort',
  'f_page',
  'f_hyoji',
  'f_tab',
]);

interface DatedState {
  isDated: boolean;
  conditions: Record<string, string[]>;
  totalResults: number[];
  displayedHotels: number[];
  hotels: Record<string, unknown>;
}

function projectState(value: unknown): DatedState {
  if (
    !isRecord(value) ||
    typeof value.isDated !== 'boolean' ||
    !isRecord(value.conditions) ||
    !isRecord(value.hotels) ||
    !Array.isArray(value.displayedHotels) ||
    !Array.isArray(value.totalResults) ||
    !value.displayedHotels.every((id) => typeof id === 'number' && Number.isSafeInteger(id)) ||
    !value.totalResults.every((count) => typeof count === 'number' && Number.isSafeInteger(count))
  ) {
    throw new RakutenHotelError('SCHEMA_CHANGED', 'ds の構造が観測時と異なります');
  }
  const conditions: Record<string, string[]> = {};
  for (const [key, condition] of Object.entries(value.conditions)) {
    if (!CONDITION_KEYS.has(key)) continue;
    if (!Array.isArray(condition) || !condition.every((item) => typeof item === 'string')) {
      throw new RakutenHotelError('SCHEMA_CHANGED', 'ds の条件形式が観測時と異なります');
    }
    conditions[key] = condition;
  }
  return {
    isDated: value.isDated,
    conditions,
    totalResults: value.totalResults,
    displayedHotels: value.displayedHotels,
    hotels: value.hotels,
  };
}

/**
 * The value after `var ds =` is JSON in the observed pages. Scan the JSON
 * boundary and parse it. Never eval page JavaScript.
 */
export function extractDatedState(html: string): DatedState | null {
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const source = script[1];
    const match = /\bvar\s+ds\s*=\s*(?=\{)/.exec(source);
    if (!match) continue;
    const start = match.index + match[0].length;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') {
        quoted = true;
      } else if (char === '{') {
        depth++;
      } else if (char === '}' && --depth === 0) {
        return projectState(JSON.parse(source.slice(start, i + 1)));
      }
    }
    throw new RakutenHotelError('SCHEMA_CHANGED', 'ds の JSON が途中で終わっています');
  }
  return null;
}

function conditionOf(state: DatedState, key: string): string | undefined {
  const values = state.conditions[key];
  return values && values.length === 1 ? values[0] : undefined;
}

function conditionsMatch(state: DatedState, input: HotelSearchInput): string | null {
  const [inYear, inMonth, inDay] = input.checkIn.split('-');
  const [outYear, outMonth, outDay] = input.checkOut.split('-');
  const expected: Array<[string, string]> = [
    ['f_nen1', inYear],
    ['f_tuki1', String(Number(inMonth))],
    ['f_hi1', String(Number(inDay))],
    ['f_nen2', outYear],
    ['f_tuki2', String(Number(outMonth))],
    ['f_hi2', String(Number(outDay))],
    ['f_otona_su', String(input.adults)],
    ['f_heya_su', String(input.rooms)],
  ];
  for (const [key, want] of expected) {
    if (conditionOf(state, key) !== want) {
      return key + ' の有効条件が要求と一致しません';
    }
  }
  return null;
}

function chargeOf(charge: unknown, warnings: string[], where: string): { amount: number; taxStatus: HotelTaxStatus } | null {
  if (!isRecord(charge)) return null;
  const inclusive = charge.sumTotalChargeTaxInclusive;
  const exclusive = charge.sumTotalChargeTaxExclusive;
  const amount = typeof inclusive === 'number' ? inclusive : exclusive;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    warnings.push(where + ' の料金を読み取れないため除外しました');
    return null;
  }
  const taxType = charge.taxType;
  const taxStatus: HotelTaxStatus =
    taxType === 'inclusive' ? 'included' : taxType === 'exclusive' ? 'excluded' : 'unknown';
  if (taxType !== 'inclusive' && taxType !== 'exclusive') {
    warnings.push(where + ' の税区分が不明のため unknown として保持します');
  }
  return { amount, taxStatus };
}

function hotelsOf(state: DatedState, sourceUrl: string, warnings: string[]): Hotel[] {
  const hotels: Hotel[] = [];
  for (const hotelId of state.displayedHotels) {
    const hotel = state.hotels[String(hotelId)];
    if (!isRecord(hotel) || !isRecord(hotel.plans)) {
      warnings.push('施設 ' + hotelId + ' の形式が異なるため除外しました');
      continue;
    }
    const plans: Hotel['plans'] = [];
    for (const [planId, plan] of Object.entries(hotel.plans)) {
      if (!/^\d+$/.test(planId) || !isRecord(plan) || !isRecord(plan.rooms)) {
        warnings.push('施設 ' + hotelId + ' のプラン形式が異なるため除外しました');
        continue;
      }
      const rooms: Hotel['plans'][number]['rooms'] = [];
      for (const [roomId, charge] of Object.entries(plan.rooms)) {
        const parsed = chargeOf(charge, warnings, '施設 ' + hotelId + ' プラン ' + planId);
        if (parsed) rooms.push({ roomId, ...parsed, currency: 'JPY', basis: 'unknown' });
      }
      if (rooms.length > 0) plans.push({ planId, rooms });
    }
    if (plans.length > 0) hotels.push({ id: String(hotelId), name: null, address: null, sourceUrl, plans });
  }
  return hotels;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round(
    (Date.parse(checkOut + 'T00:00:00Z') - Date.parse(checkIn + 'T00:00:00Z')) / 86400000,
  );
}

export function parseRakutenResponse(
  raw: unknown,
  input: HotelSearchInput,
  retrievedAt: string,
): HotelSearchResult {
  if (!isRecord(raw) || typeof raw.status !== 'number' || typeof raw.html !== 'string' || typeof raw.url !== 'string') {
    throw new Error('parseRakutenResponse requires { status, html, url }');
  }
  if (raw.status !== 200) {
    throw new Error('parseRakutenResponse requires status 200; map other statuses in the service');
  }
  const query = {
    location: input.location,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    adults: input.adults,
    rooms: input.rooms,
    limit: input.limit,
  };
  const base = { source: 'rakuten_travel' as const, query, retrievedAt, hotels: [], warnings: [] as string[] };
  try {
    const state = extractDatedState(raw.html);
    if (!state) {
      return { ...base, status: 'unavailable', failures: [{ code: 'SCHEMA_CHANGED', message: '構造化された日付指定状態がありません' }] };
    }
    if (!state.isDated) {
      return {
        ...base,
        status: 'unavailable',
        failures: [{ code: 'CONDITION_MISMATCH', message: '日付未指定の参考表示のため指定日の料金に使いません' }],
      };
    }
    const mismatch = conditionsMatch(state, input);
    if (mismatch) {
      return { ...base, status: 'unavailable', failures: [{ code: 'CONDITION_MISMATCH', message: mismatch }] };
    }
    if (state.displayedHotels.length === 0) {
      return { ...base, status: 'empty', failures: [] };
    }
    const warnings: string[] = [];
    const oneNight = nightsBetween(input.checkIn, input.checkOut) === 1;
    const basis: HotelPriceBasis = oneNight ? 'stay_total' : 'unknown';
    const hotels = hotelsOf(state, raw.url, warnings).map((hotel) => ({
      ...hotel,
      plans: hotel.plans.map((plan) => ({
        ...plan,
        rooms: plan.rooms.map((room) => ({ ...room, basis })),
      })),
    }));
    if (hotels.length === 0) {
      return {
        ...base,
        status: 'unavailable',
        warnings,
        failures: [{ code: 'SCHEMA_CHANGED', message: '表示施設の料金を1件も読み取れませんでした' }],
      };
    }
    const limited = hotels.slice(0, input.limit);
    if (limited.length < hotels.length) {
      warnings.push('表示 ' + hotels.length + ' 件のうち先頭 ' + limited.length + ' 件を返します');
    }
    return { ...base, status: 'ok', hotels: limited, warnings, failures: [] };
  } catch (err) {
    if (err instanceof RakutenHotelError) {
      return { ...base, status: 'unavailable', failures: [{ code: err.code, message: err.message }] };
    }
    throw err;
  }
}
