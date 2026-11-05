import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fetchWeatherForecast, resolveCityId } from './life.js';
import { clearCache } from '../cache.js';
import { app } from '../index.js';
import { installExternalApiFixtures } from '../test_fixtures/external_apis.js';

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
});
