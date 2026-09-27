import { afterEach, expect, test, spyOn } from 'bun:test';
import account from '../test/fixtures/yahoo-realtime/account.json';
import { app } from './index.js';
import { buildRealtimeSearchCacheKey, searchYahooRealtime } from './services/yahoo.js';
import * as httpFetcher from './http_fetcher.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('separates different URL and OR constraints in the realtime cache', () => {
  const key = buildRealtimeSearchCacheKey;
  expect(key({ query: '告知', url: 'a.example' }))
    .not.toBe(key({ query: '告知', url: 'b.example' }));
  expect(key({ query: '告知', orWords: ['出演', '辞退'] }))
    .not.toBe(key({ query: '告知', orWords: ['出演', '中止'] }));
  expect(key({ query: '告知', sort: 'recent' }))
    .not.toBe(key({ query: '告知', sort: 'popular' }));
  expect(key({ query: '告知', limit: 5 }))
    .not.toBe(key({ query: '告知', limit: 6 }));
  expect(key({ query: '告知', page: 1 }))
    .not.toBe(key({ query: '告知', page: 2 }));
});

test('accepts url-only, orWords-only, and account-only inputs', async () => {
  const seen: string[] = [];
  const mcp = (async (_tool: string, args: Record<string, any>) => {
    seen.push(args.query);
    return { items: [] };
  }) as any;
  await searchYahooRealtime({ url: 'x.com', detailEnrichment: false, _callMcp: mcp } as any);
  expect(seen[0]).toBe('URL:x.com');
  await searchYahooRealtime({ orWords: ['出演', '辞退'], detailEnrichment: false, _callMcp: mcp } as any);
  expect(seen[1]).toBe('(出演 辞退)');
  await searchYahooRealtime({ accountId: 'kimisora_JPN', detailEnrichment: false, _callMcp: mcp } as any);
  expect(seen[2]).toBe('id:kimisora_JPN');
});

test('rejects invalid realtime inputs', async () => {
  const mcp = (async () => ({ items: [] })) as any;
  await expect(searchYahooRealtime({ query: 'SPARK', limit: 0, _callMcp: mcp } as any)).rejects.toThrow();
  await expect(searchYahooRealtime({ query: 'SPARK', limit: 2.5, _callMcp: mcp } as any)).rejects.toThrow();
  await expect(searchYahooRealtime({ query: 'SPARK', page: 1.5, _callMcp: mcp } as any)).rejects.toThrow();
  await expect(searchYahooRealtime({ accountId: 'not valid!', _callMcp: mcp } as any)).rejects.toThrow();
});

test('reports total provider failure as an error, not zero hits', async () => {
  await expect(searchYahooRealtime({
    query: 'SPARK', detailEnrichment: false, _callMcp: (async () => { throw new Error('provider down'); }) as any,
  } as any)).rejects.toThrow('provider down');
});

test('HTTP accepts url-only input and maps provider outage to 502', async () => {
  // realtime取得は http_fetcher（wreq）経路のためモジュール差し替えで固定する。
  const fetchSpy = spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation(async () => ({
    finalUrl: 'https://search.yahoo.co.jp/realtime/search',
    response: new Response(JSON.stringify(account), { status: 200 }),
  }) as any);
  try {
  const first = await app.request('/search/realtime', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'realtime-contract-a.example', noCache: true }),
  });
  expect(first.status).toBe(200);
  const firstJson = await first.json() as any;
  expect(firstJson.data.count).toBe(7);
  expect(firstJson.data.items.map((item: any) => String(item.id))).toContain('2101660418129494169');

  const bad = await app.request('/search/realtime', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'SPARK', limit: 99 }),
  });
  expect(bad.status).toBe(400);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('HTTP maps provider outage to 502', async () => {
  const fetchSpy = spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation(async () => {
    throw new Error('down');
  });
  try {
  const res = await app.request('/search/realtime', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'SPARK realtime-contract-outage', noCache: true }),
  });
  expect(res.status).toBe(502);
  } finally {
    fetchSpy.mockRestore();
  }
});
