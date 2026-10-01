import { afterEach, describe, expect, test } from 'bun:test';
import { createHotelService, type HotelFetchFn } from './index.js';
import { TOKYO_DS } from './fixtures/ds.js';
import type { HotelSearchInput } from './types.js';

const FLAG = 'SORA_RAKUTEN_TRAVEL_ENABLED';
const savedFlag = process.env[FLAG];
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});
const enable = () => {
  process.env[FLAG] = 'true';
};

const input = (overrides: Partial<HotelSearchInput> = {}): HotelSearchInput => ({
  location: '東京駅',
  checkIn: '2026-10-20',
  checkOut: '2026-10-21',
  adults: 2,
  rooms: 1,
  limit: 5,
  ...overrides,
});

const htmlWith = (ds: unknown) =>
  '<html><head><script>var ds = ' + JSON.stringify(ds) + ';</script></head><body></body></html>';

const okFetch = (calls: string[]): HotelFetchFn => async (url) => {
  calls.push(url);
  return { status: 200, headers: { get: () => null }, text: async () => htmlWith(TOKYO_DS) };
};

const context = (ms = 5000) => {
  const controller = new AbortController();
  return { context: { signal: controller.signal, deadlineAt: Date.now() + ms }, controller };
};

describe('searchHotelAvailability', () => {
  test('makes zero requests when the flag is off', async () => {
    delete process.env[FLAG];
    const calls: string[] = [];
    const service = createHotelService({ fetchImpl: okFetch(calls), minIntervalMs: 1 });
    const result = await service.searchHotelAvailability(input(), context().context);
    expect(result.status).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  test('makes zero requests for invalid input, past dates, and unknown locations', async () => {
    enable();
    const calls: string[] = [];
    const service = createHotelService({ fetchImpl: okFetch(calls), minIntervalMs: 1 });
    for (const bad of [
      input({ checkIn: '2026-02-30' }),
      input({ checkIn: '2000-01-01', checkOut: '2000-01-02' }),
      input({ location: '大阪' }),
    ]) {
      const result = await service.searchHotelAvailability(bad, context().context);
      expect(result.status).toBe('unavailable');
    }
    expect(calls).toHaveLength(0);
  });

  test('returns dated hotels from one upstream request', async () => {
    enable();
    const calls: string[] = [];
    const service = createHotelService({ fetchImpl: okFetch(calls), minIntervalMs: 1 });
    const result = await service.searchHotelAvailability(input(), context().context);
    expect(result.status).toBe('ok');
    expect(result.hotels.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('f_otona_su=2');
  });

  test('stops on 429 and suppresses the next request', async () => {
    enable();
    const calls: string[] = [];
    const fetch429: HotelFetchFn = async (url) => {
      calls.push(url);
      return { status: 429, headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '1' : null) }, text: async () => '' };
    };
    const service = createHotelService({ fetchImpl: fetch429, minIntervalMs: 1 });
    const first = await service.searchHotelAvailability(input(), context().context);
    expect(first.status).toBe('unavailable');
    expect(first.failures[0].code).toBe('RATE_LIMITED');
    const second = await service.searchHotelAvailability(input(), context().context);
    expect(second.failures[0].code).toBe('RATE_LIMITED');
    expect(calls).toHaveLength(1);
  });

  test('classifies 403, 500, and timeouts without retrying', async () => {
    enable();
    for (const [status, code] of [
      [403, 'ACCESS_DENIED'],
      [500, 'UPSTREAM_ERROR'],
    ] as const) {
      const calls: string[] = [];
      const service = createHotelService({
        fetchImpl: async (url) => {
          calls.push(url);
          return { status, headers: { get: () => null }, text: async () => '' };
        },
        minIntervalMs: 1,
      });
      const result = await service.searchHotelAvailability(input(), context().context);
      expect(result.failures[0].code).toBe(code);
      expect(calls).toHaveLength(1);
    }
    const hanging: HotelFetchFn = () => new Promise(() => {});
    const slow = createHotelService({ fetchImpl: hanging, minIntervalMs: 1 });
    const timedOut = await slow.searchHotelAvailability(input(), context(40).context);
    expect(timedOut.failures[0].code).toBe('TIMEOUT');
  });

  test('aborts only the leaving caller while the other still completes', async () => {
    enable();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = createHotelService({
      fetchImpl: async () => {
        await gate;
        return { status: 200, headers: { get: () => null }, text: async () => htmlWith(TOKYO_DS) };
      },
      minIntervalMs: 1,
    });
    const first = context();
    const second = context();
    const pending = [
      service.searchHotelAvailability(input(), first.context),
      service.searchHotelAvailability(input(), second.context),
    ];
    first.controller.abort();
    release();
    const [left, stayed] = await Promise.all(pending);
    expect(left.failures[0].code).toBe('TIMEOUT');
    expect(stayed.status).toBe('ok');
  });

  test('merges simultaneous identical requests into one upstream call', async () => {
    enable();
    const calls: string[] = [];
    const service = createHotelService({ fetchImpl: okFetch(calls), minIntervalMs: 1 });
    const [a, b] = await Promise.all([
      service.searchHotelAvailability(input(), context().context),
      service.searchHotelAvailability(input(), context().context),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  test('serializes different conditions with spacing and honors queue deadlines', async () => {
    enable();
    const calls: string[] = [];
    const service = createHotelService({ fetchImpl: okFetch(calls), minIntervalMs: 60 });
    const started = Date.now();
    const [a, b] = await Promise.all([
      service.searchHotelAvailability(input(), context().context),
      service.searchHotelAvailability(input({ limit: 3 }), context().context),
    ]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);

    const slowCalls: string[] = [];
    const slow = createHotelService({
      fetchImpl: async (url) => {
        slowCalls.push(url);
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { status: 200, headers: { get: () => null }, text: async () => htmlWith(TOKYO_DS) };
      },
      minIntervalMs: 1,
    });
    const firstPending = slow.searchHotelAvailability(input(), context().context);
    const expired = await slow.searchHotelAvailability(input({ adults: 1 }), context(30).context);
    expect(expired.failures[0].code).toBe('TIMEOUT');
    expect(slowCalls).toHaveLength(1);
    await firstPending;
  });

});
