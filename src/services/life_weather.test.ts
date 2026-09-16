import { describe, expect, it } from 'bun:test';
import { fetchWeatherForecast, resolveCityId } from './life.js';

describe('Weather Forecast Service (JMA Weekly Integration)', () => {
  it('should resolve Yamanakako to 190020', () => {
    expect(resolveCityId('山中湖')).toBe('190020');
    expect(resolveCityId('山中湖村')).toBe('190020');
  });

  it('should fetch 7-day forecast for Yamanakako from JMA official API', async () => {
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
    expect(result.forecasts.length).toBe(8);
  });

  it('should clamp days between 1 and 8', async () => {
    const minResult = await fetchWeatherForecast({ city: '東京', days: 0, noCache: true });
    expect(minResult.forecasts.length).toBe(1);

    const maxResult = await fetchWeatherForecast({ city: '東京', days: 100, noCache: true });
    expect(maxResult.forecasts.length).toBe(8);
  });
});
