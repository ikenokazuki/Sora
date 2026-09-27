import { describe, expect, test, beforeEach } from 'bun:test';
import { searchYahooWeb, resetYahooWebPressure, resetYahooBreaker, resetYahooCallGate } from './yahoo.js';

beforeEach(() => {
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
  test('union path also records upstream failure', async () => {
    process.env.SORA_WEB_QUERY_UNION = 'true';
    try {
      const r = await searchYahooWeb(
        { query: 'x' },
        { callYahooMcp: async () => err429, fetchYahooWebDirect: directDown } as any,
      );
      expect(r.queryUnion).toBe(true);
      expect(r.providerErrors.length).toBeGreaterThan(0);
    } finally {
      delete process.env.SORA_WEB_QUERY_UNION;
    }
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
    process.env.SORA_WEB_QUERY_UNION = 'true';
    let calls = 0;
    try {
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
    } finally {
      delete process.env.SORA_WEB_QUERY_UNION;
    }
  });
  test('deprecated retry-wait env does not re-enable fan-out after 429', async () => {
    process.env.SORA_WEB_QUERY_UNION = 'true';
    process.env.SORA_WEB_RETRY_WAIT_MS = '0';
    let calls = 0;
    try {
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
      expect(r.throttled).toBe(true);
    } finally {
      delete process.env.SORA_WEB_QUERY_UNION;
      delete process.env.SORA_WEB_RETRY_WAIT_MS;
    }
  });

  test('Q0 success survives Q1 rate-limit as partial results', async () => {
    process.env.SORA_WEB_QUERY_UNION = 'true';
    const rateErr: any = new Error('Yahoo provider rate limited');
    rateErr.code = 'YAHOO_RATE_LIMITED';
    const ten = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `https://e/${i}` }));
    let calls = 0;
    try {
      const r = await searchYahooWeb(
        { query: 'ｘ' },
        {
          callYahooMcp: async () => {
            calls++;
            if (calls === 1) return { content: [{ text: JSON.stringify({ items: ten }) }], isError: false };
            throw rateErr;
          },
          fetchYahooWebDirect: directEmpty,
        } as any,
      );
      expect(calls).toBe(2);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.partial).toBe(true);
      expect(r.throttled).toBe(true);
      expect(r.stopReason).toBe('provider_rate_limited');
    } finally {
      delete process.env.SORA_WEB_QUERY_UNION;
    }
  });
});
