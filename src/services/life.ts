import * as cheerio from 'cheerio';
import { MUNICIPALITY_CITY_MAP } from '../city_map.js';
import { getFromCache, setToCache, CACHE_TTL_WEATHER } from '../cache.js';
import type { TransitSearchOptions, WeatherForecastOptions } from '../types.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export { MUNICIPALITY_CITY_MAP };

/** 乗換案内の URL パラメータを組み立てる */
function buildTransitUrl(opts: TransitSearchOptions): string {
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
  const now = new Date();
  params.set('y', String(opts.year || now.getFullYear()));
  params.set('m', String(opts.month || now.getMonth() + 1).padStart(2, '0'));
  params.set('d', String(opts.day || now.getDate()).padStart(2, '0'));
  params.set('hh', String(opts.hour ?? now.getHours()).padStart(2, '0'));
  params.set('m1', String(Math.floor((opts.minute ?? now.getMinutes()) / 10)));
  params.set('m2', String((opts.minute ?? now.getMinutes()) % 10));

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
export async function searchTransitRoute(opts: TransitSearchOptions): Promise<any> {
  const cacheKey = `transit:${opts.from}:${opts.to}:${(opts.via || []).join(',')}:${opts.year || ''}:${opts.month || ''}:${opts.day || ''}:${opts.hour ?? ''}:${opts.minute ?? ''}:${opts.timeType || 'departure'}`;
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

/** 都市名または都道府県名から 6 桁の地点 ID を解決 */
export function resolveCityId(query: string): string {
  const clean = query.trim();
  if (/^\d{6}$/.test(clean)) {
    return clean;
  }

  // 1. 気象庁公式自治体マップによる完全一致
  if (MUNICIPALITY_CITY_MAP[clean]) {
    return MUNICIPALITY_CITY_MAP[clean];
  }

  // 2. 接尾辞を除去して再試行（例: "東京都" -> "東京", "天童市" -> "天童", "軽井沢町" -> "軽井沢"）
  const stripped = clean.replace(/(?:都|府|県|市|区|町|村)$/, '');
  if (MUNICIPALITY_CITY_MAP[stripped]) {
    return MUNICIPALITY_CITY_MAP[stripped];
  }

  // 3. 部分一致
  for (const [key, id] of Object.entries(MUNICIPALITY_CITY_MAP)) {
    if (key.length >= 2 && (clean.includes(key) || key.includes(clean))) {
      return id;
    }
  }

  // 見つからない場合はデフォルトで東京 (130010)
  return '130010';
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
  const days = Math.min(Math.max(options.days ?? 3, 1), 3);
  const cacheKey = `weather:${cityId}:${days}`;

  if (!options.noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return cached;
  }

  // 1. 気象庁（JMA）公式 API 直接通信
  try {
    const officeCode = cityId.substring(0, 2) + '0000';
    const [forecastRes, overviewRes] = await Promise.all([
      fetch(`https://www.jma.go.jp/bosai/forecast/data/forecast/${officeCode}.json`, {
        headers: { 'User-Agent': 'Sora/2.0' },
      }),
      fetch(`https://www.jma.go.jp/bosai/forecast/data/overview_forecast/${officeCode}.json`, {
        headers: { 'User-Agent': 'Sora/2.0' },
      }).catch(() => null),
    ]);

    if (forecastRes.ok) {
      const forecastData: any = await forecastRes.json();
      const overviewData: any = overviewRes?.ok ? await overviewRes.json() : null;

      const shortForecast = forecastData[0];
      const timeDefines: string[] = shortForecast?.timeSeries?.[0]?.timeDefines || [];
      const weatherAreas: any[] = shortForecast?.timeSeries?.[0]?.areas || [];
      const popAreas: any[] = shortForecast?.timeSeries?.[1]?.areas || [];
      const tempAreas: any[] = shortForecast?.timeSeries?.[2]?.areas || [];

      const targetArea = weatherAreas.find((a: any) => a.area?.code === cityId) || weatherAreas[0];
      const targetPop = popAreas.find((a: any) => a.area?.code === cityId) || popAreas[0];
      const targetTemp = tempAreas[0];

      const dateLabels = ['今日', '明日', '明後日'];
      const forecasts = [];

      for (let i = 0; i < Math.min(days, timeDefines.length); i++) {
        const rawDate = timeDefines[i];
        const dateStr = rawDate ? rawDate.split('T')[0] : '';
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

      const formatted = {
        source: 'weather',
        cityId,
        title: `${targetArea?.area?.name || options.city} の天気`,
        publishedTime: shortForecast?.reportDatetime,
        publicTime: shortForecast?.reportDatetime,
        publishingOffice: shortForecast?.publishingOffice || '気象庁',
        location: {
          area: targetArea?.area?.name,
          prefecture: targetArea?.area?.name,
          city: options.city,
        },
        overview: overviewData?.text || overviewData?.headlineText || '',
        description: {
          headline: overviewData?.headlineText || '',
          body: overviewData?.text || '',
          text: overviewData?.text || '',
          publicTime: overviewData?.reportDatetime || '',
        },
        forecasts,
        link: `https://www.jma.go.jp/bosai/forecast/#area_type=class20&area_code=${cityId}`,
        cached: false,
      };

      if (!options.noCache) setToCache(cacheKey, formatted, CACHE_TTL_WEATHER);
      return formatted;
    }
  } catch (err) {
    // Graceful fallback to tsukumijima weather API
  }

  // 2. フォールバック: tsukumijima weather API
  const url = `https://weather.tsukumijima.net/api/forecast?city=${cityId}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Sora/2.0 (+https://github.com/ikenokazuki/Sora)',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Weather API returned HTTP ${res.status}`);
  }

  const raw: any = await res.json();
  const forecasts = Array.isArray(raw.forecasts) ? raw.forecasts.slice(0, days) : [];

  const formattedResult = {
    source: 'weather',
    cityId,
    title: raw.title,
    publicTime: raw.publicTime,
    publicTimeFormatted: raw.publicTimeFormatted,
    publishingOffice: raw.publishingOffice,
    location: raw.location,
    description: {
      headline: raw.description?.headlineText || '',
      body: raw.description?.bodyText || '',
      text: raw.description?.text || '',
      publicTime: raw.description?.publicTimeFormatted || '',
    },
    forecasts: forecasts.map((f: any) => ({
      date: f.date,
      dateLabel: f.dateLabel,
      telop: f.telop,
      detail: f.detail,
      temperature: {
        min: f.temperature?.min?.celsius ? `${f.temperature.min.celsius}℃` : null,
        max: f.temperature?.max?.celsius ? `${f.temperature.max.celsius}℃` : null,
      },
      chanceOfRain: f.chanceOfRain,
      image: f.image?.url || null,
    })),
    link: raw.link,
    cached: false,
  };

  if (!options.noCache) setToCache(cacheKey, formattedResult, CACHE_TTL_WEATHER);
  return formattedResult;
}
