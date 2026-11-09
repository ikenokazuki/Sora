import { afterEach, describe, expect, test } from 'bun:test';
import { buildTransitUrl, resolveTransitDateTime, transitCacheKey } from './life.js';
import { TransitRouteRequestSchema } from '../types.js';
import { clearCache } from '../cache.js';
import { app } from '../index.js';

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

describe('Yahoo の乗換のフォーム値', () => {
  const param = (opts: Parameters<typeof buildTransitUrl>[0], key: string) => new URL(buildTransitUrl(opts)).searchParams.get(key);
  const base = { from: '東京', to: '新宿' };

  test('sortBy は s に、到着が早い順=0・料金が安い順=1・乗り換え回数順=2 で送る', () => {
    expect(param({ ...base, sortBy: 'time' }, 's')).toBe('0');
    expect(param({ ...base, sortBy: 'fare' }, 's')).toBe('1');
    expect(param({ ...base, sortBy: 'transfer' }, 's')).toBe('2');
    expect(param(base, 's')).toBe('0');
  });

  test('seatPreference は expkind に送り、shin は useShinkansen だけで決まる', () => {
    expect(param({ ...base, seatPreference: 'non_reserved' }, 'expkind')).toBe('1');
    expect(param({ ...base, seatPreference: 'reserved' }, 'expkind')).toBe('2');
    expect(param({ ...base, seatPreference: 'green' }, 'expkind')).toBe('3');
    expect(param(base, 'expkind')).toBe('1');
    for (const seatPreference of ['non_reserved', 'reserved', 'green'] as const) {
      expect(param({ ...base, seatPreference }, 'shin')).toBe('1');
      expect(param({ ...base, seatPreference, useShinkansen: false }, 'shin')).toBe('0');
    }
  });
});

describe('POST /transit/route の検証', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearCache();
  });
  const post = (body: unknown) =>
    app.request('/transit/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  test('MCP と同じスキーマで検証し、通らなければ 400 を返す（外へは出ない）', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('<html></html>'); }) as unknown as typeof fetch;
    for (const body of [
      {},
      { from: '東京' },
      { from: '東京', to: '新宿', via: ['a', 'b', 'c', 'd'] },
      { from: '東京', to: '新宿', sortBy: 'cheapest' },
      { from: '東京', to: '新宿', date: '2026-10-05' },
      { from: '東京', to: '新宿', hour: 25 },
      { from: '東京', to: '新宿', month: 13 },
      { from: 123, to: '新宿' },
    ]) {
      const res = await post(body);
      expect([res.status, JSON.stringify(body)]).toEqual([400, JSON.stringify(body)]);
    }
    expect((await post('{not json')).status).toBe(400);
    expect(calls).toBe(0);
  });

  test('null の項目は指定なしとして扱い、null の from は欠けとして 400 にする', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL) => { requested.push(String(input)); return new Response('<html></html>'); }) as unknown as typeof fetch;
    const res = await post({ from: '東京', to: '新宿', via: null, date: null, time: null, sortBy: null, useShinkansen: null });
    expect(res.status).toBe(200);
    expect(new URL(requested[0]).searchParams.get('from')).toBe('東京');
    expect((await post({ from: null, to: '新宿' })).status).toBe(400);
    expect(requested).toHaveLength(1);
  });

  test('REST だけが受けていた year・month・day・hour・minute は残り、日時として使われる', async () => {
    let requested = '';
    globalThis.fetch = (async (input: string | URL) => { requested = String(input); return new Response('<html></html>'); }) as unknown as typeof fetch;
    const res = await post({ from: '東京', to: '新宿', via: ['品川'], year: 2026, month: 12, day: 3, hour: 7, minute: 45, sortBy: 'fare', seatPreference: 'green' });
    expect(res.status).toBe(200);
    const q = new URL(requested).searchParams;
    expect(['y', 'm', 'd', 'hh', 'm1', 'm2', 'via1', 's', 'expkind'].map((k) => q.get(k))).toEqual(['2026', '12', '03', '07', '4', '5', '品川', '1', '3']);
  });
});
