import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import * as scraper from './scraper.js';
import * as cleaner from './response_cleaner.js';
import * as social from './services/social/index.js';
import * as addressTools from './services/address_tools.js';
import { createAddressContext, setAddressContextForTest } from './services/address_context.js';
import { createTestAddressData, settleAddressData } from './test_fixtures/address/builders.js';
import { CHIYODA_LG, replaceTowns, sampleUpstream } from './test_fixtures/address/harness.js';
import * as yahooCache from './yahoo_search_cache.js';
import { BatchScrapeRequestSchema, ScrapeRequestSchema } from './types.js';
import type { XPostDetailProvider } from './services/x_detail.js';

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

// v4.0.0 の MCP の引数（docs/superpowers/specs/2026-11-04-v4-extraction-and-params-design.md の 5）。
// v5.0.0 で scrape に旧 scrape_batch の urls・concurrency・webhookUrl を、crawl_site に旧 map_site の listOnly・limit・since・until を足した。
// 統合したツールの引数は、旧ツールの引数の和（fetch_social_post は旧 fetch_x_post の statusId、search_media・search_keywords は Yahoo の 5 ツール）
const expected: Record<string, string[]> = {
  scrape: ['url', 'urls', 'concurrency', 'webhookUrl', 'maxChars', 'mode', 'formats', 'fullPage', 'stripLinks', 'maskPii', 'query', 'onlyMainContent', 'headers', 'verbose', 'keepDataImages', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
  crawl_site: ['url', 'listOnly', 'limit', 'since', 'until', 'maxPages', 'maxChars', 'includePatterns', 'excludePatterns', 'formats', 'query', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
  fetch_social_post: ['url', 'statusId', 'commentLimit'],
  search_media: ['type', 'query', 'limit', 'page', 'transcripts', 'transcriptChars', 'updated', 'platform'],
  search_keywords: ['query', 'limit'],
  lookup_address: ['address', 'zipcode', 'lat', 'lon', 'level', 'compareAddress', 'maxDistanceMeters'],
};

/** 手元の MCP サーバーに 1 つのクライアントでつなぎ、fn を呼んで閉じる */
async function withClient<T>(fn: (client: Client) => Promise<T>, options: Parameters<typeof createMcpServer>[0] = {}): Promise<T> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false, ...options });
  const client = new Client({ name: 'tool-params', version: '1.0.0' });
  await server.connect(st);
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (res: any): string => res.content?.[0]?.text ?? '';

describe('MCP のツールの引数', () => {
  test('統合したツール（scrape・crawl_site・fetch_social_post・search_media・search_keywords・lookup_address）の引数が決めたとおり、search_deep は 26 個', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'tool-params', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const { tools } = await client.listTools();
      const props = (name: string) => Object.keys((tools.find((t) => t.name === name)?.inputSchema as any)?.properties ?? {});
      for (const [name, keys] of Object.entries(expected)) expect(props(name).sort()).toEqual([...keys].sort());
      expect(props('search_deep')).toHaveLength(26);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('REST の scrape と batch には、CSS セレクタの引数と renderJs・fastOnly が残る', () => {
    for (const field of ['selectors', 'clipSelector', 'removeSelectors']) {
      expect((ScrapeRequestSchema.shape as any)[field], `scrape.${field}`).toBeDefined();
      expect((BatchScrapeRequestSchema.shape as any)[field], `batch.${field}`).toBeDefined();
    }
    expect((ScrapeRequestSchema.shape as any).renderJs).toBeDefined();
    expect((ScrapeRequestSchema.shape as any).fastOnly).toBeDefined();
  });

  test('消した引数を REST に送っても通り、その項目は捨てられる', () => {
    const parsed = ScrapeRequestSchema.parse({ url: 'https://example.com', onlyHighlights: true, safeNormalize: true, retries: 2 }) as Record<string, unknown>;
    expect(parsed.url).toBe('https://example.com');
    for (const field of ['onlyHighlights', 'safeNormalize', 'retries']) expect(parsed[field]).toBeUndefined();
  });

  test('消した引数・MCP から外した引数を MCP に送っても通り、scrapeUrl には届かない', async () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue({ url: 'https://example.com', title: 't', content: 'c', isTruncated: false, contentType: 'text/html', source: 'web' } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'tool-params', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const res = await client.callTool({ name: 'scrape', arguments: { url: 'https://example.com', onlyHighlights: true, renderJs: true, fastOnly: true, selectors: { a: 'h1' }, clipSelector: '#a', removeSelectors: ['.ad'] } });
      expect(res.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
    const args = spy.mock.calls[0][0] as Record<string, unknown>;
    for (const field of ['onlyHighlights', 'renderJs', 'fastOnly', 'selectors', 'clipSelector', 'removeSelectors']) expect(args[field], field).toBeUndefined();
  });

  test('scrape の urls に CSS セレクタの引数を送っても通り、scrapeBatchUrls には届かない', async () => {
    const spy = spyOn(scraper, 'scrapeBatchUrls').mockResolvedValue({ total: 1, successful: 1, failed: 0, results: [], errors: [] } as any);
    restore.push(() => spy.mockRestore());
    await withClient(async (client) => {
      const res = await client.callTool({ name: 'scrape', arguments: { urls: ['https://example.com'], selectors: { a: 'h1' }, clipSelector: '#a', removeSelectors: ['.ad'] } });
      expect(res.isError).toBeFalsy();
    });
    const args = spy.mock.calls[0][0] as Record<string, unknown>;
    for (const field of ['selectors', 'clipSelector', 'removeSelectors']) expect(args[field], field).toBeUndefined();
  });
});

describe('scrape: url は 1 ページ、urls は一括（旧 scrape_batch）', () => {
  const page = { url: 'https://example.com/a', title: 't', content: 'c', isTruncated: false, contentType: 'text/html', source: 'web', quality: 0.9 };
  const mockSingle = () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue(page as any);
    restore.push(() => spy.mockRestore());
    return spy;
  };
  const mockBatch = () => {
    const spy = spyOn(scraper, 'scrapeBatchUrls').mockResolvedValue({ total: 2, successful: 1, failed: 1, results: [page], errors: [{ url: 'https://example.com/b', error: 'x' }] } as any);
    restore.push(() => spy.mockRestore());
    return spy;
  };

  test('url だけ: scrapeUrl を呼び、応答は旧 scrape と同じ（fullPage の既定 true を補う）', async () => {
    const single = mockSingle();
    const batch = mockBatch();
    const res: any = await withClient((client) => client.callTool({ name: 'scrape', arguments: { url: 'https://example.com/a', query: 'q' } }));
    expect(res.isError).toBeFalsy();
    expect(batch).not.toHaveBeenCalled();
    const args = single.mock.calls[0][0] as Record<string, unknown>;
    expect(args.url).toBe('https://example.com/a');
    expect(args.query).toBe('q');
    expect(args.fullPage).toBe(true);
    expect(JSON.parse(textOf(res))).toEqual(JSON.parse(JSON.stringify(cleaner.formatCompactScrapeResult(page as any, {}))));
  });

  test('url と fullPage: false・keepDataImages: true は、そのまま渡る', async () => {
    const single = mockSingle();
    await withClient((client) => client.callTool({ name: 'scrape', arguments: { url: 'https://example.com/a', fullPage: false, keepDataImages: true } }));
    const args = single.mock.calls[0][0] as Record<string, unknown>;
    expect(args.fullPage).toBe(false);
    expect(args.keepDataImages).toBe(true);
  });

  test('urls だけ: scrapeBatchUrls を呼び、応答は旧 scrape_batch と同じ（各ページを整形）', async () => {
    const single = mockSingle();
    const batch = mockBatch();
    const res: any = await withClient((client) => client.callTool({ name: 'scrape', arguments: { urls: ['https://example.com/a', 'https://example.com/b'], concurrency: 2, webhookUrl: 'https://example.com/hook', maxChars: 50_000, query: 'q' } }));
    expect(res.isError).toBeFalsy();
    expect(single).not.toHaveBeenCalled();
    const args = batch.mock.calls[0][0] as Record<string, unknown>;
    expect(args.urls).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(args.concurrency).toBe(2);
    expect(args.webhookUrl).toBe('https://example.com/hook');
    expect(args.maxChars).toBe(50_000);
    expect(args.query).toBe('q');
    for (const field of ['url', 'fullPage', 'keepDataImages']) expect(args[field], field).toBeUndefined();
    const json = JSON.parse(textOf(res));
    expect(json).toMatchObject({ total: 2, successful: 1, failed: 1, errors: [{ url: 'https://example.com/b', error: 'x' }] });
    expect(json.results).toEqual([JSON.parse(JSON.stringify(cleaner.formatCompactScrapeResult(page as any, {})))]);
    expect(json.results[0].quality).toBeUndefined();
  });

  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['url も urls も無い', {}, ['url・urls のどれか 1 つを指定してください']],
    ['url と urls の両方', { url: 'https://example.com/a', urls: ['https://example.com/b'] }, ['url, urls']],
    // 既定値と違う値は断る（既定値と同じ値は、下の echoed で通す）
    ['url に concurrency: 5（既定値の 3 と違う）', { url: 'https://example.com/a', concurrency: 5 }, ['concurrency は urls を指定したときだけ指定できます（いま: url を指定したとき）']],
    ['url に webhookUrl', { url: 'https://example.com/a', webhookUrl: 'https://example.com/hook' }, ['webhookUrl は urls を指定したときだけ指定できます（いま: url を指定したとき）']],
    ['urls に fullPage: false（既定値の true と違う）', { urls: ['https://example.com/a'], fullPage: false }, ['fullPage は url を指定したときだけ指定できます（いま: urls を指定したとき）']],
    ['urls に keepDataImages: true（既定値の false と違う）', { urls: ['https://example.com/a'], keepDataImages: true }, ['keepDataImages は url を指定したときだけ指定できます（いま: urls を指定したとき）']],
    ['urls に 50000 を超える maxChars', { urls: ['https://example.com/a'], maxChars: 50_001 }, ['maxChars', '50000']],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 取得せず、正しい使い方のエラー`, async () => {
      const single = mockSingle();
      const batch = mockBatch();
      const res: any = await withClient((client) => client.callTool({ name: 'scrape', arguments: args }));
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      // scrape には実在の引数 mode（auto・fast・browser）がある。エラーの文は「モード」の語を使わない
      expect(text).not.toContain('モード');
      // 正しい使い方を添える
      expect(text).toContain('url');
      expect(text).toContain('urls');
      expect(single).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    });
  }

  // LLM は、スキーマの default をそのまま引数に入れることがある。モード専用の引数でも、既定値と同じ値は断らない（無視して取得する）
  const echoed: Array<[string, Record<string, unknown>, 'single' | 'batch', string]> = [
    ['urls + fullPage: true', { urls: ['https://example.com/a'], fullPage: true }, 'batch', 'fullPage'],
    ['urls + keepDataImages: false', { urls: ['https://example.com/a'], keepDataImages: false }, 'batch', 'keepDataImages'],
    ['url + concurrency: 3', { url: 'https://example.com/a', concurrency: 3 }, 'single', 'concurrency'],
  ];
  for (const [label, args, calls, ignored] of echoed) {
    test(`${label}（既定値と同じ）は通り、その引数は使われない`, async () => {
      const single = mockSingle();
      const batch = mockBatch();
      const res: any = await withClient((client) => client.callTool({ name: 'scrape', arguments: args }));
      expect(res.isError).toBeFalsy();
      const [called, notCalled] = calls === 'single' ? [single, batch] : [batch, single];
      expect(notCalled).not.toHaveBeenCalled();
      expect((called.mock.calls[0][0] as Record<string, unknown>)[ignored], ignored).toBeUndefined();
    });
  }

  test('モード専用の引数のうち、スキーマが既定値を出しているものは、その値をそのまま入れても通る', async () => {
    mockSingle();
    mockBatch();
    await withClient(async (client) => {
      const props = ((await client.listTools()).tools.find((t) => t.name === 'scrape')!.inputSchema as any).properties;
      const url = 'https://example.com/a';
      for (const [base, keys] of [[{ url }, ['concurrency']], [{ urls: [url] }, ['fullPage', 'keepDataImages']]] as const) {
        for (const key of keys) {
          expect(props[key].default, `${key} の default`).not.toBeUndefined();
          const res: any = await client.callTool({ name: 'scrape', arguments: { ...base, [key]: props[key].default } });
          expect(res.isError, `${key}: ${textOf(res)}`).toBeFalsy();
        }
      }
    });
  });
});

describe('crawl_site: 省略は巡回、listOnly: true は URL の一覧だけ（旧 map_site）', () => {
  const crawled = { url: 'https://example.com/', baseUrl: 'https://example.com', count: 1, totalPages: 1, pages: [{ url: 'https://example.com/', title: 't', content: 'c' }] };
  const mapped = { url: 'https://example.com/', links: ['https://example.com/a'], count: 1, source: 'sitemap' };
  const mockBoth = () => {
    const crawl = spyOn(scraper, 'crawlSiteUrl').mockResolvedValue(crawled as any);
    const map = spyOn(scraper, 'mapSiteUrl').mockResolvedValue(mapped as any);
    restore.push(() => crawl.mockRestore(), () => map.mockRestore());
    return { crawl, map };
  };

  test('listOnly を省くと crawlSiteUrl を呼び、応答は旧 crawl_site と同じ', async () => {
    const { crawl, map } = mockBoth();
    const res: any = await withClient((client) => client.callTool({ name: 'crawl_site', arguments: { url: 'https://example.com/', maxPages: 2, query: 'q' } }));
    expect(res.isError).toBeFalsy();
    expect(map).not.toHaveBeenCalled();
    const args = crawl.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({ url: 'https://example.com/', maxPages: 2, query: 'q' });
    expect(JSON.parse(textOf(res))).toEqual(crawled);
  });

  test('listOnly: false も巡回', async () => {
    const { crawl, map } = mockBoth();
    const res: any = await withClient((client) => client.callTool({ name: 'crawl_site', arguments: { url: 'https://example.com/', listOnly: false } }));
    expect(res.isError).toBeFalsy();
    expect(crawl).toHaveBeenCalledTimes(1);
    expect(map).not.toHaveBeenCalled();
  });

  test('listOnly: true は mapSiteUrl に url・limit・since・until だけを渡し、応答は旧 map_site と同じ', async () => {
    const { crawl, map } = mockBoth();
    const res: any = await withClient((client) => client.callTool({ name: 'crawl_site', arguments: { url: 'https://example.com/', listOnly: true, limit: 5, since: '2026-05-01', until: '2026-10-01' } }));
    expect(res.isError).toBeFalsy();
    expect(crawl).not.toHaveBeenCalled();
    expect(map.mock.calls[0][0]).toEqual({ url: 'https://example.com/', limit: 5, since: '2026-05-01', until: '2026-10-01' });
    expect(JSON.parse(textOf(res))).toEqual(mapped);
  });

  const LIST = 'listOnly: true のとき';
  const CRAWL = 'listOnly が無い（false を含む）とき';
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['listOnly: true に maxPages: 3（既定値の 10 と違う）', { listOnly: true, maxPages: 3 }, [`maxPages は ${CRAWL}だけ指定できます（いま: ${LIST}）`]],
    ['listOnly: true に query・formats: ["html"]（既定値の ["markdown"] と違う）', { listOnly: true, query: 'q', formats: ['html'] }, ['formats', 'query', `は ${CRAWL}だけ指定できます（いま: ${LIST}）`]],
    ['listOnly: true に includePatterns', { listOnly: true, includePatterns: ['/docs/**'] }, [`includePatterns は ${CRAWL}だけ指定できます（いま: ${LIST}）`]],
    ['listOnly を省いて limit', { limit: 5 }, [`limit は ${LIST}だけ指定できます（いま: ${CRAWL}）`]],
    ['listOnly: false に since・until', { listOnly: false, since: '2026-05-01', until: '2026-10-01' }, ['since', 'until', `は ${LIST}だけ指定できます（いま: ${CRAWL}）`]],
    ['listOnly: false に limit: 50（既定値の 200 と違う）', { listOnly: false, limit: 50 }, [`limit は ${LIST}だけ指定できます（いま: ${CRAWL}）`]],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 取得せず、正しい使い方のエラー`, async () => {
      const { crawl, map } = mockBoth();
      const res: any = await withClient((client) => client.callTool({ name: 'crawl_site', arguments: { url: 'https://example.com/', ...args } }));
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      expect(text).toContain('listOnly');
      expect(crawl).not.toHaveBeenCalled();
      expect(map).not.toHaveBeenCalled();
    });
  }

  // LLM は、スキーマの default をそのまま引数に入れることがある。モード専用の引数でも、既定値と同じ値は断らない（無視して実行する）
  const echoed: Array<[string, Record<string, unknown>, 'crawl' | 'map', string]> = [
    ['listOnly: false + limit: 200', { listOnly: false, limit: 200 }, 'crawl', 'limit'],
    ['limit: 200（listOnly を省く）', { limit: 200 }, 'crawl', 'limit'],
    ['listOnly: true + maxPages: 10', { listOnly: true, maxPages: 10 }, 'map', 'maxPages'],
    ['listOnly: true + formats: ["markdown"]（配列の既定値）', { listOnly: true, formats: ['markdown'] }, 'map', 'formats'],
  ];
  for (const [label, args, calls, ignored] of echoed) {
    test(`${label}（既定値と同じ）は通り、その引数は使われない`, async () => {
      const { crawl, map } = mockBoth();
      const res: any = await withClient((client) => client.callTool({ name: 'crawl_site', arguments: { url: 'https://example.com/', ...args } }));
      expect(res.isError).toBeFalsy();
      const [called, notCalled] = calls === 'crawl' ? [crawl, map] : [map, crawl];
      expect(notCalled).not.toHaveBeenCalled();
      expect((called.mock.calls[0][0] as Record<string, unknown>)[ignored], ignored).toBeUndefined();
    });
  }

  test('モード専用の引数のうち、スキーマが既定値を出しているものは、その値をそのまま入れても通る', async () => {
    mockBoth();
    await withClient(async (client) => {
      const props = ((await client.listTools()).tools.find((t) => t.name === 'crawl_site')!.inputSchema as any).properties;
      const url = 'https://example.com/';
      for (const [base, keys] of [[{ listOnly: true }, ['maxPages', 'maxChars', 'formats', 'responseMode', 'annotateTemporal', 'includeMedia']], [{}, ['limit']]] as const) {
        for (const key of keys) {
          expect(props[key].default, `${key} の default`).not.toBeUndefined();
          const res: any = await client.callTool({ name: 'crawl_site', arguments: { url, ...base, [key]: props[key].default } });
          expect(res.isError, `${key}: ${textOf(res)}`).toBeFalsy();
        }
      }
    });
  });
});

describe('fetch_social_post: X の投稿は旧 fetch_x_post、ほかは旧 fetch_social_post', () => {
  const socialResult = { status: 'ok', post: { url: 'https://m.weibo.cn/detail/1', author: { name: 'a' }, text: 't', publishedAt: '2026-11-01T00:00:00Z', metrics: {}, comments: { state: 'ok', order: 'hot', items: [] } }, failures: [] };
  const mockSocial = () => {
    const fetch = mock(async (_input: unknown) => socialResult);
    const spy = spyOn(social, 'createSocialService').mockReturnValue({ fetch, search: mock() } as any);
    restore.push(() => spy.mockRestore());
    return fetch;
  };
  const xProvider = (calls: string[]): XPostDetailProvider => ({
    async fetchStatus(id: string) {
      calls.push(id);
      return id === '999' ? null : { statusId: id, text: '公式タイムテーブル公開', provider: 'fxtwitter' };
    },
  });
  const call = (args: Record<string, unknown>, calls: string[] = []) =>
    withClient((client) => client.callTool({ name: 'fetch_social_post', arguments: args }), { xDetailProvider: xProvider(calls) }) as Promise<any>;

  test('X 以外の URL: 旧 fetch_social_post の経路（commentLimit の既定 10 を補う）で、応答も同じ', async () => {
    const fetch = mockSocial();
    const calls: string[] = [];
    const res = await call({ url: 'https://m.weibo.cn/detail/1' }, calls);
    expect(res.isError).toBeFalsy();
    expect(fetch.mock.calls[0][0]).toEqual({ url: 'https://m.weibo.cn/detail/1', commentLimit: 10 });
    expect(JSON.parse(textOf(res))).toEqual(socialResult);
    expect(calls).toEqual([]);
  });

  test('X 以外の URL と commentLimit は、そのまま渡る', async () => {
    const fetch = mockSocial();
    await call({ url: 'https://m.weibo.cn/detail/1', commentLimit: 0 });
    expect(fetch.mock.calls[0][0]).toEqual({ url: 'https://m.weibo.cn/detail/1', commentLimit: 0 });
  });

  test.each([
    ['https://x.com/someone/status/2100871827090501852'],
    ['https://twitter.com/someone/status/2100871827090501852'],
    ['https://mobile.twitter.com/someone/status/2100871827090501852'],
  ])('X の URL（%s）: 旧 fetch_x_post の経路で、応答も同じ', async (url) => {
    const fetch = mockSocial();
    const calls: string[] = [];
    const res = await call({ url }, calls);
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(['2100871827090501852']);
    expect(JSON.parse(textOf(res))).toEqual({ found: true, statusId: '2100871827090501852', detail: { statusId: '2100871827090501852', text: '公式タイムテーブル公開', provider: 'fxtwitter' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([['https://www.x.com/someone/status/1'], ['https://www.twitter.com/someone/status/1']])('www. の付いた X の URL（%s）も X の経路（旧 fetch_x_post と同じく、読めない URL は invalid_input）', async (url) => {
    const fetch = mockSocial();
    const res = await call({ url });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('X post not found: invalid_input');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('statusId だけ: X の経路。見つからない投稿は旧 fetch_x_post と同じエラー', async () => {
    const fetch = mockSocial();
    const calls: string[] = [];
    expect(JSON.parse(textOf(await call({ statusId: '2100871827090501852' }, calls))).found).toBe(true);
    const missing = await call({ statusId: '999' }, calls);
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('X post not found: not_found');
    expect(calls).toEqual(['2100871827090501852', '999']);
    expect(fetch).not.toHaveBeenCalled();
  });

  const X = 'X の投稿を指定したとき';
  const OTHER = 'X 以外の投稿を指定したとき';
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['url も statusId も無い', {}, ['url・statusId のどちらかを指定してください']],
    ['X の URL に commentLimit: 5（既定値の 10 と違う）', { url: 'https://x.com/someone/status/1', commentLimit: 5 }, [`commentLimit は ${OTHER}だけ指定できます（いま: ${X}）`]],
    ['statusId に commentLimit: 0', { statusId: '1', commentLimit: 0 }, [`commentLimit は ${OTHER}だけ指定できます（いま: ${X}）`]],
    ['X 以外の URL に statusId', { url: 'https://m.weibo.cn/detail/1', statusId: '1' }, [`statusId は ${X}だけ指定できます（いま: ${OTHER}）`]],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 取得せず、正しい使い方のエラー`, async () => {
      const fetch = mockSocial();
      const calls: string[] = [];
      const res = await call(args, calls);
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      expect(text).toContain('statusId');
      expect(text).toContain('commentLimit');
      expect(fetch).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });
  }

  test('X の URL に、スキーマの既定値の commentLimit をそのまま入れても通る（使われない）', async () => {
    const fetch = mockSocial();
    await withClient(async (client) => {
      const props = ((await client.listTools()).tools.find((t) => t.name === 'fetch_social_post')!.inputSchema as any).properties;
      expect(props.commentLimit.default).toBe(10);
      const res: any = await client.callTool({ name: 'fetch_social_post', arguments: { url: 'https://x.com/someone/status/1', commentLimit: props.commentLimit.default } });
      expect(res.isError, textOf(res)).toBeFalsy();
    }, { xDetailProvider: xProvider([]) });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('search_media: type で画像・動画・ニュース（旧 search_image・search_video・search_news）', () => {
  const result = (source: string) => ({ source, query: 'q', count: 1, items: [{ title: 't', url: 'https://example.com/a' }] });
  const mockAll = () => {
    const image = spyOn(yahooCache, 'searchImageCached').mockResolvedValue(result('image') as any);
    const video = spyOn(yahooCache, 'searchVideoCached').mockResolvedValue(result('video') as any);
    const news = spyOn(yahooCache, 'searchNewsCached').mockResolvedValue(result('news') as any);
    restore.push(() => image.mockRestore(), () => video.mockRestore(), () => news.mockRestore());
    return { image, video, news };
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'search_media', arguments: args })) as Promise<any>;

  test('type: image は searchImageCached に query・limit・page だけを渡し、応答は旧 search_image と同じ', async () => {
    const { image, video, news } = mockAll();
    const res = await call({ type: 'image', query: '富士山', limit: 5, page: 2 });
    expect(res.isError).toBeFalsy();
    expect(image.mock.calls[0][0]).toEqual({ query: '富士山', limit: 5, page: 2 });
    expect(JSON.parse(textOf(res))).toEqual(result('image'));
    expect(video).not.toHaveBeenCalled();
    expect(news).not.toHaveBeenCalled();
  });

  test('type: video は searchVideoCached に動画の引数も渡し、応答は旧 search_video と同じ', async () => {
    const { image, video, news } = mockAll();
    const res = await call({ type: 'video', query: '料理', limit: 5, page: 2, transcripts: 2, transcriptChars: 3000, updated: 'week', platform: 'youtube' });
    expect(res.isError).toBeFalsy();
    expect(video.mock.calls[0][0]).toEqual({ query: '料理', limit: 5, page: 2, transcripts: 2, transcriptChars: 3000, updated: 'week', platform: 'youtube' });
    expect(JSON.parse(textOf(res))).toEqual(result('video'));
    expect(image).not.toHaveBeenCalled();
    expect(news).not.toHaveBeenCalled();
  });

  test('type: news は searchNewsCached に query・limit だけを渡し、応答は旧 search_news と同じ', async () => {
    const { image, video, news } = mockAll();
    const res = await call({ type: 'news', query: '経済', limit: 30 });
    expect(res.isError).toBeFalsy();
    expect(news.mock.calls[0][0]).toEqual({ query: '経済', limit: 30 });
    expect(JSON.parse(textOf(res))).toEqual(result('news'));
    expect(image).not.toHaveBeenCalled();
    expect(video).not.toHaveBeenCalled();
  });

  test('type が無い・知らない type は、検索せずに入力の誤り', async () => {
    const { image, video, news } = mockAll();
    for (const args of [{ query: 'q' }, { type: 'music', query: 'q' }]) {
      const res = await call(args);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('type');
    }
    for (const spy of [image, video, news]) expect(spy).not.toHaveBeenCalled();
  });

  const typeIs = (t: string) => `type が ${t} のとき`;
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['news に page', { type: 'news', page: 2 }, [`page は ${typeIs('image')} か ${typeIs('video')}だけ指定できます（いま: ${typeIs('news')}）`]],
    ['image に transcripts: 3（既定値の 0 と違う）', { type: 'image', transcripts: 3 }, [`transcripts は ${typeIs('video')}だけ指定できます（いま: ${typeIs('image')}）`]],
    ['image に transcriptChars: 3000（既定値の 2000 と違う）', { type: 'image', transcriptChars: 3000 }, [`transcriptChars は ${typeIs('video')}だけ指定できます（いま: ${typeIs('image')}）`]],
    ['news に updated・platform', { type: 'news', updated: 'day', platform: 'youtube' }, [`updated, platform は ${typeIs('video')}だけ指定できます（いま: ${typeIs('news')}）`]],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 検索せず、正しい使い方のエラー`, async () => {
      const { image, video, news } = mockAll();
      const res = await call({ query: 'q', ...args });
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      expect(text).toContain('image');
      expect(text).toContain('video');
      expect(text).toContain('news');
      for (const spy of [image, video, news]) expect(spy).not.toHaveBeenCalled();
    });
  }

  test('news に page: 1 は通り（news には page が無く、1 は省いたのと同じ）、使われない', async () => {
    const { image, video, news } = mockAll();
    const res = await call({ type: 'news', query: '経済', page: 1 });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(news.mock.calls[0][0]).toEqual({ query: '経済' });
    expect(image).not.toHaveBeenCalled();
    expect(video).not.toHaveBeenCalled();
  });

  test('動画だけの引数のうち、スキーマが既定値を出しているものは、その値をそのまま入れても通り、使われない', async () => {
    const { image } = mockAll();
    await withClient(async (client) => {
      const props = ((await client.listTools()).tools.find((t) => t.name === 'search_media')!.inputSchema as any).properties;
      for (const key of ['transcripts', 'transcriptChars', 'updated', 'platform']) {
        expect(props[key].default, `${key} の default`).not.toBeUndefined();
        const res: any = await client.callTool({ name: 'search_media', arguments: { type: 'image', query: 'q', [key]: props[key].default } });
        expect(res.isError, `${key}: ${textOf(res)}`).toBeFalsy();
        expect(image.mock.calls.at(-1)![0]).toEqual({ query: 'q' });
      }
    });
  });
});

describe('search_keywords: query ありはサジェスト、なしは急上昇トレンド（旧 suggest_keywords・search_trend）', () => {
  const suggested = { query: '東京', suggestions: ['東京 観光'] };
  const trends = { source: 'yahoo-realtime', type: 'trend', count: 1, items: [{ rank: 1, keyword: 'k', tweetCount: 10, url: 'https://example.com/t' }], timestamp: '2026-11-11T00:00:00Z' };
  const mockBoth = () => {
    const suggest = spyOn(yahooCache, 'suggestKeywordsCached').mockResolvedValue(suggested as any);
    const trend = spyOn(scraper, 'fetchRealtimeTrends').mockResolvedValue(trends as any);
    restore.push(() => suggest.mockRestore(), () => trend.mockRestore());
    return { suggest, trend };
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'search_keywords', arguments: args })) as Promise<any>;

  test('query あり: suggestKeywordsCached に query・limit を渡し、応答は旧 suggest_keywords と同じ', async () => {
    const { suggest, trend } = mockBoth();
    const res = await call({ query: '東京', limit: 20 });
    expect(res.isError).toBeFalsy();
    expect(suggest.mock.calls[0][0]).toEqual({ query: '東京', limit: 20 });
    expect(JSON.parse(textOf(res))).toEqual(suggested);
    expect(trend).not.toHaveBeenCalled();
  });

  test('query なし: fetchRealtimeTrends に limit を渡し（上限 50）、応答は旧 search_trend と同じ', async () => {
    const { suggest, trend } = mockBoth();
    const res = await call({ limit: 50 });
    expect(res.isError).toBeFalsy();
    expect(trend.mock.calls[0][0]).toBe(50);
    expect(JSON.parse(textOf(res))).toEqual(trends);
    await call({});
    expect(trend.mock.calls[1][0]).toBeUndefined();
    expect(suggest).not.toHaveBeenCalled();
  });

  test('query ありで limit が 20 を超えると、サジェストを取らずに正しい使い方のエラー（旧 suggest_keywords の上限）', async () => {
    const { suggest, trend } = mockBoth();
    const res = await call({ query: '東京', limit: 21 });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('入力の誤り');
    expect(text).toContain('limit は 20 まで');
    expect(text).toContain('query');
    expect(suggest).not.toHaveBeenCalled();
    expect(trend).not.toHaveBeenCalled();
  });
});

describe('lookup_address: address は正規化、lat・lon だけは逆引き、zipcode だけは郵便番号の候補（旧 normalize_address・reverse_geocode・search_postal_code）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lookup-address-'));
  });
  afterEach(async () => {
    setAddressContextForTest(null);
    await settleAddressData();
    rmSync(dir, { recursive: true, force: true });
  });
  /** 手元の取得元（番地・号まで）で作った住所データを、ツールが使う */
  const useData = (up = sampleUpstream({ numbers: true })) => {
    const ctx = createAddressContext(createTestAddressData(dir, { up }).data);
    setAddressContextForTest(ctx);
    return ctx;
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'lookup_address', arguments: args })) as Promise<any>;
  const body = (res: any) => JSON.parse(textOf(res));
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

  test('address と zipcode: 旧 normalize_address と同じ応答に mode: normalize（番地・号の level 8、郵便番号の突き合わせ）', async () => {
    const ctx = useData();
    const args = { address: '東京都千代田区永田町1-7-1', zipcode: '100-0014' };
    const res = await call(args);
    expect(res.isError, textOf(res)).toBeFalsy();
    const { mode, ...rest } = body(res);
    expect(mode).toBe('normalize');
    expect(rest).toMatchObject({
      level: 8, normalized: '東京都千代田区永田町一丁目7-1', numberSource: 'rsdt', keys: { blk: '7', rsdt: '1' },
      point: { lat: 35.675912, lon: 139.745512, level: 8 }, postalCodes: [{ zipcode: '1000014', exact: true }], checks: { zipcode: { status: 'match' } },
    });
    expect(rest).toEqual(plain(await addressTools.normalizeAddressTool(args, ctx)));
  });

  test('address と lat・lon・compareAddress・level: 旧 normalize_address の突き合わせ（座標の近さ・名寄せ）', async () => {
    const ctx = useData();
    const args = { address: '東京都千代田区永田町1-7-1', lat: 35.675915, lon: 139.745515, compareAddress: '千代田区永田町一丁目7番1号', level: 8 };
    const { mode, ...rest } = body(await call(args));
    expect(mode).toBe('normalize');
    expect(rest.checks.coordinates).toBeDefined();
    expect(rest.checks.compare).toMatchObject({ relation: 'identical', sameLevel: 8 });
    expect(rest).toEqual(plain(await addressTools.normalizeAddressTool(args, ctx)));
  });

  test('address だけ（地番の住所）: 旧 search_postal_code の「住所から郵便番号」と同じ郵便番号・正規化・階層・出典を返す', async () => {
    const ctx = useData();
    const address = '札幌市中央区北1条西2丁目12-3';
    const res = body(await call({ address }));
    expect(res).toMatchObject({ mode: 'normalize', input: address, level: 8, numberSource: 'chiban', normalized: '北海道札幌市中央区北１条西二丁目12-3', postalCodes: [{ zipcode: '0600001', exact: true }] });
    const old = (await addressTools.searchPostalCode({ address }, ctx)) as addressTools.SearchPostalCodeByAddress;
    const pick = (r: any) => ({ normalized: r.normalized, level: r.level, postalCodes: r.postalCodes, attribution: r.attribution });
    expect(pick(res)).toEqual(plain(pick(old)));
  });

  test('address の町名がローマ字でも、番地・号まで読む', async () => {
    const up = sampleUpstream({ numbers: true });
    const row = (id: string, oaza: string, roma: string, chome: string, n: string): string[] => [CHIYODA_LG, id, oaza, `${oaza}カナ`, roma, chome, n, '', '', '', '1'];
    replaceTowns(up, CHIYODA_LG, [row('0006000', '千代田', 'Chiyoda', '', ''), row('0005001', '永田町', 'Nagatacho', '一丁目', '1'), row('0005002', '永田町', 'Nagatacho', '二丁目', '2')], '"roma"');
    useData(up);
    expect(body(await call({ address: '東京都千代田区Nagatacho 1-7-1' }))).toMatchObject({ mode: 'normalize', level: 8, numberSource: 'rsdt', normalized: '東京都千代田区永田町一丁目7-1' });
  });

  test('zipcode だけ: 旧 search_postal_code と同じ応答に mode: postal（事業所の個別郵便番号も）', async () => {
    const ctx = useData();
    const res = await call({ zipcode: '060-8621' });
    expect(res.isError, textOf(res)).toBeFalsy();
    const { mode, ...rest } = body(res);
    expect(mode).toBe('postal');
    expect(rest).toMatchObject({ zipcode: '0608621', count: 1, candidates: [{ kind: 'office', city: '札幌市中央区' }] });
    expect(rest.candidates[0].office).toEqual(expect.any(String));
    expect(rest).toEqual(plain(await addressTools.searchPostalCode({ zipcode: '060-8621' }, ctx)));
  });

  test('lat と lon だけ: 旧 reverse_geocode と同じ応答に mode: reverse（番地・号の点までの距離）', async () => {
    const ctx = useData();
    const point = { lat: 35.675915, lon: 139.745515 };
    const { mode, ...rest } = body(await call(point));
    expect(mode).toBe('reverse');
    expect(rest).toMatchObject({ found: true, level: 8, numberSource: 'rsdt', normalized: '東京都千代田区永田町一丁目7-1' });
    expect(rest.distanceMeters).toBeLessThan(5);
    expect(rest).toEqual(plain(await addressTools.reverseGeocodeTool(point, ctx)));
  });

  test('lat・lon と maxDistanceMeters: 範囲内に番地・号の点が無ければ、旧 reverse_geocode と同じく町字（level 3）', async () => {
    const ctx = useData();
    const args = { lat: 35.675895, lon: 139.746306, maxDistanceMeters: 50 };
    const { mode, ...rest } = body(await call(args));
    expect(mode).toBe('reverse');
    expect(rest).toMatchObject({ found: true, level: 3, numberSource: null, normalized: '東京都千代田区永田町一丁目' });
    expect(rest).toEqual(plain(await addressTools.reverseGeocodeTool(args, ctx)));
  });

  test('機能の入力の誤りは、旧ツールと同じエラーの文', async () => {
    useData();
    const normalize = await call({ address: '東京都千代田区永田町1-7-1', lat: 35.6 });
    expect(normalize.isError).toBe(true);
    expect(textOf(normalize)).toBe('Address normalize error: lat と lon は組で指定してください');
    const postal = await call({ zipcode: '12' });
    expect(postal.isError).toBe(true);
    expect(textOf(postal)).toStartWith('Postal code error: ');
  });

  // 誤った組み合わせ: 取得しない（サービスの関数を呼ばない）
  const mockAll = () => {
    const normalize = spyOn(addressTools, 'normalizeAddressTool').mockResolvedValue({ normalized: 'n' } as any);
    const reverse = spyOn(addressTools, 'reverseGeocodeTool').mockResolvedValue({ found: true } as any);
    const postal = spyOn(addressTools, 'searchPostalCode').mockResolvedValue({ zipcode: 'z' } as any);
    restore.push(() => normalize.mockRestore(), () => reverse.mockRestore(), () => postal.mockRestore());
    return { normalize, reverse, postal };
  };
  const ADDRESS = 'address を指定したとき';
  const POINT = 'address なしで lat・lon を指定したとき';
  const ZIP = 'zipcode だけを指定したとき';
  const point = { lat: 35.675915, lon: 139.745515 };
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['何も無い', {}, ['address・zipcode・lat と lon のどれかを指定してください']],
    ['lat だけ', { lat: 35.6 }, ['lat と lon は組で指定してください']],
    ['lon と zipcode', { lon: 139.7, zipcode: '1000014' }, ['lat と lon は組で指定してください']],
    ['lat・lon と zipcode', { ...point, zipcode: '1000014' }, [`zipcode は ${ADDRESS} か ${ZIP}だけ指定できます（いま: ${POINT}）`]],
    ['address と maxDistanceMeters: 100（既定値の 300 と違う）', { address: '東京都千代田区', maxDistanceMeters: 100 }, [`maxDistanceMeters は ${POINT}だけ指定できます（いま: ${ADDRESS}）`]],
    ['zipcode と maxDistanceMeters: 100', { zipcode: '1000014', maxDistanceMeters: 100 }, [`maxDistanceMeters は ${POINT}だけ指定できます（いま: ${ZIP}）`]],
    ['zipcode と level: 3（既定値の 8 と違う）', { zipcode: '1000014', level: 3 }, [`level は ${ADDRESS}だけ指定できます（いま: ${ZIP}）`]],
    ['zipcode と compareAddress', { zipcode: '1000014', compareAddress: '東京都千代田区' }, [`compareAddress は ${ADDRESS}だけ指定できます（いま: ${ZIP}）`]],
    ['lat・lon と level: 3・compareAddress', { ...point, level: 3, compareAddress: '東京都千代田区' }, [`level, compareAddress は ${ADDRESS}だけ指定できます（いま: ${POINT}）`]],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 取得せず、正しい使い方のエラー`, async () => {
      const spies = mockAll();
      const res = await call(args);
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      // 正しい使い方を添える
      for (const key of ['address', 'zipcode', 'lat', 'lon']) expect(text).toContain(key);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    });
  }

  test('空の address・zipcode は、指定しなかったのと同じ', async () => {
    const { normalize, reverse, postal } = mockAll();
    const res = await call({ address: '  ', zipcode: '', ...point });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(reverse.mock.calls[0][0]).toEqual(point);
    expect(normalize).not.toHaveBeenCalled();
    expect(postal).not.toHaveBeenCalled();
  });

  test('各経路は、旧ツールの引数だけをサービスに渡す', async () => {
    const { normalize, reverse, postal } = mockAll();
    await call({ address: '東京都千代田区永田町1-7-1', zipcode: '1000014', lat: 35.6, lon: 139.7, level: 3, compareAddress: '東京都千代田区' });
    expect(normalize.mock.calls[0][0]).toEqual({ address: '東京都千代田区永田町1-7-1', zipcode: '1000014', lat: 35.6, lon: 139.7, level: 3, compareAddress: '東京都千代田区' });
    await call({ ...point, maxDistanceMeters: 1000 });
    expect(reverse.mock.calls[0][0]).toEqual({ ...point, maxDistanceMeters: 1000 });
    await call({ zipcode: '〒100-0014' });
    expect(postal.mock.calls[0][0]).toEqual({ zipcode: '〒100-0014' });
  });

  // LLM は、スキーマの default をそのまま引数に入れることがある。ほかの入力の引数でも、既定値と同じ値は断らない（使わない）
  const echoed: Array<[string, Record<string, unknown>, 'normalize' | 'reverse' | 'postal', string[]]> = [
    ['address + maxDistanceMeters: 300', { address: '東京都千代田区', maxDistanceMeters: 300 }, 'normalize', ['maxDistanceMeters']],
    ['lat・lon + level: 8', { ...point, level: 8 }, 'reverse', ['level']],
    ['zipcode + level: 8・maxDistanceMeters: 300', { zipcode: '1000014', level: 8, maxDistanceMeters: 300 }, 'postal', ['level', 'maxDistanceMeters']],
  ];
  for (const [label, args, calls, ignored] of echoed) {
    test(`${label}（既定値と同じ）は通り、その引数は使われない`, async () => {
      const spies = mockAll();
      const res = await call(args);
      expect(res.isError, textOf(res)).toBeFalsy();
      expect(body(res).mode).toBe(calls);
      for (const [name, spy] of Object.entries(spies)) expect(spy, name).toHaveBeenCalledTimes(name === calls ? 1 : 0);
      for (const key of ignored) expect((spies[calls].mock.calls[0][0] as Record<string, unknown>)[key], key).toBeUndefined();
    });
  }

  test('ほかの入力の引数のうち、スキーマが既定値を出しているものは、その値をそのまま入れても通る', async () => {
    mockAll();
    await withClient(async (client) => {
      const props = ((await client.listTools()).tools.find((t) => t.name === 'lookup_address')!.inputSchema as any).properties;
      for (const [base, keys] of [[{ address: '東京都千代田区' }, ['maxDistanceMeters']], [{ zipcode: '1000014' }, ['level', 'maxDistanceMeters']], [point, ['level']]] as const) {
        for (const key of keys) {
          expect(props[key].default, `${key} の default`).not.toBeUndefined();
          const res: any = await client.callTool({ name: 'lookup_address', arguments: { ...base, [key]: props[key].default } });
          expect(res.isError, `${key}: ${textOf(res)}`).toBeFalsy();
        }
      }
    });
  });
});

describe('旧名で search_tools を引くと、統合先が見つかる', () => {
  test.each([
    ['scrape_batch', 'scrape', 'web'],
    ['map_site', 'crawl_site', 'web'],
    ['fetch_x_post', 'fetch_social_post', 'web'],
    ['search_image', 'search_media', 'yahoo'],
    ['search_video', 'search_media', 'yahoo'],
    ['search_news', 'search_media', 'yahoo'],
    ['suggest_keywords', 'search_keywords', 'yahoo'],
    ['search_trend', 'search_keywords', 'yahoo'],
    ['search_postal_code', 'lookup_address', 'disaster'],
    ['normalize_address', 'lookup_address', 'disaster'],
    ['reverse_geocode', 'lookup_address', 'disaster'],
  ])('%s → %s', async (oldName, newName, category) => {
    const server = createMcpServer({ deferTools: true });
    const res = await (server as any)._registeredTools['search_tools'].handler({ query: oldName, detail: 'names', activate: false });
    expect(res.content[0].text).toMatch(new RegExp(`^- ${newName} \\[${category}\\]`, 'm'));
  });
});
