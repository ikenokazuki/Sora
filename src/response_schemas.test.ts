import { describe, expect, test } from 'bun:test';
import {
  EarthquakeSearchResultSchema, ImageSearchResponseSchema, SuggestResponseSchema, VideoSearchResponseSchema,
  WatchCheckResponseSchema, WatchTargetRecordSchema, WeatherDayForecastSchema,
} from './types.js';
import { normalizeYahooMediaItems } from './services/yahoo.js';

const image = { ok: true, provider: 'yahoo', vertical: 'image', query: '東京タワー', page: 1, count: 1, next_page: 2, related_queries: [], source: 'image',
  items: [{ id: 'c9d5', title: '東京タワー', file_format: 'jpeg', source_site: 'www.tokyotower.co.jp', source_url: 'https://www.tokyotower.co.jp/',
    original: { url: 'https://www.tokyotower.co.jp/a.jpg', width: 1000, height: 1000 }, thumbnail: { url: 'https://msp.c.yimg.jp/t', width: 225, height: 225 },
    cached: { url: 'https://msp.c.yimg.jp/c', width: 1000, height: 1000 } }] };
const video = { ok: true, provider: 'yahoo', vertical: 'video', query: '東京タワー', page: 1, count: 1,
  items: [{ id: 'd255', title: '東京タワー公式チャンネル - YouTube', url: 'https://www.youtube.com/channel/x', duration: '0:11', summary: 's',
    thumbnail: 'https://s.yimg.jp/t', upload_date: '6日前', uploader: '東京タワー公式チャンネル', source: 'YouTube' }] };

describe('documented responses match actual payloads', () => {
  test('image search', () => {
    expect(ImageSearchResponseSchema.safeParse(normalizeYahooMediaItems(structuredClone(image), 'image')).success).toBe(true);
  });

  test('video search keeps the platform and reports source "video"', () => {
    const out = normalizeYahooMediaItems(structuredClone(video), 'video');
    expect(out.items[0]).toMatchObject({ source: 'video', platform: 'YouTube' });
    expect(VideoSearchResponseSchema.safeParse(out).success).toBe(true);
  });

  test('suggestions are objects', () => {
    const suggest = { ok: true, provider: 'yahoo', vertical: 'suggest', query: '東京タワー', count: 1, source: 'suggest',
      suggestions: [{ keyword: '東京タワー ライトアップ', search_url: 'https://search.yahoo.co.jp/search?p=x' }] };
    expect(SuggestResponseSchema.safeParse(suggest).success).toBe(true);
  });

  test('weekly weather days have no detail block', () => {
    const day = { date: '2026-10-06', dateLabel: '4日後', telop: '晴れ', reliability: 'A', temperature: { min: '18℃', max: '26℃' },
      chanceOfRain: { allDay: '10%', T00_06: '10%', T06_12: '10%', T12_18: '10%', T18_24: '10%' }, image: 'https://www.jma.go.jp/bosai/forecast/img/100.svg' };
    expect(WeatherDayForecastSchema.safeParse(day).success).toBe(true);
  });

  test('earthquake result uses the earthquakes array', () => {
    expect(EarthquakeSearchResultSchema.safeParse({ count: 0, earthquakes: [] }).success).toBe(true);
  });

  test('watch check returns one result or an array, and stored targets may hold null', () => {
    const one = { targetId: 'wt_1', url: 'https://example.com', changed: false, currentHash: 'h', checkedAt: '2026-10-03T00:00:00Z' };
    expect(WatchCheckResponseSchema.safeParse({ result: one }).success).toBe(true);
    expect(WatchCheckResponseSchema.safeParse({ results: [one] }).success).toBe(true);
    const target = { id: 'wt_1', url: 'https://example.com', title: null, selector: null, last_hash: null, last_content: null, webhook_url: null,
      interval_seconds: 3600, last_checked_at: null, created_at: 1 };
    expect(WatchTargetRecordSchema.safeParse(target).success).toBe(true);
  });
});
