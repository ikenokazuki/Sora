import * as cheerio from 'cheerio';
import { MUNICIPALITY_CITY_MAP } from '../city_map.js';
import { JMA_CLASS10, JMA_CLASS20, JMA_OFFICES, PREFECTURE_NAMES } from '../jma_areas.js';
import { getFromCache, setToCache, CACHE_TTL_WEATHER } from '../cache.js';
import type { TransitSearchOptions, WeatherForecastOptions } from '../types.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export { MUNICIPALITY_CITY_MAP };

function tokyoNow(now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** date(YYYYMMDD)/time(HHMM) と year..minute を統合し、省略分は東京の現在時刻で埋める。 */
export function resolveTransitDateTime(opts: TransitSearchOptions, now = new Date()) {
  const base = tokyoNow(now);
  const date = opts.date?.match(/^(\d{4})(\d{2})(\d{2})$/);
  const time = opts.time?.match(/^(\d{2})(\d{2})$/);
  return {
    year: opts.year ?? (date ? Number(date[1]) : base.year),
    month: opts.month ?? (date ? Number(date[2]) : base.month),
    day: opts.day ?? (date ? Number(date[3]) : base.day),
    hour: opts.hour ?? (time ? Number(time[1]) : base.hour),
    minute: opts.minute ?? (time ? Number(time[2]) : base.minute),
  };
}

export function transitCacheKey(opts: TransitSearchOptions): string {
  const dt = resolveTransitDateTime(opts);
  return `transit:v2:${JSON.stringify([
    opts.from, opts.to, opts.via ?? [], dt.year, dt.month, dt.day, dt.hour, dt.minute,
    opts.timeType ?? 'departure', opts.ticket ?? 'ic', opts.seatPreference ?? '', opts.walkSpeed ?? '', opts.sortBy ?? 'time',
    opts.useAirline !== false, opts.useShinkansen !== false, opts.useExpress !== false,
    opts.useHighwayBus !== false, opts.useLocalBus !== false, opts.useFerry !== false,
  ])}`;
}

/** 乗換案内の URL パラメータを組み立てる */
export function buildTransitUrl(opts: TransitSearchOptions): string {
  const base = 'https://transit.yahoo.co.jp/search/result';
  const params = new URLSearchParams();

  params.set('from', opts.from);
  params.set('to', opts.to);
  params.set('flatlon', '');
  params.set('tlatlon', '');

  // 経由駅（最大3駅）
  const via = opts.via || [];
  for (let i = 0; i < 3; i++) {
    params.set(`via${i + 1}`, via[i] || '');
    params.set(`viacode${i + 1}`, '');
  }

  // 日時
  const dt = resolveTransitDateTime(opts);
  params.set('y', String(dt.year));
  params.set('m', String(dt.month).padStart(2, '0'));
  params.set('d', String(dt.day).padStart(2, '0'));
  params.set('hh', String(dt.hour).padStart(2, '0'));
  params.set('m1', String(Math.floor(dt.minute / 10)));
  params.set('m2', String(dt.minute % 10));

  // 時刻タイプ
  const timeTypeMap: Record<string, string> = {
    departure: '1',
    arrival: '4',
    first_train: '3',
    last_train: '2',
    unspecified: '1',
  };
  params.set('type', timeTypeMap[opts.timeType || 'departure'] || '1');

  // 運賃タイプ
  params.set('ticket', opts.ticket === 'cash' ? 'normal' : 'ic');

  // 座席指定（expkind。shin は新幹線を使うかどうかのフラグ）
  const seatMap: Record<string, string> = { non_reserved: '1', reserved: '2', green: '3' };
  params.set('expkind', seatMap[opts.seatPreference || 'non_reserved'] || '1');

  // 歩く速度
  const walkMap: Record<string, string> = { fast: '1', slightly_fast: '2', slightly_slow: '3', slow: '4' };
  params.set('ws', walkMap[opts.walkSpeed || 'slightly_slow'] || '3');

  // 並び順（0: 到着が早い順、1: 料金が安い順、2: 乗り換え回数順）
  const sortMap: Record<string, string> = { time: '0', fare: '1', transfer: '2' };
  params.set('s', sortMap[opts.sortBy || 'time'] || '0');

  // 交通手段フラグ
  params.set('al', opts.useAirline !== false ? '1' : '0');
  params.set('shin', opts.useShinkansen !== false ? '1' : '0');
  params.set('ex', opts.useExpress !== false ? '1' : '0');
  params.set('hb', opts.useHighwayBus !== false ? '1' : '0');
  params.set('lb', opts.useLocalBus !== false ? '1' : '0');
  params.set('sr', opts.useFerry !== false ? '1' : '0');

  params.set('kw', opts.from);

  return `${base}?${params.toString()}`;
}

/** HTML からルート情報をパースする */
function parseTransitHtml(html: string, opts: TransitSearchOptions): any {
  const $ = cheerio.load(html);
  const routes: any[] = [];

  // 各ルートブロックを解析
  $('.routeList .route, .routeDetail, #route01, #route02, #route03, #route04, #route05, .routeCand').each((i, el) => {
    const routeEl = $(el);

    // ルートサマリー情報
    const summary = routeEl.find('.summary, .routeSummary').first();
    const timeText = summary.find('.time, .reqTime').text().trim() || routeEl.find('.time').first().text().trim();
    const transferText = summary.find('.transfer, .transfer-num').text().trim() || routeEl.find('.transfer').first().text().trim();
    const fareText = summary.find('.fare, .fare-num').text().trim() || routeEl.find('.fare').first().text().trim();

    // 区間詳細
    const sections: any[] = [];
    routeEl.find('.section, li.routeDetail, .access, .routeStep').each((j, sec) => {
      const secEl = $(sec);
      const lineName = secEl.find('.lineName, .transport, .name').text().trim();
      const fromStation = secEl.find('.staName .from, .dep .name, .startName').text().trim();
      const toStation = secEl.find('.staName .to, .arr .name, .endName').text().trim();
      const depTime = secEl.find('.dep .time, .depTime, .startTime').text().trim();
      const arrTime = secEl.find('.arr .time, .arrTime, .endTime').text().trim();

      if (lineName || fromStation || toStation) {
        sections.push({
          line: lineName || undefined,
          from: fromStation || undefined,
          to: toStation || undefined,
          departureTime: depTime || undefined,
          arrivalTime: arrTime || undefined,
        });
      }
    });

    if (timeText || fareText || sections.length > 0) {
      routes.push({
        index: i + 1,
        totalTime: timeText || undefined,
        transfers: transferText || undefined,
        fare: fareText || undefined,
        sections: sections.length > 0 ? sections : undefined,
      });
    }
  });

  // フォールバック: routeList 形式でなかった場合、より汎用的にパース
  if (routes.length === 0) {
    const resultSummaries: any[] = [];
    $('#srline, .elmRouteDetail, #rsltlst li').each((i, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > 10) {
        resultSummaries.push({
          index: i + 1,
          summary: text.substring(0, 500),
        });
      }
    });
    if (resultSummaries.length > 0) {
      return {
        source: 'transit',
        from: opts.from,
        to: opts.to,
        via: opts.via,
        routes: resultSummaries,
        note: 'Summary mode: structured parsing did not match, providing raw summaries.',
      };
    }

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const transitSection = bodyText.substring(0, 2000);
    return {
      source: 'transit',
      from: opts.from,
      to: opts.to,
      via: opts.via,
      rawText: transitSection,
      note: 'Could not parse structured route data. Providing raw text.',
    };
  }

  return {
    source: 'transit',
    from: opts.from,
    to: opts.to,
    via: opts.via,
    routeCount: routes.length,
    routes,
  };
}

/** 乗換案内のメイン関数 */
export async function searchTransitRoute(input: TransitSearchOptions): Promise<any> {
  const opts = { ...input, ...resolveTransitDateTime(input) };
  const cacheKey = transitCacheKey(opts);
  const cached = getFromCache<any>(cacheKey);
  if (cached) return cached;

  const url = buildTransitUrl(opts);

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.5',
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Transit returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const result = parseTransitHtml(html, opts);

  setToCache(cacheKey, result);
  return result;
}

/** 地名・番号が見つからない、または 1 つに決まらない（入力の誤り。REST は 400） */
export class AreaInputError extends Error {}

/** 入力の文字列で表を引く（"constructor" などで Object の既定のプロパティを拾わない） */
const lookup = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** 番号の上 2 桁（都道府県コード）から都道府県名 */
export const prefectureOf = (code: string): string => PREFECTURE_NAMES[Number(code.slice(0, 2)) - 1] ?? '';

/** 都道府県名（"静岡県"・略称の "静岡"・"北海道"）なら 2 桁の都道府県コード */
export function prefectureCodeOf(name: string): string | undefined {
  const i = PREFECTURE_NAMES.findIndex((p) => name === p || name === p.replace(/[都府県]$/, ''));
  return i < 0 ? undefined : String(i + 1).padStart(2, '0');
}

/** 市町村。codes は気象庁の市町村（class20）の番号、class10 は最初の区域の予報区 */
export interface Municipality {
  name: string;
  codes: string[];
  class10: string;
}

/**
 * 名前 → 市町村。class20 の番号ごとに 1 つ（同じ名前が別の都道府県にもあれば複数）。気象庁が区域に分けた市（"横浜市北部"・"横浜市南部"、区ごとの
 * "神戸市中央区" など）は、区域を合わせた市全体（"横浜市"）も 1 つの市町村にする。市の名前そのままの区域が
 * ある市（郡山市と郡山市湖南）は、その名前を市全体にする。
 */
const MUNICIPALITIES = (() => {
  const byName = new Map<string, Municipality[]>();
  const add = (m: Municipality) => byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  const cities = new Map<string, Municipality>(); // `${都道府県コード}${市の名前}` → 区域を合わせた市
  for (const [name, towns] of Object.entries(JMA_CLASS20)) {
    // 市の名前の後に続きがあれば、その市の区域（"余市町" などの町村と "四日市市" などの市は除く）
    const city = /[市町村]$/.test(name) ? undefined : name.match(/^(.+?市)./)?.[1];
    for (const t of towns) {
      add({ name, codes: [t.code], class10: t.class10 });
      if (!city) continue;
      const key = t.code.slice(0, 2) + city;
      const whole = cities.get(key) ?? { name: city, codes: [], class10: t.class10 };
      whole.codes.push(t.code);
      cities.set(key, whole);
    }
  }
  for (const [key, whole] of cities) {
    const same = byName.get(whole.name) ?? [];
    const main = same.find((m) => m.codes[0].startsWith(key.slice(0, 2)));
    if (main) {
      whole.codes.unshift(...main.codes);
      whole.class10 = main.class10;
    }
    byName.set(whole.name, [...same.filter((m) => m !== main), whole]);
  }
  return byName;
})();

/**
 * 市町村を名前から引く。市・区・町・村は省いてよい（"札幌" → 札幌市）。先頭の都道府県名で同じ名前の候補を絞り
 * （"北海道森町"）、政令指定都市の区は市全体に当てる（"横浜市中区" → 横浜市。区ごとの区域がある神戸市・広島市の
 * 区と、東京の特別区はその区のまま）。郡の付いた住所は、当たらなければ郡を外して引き直す（"北海道上川郡上川町" → 上川町。
 * 小郡市・郡山市などは先に当たるので外さない）。当たらなければ undefined。候補が複数残れば候補を挙げたエラー。
 */
export function resolveMunicipality(query: string): Municipality | undefined {
  const s = query.replace(/\s/g, '');
  const pref = PREFECTURE_NAMES.find((p) => s.startsWith(p) && s.length > p.length);
  let name = pref ? s.slice(pref.length) : s;
  const city = name.match(/^(.+?市).+区$/)?.[1];
  if (city && !MUNICIPALITIES.has(name) && MUNICIPALITIES.has(city)) name = city;
  const hits = (MUNICIPALITIES.get(name) ?? ['市', '区', '町', '村'].flatMap((suffix) => MUNICIPALITIES.get(name + suffix) ?? []))
    .filter((m) => !pref || prefectureOf(m.codes[0]) === pref);
  const town = name.replace(/^[^郡]+郡/, '');
  if (hits.length === 0 && town && town !== name) return resolveMunicipality((pref ?? '') + town);
  if (hits.length > 1) {
    const names = hits.map((m) => prefectureOf(m.codes[0]) + m.name);
    throw new AreaInputError(`地名「${query}」に当たる市町村が複数あります（${names.join('、')}）。都道府県名や市・区・町・村まで付けてください（例: ${names[0]}）`);
  }
  return hits[0];
}

/** 市町村の番号（class20）→ 名前と予報区 */
export const TOWN_BY_CODE = new Map(
  Object.entries(JMA_CLASS20).flatMap(([name, towns]) => towns.map((t) => [t.code, { name, class10: t.class10 }] as const)),
);

/** 区域の番号 → その区域を含む市全体（区域に分かれた市だけ） */
const WHOLE_CITY_BY_CODE = new Map(
  [...MUNICIPALITIES.values()].flat().filter((m) => m.codes.length > 1).flatMap((m) => m.codes.map((c) => [c, m] as const)),
);

/** 番号がすべて同じ市の区域なら、その市全体 */
export function wholeCityOf(codes: string[]): Municipality | undefined {
  const city = WHOLE_CITY_BY_CODE.get(codes[0]);
  return city && codes.every((c) => city.codes.includes(c)) ? city : undefined;
}

/** 地名の解決の結果。class10 は予報区、town は市町村（区域に分かれた市は市全体）に当たったとき */
export interface Place {
  class10: string;
  town?: Municipality;
}

/**
 * 天気と警報で共通の地名の解決。
 * 1. 市町村の名前そのまま（候補が 1 つ。"横浜市" などの市全体を含む）
 * 2. city_map の地名（都道府県名・気温の地点の名前を含む）→ その予報区。town: true（警報）では、地名に「市」「区」を
 *    足した市町村が同じ予報区にあればその市町村（"横浜" → 横浜市。"八幡" は京都府八幡市が別の予報区なので北九州地方のまま）
 * 3. 市町村の表（都道府県名の付いた名前・政令指定都市の区・市区町村の省略・郡の付いた住所）。候補が複数なら候補を挙げたエラー
 * 4. city_map の部分一致（先頭が都道府県名なら、その都道府県の地名だけ）。どれにも当たらなければエラー
 * 警報は、都道府県名をこの前に県全体にする（disaster.ts）。天気では、city_map に無い都道府県名（気象台が複数ある北海道）は、
 * 予報区の番号と名前を挙げたエラー
 */
export function resolvePlace(query: string, { town: preferTown = false } = {}): Place {
  const clean = query.trim();
  const exact = MUNICIPALITIES.get(clean);
  if (exact?.length === 1) return { class10: exact[0].class10, town: exact[0] };

  const mapped = lookup(MUNICIPALITY_CITY_MAP, clean);
  if (mapped) {
    const towns = preferTown
      ? [`${clean}市`, `${clean}区`].flatMap((n) => MUNICIPALITIES.get(n) ?? []).filter((m) => m.codes.some((c) => TOWN_BY_CODE.get(c)?.class10 === mapped))
      : [];
    return towns.length === 1 ? { class10: mapped, town: towns[0] } : { class10: mapped };
  }

  const town = resolveMunicipality(clean);
  if (town) return { class10: town.class10, town };

  const prefCode = prefectureCodeOf(clean);
  if (prefCode) {
    const areas = Object.entries(JMA_CLASS10).filter(([c]) => c.startsWith(prefCode)).map(([c, a]) => `${c}（${a.name}）`);
    throw new AreaInputError(`都道府県名「${clean}」からは予報区が 1 つに決まりません。予報区の番号か市町村の名前で指定してください: ${areas.join('、')}`);
  }
  const pref = PREFECTURE_NAMES.find((p) => clean.startsWith(p));
  for (const [key, id] of Object.entries(MUNICIPALITY_CITY_MAP)) {
    if (key.length >= 2 && (!pref || prefectureOf(id) === pref) && (clean.includes(key) || key.includes(clean))) return { class10: id };
  }
  throw new AreaInputError(`地名「${clean}」が見つかりません`);
}

/** 都市名または都道府県名から 6 桁の予報区の番号を解決する（6 桁の数字はそのまま）。見つからなければエラー */
export function resolveCityId(query: string): string {
  const clean = query.trim();
  return /^\d{6}$/.test(clean) ? clean : resolvePlace(clean).class10;
}

/**
 * 予報区（または気象台）の番号から、予報の JSON を出す気象台の番号。北海道・鹿児島・沖縄は XX0000 ではなく、
 * 十勝・奄美の予報は別の気象台（014100・460100）の JSON に入る
 */
function weatherOfficeOf(cityId: string): string {
  const area = JMA_CLASS10[cityId];
  const office = area ? (area.forecastOffice ?? area.office) : JMA_OFFICES[cityId] ? cityId : undefined;
  if (!office) throw new AreaInputError(`地点ID「${cityId}」が見つかりません`);
  return office;
}

const WEATHER_CODE_TELOP: Record<string, string> = {
  '100': '晴れ', '101': '晴時々曇', '102': '晴一時雨', '103': '晴時々雨', '104': '晴一時雪', '105': '晴時々雪',
  '110': '晴のち時々曇', '111': '晴のち曇', '112': '晴のち一時雨', '113': '晴のち時々雨', '114': '晴のち雨',
  '200': '曇り', '201': '曇時々晴', '202': '曇一時雨', '203': '曇時々雨', '204': '曇一時雪', '205': '曇時々雪',
  '210': '曇のち時々晴', '211': '曇のち晴', '212': '曇のち一時雨', '213': '曇のち時々雨', '214': '曇のち雨',
  '300': '雨', '301': '雨時々晴', '302': '雨時々止む', '303': '雨時々雪', '304': '雨一時雪',
  '311': '雨のち晴', '313': '雨のち曇', '314': '雨のち時々雪', '315': '雨のち雪',
  '400': '雪', '401': '雪時々晴', '402': '雪時々止む', '403': '雪時々雨',
  '411': '雪のち晴', '413': '雪のち曇', '414': '雪のち雨',
};

function getTelopFromCode(code: string, weatherText?: string): string {
  if (WEATHER_CODE_TELOP[code]) return WEATHER_CODE_TELOP[code];
  if (weatherText) {
    if (weatherText.startsWith('晴')) return '晴れ';
    if (weatherText.startsWith('くもり') || weatherText.startsWith('曇')) return '曇り';
    if (weatherText.startsWith('雨')) return '雨';
    if (weatherText.startsWith('雪')) return '雪';
  }
  return '晴れ';
}

/** 天気予報を取得 (気象庁公式オープンデータ API 直接通信 / 完全自律型) */
export async function fetchWeatherForecast(options: WeatherForecastOptions): Promise<any> {
  const cityId = resolveCityId(options.city);
  const officeCode = weatherOfficeOf(cityId);
  const days = Math.min(Math.max(options.days ?? 7, 1), 8);
  const cacheKey = `weather:v3:${cityId}:${days}`;
  // キャッシュには入力に依らない中身だけを入れ、返すときに今の入力の地名を付ける
  const withCity = (result: any) => ({ ...result, location: { ...result.location, city: options.city } });

  if (!options.noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return withCity(cached);
  }

  // 気象庁（JMA）公式 API 直接通信（一次ソース一本化）
  const [forecastRes, overviewRes] = await Promise.all([
    fetch(`https://www.jma.go.jp/bosai/forecast/data/forecast/${officeCode}.json`, {
      headers: { 'User-Agent': 'Sora/2.0' },
    }),
    fetch(`https://www.jma.go.jp/bosai/forecast/data/overview_forecast/${officeCode}.json`, {
      headers: { 'User-Agent': 'Sora/2.0' },
    }).catch(() => null),
  ]);

  if (!forecastRes.ok) {
    throw new Error(`JMA Weather API returned HTTP ${forecastRes.status}`);
  }

  const forecastData: any = await forecastRes.json();
  const overviewData: any = overviewRes?.ok ? await overviewRes.json() : null;

  const shortForecast = forecastData[0];
  const weeklyForecast = forecastData[1];

  const timeDefines: string[] = shortForecast?.timeSeries?.[0]?.timeDefines || [];
  const weatherAreas: any[] = shortForecast?.timeSeries?.[0]?.areas || [];
  const popAreas: any[] = shortForecast?.timeSeries?.[1]?.areas || [];
  const tempAreas: any[] = shortForecast?.timeSeries?.[2]?.areas || [];

  const targetArea = weatherAreas.find((a: any) => a.area?.code === cityId) || weatherAreas[0];
  const targetPop = popAreas.find((a: any) => a.area?.code === cityId) || popAreas[0];
  // 気温の地点は予報区の表の地点の名前で選ぶ（JSON の地点の並びは予報区の並びと同じとは限らない）。無ければ最初の地点
  const targetTemp = tempAreas.find((a: any) => a.area?.name === JMA_CLASS10[cityId]?.point) ?? tempAreas[0];

  const dateLabels = ['今日', '明日', '明後日'];
  const forecasts = [];
  const seenDates = new Set<string>();

  // 1. 短期予報 (今日・明日・明後日)
  for (let i = 0; i < timeDefines.length; i++) {
    const rawDate = timeDefines[i];
    const dateStr = rawDate ? rawDate.split('T')[0] : '';
    if (!dateStr || seenDates.has(dateStr)) continue;
    seenDates.add(dateStr);

    const wCode = targetArea?.weatherCodes?.[i] || '100';
    const wDetail = targetArea?.weathers?.[i] || '';
    const wind = targetArea?.winds?.[i] || null;
    const wave = targetArea?.waves?.[i] || null;

    forecasts.push({
      date: dateStr,
      dateLabel: dateLabels[i] || `${i + 1}日後`,
      telop: getTelopFromCode(wCode, wDetail),
      detail: {
        weather: wDetail,
        wind,
        wave,
      },
      temperature: {
        min: targetTemp?.temps?.[i * 2] ? `${targetTemp.temps[i * 2]}℃` : null,
        max: targetTemp?.temps?.[i * 2 + 1] ? `${targetTemp.temps[i * 2 + 1]}℃` : null,
      },
      chanceOfRain: {
        T00_06: targetPop?.pops?.[0] ? `${targetPop.pops[0]}%` : '--%',
        T06_12: targetPop?.pops?.[1] ? `${targetPop.pops[1]}%` : '--%',
        T12_18: targetPop?.pops?.[2] ? `${targetPop.pops[2]}%` : '--%',
        T18_24: targetPop?.pops?.[3] ? `${targetPop.pops[3]}%` : '--%',
      },
      image: `https://www.jma.go.jp/bosai/forecast/img/${wCode}.svg`,
    });
  }

  // 2. 週間予報 (3日目以降〜最大7日先) をマージ
  if (weeklyForecast) {
    const weeklyTimeDefines: string[] = weeklyForecast.timeSeries?.[0]?.timeDefines || [];
    const weeklyWeatherAreas: any[] = weeklyForecast.timeSeries?.[0]?.areas || [];
    const weeklyTempAreas: any[] = weeklyForecast.timeSeries?.[1]?.areas || [];

    // 週間予報の地域は予報区をまとめたもの（"中部・南部"・"下北・三八上北"）や気象台の範囲（"鹿児島県（奄美地方除く）"）。
    // 予報区の番号、気象台の番号、名前（"中部" は "中部・南部"、"沿岸北部" は "沿岸"）の順で選ぶ
    const areaName: string = JMA_CLASS10[cityId]?.name ?? '';
    const targetWeeklyWeather =
      weeklyWeatherAreas.find((a: any) => a.area?.code === cityId) ??
      weeklyWeatherAreas.find((a: any) => a.area?.code === officeCode) ??
      weeklyWeatherAreas.find((a: any) => areaName && a.area?.name && (a.area.name.split('・').includes(areaName) || areaName.startsWith(a.area.name))) ??
      weeklyWeatherAreas[0];
    // 気温の地点は、短期予報と同じく予報区の表の地点の名前で選ぶ。週間予報に無い地点（飯田・むつなど）は、
    // 選んだ地域と同じ位置の地点（気温の地点は地域と同じ並び）
    const targetWeeklyTemp =
      weeklyTempAreas.find((a: any) => a.area?.name === JMA_CLASS10[cityId]?.point) ??
      weeklyTempAreas[weeklyWeatherAreas.indexOf(targetWeeklyWeather)] ??
      weeklyTempAreas[0];

    for (let j = 0; j < weeklyTimeDefines.length; j++) {
      const rawDate = weeklyTimeDefines[j];
      const dateStr = rawDate ? rawDate.split('T')[0] : '';
      if (!dateStr || seenDates.has(dateStr)) continue;
      seenDates.add(dateStr);

      const wCode = targetWeeklyWeather?.weatherCodes?.[j] || '100';
      const popVal = targetWeeklyWeather?.pops?.[j];
      const popStr = popVal !== undefined && popVal !== '' ? `${popVal}%` : '--%';
      const reliability = targetWeeklyWeather?.reliabilities?.[j] || undefined;
      const minTemp = targetWeeklyTemp?.tempsMin?.[j];
      const maxTemp = targetWeeklyTemp?.tempsMax?.[j];

      const diffDays: number = forecasts.length;
      forecasts.push({
        date: dateStr,
        dateLabel: dateLabels[diffDays] || `${diffDays + 1}日後`,
        telop: getTelopFromCode(wCode),
        reliability,
        temperature: {
          min: minTemp && minTemp !== '' ? `${minTemp}℃` : null,
          max: maxTemp && maxTemp !== '' ? `${maxTemp}℃` : null,
        },
        chanceOfRain: {
          allDay: popStr,
          T00_06: popStr,
          T06_12: popStr,
          T12_18: popStr,
          T18_24: popStr,
        },
        image: `https://www.jma.go.jp/bosai/forecast/img/${wCode}.svg`,
      });
    }
  }

  const resultForecasts = forecasts.slice(0, days);

  const formatted = {
    source: 'weather',
    cityId,
    title: `${targetArea?.area?.name || JMA_CLASS10[cityId]?.name || cityId} の天気`,
    publishedTime: shortForecast?.reportDatetime,
    publicTime: shortForecast?.reportDatetime,
    publishingOffice: shortForecast?.publishingOffice || '気象庁',
    location: {
      area: targetArea?.area?.name,
      prefecture: targetArea?.area?.name,
    },
    temperatureArea: targetTemp?.area?.name,
    overview: overviewData?.text || overviewData?.headlineText || '',
    description: {
      headline: overviewData?.headlineText || '',
      body: overviewData?.text || '',
      text: overviewData?.text || '',
      publicTime: overviewData?.reportDatetime || '',
    },
    forecasts: resultForecasts,
    link: `https://www.jma.go.jp/bosai/forecast/#area_type=class20&area_code=${cityId}`,
    cached: false,
  };

  if (!options.noCache) setToCache(cacheKey, formatted, CACHE_TTL_WEATHER);
  return withCity(formatted);
}
