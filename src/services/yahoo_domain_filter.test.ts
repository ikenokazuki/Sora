import { beforeEach, describe, expect, test } from 'bun:test';
import { clearYahooSearchCache } from '../retrieval/yahoo_cache.js';
import { buildSearchWebCacheKey } from '../search_web_formats.js';
import { normalizeDomainList, resetYahooBreaker, resetYahooCallGate, resetYahooWebPressure, searchYahooWeb, yahooWebSearchFlightKey } from './yahoo.js';

beforeEach(() => {
  clearYahooSearchCache();
  resetYahooWebPressure();
  resetYahooBreaker();
  resetYahooCallGate();
  process.env.SORA_YAHOO_MIN_INTERVAL_MS = '0';
});

const item = { title: 'ライブ予定', url: 'https://example.com/live', snippet: '予定一覧' };
const recorder = () => {
  const calls: Array<{ query: string; opts: any }> = [];
  const fetchYahooWebDirect: any = async (query: string, _n: number, _x: unknown, opts: any) => { calls.push({ query, opts }); return [item]; };
  const callYahooMcp: any = async () => ({ content: [{ text: JSON.stringify({ items: [item] }) }], isError: false });
  return { calls, deps: { callYahooMcp, fetchYahooWebDirect } as any };
};

describe('normalizeDomainList', () => {
  test('drops empty and whitespace-only entries, trims and de-duplicates', () => {
    expect(normalizeDomainList([''])).toBeUndefined();
    expect(normalizeDomainList(['', '   '])).toBeUndefined();
    expect(normalizeDomainList(undefined)).toBeUndefined();
    expect(normalizeDomainList(['  natalie.mu ', '', 'natalie.mu', 'oricon.co.jp'])).toEqual(['natalie.mu', 'oricon.co.jp']);
  });
});

describe('web search ignores empty domain filters (API docs "Try it" sends [""])', () => {
  test('includeDomains [""] does not add "site:" and does not collapse the result set', async () => {
    const { calls, deps } = recorder();
    const r = await searchYahooWeb({ query: '=LOVE ライブ 予定', includeDomains: [''], excludeDomains: [''], disableFallback: true, noCache: true }, deps);
    expect(r.items.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.query).not.toContain('site:');
      expect(c.opts?.includeDomains).toBeUndefined();
    }
  });

  test('a real domain filter still applies', async () => {
    const { calls, deps } = recorder();
    await searchYahooWeb({ query: 'ライブ', includeDomains: ['', ' example.com '], disableFallback: true, noCache: true }, deps);
    expect(calls.some((c) => c.query.includes('site:example.com') || (c.opts?.includeDomains ?? []).includes('example.com'))).toBe(true);
  });

  test('cache keys do not distinguish [""] from an absent filter', () => {
    expect(yahooWebSearchFlightKey({ query: 'q', includeDomains: [''], excludeDomains: [''] })).toBe(yahooWebSearchFlightKey({ query: 'q' }));
    expect(buildSearchWebCacheKey({ query: 'q', includeDomains: [''] } as any)).toBe(buildSearchWebCacheKey({ query: 'q' } as any));
  });
});
