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
import * as youtube from './services/youtube.js';
import * as intelDb from './services/country_intel/db.js';
import * as intelReport from './services/country_intel/report.js';
import { clearCache } from './cache.js';
import { BatchScrapeRequestSchema, DEFAULT_MAX_CHARS, ScrapeRequestSchema } from './types.js';
import type { XPostDetailProvider } from './services/x_detail.js';

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

// v4.0.0 の MCP の引数（docs/superpowers/specs/2026-11-04-v4-extraction-and-params-design.md の 5）。
// v5.0.0 で scrape に旧 scrape_batch の urls・concurrency・webhookUrl を、crawl_site に旧 map_site の listOnly・limit・since・until を足した。
// 統合したツールの引数は、旧ツールの引数の和（fetch_social_post は旧 fetch_x_post の statusId、search_media・search_keywords は Yahoo の 5 ツール。
// lookup_hts は旧 verify_hts_code の productDescription を、旧 predict_hts_code の description にまとめる。
// get_country_context は旧 get_country_context_evidence・get_country_context_updates の引数に part を、get_youtube は旧 2 ツールの引数の和）
const expected: Record<string, string[]> = {
  scrape: ['url', 'urls', 'concurrency', 'webhookUrl', 'maxChars', 'mode', 'formats', 'fullPage', 'stripLinks', 'maskPii', 'query', 'onlyMainContent', 'headers', 'verbose', 'keepDataImages', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
  crawl_site: ['url', 'listOnly', 'limit', 'since', 'until', 'maxPages', 'maxChars', 'includePatterns', 'excludePatterns', 'formats', 'query', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
  fetch_social_post: ['url', 'statusId', 'commentLimit'],
  search_media: ['type', 'query', 'limit', 'page', 'transcripts', 'transcriptChars', 'updated', 'platform'],
  search_keywords: ['query', 'limit'],
  lookup_address: ['address', 'zipcode', 'lat', 'lon', 'level', 'compareAddress', 'maxDistanceMeters'],
  get_place_info: ['address', 'lat', 'lon', 'noCache', 'include'],
  get_disaster_info: ['city', 'areaCode', 'limit', 'minIntensity', 'include'],
  search_laws: ['keyword', 'lawId', 'limit'],
  search_music: ['query', 'country', 'entity', 'attribute', 'limit'],
  watch: ['action', 'url', 'title', 'selector', 'webhookUrl', 'id'],
  lookup_hts: ['htsCode', 'description', 'productName', 'material', 'productCategory', 'targetAge', 'foodContact', 'hasBattery'],
  check_regulations: ['htsCode', 'agencies', 'targetAge', 'material', 'hasBattery', 'batteryType', 'fabricSurface', 'fabricWeightOzPerSqYd', 'foodContact'],
  get_country_context: ['contextId', 'part', 'evidenceIds', 'cursor', 'limit'],
  get_youtube: ['url', 'lang', 'fromSec', 'maxChars', 'limit', 'noCache'],
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
  test('統合したツール（scrape・crawl_site・fetch_social_post・search_media・search_keywords・lookup_address・get_place_info・get_disaster_info・search_laws・search_music・watch・lookup_hts・check_regulations・get_country_context・get_youtube）の引数が決めたとおり、search_deep は 26 個', async () => {
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
    ['空の url だけ', { url: '' }, ['url・urls のどれか 1 つを指定してください']],
    ['URL として読めない url', { url: 'example.com/a' }, ['url は URL として読めません（いま: "example.com/a"）']],
    ['urls に URL として読めない webhookUrl', { urls: ['https://example.com/a'], webhookUrl: 'hook' }, ['webhookUrl は URL として読めません（いま: "hook"）']],
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

  test('使わない側の "" は指定なし（LLM の空のプレースホルダ）: urls と url: ""・url と webhookUrl: "" は通る', async () => {
    const single = mockSingle();
    const batch = mockBatch();
    const many: any = await withClient((client) => client.callTool({ name: 'scrape', arguments: { urls: ['https://example.com/a'], url: '' } }));
    expect(many.isError, textOf(many)).toBeFalsy();
    expect((batch.mock.calls[0][0] as Record<string, unknown>).url).toBeUndefined();
    const one: any = await withClient((client) => client.callTool({ name: 'scrape', arguments: { url: 'https://example.com/a', webhookUrl: '' } }));
    expect(one.isError, textOf(one)).toBeFalsy();
    expect((single.mock.calls[0][0] as Record<string, unknown>).url).toBe('https://example.com/a');
  });

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
    ['address と lat だけ', { address: '東京都千代田区永田町1-7-1', lat: 35.6 }, ['lat と lon は組で指定してください']],
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

describe('get_place_info: address か lat・lon の地点の情報を、include で選んで返す（旧 get_elevation）', () => {
  /** 地名は Nominatim（候補が 2 つで needsVerification）、標高は国土地理院。ほかの送り先には行かない */
  const stubUpstream = () => {
    const calls: string[] = [];
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.hostname);
      if (url.hostname === 'nominatim.openstreetmap.org') {
        return Response.json([
          { display_name: '東京都渋谷区神宮前 原宿', lat: '35.669968', lon: '139.709008', address: { 'ISO3166-2-lvl4': 'JP-13' } },
          { display_name: '原宿, 群馬県', lat: '36.3', lon: '139.0', address: { 'ISO3166-2-lvl4': 'JP-10' } },
        ]);
      }
      if (url.hostname === 'cyberjapandata2.gsi.go.jp') return Response.json({ elevation: 34, hsrc: '5m' });
      throw new Error('unexpected upstream: ' + url.hostname);
    }) as typeof fetch);
    restore.push(() => spy.mockRestore());
    return calls;
  };
  beforeEach(() => clearCache());
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'get_place_info', arguments: args })) as Promise<any>;
  const body = (res: any) => JSON.parse(textOf(res));
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const point = { lat: 35.3606, lon: 138.7274 };

  test('address: 旧 get_elevation の欄を、名前と値のまま location と elevation に分ける（出典・要確認の印も残る）', async () => {
    stubUpstream();
    const res = await call({ address: '原宿' });
    expect(res.isError, textOf(res)).toBeFalsy();
    const out = body(res);
    expect(Object.keys(out)).toEqual(['location', 'elevation', 'include']);
    expect(out.include).toEqual(['elevation']);
    expect(out.location).toEqual({
      query: '原宿', address: '原宿', matchedTitle: '東京都渋谷区神宮前 原宿', geocodingSource: 'nominatim',
      geocodingAttribution: expect.stringContaining('OpenStreetMap'), needsVerification: true, lat: 35.669968, lon: 139.709008,
    });
    expect(out.elevation).toEqual({ elevationMeters: 34, dataAccuracy: '5m', formatted: '東京都渋谷区神宮前 原宿 の標高 (海抜): 34m (精度: 5m)', source: 'gsi' });
    // 旧 get_elevation の応答（= サービスの結果。2 回目なのでキャッシュの印が付く）と、欄が 1 つも欠けない
    const { cached, cachedAt, ageSeconds, ...old } = plain(await scraper.fetchElevationAndCoordinates({ address: '原宿' })) as Record<string, unknown>;
    expect(cached).toBe(true);
    expect({ ...out.location, ...out.elevation }).toEqual(old);
    // キャッシュから返したときの印は、elevation の節に入る
    const again = body(await call({ address: '原宿' }));
    expect(again.elevation).toMatchObject({ cached: true, cachedAt: expect.any(String), ageSeconds: expect.any(Number) });
    expect(again.location.cached).toBeUndefined();
  });

  test('lat と lon: 座標の標高（座標解決の欄は無い）。include: ["elevation"] を明示しても同じ', async () => {
    const calls = stubUpstream();
    const out = body(await call(point));
    expect(out).toEqual({ location: point, elevation: { elevationMeters: 34, dataAccuracy: '5m', formatted: '緯度: 35.3606, 経度: 138.7274 の標高 (海抜): 34m (精度: 5m)', source: 'gsi' }, include: ['elevation'] });
    expect(calls).toEqual(['cyberjapandata2.gsi.go.jp']);
    expect(body(await call({ ...point, include: ['elevation'], noCache: true }))).toEqual(out);
    expect(calls).toEqual(['cyberjapandata2.gsi.go.jp', 'cyberjapandata2.gsi.go.jp']);
  });

  test('include: [] は省略と同じ既定（["elevation"]）。args.ts の given と同じく、空の配列は指定なし', async () => {
    stubUpstream();
    expect(body(await call({ ...point, include: [] })).include).toEqual(['elevation']);
  });

  test('サービスには、旧 get_elevation の引数だけを渡す（include は渡さない）', async () => {
    const spy = spyOn(scraper, 'fetchElevationAndCoordinates').mockResolvedValue({ lat: 1, lon: 2, elevationMeters: 3, formatted: 'f', source: 'gsi' });
    restore.push(() => spy.mockRestore());
    await call({ address: '富士山頂', noCache: true, include: ['elevation'] });
    expect(spy.mock.calls[0][0]).toEqual({ address: '富士山頂', noCache: true });
    await call(point);
    expect(spy.mock.calls[1][0]).toEqual(point);
  });

  test('取得の失敗は、旧 get_elevation と同じ Elevation error の文', async () => {
    const spy = spyOn(scraper, 'fetchElevationAndCoordinates').mockRejectedValue(new Error('住所から座標を特定できませんでした: どこか'));
    restore.push(() => spy.mockRestore());
    const res = await call({ address: 'どこか' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Elevation error: 住所から座標を特定できませんでした: どこか');
  });

  // 誤った組み合わせ・使えない include: 取得しない（外に問い合わせない）
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['何も無い', {}, ['address または (lat, lon) のいずれかを指定してください']],
    ['空の address だけ', { address: '  ' }, ['address または (lat, lon) のいずれかを指定してください']],
    ['lat だけ', { lat: 35.6 }, ['lat と lon は組で指定してください']],
    ['address と lon だけ', { address: '原宿', lon: 139.7 }, ['lat と lon は組で指定してください']],
    ['address と lat・lon', { address: '原宿', ...point }, ['address と lat・lon は、どちらか一方だけを指定してください']],
    ['include に使えない値', { address: '原宿', include: ['elevation', 'hazards'] }, ['include に使えない値があります: hazards']],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 取得せず、正しい使い方のエラー`, async () => {
      const calls = stubUpstream();
      const res = await call(args);
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      // 正しい使い方（地点の指定と、include の使える値）を添える
      for (const key of ['address', 'lat', 'lon', 'include', 'elevation']) expect(text).toContain(key);
      expect(calls).toEqual([]);
    });
  }

  test('空の address と lat・lon は、座標の指定として通る', async () => {
    stubUpstream();
    const res = await call({ address: '', ...point });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res).location).toEqual(point);
  });

  test('スキーマの include の既定値は ["elevation"] で、その値をそのまま入れても通る', async () => {
    stubUpstream();
    await withClient(async (client) => {
      const props = ((await client.listTools()).tools.find((t) => t.name === 'get_place_info')!.inputSchema as any).properties;
      expect(props.include.default).toEqual(['elevation']);
      const res: any = await client.callTool({ name: 'get_place_info', arguments: { ...point, include: props.include.default } });
      expect(res.isError, textOf(res)).toBeFalsy();
    });
  });
});

describe('get_disaster_info: 警報・注意報（city・areaCode）と地震（limit・minIntensity）を、include で選んで返す（旧 search_disaster_warnings・search_earthquake）', () => {
  const WARNINGS = { areaCode: '1310400', areaName: '新宿区', prefecture: '東京都', reportTime: '2026-11-11T05:00:00+09:00', warnings: [], advisories: [{ code: '14', name: '雷注意報', status: '発表' }] };
  const QUAKES = { count: 1, earthquakes: [{ id: '20261111125704', time: '2026/11/11 12:57:00', maxScale: '震度1', maxScaleRaw: 10, tsunami: '津波の心配なし', source: 'jma' }] };
  /** 2 つのサービスを差し替える（外には問い合わせない） */
  const mockAll = () => {
    const warnings = spyOn(scraper, 'fetchWeatherWarnings').mockResolvedValue(WARNINGS as any);
    const quakes = spyOn(scraper, 'fetchRecentEarthquakes').mockResolvedValue(QUAKES as any);
    restore.push(() => { warnings.mockRestore(); quakes.mockRestore(); });
    return { warnings, quakes };
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'get_disaster_info', arguments: args })) as Promise<any>;
  const body = (res: any) => JSON.parse(textOf(res));

  test('city があれば警報だけ: warnings の節は旧 search_disaster_warnings の応答のまま（地震は取らない）', async () => {
    const { warnings, quakes } = mockAll();
    const res = await call({ city: '新宿区' });
    expect(res.isError, textOf(res)).toBeFalsy();
    const out = body(res);
    expect(Object.keys(out)).toEqual(['include', 'warnings']);
    expect(out).toEqual({ include: ['warnings'], warnings: WARNINGS });
    expect(warnings.mock.calls[0][0]).toEqual({ city: '新宿区' });
    expect(quakes).not.toHaveBeenCalled();
  });

  test('areaCode だけでも警報。サービスには旧ツールの引数だけを渡す', async () => {
    const { warnings, quakes } = mockAll();
    expect(body(await call({ areaCode: '13' })).include).toEqual(['warnings']);
    expect(warnings.mock.calls[0][0]).toEqual({ areaCode: '13' });
    expect(quakes).not.toHaveBeenCalled();
  });

  test('city も areaCode も無ければ地震だけ: earthquake の節は旧 search_earthquake の応答（{ count, earthquakes }）のまま', async () => {
    const { warnings, quakes } = mockAll();
    const out = body(await call({}));
    expect(out).toEqual({ include: ['earthquake'], earthquake: QUAKES });
    expect(quakes.mock.calls[0][0]).toEqual({});
    expect(warnings).not.toHaveBeenCalled();
    await call({ limit: 3, minIntensity: 40 });
    expect(quakes.mock.calls[1][0]).toEqual({ limit: 3, minIntensity: 40 });
  });

  test('両方は include: ["warnings","earthquake"] で、節を 2 つ返す（順序は登録順、重複は 1 つ）', async () => {
    const { warnings, quakes } = mockAll();
    const out = body(await call({ include: ['earthquake', 'warnings', 'earthquake'], areaCode: '13', limit: 2 }));
    expect(Object.keys(out)).toEqual(['include', 'warnings', 'earthquake']);
    expect(out).toEqual({ include: ['warnings', 'earthquake'], warnings: WARNINGS, earthquake: QUAKES });
    expect(warnings.mock.calls[0][0]).toEqual({ areaCode: '13' });
    expect(quakes.mock.calls[0][0]).toEqual({ limit: 2 });
  });

  test('include: [] は省略と同じ既定（地域があれば警報、無ければ地震）。空の配列は指定なし', async () => {
    mockAll();
    expect(body(await call({ city: '新宿区', include: [] })).include).toEqual(['warnings']);
    expect(body(await call({ include: [] })).include).toEqual(['earthquake']);
  });

  test('include: ["earthquake"] を明示すれば、city が無くても地震（既定と同じ）', async () => {
    mockAll();
    expect(body(await call({ include: ['earthquake'], limit: 1 }))).toEqual({ include: ['earthquake'], earthquake: QUAKES });
  });

  test('取得の失敗は、旧ツールと同じ文（Disaster warnings error・Earthquake search error）', async () => {
    const w = spyOn(scraper, 'fetchWeatherWarnings').mockRejectedValue(new Error('地名「ほげほげ」が見つかりません'));
    const q = spyOn(scraper, 'fetchRecentEarthquakes').mockRejectedValue(new Error('unavailable'));
    restore.push(() => { w.mockRestore(); q.mockRestore(); });
    const bad = await call({ city: 'ほげほげ' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe('Disaster warnings error: 地名「ほげほげ」が見つかりません');
    const down = await call({ limit: 2 });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toBe('Earthquake search error: unavailable');
  });

  // 誤った組み合わせ・使えない include: 取得しない（外に問い合わせない）
  const WITH_WARNINGS = 'include に warnings を含むとき';
  const WITH_EARTHQUAKE = 'include に earthquake を含むとき';
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['include: ["warnings"] で地域なし', { include: ['warnings'] }, ['include の warnings には city か areaCode が必要です']],
    ['include: ["warnings"] で空の city・areaCode', { include: ['warnings'], city: '', areaCode: '' }, ['include の warnings には city か areaCode が必要です']],
    ['include に使えない値', { include: ['earthquake', 'typhoon'] }, ['include に使えない値があります: typhoon']],
    ['city と limit: 3（既定値の 5 と違う）', { city: '新宿区', limit: 3 }, [`limit は ${WITH_EARTHQUAKE}だけ指定できます（いま: include: ["warnings"]）`]],
    ['areaCode と minIntensity: 40', { areaCode: '13', minIntensity: 40 }, [`minIntensity は ${WITH_EARTHQUAKE}だけ指定できます（いま: include: ["warnings"]）`]],
    ['include: ["earthquake"] と city', { include: ['earthquake'], city: '新宿区' }, [`city は ${WITH_WARNINGS}だけ指定できます（いま: include: ["earthquake"]）`]],
    ['include: ["earthquake"] と city・areaCode', { include: ['earthquake'], city: '新宿区', areaCode: '13' }, [`city, areaCode は ${WITH_WARNINGS}だけ指定できます（いま: include: ["earthquake"]）`]],
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
      // 正しい使い方（include の値と、それぞれの引数）を添える
      for (const key of ['include', 'warnings', 'earthquake', 'city', 'areaCode', 'limit', 'minIntensity']) expect(text).toContain(key);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    });
  }

  test('空の city は、指定しなかったのと同じ（地震を返す）', async () => {
    const { warnings, quakes } = mockAll();
    expect(body(await call({ city: '' })).include).toEqual(['earthquake']);
    expect(warnings).not.toHaveBeenCalled();
    expect(quakes).toHaveBeenCalledTimes(1);
  });

  // LLM は、スキーマの default をそのまま引数に入れることがある。地震を返さないときでも、既定値と同じ値は断らない（使わない）
  test('city + limit: 5・minIntensity: 10（既定値と同じ）は通り、地震は取らない', async () => {
    const { warnings, quakes } = mockAll();
    const res = await call({ city: '新宿区', limit: 5, minIntensity: 10 });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res).include).toEqual(['warnings']);
    expect(warnings.mock.calls[0][0]).toEqual({ city: '新宿区' });
    expect(quakes).not.toHaveBeenCalled();
  });

  test('スキーマの limit・minIntensity の既定値は 5・10 で、警報だけのときにその値をそのまま入れても通る', async () => {
    mockAll();
    await withClient(async (client) => {
      const props = ((await client.listTools()).tools.find((t) => t.name === 'get_disaster_info')!.inputSchema as any).properties;
      expect([props.limit.default, props.minIntensity.default]).toEqual([5, 10]);
      // Gemini は数の enum を受けない: MCP は範囲だけを出す（値は refine で確かめる）
      expect([props.minIntensity.minimum, props.minIntensity.maximum, props.minIntensity.enum]).toEqual([10, 70, undefined]);
      for (const key of ['limit', 'minIntensity']) {
        const res: any = await client.callTool({ name: 'get_disaster_info', arguments: { areaCode: '13', [key]: props[key].default } });
        expect(res.isError, `${key}: ${textOf(res)}`).toBeFalsy();
      }
      expect((await client.callTool({ name: 'get_disaster_info', arguments: { minIntensity: 35 } })).isError).toBe(true);
    });
  });
});

describe('search_laws: keyword は法令の検索、lawId は条文の全文（旧 get_law_text）', () => {
  const LIST = { count: 1, items: [{ id: '129AC0000000089', title: '民法', lawNum: '明治二十九年法律第八十九号', promulgationDate: '1896-04-27' }], source: 'e-gov' };
  const TEXT = { id: '129AC0000000089', title: '民法', lawNum: '明治二十九年法律第八十九号', markdown: '# 民法\n\n第一条 私権は、公共の福祉に適合しなければならない。', articleCount: 1, source: 'e-gov' };
  /** 2 つのサービスを差し替える（e-Gov には問い合わせない） */
  const mockBoth = () => {
    const search = spyOn(scraper, 'searchLaws').mockResolvedValue(LIST as any);
    const text = spyOn(scraper, 'getLawData').mockResolvedValue(TEXT as any);
    restore.push(() => { search.mockRestore(); text.mockRestore(); });
    return { search, text };
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'search_laws', arguments: args })) as Promise<any>;
  const body = (res: any) => JSON.parse(textOf(res));

  test('keyword: searchLaws に keyword・limit を渡し、応答は旧 search_laws と同じ', async () => {
    const { search, text } = mockBoth();
    const res = await call({ keyword: '民法', limit: 3 });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res)).toEqual(LIST);
    expect(search.mock.calls[0][0]).toEqual({ keyword: '民法', limit: 3 });
    await call({ keyword: '民法' });
    expect(search.mock.calls[1][0]).toEqual({ keyword: '民法' });
    expect(text).not.toHaveBeenCalled();
  });

  test('lawId: getLawData に lawId だけを渡し、応答は旧 get_law_text と同じ', async () => {
    const { search, text } = mockBoth();
    const res = await call({ lawId: '129AC0000000089' });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res)).toEqual(TEXT);
    expect(text.mock.calls[0][0]).toEqual({ lawId: '129AC0000000089' });
    expect(search).not.toHaveBeenCalled();
  });

  test('取得の失敗は、旧ツールと同じ文（Law search error・Law data error）', async () => {
    const s = spyOn(scraper, 'searchLaws').mockRejectedValue(new Error('e-Gov down'));
    const t = spyOn(scraper, 'getLawData').mockRejectedValue(new Error('not found'));
    restore.push(() => { s.mockRestore(); t.mockRestore(); });
    const bad = await call({ keyword: '民法' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe('Law search error: e-Gov down');
    const missing = await call({ lawId: 'nope' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('Law data error: not found');
  });

  // 誤った組み合わせ: 取得しない（外に問い合わせない）
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['keyword と lawId の両方', { keyword: '民法', lawId: '129AC0000000089' }, ['keyword・lawId は 1 つだけ指定してください（指定: keyword, lawId）']],
    ['どちらも無い', {}, ['keyword・lawId のどれか 1 つを指定してください']],
    ['limit だけ', { limit: 5 }, ['keyword・lawId のどれか 1 つを指定してください']],
    ['lawId と limit: 5（既定値の 20 と違う）', { lawId: '129AC0000000089', limit: 5 }, ['limit は keyword を指定したときだけ指定できます（いま: lawId を指定したとき）']],
    ['空の keyword だけ', { keyword: '' }, ['keyword・lawId のどれか 1 つを指定してください']],
  ];

  test('使わない側の "" は指定なし（LLM の空のプレースホルダ）: lawId: "" なら検索、keyword: "" なら条文', async () => {
    const { search, text } = mockBoth();
    const found = await call({ keyword: '民法', lawId: '' });
    expect(found.isError, textOf(found)).toBeFalsy();
    expect(search.mock.calls[0][0]).toEqual({ keyword: '民法' });
    const law = await call({ keyword: '', lawId: '129AC0000000089' });
    expect(law.isError, textOf(law)).toBeFalsy();
    expect(text.mock.calls[0][0]).toEqual({ lawId: '129AC0000000089' });
    expect(search).toHaveBeenCalledTimes(1);
  });
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 取得せず、正しい使い方のエラー`, async () => {
      const spies = mockBoth();
      const res = await call(args);
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      for (const key of ['keyword', 'lawId', 'limit']) expect(text).toContain(key);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    });
  }

  test('スキーマの limit の既定値は 20 で、lawId にその値をそのまま入れても通り、使われない', async () => {
    const { text } = mockBoth();
    await withClient(async (client) => {
      const props = ((await client.listTools()).tools.find((t) => t.name === 'search_laws')!.inputSchema as any).properties;
      expect(props.limit.default).toBe(20);
      const res: any = await client.callTool({ name: 'search_laws', arguments: { lawId: '129AC0000000089', limit: props.limit.default } });
      expect(res.isError, textOf(res)).toBeFalsy();
    });
    expect(text.mock.calls[0][0]).toEqual({ lawId: '129AC0000000089' });
  });
});

describe('search_music: 曲名・アーティスト名の検索も attribute と entity で（旧 search_song・search_artist）', () => {
  const ITUNES = { results: [{ wrapperType: 'track', kind: 'song', trackId: 1, trackName: 'テスト曲', artistName: 'テスト歌手', previewUrl: 'https://example.com/p.m4a', artworkUrl100: 'https://example.com/a/100x100bb.jpg' }] };
  /** iTunes を差し替え、問い合わせた URL を残す */
  const mockItunes = () => {
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => { fetched.push(String(url)); return new Response(JSON.stringify(ITUNES)); }) as unknown as typeof fetch;
    restore.push(() => { globalThis.fetch = realFetch; });
    return fetched;
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'search_music', arguments: args })) as Promise<any>;

  // 旧ツールは、同じサービス（searchSong・searchArtist）を呼んでいた。同じ iTunes の URL を問い合わせ、同じ応答になる
  test.each([
    ['search_song', () => scraper.searchSong({ query: 'テスト曲', country: 'us', limit: 5 }), { query: 'テスト曲', country: 'us', limit: 5, attribute: 'songTerm' }],
    ['search_artist（entity 省略）', () => scraper.searchArtist({ query: 'テスト歌手' }), { query: 'テスト歌手', attribute: 'artistTerm' }],
    ['search_artist（entity: album）', () => scraper.searchArtist({ query: 'テスト歌手', entity: 'album' }), { query: 'テスト歌手', entity: 'album', attribute: 'artistTerm' }],
    ['search_artist（entity: musicArtist）', () => scraper.searchArtist({ query: 'テスト歌手', entity: 'musicArtist' }), { query: 'テスト歌手', entity: 'musicArtist' }],
  ] as Array<[string, () => Promise<unknown>, Record<string, unknown>]>)('旧 %s と同じ iTunes の問い合わせと応答', async (_label, old, args) => {
    const fetched = mockItunes();
    clearCache();
    const before = await old();
    clearCache();
    const res = await call(args);
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(fetched).toHaveLength(2);
    expect(fetched[1]).toBe(fetched[0]);
    expect(JSON.parse(textOf(res))).toEqual(JSON.parse(JSON.stringify(before)));
  });

  test('説明は旧ツールを勧めず、曲名・アーティスト名の引き方と、ライブ日程は別のツールであることを書く', () => {
    const description: string = (createMcpServer({ deferTools: false }) as any)._registeredTools['search_music'].description;
    for (const old of ['search_song', 'search_artist']) expect(description).not.toContain(old);
    for (const word of ['songTerm', 'artistTerm', 'musicArtist', 'ライブ・公演日程']) expect(description).toContain(word);
  });
});

describe('watch: action で登録・確認・一覧・削除（旧 watch_register・watch_check・watch_list・watch_delete）', () => {
  const TARGET = { id: 'w1', url: 'https://example.com/status', title: '当落', selector: '#status' };
  const REGISTERED = { target: TARGET, initialResult: { targetId: 'w1', url: TARGET.url, changed: false, checkedAt: '2026-11-11T00:00:00Z' } };
  const CHECKED = { targetId: 'w1', url: TARGET.url, changed: true, diffSummary: '変化あり', checkedAt: '2026-11-11T01:00:00Z' };
  /** 5 つのサービスを差し替える（取得も DB も使わない） */
  const mockAll = () => {
    const register = spyOn(scraper, 'registerWatchTarget').mockResolvedValue(REGISTERED as any);
    const check = spyOn(scraper, 'checkWatchTarget').mockResolvedValue(CHECKED as any);
    const checkAll = spyOn(scraper, 'checkAllWatchTargets').mockResolvedValue([CHECKED] as any);
    const list = spyOn(scraper, 'listWatchTargets').mockReturnValue([TARGET] as any);
    const del = spyOn(scraper, 'deleteWatchTarget').mockReturnValue(true);
    restore.push(() => { for (const spy of [register, check, checkAll, list, del]) spy.mockRestore(); });
    return { register, check, checkAll, list, del };
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'watch', arguments: args })) as Promise<any>;
  const body = (res: any) => JSON.parse(textOf(res));
  const notCalled = (spies: Record<string, unknown>, except: string[]) => {
    for (const [name, spy] of Object.entries(spies)) if (!except.includes(name)) expect(spy as any, name).not.toHaveBeenCalled();
  };

  test('register: registerWatchTarget に url・title・selector・webhookUrl だけを渡し、応答は旧 watch_register と同じ', async () => {
    const spies = mockAll();
    const args = { url: TARGET.url, title: '当落', selector: '#status', webhookUrl: 'https://example.com/hook' };
    const res = await call({ action: 'register', ...args });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res)).toEqual(REGISTERED);
    expect(spies.register.mock.calls[0][0]).toEqual(args);
    notCalled(spies, ['register']);
  });

  test('check: id があれば旧 watch_check の 1 件、省けば全件の配列', async () => {
    const spies = mockAll();
    expect(body(await call({ action: 'check', id: 'w1' }))).toEqual(CHECKED);
    expect(spies.check.mock.calls[0][0]).toBe('w1');
    expect(body(await call({ action: 'check' }))).toEqual([CHECKED]);
    expect(spies.checkAll).toHaveBeenCalledTimes(1);
    expect(spies.check).toHaveBeenCalledTimes(1);
    notCalled(spies, ['check', 'checkAll']);
  });

  test('list: 旧 watch_list と同じ配列', async () => {
    const spies = mockAll();
    expect(body(await call({ action: 'list' }))).toEqual([TARGET]);
    expect(spies.list).toHaveBeenCalledTimes(1);
    notCalled(spies, ['list']);
  });

  test('delete: 旧 watch_delete と同じ { success, id }', async () => {
    const spies = mockAll();
    expect(body(await call({ action: 'delete', id: 'w1' }))).toEqual({ success: true, id: 'w1' });
    expect(spies.del.mock.calls[0][0]).toBe('w1');
    spies.del.mockReturnValue(false);
    expect(body(await call({ action: 'delete', id: 'none' }))).toEqual({ success: false, id: 'none' });
    notCalled(spies, ['del']);
  });

  test('失敗は、旧ツールと同じ文（Watch register error・Watch check error・Watch list error・Watch delete error）', async () => {
    const spies = mockAll();
    spies.register.mockRejectedValue(new Error('r'));
    spies.checkAll.mockRejectedValue(new Error('c'));
    spies.list.mockImplementation(() => { throw new Error('l'); });
    spies.del.mockImplementation(() => { throw new Error('d'); });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'register', url: TARGET.url }, 'Watch register error: r'],
      [{ action: 'check' }, 'Watch check error: c'],
      [{ action: 'list' }, 'Watch list error: l'],
      [{ action: 'delete', id: 'w1' }, 'Watch delete error: d'],
    ];
    for (const [args, message] of cases) {
      const res = await call(args);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(message);
    }
  });

  test('action が無い・知らない action は、何もせずに入力の誤り', async () => {
    const spies = mockAll();
    for (const args of [{ url: TARGET.url }, { action: 'watch', url: TARGET.url }]) {
      const res = await call(args);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('action');
    }
    notCalled(spies, []);
  });

  // 誤った組み合わせ・足りない引数: 何もしない（登録・取得・削除しない）
  const actionIs = (a: string) => `action が ${a} のとき`;
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['register に url が無い', { action: 'register', title: '当落' }, [`${actionIs('register')}は url が必要です`]],
    ['delete に id が無い', { action: 'delete' }, [`${actionIs('delete')}は id が必要です`]],
    ['delete に空の id', { action: 'delete', id: '' }, [`${actionIs('delete')}は id が必要です`]],
    ['check に url', { action: 'check', url: TARGET.url }, [`url は ${actionIs('register')}だけ指定できます（いま: ${actionIs('check')}）`]],
    ['list に id', { action: 'list', id: 'w1' }, [`id は ${actionIs('check')} か ${actionIs('delete')}だけ指定できます（いま: ${actionIs('list')}）`]],
    ['register に id', { action: 'register', url: TARGET.url, id: 'w1' }, [`id は ${actionIs('check')} か ${actionIs('delete')}だけ指定できます（いま: ${actionIs('register')}）`]],
    ['delete に title・selector・webhookUrl', { action: 'delete', id: 'w1', title: 't', selector: '#a', webhookUrl: 'https://example.com/hook' }, [`title, selector, webhookUrl は ${actionIs('register')}だけ指定できます（いま: ${actionIs('delete')}）`]],
    ['register に空の url', { action: 'register', url: '' }, [`${actionIs('register')}は url が必要です`]],
    ['register に URL として読めない url', { action: 'register', url: 'example.com/status' }, ['url は URL として読めません（いま: "example.com/status"）']],
    ['register に URL として読めない webhookUrl', { action: 'register', url: TARGET.url, webhookUrl: 'hook' }, ['webhookUrl は URL として読めません（いま: "hook"）']],
  ];

  test('使わない引数の "" は指定なし（LLM の空のプレースホルダ）: list に url: ""・webhookUrl: ""、register に webhookUrl: ""', async () => {
    const spies = mockAll();
    expect(body(await call({ action: 'list', url: '', webhookUrl: '', id: '' }))).toEqual([TARGET]);
    const res = await call({ action: 'register', url: TARGET.url, webhookUrl: '' });
    expect(res.isError, textOf(res)).toBeFalsy();
    // 空の webhookUrl は登録しない（旧 watch_register は "" を断っていた）
    expect(spies.register.mock.calls[0][0]).toStrictEqual({ url: TARGET.url, title: undefined, selector: undefined, webhookUrl: undefined });
    notCalled(spies, ['list', 'register']);
  });
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 何もせず、正しい使い方のエラー`, async () => {
      const spies = mockAll();
      const res = await call(args);
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      // 正しい使い方（action の値と、それぞれの引数）を添える
      for (const key of ['register', 'check', 'list', 'delete', 'url', 'title', 'selector', 'webhookUrl', 'id']) expect(text).toContain(key);
      notCalled(spies, []);
    });
  }
});

describe('lookup_hts: htsCode があれば照合、省けば商品の説明から推測（旧 verify_hts_code・predict_hts_code）', () => {
  const VERIFIED = { htsCode: '9503.00.0073', productDescription: 'plastic toy car', verified: true, matchLevel: 'exact', officialDescription: 'Toys', generalRate: 'Free', nearbyCandidates: [], disclaimer: 'd', source: 'usitc-hts' };
  const PREDICTED = { detectedSubheading: '6912.00', bestMatch: { htsCode: '6912.00.4400' }, candidates: [], decisionPoints: [], evidence: { crossStatus: 'ok' } };
  /** 2 つのサービスを差し替える（関税率表も判例も読まない） */
  const mockAll = () => {
    const verify = spyOn(scraper, 'verifyHtsCode').mockResolvedValue(VERIFIED as any);
    const predict = spyOn(scraper, 'predictHtsCode').mockResolvedValue(PREDICTED as any);
    restore.push(() => { verify.mockRestore(); predict.mockRestore(); });
    return { verify, predict };
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'lookup_hts', arguments: args })) as Promise<any>;
  const body = (res: any) => JSON.parse(textOf(res));
  const PREDICT_ARGS = { productName: 'Ceramic Coffee Mug', description: 'Stoneware mug for coffee', material: 'ceramic', productCategory: 'Tableware', targetAge: 'adult', foodContact: true, hasBattery: false } as const;

  test('htsCode と description: verifyHtsCode に htsCode と productDescription（description）だけを渡し、応答は旧 verify_hts_code と同じに mode: verify', async () => {
    const { verify, predict } = mockAll();
    const res = await call({ htsCode: '9503.00.0073', description: 'plastic toy car' });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res)).toEqual({ mode: 'verify', ...VERIFIED });
    expect(verify.mock.calls[0][0]).toEqual({ htsCode: '9503.00.0073', productDescription: 'plastic toy car' });
    expect(predict).not.toHaveBeenCalled();
  });

  test('htsCode なし: predictHtsCode に旧 predict_hts_code の引数だけを渡し、応答は旧 predict_hts_code と同じに mode: predict', async () => {
    const { verify, predict } = mockAll();
    const res = await call(PREDICT_ARGS);
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res)).toEqual({ mode: 'predict', ...PREDICTED });
    expect(predict.mock.calls[0][0]).toEqual(PREDICT_ARGS);
    expect(verify).not.toHaveBeenCalled();
    await call({ productName: 'Green Tea' });
    expect(predict.mock.calls[1][0]).toEqual({ productName: 'Green Tea' });
  });

  test('空の htsCode は、指定しなかったのと同じ（推測）', async () => {
    const { verify, predict } = mockAll();
    for (const htsCode of ['', '  ']) {
      const res = await call({ htsCode, productName: 'Green Tea', material: 'tea leaves' });
      expect(res.isError, textOf(res)).toBeFalsy();
      expect(body(res).mode).toBe('predict');
    }
    expect(predict).toHaveBeenCalledTimes(2);
    expect(verify).not.toHaveBeenCalled();
  });

  test('失敗は、旧ツールと同じ文（HTS code verification error・HTS code prediction error）', async () => {
    const { verify, predict } = mockAll();
    verify.mockRejectedValue(new Error('v'));
    predict.mockRejectedValue(new Error('p'));
    const bad = await call({ htsCode: '9503.00.0073', description: 'toy' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe('HTS code verification error: v');
    const down = await call({ productName: 'Green Tea' });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toBe('HTS code prediction error: p');
  });

  // 誤った組み合わせ・足りない引数: 照合も推測もしない
  const VERIFY = 'htsCode を指定したとき';
  const PREDICT = 'htsCode を省いたとき';
  const HTS = '9503.00.0073';
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['何も無い', {}, [`${PREDICT}は productName が必要です`]],
    ['空の productName', { productName: '  ', description: 'mug' }, [`${PREDICT}は productName が必要です`]],
    ['htsCode に description が無い', { htsCode: HTS }, [`${VERIFY}は description が必要です`]],
    ['htsCode に空の description', { htsCode: HTS, description: ' ' }, [`${VERIFY}は description が必要です`]],
    ['htsCode と productName', { htsCode: HTS, description: 'toy', productName: 'Toy Car' }, [`productName は ${PREDICT}だけ指定できます（いま: ${VERIFY}）`]],
    ['htsCode と material・targetAge・foodContact: false・hasBattery: false', { htsCode: HTS, description: 'toy', material: 'plastic', targetAge: 'child', foodContact: false, hasBattery: false }, [`material, targetAge, foodContact, hasBattery は ${PREDICT}だけ指定できます（いま: ${VERIFY}）`]],
    ['htsCode と productCategory', { htsCode: HTS, description: 'toy', productCategory: 'Toys' }, [`productCategory は ${PREDICT}だけ指定できます（いま: ${VERIFY}）`]],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 照合も推測もせず、正しい使い方のエラー`, async () => {
      const spies = mockAll();
      const res = await call(args);
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      // 正しい使い方（htsCode の有無と、それぞれの引数）を添える
      expect(text).toContain('使い方');
      for (const key of ['htsCode', 'description', 'productName', 'material', 'productCategory', 'targetAge', 'foodContact', 'hasBattery']) expect(text).toContain(key);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    });
  }

  // 推測だけの引数にスキーマの既定値が付いたら、照合のときにその値を断らないよう onlyForMode に defaults を渡すこと
  test('推測だけの引数には、スキーマの既定値が無い（照合で断る値に、既定値の例外は要らない）', async () => {
    await withClient(async (client) => {
      const schema = (await client.listTools()).tools.find((t) => t.name === 'lookup_hts')!.inputSchema as any;
      for (const key of ['productName', 'material', 'productCategory', 'targetAge', 'foodContact', 'hasBattery']) expect(schema.properties[key].default, key).toBeUndefined();
      // htsCode・description・productName の要否は入力の形で決まるので、スキーマでは必須にしない
      expect(schema.required ?? []).toEqual([]);
    });
  });
});

describe('check_regulations: agencies で CPSC と FDA を選び、機関ごとの節で返す（旧 check_cpsc_certificate・check_fda_regulated）', () => {
  const CPSC = { certificateRequired: true, certificateType: 'CCC', eFilingRequired: true, applicableRegulations: [], missingInfo: [], nextActions: [], disclaimer: 'd' };
  const FDA = { fdaRegulatedLikely: false, fdFlag: 'none', possiblePrograms: [], priorNoticeMayApply: false, matchedChapter: '95', confidence: 'chapter-level-estimate', missingInfo: [], nextActions: [], disclaimer: 'd' };
  /** 2 つのサービスを差し替える */
  const mockAll = () => {
    const cpsc = spyOn(scraper, 'checkCpscCertificate').mockResolvedValue(CPSC as any);
    const fda = spyOn(scraper, 'checkFdaRegulated').mockReturnValue(FDA as any);
    restore.push(() => { cpsc.mockRestore(); fda.mockRestore(); });
    return { cpsc, fda };
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'check_regulations', arguments: args })) as Promise<any>;
  const body = (res: any) => JSON.parse(textOf(res));
  const HTS = '9503.00.0073';

  test('既定は両方: cpsc と fda の節は、旧ツールの応答のまま（順序は登録順）', async () => {
    const { cpsc, fda } = mockAll();
    const res = await call({ htsCode: HTS, targetAge: 'child' });
    expect(res.isError, textOf(res)).toBeFalsy();
    const out = body(res);
    expect(Object.keys(out)).toEqual(['agencies', 'cpsc', 'fda']);
    expect(out).toEqual({ agencies: ['cpsc', 'fda'], cpsc: CPSC, fda: FDA });
    expect(cpsc.mock.calls[0][0]).toEqual({ htsCode: HTS, targetAge: 'child' });
    expect(fda.mock.calls[0][0]).toEqual({ htsCode: HTS });
  });

  test('各機関には、旧ツールの引数だけを渡す', async () => {
    const { cpsc, fda } = mockAll();
    const cpscArgs = { targetAge: 'adult', material: '100% polyester', hasBattery: true, batteryType: 'button_coin', fabricSurface: 'plain', fabricWeightOzPerSqYd: 3 } as const;
    await call({ htsCode: HTS, ...cpscArgs, foodContact: true });
    expect(Object.keys(cpsc.mock.calls[0][0] as object).sort()).toEqual(['htsCode', ...Object.keys(cpscArgs)].sort());
    expect(cpsc.mock.calls[0][0]).toEqual({ htsCode: HTS, ...cpscArgs });
    expect(Object.keys(fda.mock.calls[0][0] as object).sort()).toEqual(['foodContact', 'htsCode']);
    expect(fda.mock.calls[0][0]).toEqual({ htsCode: HTS, foodContact: true });
  });

  test('agencies: ["fda"] は FDA だけ（targetAge は要らない）、["cpsc"] は CPSC だけ', async () => {
    const { cpsc, fda } = mockAll();
    expect(body(await call({ htsCode: '6912.00.4400', agencies: ['fda'], foodContact: false }))).toEqual({ agencies: ['fda'], fda: FDA });
    expect(cpsc).not.toHaveBeenCalled();
    expect(body(await call({ htsCode: HTS, agencies: ['cpsc'], targetAge: 'unknown' }))).toEqual({ agencies: ['cpsc'], cpsc: CPSC });
    expect(fda).toHaveBeenCalledTimes(1);
  });

  test('agencies: [] は省略と同じ既定（両方）。空の配列は指定なし', async () => {
    mockAll();
    expect(body(await call({ htsCode: HTS, targetAge: 'adult', agencies: [] })).agencies).toEqual(['cpsc', 'fda']);
  });

  test('agencies の順序と重複は、登録順の 1 つずつにまとめる', async () => {
    mockAll();
    const out = body(await call({ htsCode: HTS, targetAge: 'adult', agencies: ['fda', 'cpsc', 'fda'] }));
    expect(Object.keys(out)).toEqual(['agencies', 'cpsc', 'fda']);
    expect(out.agencies).toEqual(['cpsc', 'fda']);
  });

  test('失敗は、旧ツールと同じ文（CPSC certificate check error・FDA regulation check error）', async () => {
    // 電池の矛盾は、本物の checkCpscCertificate の入力の誤り
    const battery = await call({ htsCode: '8513.10.20.00', agencies: ['cpsc'], targetAge: 'adult', hasBattery: false, batteryType: 'button_coin' });
    expect(battery.isError).toBe(true);
    expect(textOf(battery)).toBe('CPSC certificate check error: batteryType が button_coin なのに hasBattery が false です。どちらかを直してください');
    const fda = spyOn(scraper, 'checkFdaRegulated').mockImplementation(() => { throw new Error('f'); });
    restore.push(() => fda.mockRestore());
    const down = await call({ htsCode: '6912.00.4400', agencies: ['fda'] });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toBe('FDA regulation check error: f');
  });

  // 誤った組み合わせ・足りない引数・使えない agencies: 判定しない
  const WITH_CPSC = 'agencies に cpsc を含むとき';
  const WITH_FDA = 'agencies に fda を含むとき';
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['targetAge が無い（既定は cpsc を含む）', { htsCode: HTS }, [`${WITH_CPSC}（既定）は targetAge が必要です`, 'agencies: ["fda"]']],
    ['agencies: ["cpsc"] で targetAge が無い', { htsCode: HTS, agencies: ['cpsc'], material: 'wood' }, [`${WITH_CPSC}（既定）は targetAge が必要です`]],
    ['agencies に使えない値', { htsCode: HTS, targetAge: 'adult', agencies: ['cpsc', 'usda'] }, ['agencies に使えない値があります: usda']],
    ['agencies: ["fda"] と batteryType', { htsCode: HTS, agencies: ['fda'], batteryType: 'button_coin' }, [`batteryType は ${WITH_CPSC}だけ指定できます（いま: agencies: ["fda"]）`]],
    ['agencies: ["fda"] と targetAge・material・hasBattery: false', { htsCode: HTS, agencies: ['fda'], targetAge: 'adult', material: 'wood', hasBattery: false }, [`targetAge, material, hasBattery は ${WITH_CPSC}だけ指定できます（いま: agencies: ["fda"]）`]],
    ['agencies: ["fda"] と生地の引数', { htsCode: HTS, agencies: ['fda'], fabricSurface: 'raised', fabricWeightOzPerSqYd: 2 }, [`fabricSurface, fabricWeightOzPerSqYd は ${WITH_CPSC}だけ指定できます（いま: agencies: ["fda"]）`]],
    ['agencies: ["cpsc"] と foodContact: false', { htsCode: HTS, agencies: ['cpsc'], targetAge: 'adult', foodContact: false }, [`foodContact は ${WITH_FDA}だけ指定できます（いま: agencies: ["cpsc"]）`]],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 判定せず、正しい使い方のエラー`, async () => {
      const spies = mockAll();
      const res = await call(args);
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      // 正しい使い方（agencies の値と、それぞれの引数）を添える
      expect(text).toContain('使い方');
      for (const key of ['htsCode', 'agencies', 'cpsc', 'fda', 'targetAge', 'material', 'hasBattery', 'batteryType', 'fabricSurface', 'fabricWeightOzPerSqYd', 'foodContact']) expect(text).toContain(key);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    });
  }

  test('空の material は、指定しなかったのと同じ（FDA だけでも断らない）', async () => {
    const { fda } = mockAll();
    const res = await call({ htsCode: HTS, agencies: ['fda'], material: '' });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(fda).toHaveBeenCalledTimes(1);
  });

  test('スキーマ: htsCode だけが必須、agencies の既定値は ["cpsc","fda"] でそのまま入れても通り、機関だけの引数に既定値は無い', async () => {
    mockAll();
    await withClient(async (client) => {
      const schema = (await client.listTools()).tools.find((t) => t.name === 'check_regulations')!.inputSchema as any;
      expect(schema.required).toEqual(['htsCode']);
      expect(schema.properties.agencies.default).toEqual(['cpsc', 'fda']);
      // 機関だけの引数に既定値が付いたら、頼まなかった機関でその値を断らないよう onlyForMode に defaults を渡すこと
      for (const key of ['targetAge', 'material', 'hasBattery', 'batteryType', 'fabricSurface', 'fabricWeightOzPerSqYd', 'foodContact']) expect(schema.properties[key].default, key).toBeUndefined();
      const res: any = await client.callTool({ name: 'check_regulations', arguments: { htsCode: HTS, targetAge: 'adult', agencies: schema.properties.agencies.default } });
      expect(res.isError, textOf(res)).toBeFalsy();
      expect(JSON.parse(textOf(res)).agencies).toEqual(['cpsc', 'fda']);
    });
  });
});

describe('get_country_context: part でレポート・根拠・差分（旧 get_country_context_evidence・get_country_context_updates）', () => {
  const CONTEXT = 'ctx_fixture';
  const PAGE = { contextId: CONTEXT, items: [], totalStored: 0, missingIds: ['evd_x'] };
  const UPDATES = { contextId: CONTEXT, changes: [{ id: 'chg_1', contextId: CONTEXT, observedAt: '2026-11-11T00:00:00.000Z', changeKind: 'added', evidenceId: 'evd_1' }], nextCursor: '2026-11-11T00:00:00.000Z' };
  /** 3 つのサービスを差し替える（DB を読まない）。保存済みのレポートは無い */
  const mockAll = () => {
    const report = spyOn(intelReport, 'getPersistedCountryContext').mockReturnValue(undefined);
    const evidence = spyOn(intelDb, 'getEvidencePage').mockReturnValue(PAGE as any);
    const updates = spyOn(intelDb, 'getContextUpdates').mockReturnValue(UPDATES as any);
    restore.push(() => { report.mockRestore(); evidence.mockRestore(); updates.mockRestore(); });
    return { report, evidence, updates };
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'get_country_context', arguments: args })) as Promise<any>;
  const body = (res: any) => JSON.parse(textOf(res));

  test('part を省くと report: getPersistedCountryContext を呼び、見つからなければ旧 get_country_context と同じエラー', async () => {
    const { report, evidence, updates } = mockAll();
    for (const args of [{ contextId: CONTEXT }, { contextId: CONTEXT, part: 'report' }]) {
      const res = await call(args);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(`Country context not found: ${CONTEXT}`);
    }
    expect(report.mock.calls).toEqual([[CONTEXT], [CONTEXT]]);
    expect(evidence).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
  });

  test('part: evidence は getEvidencePage に ids（evidenceIds）・cursor・limit を渡し、応答は旧 get_country_context_evidence と同じ', async () => {
    const { report, evidence, updates } = mockAll();
    const res = await call({ contextId: CONTEXT, part: 'evidence', evidenceIds: ['evd_x'], cursor: 'c1', limit: 10 });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res)).toEqual(PAGE);
    expect(res.structuredContent).toEqual(PAGE);
    expect(evidence.mock.calls[0]).toEqual([CONTEXT, { ids: ['evd_x'], cursor: 'c1', limit: 10 }]);
    await call({ contextId: CONTEXT, part: 'evidence' });
    expect(evidence.mock.calls[1]).toEqual([CONTEXT, {}]);
    expect(report).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
  });

  test('part: updates は getContextUpdates に contextId・cursor を渡し、応答は旧 get_country_context_updates と同じ', async () => {
    const { report, evidence, updates } = mockAll();
    const res = await call({ contextId: CONTEXT, part: 'updates', cursor: '2026-11-10T00:00:00.000Z' });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res)).toEqual(UPDATES);
    expect(res.structuredContent).toEqual(UPDATES);
    expect(updates.mock.calls[0]).toEqual([CONTEXT, '2026-11-10T00:00:00.000Z']);
    expect(report).not.toHaveBeenCalled();
    expect(evidence).not.toHaveBeenCalled();
  });

  test('失敗は、旧ツールと同じ文（Country intelligence error）', async () => {
    const { evidence, updates } = mockAll();
    evidence.mockImplementation(() => { throw new RangeError('Invalid page cursor'); });
    updates.mockImplementation(() => { throw new RangeError('Invalid updates cursor'); });
    const bad = await call({ contextId: CONTEXT, part: 'evidence', cursor: 'x' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe('Country intelligence error: Invalid page cursor');
    const down = await call({ contextId: CONTEXT, part: 'updates', cursor: 'x' });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toBe('Country intelligence error: Invalid updates cursor');
  });

  test('part の形に合わない応答は返さない（旧ツールの outputSchema と同じ検査）', async () => {
    const { evidence } = mockAll();
    evidence.mockReturnValue({ contextId: CONTEXT } as any);
    const res = await call({ contextId: CONTEXT, part: 'evidence' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toStartWith('Country intelligence error: invalid evidence payload');
    expect(res.structuredContent).toBeUndefined();
  });

  // 誤った組み合わせ: DB を読まない
  const partIs = (part: string) => `part が ${part} のとき`;
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['report（既定）に evidenceIds', { contextId: CONTEXT, evidenceIds: ['evd_1'] }, [`evidenceIds は ${partIs('evidence')}だけ指定できます（いま: ${partIs('report')}）`]],
    ['report に limit: 10（既定値の 40 と違う）', { contextId: CONTEXT, part: 'report', limit: 10 }, [`limit は ${partIs('evidence')}だけ指定できます（いま: ${partIs('report')}）`]],
    ['report に cursor', { contextId: CONTEXT, cursor: 'c1' }, [`cursor は ${partIs('evidence')} か ${partIs('updates')}だけ指定できます（いま: ${partIs('report')}）`]],
    ['updates に evidenceIds・limit', { contextId: CONTEXT, part: 'updates', evidenceIds: ['evd_1'], limit: 5 }, [`evidenceIds, limit は ${partIs('evidence')}だけ指定できます（いま: ${partIs('updates')}）`]],
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
      // 正しい使い方（part の値と、それぞれの引数）を添える
      expect(text).toContain('使い方');
      for (const key of ['contextId', 'part', 'report', 'evidence', 'updates', 'evidenceIds', 'cursor', 'limit']) expect(text).toContain(key);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    });
  }

  test('空の cursor・evidenceIds は、指定しなかったのと同じ（report でも断らない）', async () => {
    const { report } = mockAll();
    const res = await call({ contextId: CONTEXT, cursor: '', evidenceIds: [] });
    expect(textOf(res)).toBe(`Country context not found: ${CONTEXT}`);
    expect(report).toHaveBeenCalledTimes(1);
  });

  test('スキーマ: contextId だけが必須、part の既定値は report、limit の既定値は 40 で、その値をそのまま入れても通る', async () => {
    const { report, updates } = mockAll();
    await withClient(async (client) => {
      const schema = (await client.listTools()).tools.find((t) => t.name === 'get_country_context')!.inputSchema as any;
      expect(schema.required).toEqual(['contextId']);
      expect(schema.properties.part.default).toBe('report');
      expect(schema.properties.part.enum).toEqual(['report', 'evidence', 'updates']);
      expect(schema.properties.limit.default).toBe(40);
      // evidence だけの引数に既定値が増えたら、onlyForMode の defaults に足すこと
      expect(schema.properties.evidenceIds.default).toBeUndefined();
      expect(schema.properties.cursor.default).toBeUndefined();
      const asReport: any = await client.callTool({ name: 'get_country_context', arguments: { contextId: CONTEXT, part: schema.properties.part.default, limit: schema.properties.limit.default } });
      expect(textOf(asReport)).toBe(`Country context not found: ${CONTEXT}`);
      const asUpdates: any = await client.callTool({ name: 'get_country_context', arguments: { contextId: CONTEXT, part: 'updates', limit: schema.properties.limit.default } });
      expect(asUpdates.isError, textOf(asUpdates)).toBeFalsy();
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0]).toEqual([CONTEXT, undefined]);
  });
});

describe('get_youtube: url が動画なら字幕・説明文、チャンネルなら最新の動画（旧 get_youtube_transcript・get_youtube_channel）', () => {
  const VIDEO = { found: true, videoId: 'Ab-_0123456', title: 'テストの動画', transcript: { status: 'ok', source: 'auto', text: '[0:00] てすと' }, availableTracks: [] };
  const CHANNEL = { found: true, channelId: 'UC0000000000000000000001', title: 'テストチャンネル', url: 'https://www.youtube.com/channel/UC0000000000000000000001', videos: [] };
  /** 2 つのサービスを差し替える（YouTube には問い合わせない） */
  const mockBoth = () => {
    const transcript = spyOn(youtube, 'getYoutubeTranscript').mockResolvedValue(VIDEO as any);
    const channel = spyOn(youtube, 'getYoutubeChannel').mockResolvedValue(CHANNEL as any);
    restore.push(() => { transcript.mockRestore(); channel.mockRestore(); });
    return { transcript, channel };
  };
  const call = (args: Record<string, unknown>) => withClient((client) => client.callTool({ name: 'get_youtube', arguments: args })) as Promise<any>;
  const body = (res: any) => JSON.parse(textOf(res));

  test('動画の url: getYoutubeTranscript に旧 get_youtube_transcript の引数だけを渡し、応答は旧ツールと同じに mode: video', async () => {
    const { transcript, channel } = mockBoth();
    const res = await call({ url: 'https://youtu.be/Ab-_0123456?t=90', lang: 'en', fromSec: 60, maxChars: 2000, noCache: true });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res)).toEqual({ mode: 'video', ...VIDEO });
    expect(Object.keys(body(res))[0]).toBe('mode');
    expect(transcript.mock.calls[0][0]).toEqual({ url: 'https://youtu.be/Ab-_0123456?t=90', lang: 'en', fromSec: 60, maxChars: 2000, noCache: true });
    await call({ url: 'Ab-_0123456' });
    expect(transcript.mock.calls[1][0]).toEqual({ url: 'Ab-_0123456' });
    expect(channel).not.toHaveBeenCalled();
  });

  test('チャンネルの url: getYoutubeChannel に旧 get_youtube_channel の引数だけを渡し、応答は旧ツールと同じに mode: channel', async () => {
    const { transcript, channel } = mockBoth();
    const res = await call({ url: '@YouTube', limit: 5, noCache: true });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(body(res)).toEqual({ mode: 'channel', ...CHANNEL });
    expect(channel.mock.calls[0][0]).toEqual({ url: '@YouTube', limit: 5, noCache: true });
    for (const url of ['UC0000000000000000000001', 'https://www.youtube.com/channel/UC0000000000000000000001', 'https://www.youtube.com/c/Example', 'https://www.youtube.com/user/Example']) {
      expect(body(await call({ url })).mode).toBe('channel');
    }
    expect(channel.mock.calls[1][0]).toEqual({ url: 'UC0000000000000000000001' });
    expect(transcript).not.toHaveBeenCalled();
  });

  test('失敗は、旧ツールと同じ文（YouTube error）', async () => {
    const { transcript, channel } = mockBoth();
    transcript.mockRejectedValue(new Error('YouTube request failed: HTTP 429'));
    channel.mockRejectedValue(new Error('YouTube request failed: feed HTTP 500'));
    const bad = await call({ url: 'https://www.youtube.com/watch?v=Ab-_0123456' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe('YouTube error: YouTube request failed: HTTP 429');
    const down = await call({ url: 'https://www.youtube.com/@YouTube' });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toBe('YouTube error: YouTube request failed: feed HTTP 500');
  });

  // 誤った組み合わせ・読めない url: YouTube に問い合わせない
  const isVideo = 'url が動画のとき';
  const isChannel = 'url がチャンネルのとき';
  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['動画でもチャンネルでもない url', { url: 'https://example.com/watch?v=Ab-_0123456' }, ['url が YouTube の動画でもチャンネルでもありません']],
    ['再生リストの url', { url: 'https://www.youtube.com/playlist?list=PL1234567890' }, ['url が YouTube の動画でもチャンネルでもありません']],
    ['空白だけの url', { url: '  ' }, ['url が YouTube の動画でもチャンネルでもありません']],
    ['動画に limit: 5（既定値の 10 と違う）', { url: 'Ab-_0123456', limit: 5 }, [`limit は ${isChannel}だけ指定できます（いま: ${isVideo}）`]],
    ['チャンネルに lang・fromSec・maxChars', { url: '@YouTube', lang: 'en', fromSec: 30, maxChars: 1000 }, [`lang, fromSec, maxChars は ${isVideo}だけ指定できます（いま: ${isChannel}）`]],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 取得せず、正しい使い方のエラー`, async () => {
      const spies = mockBoth();
      const res = await call(args);
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).not.toContain('モード');
      // 正しい使い方（受け付ける url の形と、それぞれの引数）を添える
      expect(text).toContain('使い方');
      for (const key of ['watch', 'youtu.be', 'shorts', 'live', 'embed', '11 文字', '@ハンドル', '/channel/UC', '/c/', '/user/', 'lang', 'fromSec', 'maxChars', 'limit']) expect(text).toContain(key);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    });
  }

  test('スキーマ: url だけが必須、既定値（lang "ja"・fromSec 0・maxChars・limit 10）をほかの形の url にそのまま入れても通り、使われない', async () => {
    const { transcript, channel } = mockBoth();
    await withClient(async (client) => {
      const schema = (await client.listTools()).tools.find((t) => t.name === 'get_youtube')!.inputSchema as any;
      expect(schema.required).toEqual(['url']);
      const d = (key: string) => schema.properties[key].default;
      expect([d('lang'), d('fromSec'), d('maxChars'), d('limit')]).toEqual(['ja', 0, DEFAULT_MAX_CHARS, 10]);
      const asVideo: any = await client.callTool({ name: 'get_youtube', arguments: { url: 'Ab-_0123456', limit: d('limit') } });
      expect(asVideo.isError, textOf(asVideo)).toBeFalsy();
      const asChannel: any = await client.callTool({ name: 'get_youtube', arguments: { url: '@YouTube', lang: d('lang'), fromSec: d('fromSec'), maxChars: d('maxChars') } });
      expect(asChannel.isError, textOf(asChannel)).toBeFalsy();
    });
    expect(transcript.mock.calls[0][0]).toEqual({ url: 'Ab-_0123456' });
    expect(channel.mock.calls[0][0]).toEqual({ url: '@YouTube' });
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
    ['get_elevation', 'get_place_info', 'disaster'],
    ['標高', 'get_place_info', 'disaster'],
    ['海抜', 'get_place_info', 'disaster'],
    ['search_disaster_warnings', 'get_disaster_info', 'disaster'],
    ['search_earthquake', 'get_disaster_info', 'disaster'],
    ['特別警報', 'get_disaster_info', 'disaster'],
    ['震度', 'get_disaster_info', 'disaster'],
    ['get_law_text', 'search_laws', 'gov'],
    ['条文', 'search_laws', 'gov'],
    ['search_song', 'search_music', 'music'],
    ['search_artist', 'search_music', 'music'],
    ['歌手', 'search_music', 'music'],
    ['watch_register', 'watch', 'watch'],
    ['watch_check', 'watch', 'watch'],
    ['watch_list', 'watch', 'watch'],
    ['watch_delete', 'watch', 'watch'],
    ['predict_hts_code', 'lookup_hts', 'trade'],
    ['verify_hts_code', 'lookup_hts', 'trade'],
    ['HTS推測', 'lookup_hts', 'trade'],
    ['実在確認', 'lookup_hts', 'trade'],
    ['check_cpsc_certificate', 'check_regulations', 'trade'],
    ['check_fda_regulated', 'check_regulations', 'trade'],
    ['Prior Notice', 'check_regulations', 'trade'],
    ['適合証明書', 'check_regulations', 'trade'],
    ['get_country_context_evidence', 'get_country_context', 'intel'],
    ['get_country_context_updates', 'get_country_context', 'intel'],
    ['根拠', 'get_country_context', 'intel'],
    ['差分', 'get_country_context', 'intel'],
    ['get_youtube_transcript', 'get_youtube', 'youtube'],
    ['get_youtube_channel', 'get_youtube', 'youtube'],
    ['字幕', 'get_youtube', 'youtube'],
    ['文字起こし', 'get_youtube', 'youtube'],
    ['新着動画', 'get_youtube', 'youtube'],
  ])('%s → %s', async (oldName, newName, category) => {
    const server = createMcpServer({ deferTools: true });
    const res = await (server as any)._registeredTools['search_tools'].handler({ query: oldName, detail: 'names', activate: false });
    expect(res.content[0].text).toMatch(new RegExp(`^- ${newName} \\[${category}\\]`, 'm'));
  });
});
