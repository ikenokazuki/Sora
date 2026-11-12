import { describe, expect, test, beforeEach } from 'bun:test';
import { searchYahooWeb, resetYahooWebPressure, resetYahooBreaker, resetYahooCallGate, yahooWebSearchFlightKey } from './yahoo.js';
import { setYahooSearchCache, clearYahooSearchCache } from '../retrieval/yahoo_cache.js';

beforeEach(() => {
  clearYahooSearchCache();
  resetYahooWebPressure();
  resetYahooBreaker();
  resetYahooCallGate();
  process.env.SORA_YAHOO_MIN_INTERVAL_MS = '0';
});

const err429 = {
  content: [{ text: 'Error: HTTP 429 Too Many Requests for url (https://search.yahoo.co.jp/search?p=x)', type: 'text' }],
  isError: true,
};
const directDown = async () => { throw new Error('direct down'); };
const directEmpty: any = async () => [];

describe('web search distinguishes upstream failure from empty results', () => {
  test('429 on all routes is reported, not silently collapsed', async () => {
    const r = await searchYahooWeb(
      { query: 'x', disableFallback: true },
      { callYahooMcp: async () => err429, fetchYahooWebDirect: directDown } as any,
    );
    expect(r.items).toEqual([]);
    expect(r.count).toBe(0);
    expect(r.providerErrors.length).toBeGreaterThan(0);
    expect(r.providerErrors.map((e: any) => e.message).join('\n')).toContain('429');
  });
  test('genuine empty response carries no provider errors', async () => {
    const r = await searchYahooWeb(
      { query: 'x', disableFallback: true },
      { callYahooMcp: async () => ({ content: [{ text: JSON.stringify({ items: [] }) }], isError: false }), fetchYahooWebDirect: directEmpty } as any,
    );
    expect(r.items).toEqual([]);
    expect(r.providerErrors).toEqual([]);
  });
  test('direct fetch is the primary route and skips the binary', async () => {
    let mcpCalls = 0;
    const r = await searchYahooWeb(
      { query: 'x', disableFallback: true },
      {
        callYahooMcp: async () => { mcpCalls++; return err429; },
        fetchYahooWebDirect: async () => [{ url: 'https://e/d', title: 'D', snippet: 's' }],
      } as any,
    );
    expect(mcpCalls).toBe(0);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].directFetch).toBe(true);
    expect(r.providerErrors ?? []).toEqual([]);
  });
  test('binary is the alternate route when direct fails', async () => {
    const r = await searchYahooWeb(
      { query: 'x', disableFallback: true },
      {
        callYahooMcp: async () => ({ content: [{ text: JSON.stringify({ items: [{ title: 'ok', url: 'https://e/ok' }] }) }], isError: false }),
        fetchYahooWebDirect: directDown,
      } as any,
    );
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.providerErrors.map((e: any) => e.message).join('\n')).toContain('direct down');
  });
  test('rate-limit stops fan-out instead of waiting then retrying', async () => {
    let calls = 0;
    const r = await searchYahooWeb(
      { query: 'ｘ' },
      {
        callYahooMcp: async () => {
          calls++;
          return err429;
        },
        fetchYahooWebDirect: directEmpty,
      } as any,
    );
    expect(calls).toBe(1);
    expect(r.items).toEqual([]);
    expect(r.throttled).toBe(true);
    expect(r.stopReason).toBe('provider_rate_limited');
    expect(r.providerErrors).toHaveLength(1);
  });

  test('fresh cache hit skips the provider', async () => {
    const key = yahooWebSearchFlightKey({ query: 'x', disableFallback: true });
    setYahooSearchCache(key, { items: [{ title: 'cached', url: 'https://e/cached' }], count: 1 });
    const r = await searchYahooWeb(
      { query: 'x', disableFallback: true },
      {
        callYahooMcp: async () => { throw new Error('must not be called'); },
        fetchYahooWebDirect: async () => { throw new Error('must not be called'); },
      } as any,
    );
    expect(r.items).toHaveLength(1);
    expect(r.cached).toBe(true);
  });
  test('throttled search falls back to stale cache', async () => {
    const key = yahooWebSearchFlightKey({ query: 'x', disableFallback: true });
    setYahooSearchCache(key, { items: [{ title: 'stale', url: 'https://e/stale' }], count: 1 }, 0, 60000, Date.now() - 100);
    const r = await searchYahooWeb(
      { query: 'x', disableFallback: true },
      { callYahooMcp: async () => err429, fetchYahooWebDirect: directDown } as any,
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0].title).toBe('stale');
    expect(r.stale).toBe(true);
    expect(r.throttled).toBe(true);
  });
  test('10 concurrent identical searches issue one provider request', async () => {
    let calls = 0;
    const deps = {
      callYahooMcp: async () => { throw new Error('must not be called'); },
      fetchYahooWebDirect: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return [{ url: 'https://e/sf', title: 'SF', snippet: 's' }];
      },
    } as any;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => searchYahooWeb({ query: 'sf probe', disableFallback: true }, deps)),
    );
    expect(calls).toBe(1);
    expect(results.every((r) => r.items.length === 1)).toBe(true);
  });
});
