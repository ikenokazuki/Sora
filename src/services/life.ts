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
  return `transit:${JSON.stringify([
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

  // 座席指定
  const seatMap: Record<string, string> = { non_reserved: '0', reserved: '1', green: '2' };
  params.set('shin', seatMap[opts.seatPreference || 'non_reserved'] || '0');

  // 歩く速度
  const walkMap: Record<string, string> = { fast: '1', slightly_fast: '2', slightly_slow: '3', slow: '4' };
  params.set('ws', walkMap[opts.walkSpeed || 'slightly_slow'] || '3');

  // 並び順
  const sortMap: Record<string, string> = { time: '0', transfer: '1', fare: '2' };
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
 * 区と、東京の特別区はその区のまま）。当たらなければ undefined。候補が複数残れば候補を挙げたエラー。
 */
export function resolveMunicipality(query: string): Municipality | undefined {
  const s = query.replace(/\s/g, '');
  const pref = PREFECTURE_NAMES.find((p) => s.startsWith(p) && s.length > p.length);
  let name = pref ? s.slice(pref.length) : s;
  const city = name.match(/^(.+?市).+区$/)?.[1];
  if (city && !MUNICIPALITIES.has(name) && MUNICIPALITIES.has(city)) name = city;
  const hits = (MUNICIPALITIES.get(name) ?? ['市', '区', '町', '村'].flatMap((suffix) => MUNICIPALITIES.get(name + suffix) ?? []))
    .filter((m) => !pref || prefectureOf(m.codes[0]) === pref);
  if (hits.length > 1) {
    const names = hits.map((m) => prefectureOf(m.codes[0]) + m.name);
    throw new AreaInputError(`地名「${query}」に当たる市町村が複数あります（${names.join('、')}）。都道府県名や市・区・町・村まで付けてください（例: ${names[0]}）`);
  }
  return hits[0];
}

/** 都市名または都道府県名から 6 桁の予報区の番号を解決する。見つからなければエラー */
export function resolveCityId(query: string): string {
  const clean = query.trim();
  if (/^\d{6}$/.test(clean)) {
    return clean;
  }

  // 1. 気象庁公式自治体マップによる完全一致
  const exact = lookup(MUNICIPALITY_CITY_MAP, clean);
  if (exact) return exact;

  // 2. 接尾辞を除去して再試行（例: "東京都" -> "東京", "天童市" -> "天童", "軽井沢町" -> "軽井沢"）
  const stripped = lookup(MUNICIPALITY_CITY_MAP, clean.replace(/(?:都|府|県|市|区|町|村)$/, ''));
  if (stripped) return stripped;

  // 3. 市町村の表（例: "静岡県森町"。部分一致より先に引かないと、"森町" に当たって北海道になる）
  const town = resolveMunicipality(clean);
  if (town) return town.class10;

  // 4. 部分一致
  for (const [key, id] of Object.entries(MUNICIPALITY_CITY_MAP)) {
    if (key.length >= 2 && (clean.includes(key) || key.includes(clean))) {
      return id;
    }
  }

  throw new AreaInputError(`地名「${clean}」が見つかりません`);
}

/** 予報区（または気象台）の番号から、予報を発表する気象台の番号。北海道・鹿児島・沖縄は XX0000 ではない */
function weatherOfficeOf(cityId: string): string {
  const office = JMA_CLASS10[cityId]?.office ?? (JMA_OFFICES[cityId] ? cityId : undefined);
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
  const cacheKey = `weather:v2:${cityId}:${days}`;
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

  const areaIndex = weatherAreas.findIndex((a: any) => a.area?.code === cityId);
  const targetArea = weatherAreas[areaIndex] ?? weatherAreas[0];
  const targetPop = popAreas.find((a: any) => a.area?.code === cityId) || popAreas[0];
  // 気温の地点は予報区と同じ順に並ぶ（同じ位置に無ければ最初の地点）
  const targetTemp = tempAreas[areaIndex] ?? tempAreas[0];

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

    const targetWeeklyWeather =
      weeklyWeatherAreas.find((a: any) => a.area?.code === cityId || a.area?.code === officeCode) ||
      weeklyWeatherAreas[0];
    const targetWeeklyTemp =
      weeklyTempAreas.find((a: any) => a.area?.code === cityId) || weeklyTempAreas[0];

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
