import { describe, expect, test } from 'bun:test';
import { buildTransitUrl, resolveTransitDateTime, transitCacheKey } from './life.js';
import { TransitRouteRequestSchema } from '../types.js';

describe('transit date/time and cache key', () => {
  test('date/time strings drive the Yahoo query', () => {
    const url = new URL(buildTransitUrl({ from: '東京', to: '新宿', date: '20261005', time: '0930' }));
    expect(['y', 'm', 'd', 'hh', 'm1', 'm2'].map((k) => url.searchParams.get(k))).toEqual(['2026', '10', '05', '09', '3', '0']);
  });

  test('omitted date/time resolve in Asia/Tokyo regardless of server TZ', () => {
    expect(resolveTransitDateTime({ from: 'a', to: 'b' }, new Date('2026-10-03T16:05:00Z')))
      .toEqual({ year: 2026, month: 10, day: 4, hour: 1, minute: 5 });
  });

  test('cache key covers every route condition', () => {
    const base = { from: '東京', to: '新宿', date: '20261005', time: '0930' };
    const variants = [base, { ...base, ticket: 'cash' as const }, { ...base, sortBy: 'fare' as const }, { ...base, useShinkansen: false },
      { ...base, seatPreference: 'green' as const }, { ...base, walkSpeed: 'slow' as const }, { ...base, timeType: 'arrival' as const }];
    expect(new Set(variants.map((o) => transitCacheKey(o))).size).toBe(variants.length);
  });

  test('REST schema documents the same inputs as MCP', () => {
    const parsed = TransitRouteRequestSchema.parse({ from: '東京', to: '新宿', date: '20261005', time: '0930', ticket: 'cash', useShinkansen: false });
    expect(parsed).toMatchObject({ date: '20261005', time: '0930', ticket: 'cash', useShinkansen: false });
    expect(TransitRouteRequestSchema.safeParse({ from: 'a', to: 'b', via: ['1', '2', '3', '4'] }).success).toBe(false);
  });
});
