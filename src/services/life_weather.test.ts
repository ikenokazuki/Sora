import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AreaInputError, fetchWeatherForecast, prefectureOf, resolveCityId, resolveMunicipality } from './life.js';
import { clearCache } from '../cache.js';
import { app } from '../index.js';
import { JMA_CLASS20 } from '../jma_areas.js';
import { createMcpServer } from '../mcp.js';
import { installExternalApiFixtures } from '../test_fixtures/external_apis.js';
import JMA_FORECASTS from '../test_fixtures/jma_forecast_excerpt.json';

describe('Weather Forecast Service (JMA Weekly Integration)', () => {
  // 気象庁の応答は固定データ（SORA_LIVE_TESTS=1 では本物の API）
  let restore: (() => void) | undefined;
  beforeAll(() => {
    if (!process.env.SORA_LIVE_TESTS) restore = installExternalApiFixtures();
  });
  afterAll(() => restore?.());

  it('should resolve Yamanakako to 190020', () => {
    expect(resolveCityId('山中湖')).toBe('190020');
    expect(resolveCityId('山中湖村')).toBe('190020');
  });

  it('should build a 7-day forecast for Yamanakako from the JMA short-term and weekly forecasts', async () => {
    const result = await fetchWeatherForecast({ city: '山中湖', days: 7, noCache: true });

    expect(result.source).toBe('weather');
    expect(result.cityId).toBe('190020');
    expect(result.title).toContain('東部・富士五湖');
    expect(result.publishingOffice).toBe('甲府地方気象台');
    expect(result.forecasts).toBeDefined();
    expect(result.forecasts.length).toBe(7);

    // 今日・明日
    expect(result.forecasts[0].dateLabel).toBe('今日');
    expect(result.forecasts[1].dateLabel).toBe('明日');

    // 4日目以降の週間予報
    const day5 = result.forecasts[4];
    expect(day5).toBeDefined();
    expect(day5.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(day5.telop).toBeDefined();
    expect(day5.chanceOfRain).toBeDefined();
    expect(day5.temperature).toBeDefined();

    // 6日目 (2026-09-21 等)
    const day6 = result.forecasts[5];
    expect(day6).toBeDefined();
    expect(day6.telop).toBeDefined();
    expect(day6.image).toContain('jma.go.jp/bosai/forecast/img/');
  });

  it('should support up to 8 days of forecasts', async () => {
    const result = await fetchWeatherForecast({ city: '東京', days: 8, noCache: true });
    // JMA週間予報の提供日数は発表時刻により7〜8日で変動するため上限のみ検証する
    expect(result.forecasts.length).toBeLessThanOrEqual(8);
    expect(result.forecasts.length).toBeGreaterThanOrEqual(7);
  });

  it('should clamp days between 1 and 8', async () => {
    const minResult = await fetchWeatherForecast({ city: '東京', days: 0, noCache: true });
    expect(minResult.forecasts.length).toBe(1);

    const maxResult = await fetchWeatherForecast({ city: '東京', days: 100, noCache: true });
    expect(maxResult.forecasts.length).toBeLessThanOrEqual(8);
    expect(maxResult.forecasts.length).toBeGreaterThanOrEqual(7);
  });
});

describe('get_weather: 気象台・地名・気温の地点・キャッシュ', () => {
  // 論理を確かめるので、SORA_LIVE_TESTS でも固定応答を使う
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = installExternalApiFixtures();
  });
  afterAll(() => restore?.());

  it('那覇は沖縄本島地方の気象台（471000）の予報を引く', async () => {
    const result = await fetchWeatherForecast({ city: '那覇', days: 1, noCache: true });
    expect(result.cityId).toBe('471010');
    expect(result.publishingOffice).toBe('沖縄気象台');
    expect(result.title).toBe('本島中南部 の天気');
  });

  it('札幌は石狩・空知・後志地方の気象台（016000）の予報を引く', async () => {
    const result = await fetchWeatherForecast({ city: '札幌', days: 1, noCache: true });
    expect(result.cityId).toBe('016010');
    expect(result.publishingOffice).toBe('札幌管区気象台');
  });

  it('知らない地名は東京にせずエラーにする', async () => {
    await expect(fetchWeatherForecast({ city: 'ほげほげ', noCache: true })).rejects.toThrow('地名「ほげほげ」が見つかりません');
    await expect(fetchWeatherForecast({ city: '999999', noCache: true })).rejects.toThrow('999999');
  });

  it('city_map の完全一致で引けない名前は、部分一致より先に市町村の表から予報区を引く', () => {
    // 部分一致だと "森町"（city_map では北海道）に当たる
    expect(resolveCityId('静岡県森町')).toBe('220040');
    expect(resolveCityId('北海道森町')).toBe('017010');
  });

  it('郡の付いた住所は郡を外した町村で引き、小郡市・郡山市・郡上市はそのまま', () => {
    const cases: Array<[string, string]> = [
      ['北海道上川郡上川町', '012010'], ['北海道上川郡清水町', '014030'], ['北海道樺戸郡新十津川町', '016020'], ['北海道檜山郡上ノ国町', '017020'],
      ['沖縄県八重山郡竹富町', '474010'], ['静岡県周智郡森町', '220040'], ['北海道茅部郡森町', '017010'], ['静岡県駿東郡清水町', '220030'],
      ['長野県北佐久郡軽井沢町', '200020'], ['群馬県吾妻郡草津町', '100020'], ['神奈川県足柄下郡箱根町', '140020'],
    ];
    expect(cases.filter(([q, want]) => resolveCityId(q) !== want)).toEqual([]);
    expect(resolveMunicipality('福岡県小郡市')?.name).toBe('小郡市');
    expect(resolveMunicipality('郡山市')?.name).toBe('郡山市');
    expect(resolveMunicipality('岐阜県郡上市')?.name).toBe('郡上市');
  });

  it('気象庁のすべての町村を「都道府県名+郡+町村名」で引くと、その町村の予報区になる（決まらないものは候補を挙げる）', () => {
    const wrong: string[] = [];
    let n = 0;
    for (const [name, towns] of Object.entries(JMA_CLASS20)) {
      if (!/[町村]$/.test(name)) continue;
      for (const t of towns) {
        n++;
        const q = `${prefectureOf(t.code)}某郡${name}`;
        try {
          if (resolveCityId(q) !== t.class10) wrong.push(`${q} → ${resolveCityId(q)}（正しくは ${t.class10}）`);
        } catch (err) {
          if (!(err instanceof AreaInputError)) throw err;
        }
      }
    }
    expect(n).toBeGreaterThan(900);
    expect(wrong).toEqual([]);
  });

  it('先頭が都道府県名なら、部分一致もその都道府県の地名に限る', () => {
    expect(prefectureOf(resolveCityId('沖縄県ほげほげ清水'))).toBe('沖縄県');
  });

  it('北海道（気象台が複数あり city_map に無い）は、予報区の番号と名前を挙げたエラー', async () => {
    expect(() => resolveCityId('北海道')).toThrow(/014030（十勝地方）.*016010（石狩地方）/);
    const res = await app.request('/weather', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: '北海道' }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('016010（石狩地方）');
  });

  it('都道府県名と気温の地点の名前は、市町村の表より先に city_map の予報区になる', () => {
    expect(resolveCityId('石川')).toBe('170010');
    expect(resolveCityId('岩手')).toBe('030010');
    expect(resolveCityId('茨城')).toBe('080010');
    expect(resolveCityId('八幡')).toBe('400020');
    expect(resolveCityId('西郷')).toBe('320030');
    expect(resolveCityId('横浜')).toBe('140010');
    // 地点でも都道府県でもない名前が複数の市町村に当たれば、候補を挙げる
    expect(() => resolveCityId('川崎')).toThrow(/神奈川県川崎市、宮城県川崎町、福岡県川崎町/);
  });

  it('気温は予報区の表の地点の名前で選ぶ（並びが予報区と違う気象台がある）', async () => {
    const yonezawa = await fetchWeatherForecast({ city: '米沢', days: 1, noCache: true });
    expect(yonezawa.cityId).toBe('060020');
    expect(yonezawa.temperatureArea).toBe('米沢');
  });

  it('十勝地方は予報の JSON を出す釧路地方気象台（014100）から引く', async () => {
    const obihiro = await fetchWeatherForecast({ city: '帯広', days: 1, noCache: true });
    expect(obihiro.cityId).toBe('014030');
    expect(obihiro.publishingOffice).toBe('釧路地方気象台');
    expect(obihiro.temperatureArea).toBe('帯広');
  });

  it('区域に分かれた市は、区域を合わせた 1 つの市町村にする', () => {
    expect(resolveMunicipality('横浜市中区')).toMatchObject({ name: '横浜市', codes: ['1410011', '1410012'], class10: '140010' });
    // 市の名前そのままの区域（郡山市）と郡山市湖南
    expect(resolveMunicipality('郡山市')?.codes).toEqual(['0720301', '0720302']);
    expect(() => resolveMunicipality('伊達市')).toThrow(/福島県伊達市、北海道伊達市/);
    expect(resolveMunicipality('北海道伊達市')?.codes).toEqual(['0123301', '0123302']);
    expect(resolveCityId('仙台市青葉区')).toBe('040010');
  });

  it('気温は予報区と同じ位置の地点を使い、地点の名前を返す', async () => {
    const kitakyushu = await fetchWeatherForecast({ city: '北九州', days: 2, noCache: true });
    expect(kitakyushu.cityId).toBe('400020');
    expect(kitakyushu.temperatureArea).toBe('八幡');
    expect(kitakyushu.forecasts[0].temperature).toEqual({ min: '17℃', max: '26℃' });
    const fukuoka = await fetchWeatherForecast({ city: '福岡', days: 2, noCache: true });
    expect(fukuoka.temperatureArea).toBe('福岡');
    expect(fukuoka.forecasts[0].temperature).toEqual({ min: '18℃', max: '27℃' });
    // 地点が 1 つの気象台は、今までどおり最初の地点
    const izu = await fetchWeatherForecast({ city: '130020', days: 1, noCache: true });
    expect(izu.temperatureArea).toBe('代表地点');
  });

  it('キャッシュから返すときも、今の入力の地名を付ける', async () => {
    clearCache();
    const first = await fetchWeatherForecast({ city: '東京', days: 3 });
    const second = await fetchWeatherForecast({ city: '東京都', days: 3 });
    expect(first.location.city).toBe('東京');
    expect(second.cached).toBe(true);
    expect(second.cityId).toBe(first.cityId);
    expect(second.location.city).toBe('東京都');
  });
});

/**
 * 気象庁 forecast/{気象台}.json（2026-11-05 19 時の発表をそのまま）。週間予報（[1]）の地域は、予報区をまとめたもの（"中部・南部"・
 * "下北・三八上北"）や気象台の範囲（"鹿児島県（奄美地方除く）"）で、気温の地点は地域ごとに 1 つ（地域と同じ並び）
 */
describe('get_weather の週間予報は、その予報区を含む地域の天気と地点の気温を使う', () => {
  let original: typeof fetch;
  beforeAll(() => {
    original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const office = url.pathname.match(/^\/bosai\/forecast\/data\/forecast\/(\d+)\.json$/)?.[1];
      const body = office ? (JMA_FORECASTS as Record<string, unknown>)[office] : undefined;
      return body ? Response.json(body) : new Response('Not Found', { status: 404 });
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = original;
  });
  /** 3 日目以降（週間予報から足した日）の [日付, 天気の番号, 降水確率, 最低, 最高] */
  const week = async (city: string) =>
    (await fetchWeatherForecast({ city, days: 8, noCache: true })).forecasts
      .slice(3)
      .map((f: any) => [f.date, f.image.match(/(\d+)\.svg$/)?.[1], f.chanceOfRain.allDay, f.temperature.min, f.temperature.max]);

  it('長野県中部（松本）は「中部・南部」の天気と松本の気温（北部・長野のものにしない）。地点が週間予報に無い南部（飯田）も同じ地域の松本', async () => {
    const matsumoto = [
      ['2026-11-08', '101', '20%', '2℃', '12℃'], ['2026-11-09', '201', '40%', '5℃', '14℃'], ['2026-11-10', '201', '30%', '1℃', '10℃'],
      ['2026-11-11', '101', '20%', '1℃', '13℃'], ['2026-11-12', '101', '20%', '3℃', '14℃'],
    ];
    expect(await week('松本')).toEqual(matsumoto);
    expect(await week('軽井沢')).toEqual(matsumoto);
    expect(await week('飯田')).toEqual(matsumoto);
  });

  it('青森県下北（むつ）は「下北・三八上北」の天気と、その地域の地点（八戸）の気温（津軽・青森のものにしない）', async () => {
    const shimokita = [
      ['2026-11-08', '260', '50%', '2℃', '8℃'], ['2026-11-09', '260', '50%', '2℃', '8℃'], ['2026-11-10', '200', '40%', '1℃', '8℃'],
      ['2026-11-11', '200', '40%', '2℃', '12℃'], ['2026-11-12', '101', '20%', '4℃', '12℃'],
    ];
    expect(await week('むつ')).toEqual(shimokita);
    expect(await week('八戸')).toEqual(shimokita);
  });

  it('伊豆諸島・小笠原は東京の気温にせず、それぞれの地点（大島・父島）の気温', async () => {
    expect((await week('大島')).map((d: unknown[]) => d.slice(3))).toEqual([['12℃', '17℃'], ['12℃', '16℃'], ['11℃', '15℃'], ['10℃', '17℃'], ['11℃', '19℃']]);
    expect((await week('父島')).map((d: unknown[]) => d.slice(3))).toEqual([['23℃', '27℃'], ['23℃', '27℃'], ['22℃', '27℃'], ['22℃', '25℃'], ['23℃', '26℃']]);
  });

  it('奄美地方は「鹿児島県（奄美地方除く）」ではなく奄美地方の天気と名瀬の気温', async () => {
    expect(await week('名瀬')).toEqual([
      ['2026-11-08', '201', '20%', '19℃', '25℃'], ['2026-11-09', '200', '40%', '19℃', '25℃'], ['2026-11-10', '200', '40%', '19℃', '23℃'],
      ['2026-11-11', '201', '30%', '18℃', '23℃'], ['2026-11-12', '201', '30%', '18℃', '24℃'],
    ]);
  });
});

describe('REST /weather の入力の検証', () => {
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = installExternalApiFixtures();
  });
  afterAll(() => restore?.());

  const post = (body: unknown) =>
    app.request('/weather', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('POST の days は MCP と同じ 1〜8 の整数だけを受ける', async () => {
    for (const days of [0, 100, 'abc', 2.5]) expect((await post({ city: '東京', days })).status).toBe(400);
    const ok = await post({ city: '東京', days: 2, noCache: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).forecasts.length).toBe(2);
  });

  it('POST の null の項目は指定なしとして扱い、null の city は欠けとして 400 にする', async () => {
    const ok = await post({ city: '東京', days: null, noCache: null });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).forecasts.length).toBe(7);
    expect((await post({ city: null, days: 2 })).status).toBe(400);
  });

  it('GET の days も同じ範囲で確かめる', async () => {
    expect((await app.request('/weather?city=%E6%9D%B1%E4%BA%AC&days=0')).status).toBe(400);
    expect((await app.request('/weather/%E6%9D%B1%E4%BA%AC?days=abc')).status).toBe(400);
    expect((await app.request('/weather/%E6%9D%B1%E4%BA%AC?days=2&noCache=true')).status).toBe(200);
  });

  it('知らない地名は 400 で返す', async () => {
    const res = await post({ city: 'ほげほげ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('地名「ほげほげ」が見つかりません');
  });

  it('空白だけの city は 400（部分一致で別の地域にしない）。MCP も検証エラー', async () => {
    expect((await post({ city: ' ' })).status).toBe(400);
    expect((await app.request('/weather/%20')).status).toBe(400);
    expect((await app.request('/weather?city=%20')).status).toBe(400);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'weather-blank-city', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      expect((await client.callTool({ name: 'get_weather', arguments: { city: ' ' } })).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
