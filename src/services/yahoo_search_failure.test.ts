import { describe, expect, test } from 'bun:test';
import { searchYahooWeb } from './yahoo.js';

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
  test('rate-limit failure waits once (bounded) before the next candidate', async () => {
    process.env.SORA_WEB_QUERY_UNION = 'true';
    process.env.SORA_WEB_RETRY_WAIT_MS = '60';
    let calls = 0;
    try {
      const t0 = Date.now();
      const r = await searchYahooWeb(
        { query: 'ｘ' },
        {
          callYahooMcp: async () => {
            calls++;
            if (calls === 1) return err429;
            return { content: [{ text: JSON.stringify({ items: [{ title: 'ok', url: 'https://e/ok' }] }) }], isError: false };
          },
          fetchYahooWebDirect: directEmpty,
        } as any,
      );
      expect(calls).toBe(2);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.providerErrors).toHaveLength(1);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    } finally {
      delete process.env.SORA_WEB_QUERY_UNION;
      delete process.env.SORA_WEB_RETRY_WAIT_MS;
    }
  });
  test('retry wait can be disabled', async () => {
    process.env.SORA_WEB_QUERY_UNION = 'true';
    process.env.SORA_WEB_RETRY_WAIT_MS = '0';
    let calls = 0;
    try {
      const r = await searchYahooWeb(
        { query: 'ｘ' },
        {
          callYahooMcp: async () => {
            calls++;
            if (calls === 1) return err429;
            return { content: [{ text: JSON.stringify({ items: [{ title: 'ok', url: 'https://e/ok' }] }) }], isError: false };
          },
          fetchYahooWebDirect: directEmpty,
        } as any,
      );
      expect(calls).toBe(2);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.providerErrors).toHaveLength(1);
    } finally {
      delete process.env.SORA_WEB_QUERY_UNION;
      delete process.env.SORA_WEB_RETRY_WAIT_MS;
    }
  });
});
