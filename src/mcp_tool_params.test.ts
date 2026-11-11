import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import * as scraper from './scraper.js';
import * as cleaner from './response_cleaner.js';
import { BatchScrapeRequestSchema, ScrapeRequestSchema } from './types.js';

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

// v4.0.0 の MCP の引数（docs/superpowers/specs/2026-11-04-v4-extraction-and-params-design.md の 5）。
// v5.0.0 で scrape に旧 scrape_batch の urls・concurrency・webhookUrl を、crawl_site に旧 map_site の listOnly・limit・since・until を足した
const expected: Record<string, string[]> = {
  scrape: ['url', 'urls', 'concurrency', 'webhookUrl', 'maxChars', 'mode', 'formats', 'fullPage', 'stripLinks', 'maskPii', 'query', 'onlyMainContent', 'headers', 'verbose', 'keepDataImages', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
  crawl_site: ['url', 'listOnly', 'limit', 'since', 'until', 'maxPages', 'maxChars', 'includePatterns', 'excludePatterns', 'formats', 'query', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
};

/** 手元の MCP サーバーに 1 つのクライアントでつなぎ、fn を呼んで閉じる */
async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false });
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
  test('scrape・crawl_site の引数が決めたとおり、search_deep は 26 個', async () => {
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
    ['url も urls も無い', {}, ['url', 'urls']],
    ['url と urls の両方', { url: 'https://example.com/a', urls: ['https://example.com/b'] }, ['url, urls']],
    ['url に concurrency', { url: 'https://example.com/a', concurrency: 2 }, ['concurrency', '"batch"']],
    ['url に webhookUrl', { url: 'https://example.com/a', webhookUrl: 'https://example.com/hook' }, ['webhookUrl', '"batch"']],
    ['urls に fullPage', { urls: ['https://example.com/a'], fullPage: false }, ['fullPage', '"single"']],
    ['urls に keepDataImages', { urls: ['https://example.com/a'], keepDataImages: true }, ['keepDataImages', '"single"']],
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
      // 正しい使い方を添える
      expect(text).toContain('url');
      expect(text).toContain('urls');
      expect(single).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    });
  }
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

  const wrong: Array<[string, Record<string, unknown>, string[]]> = [
    ['listOnly: true に maxPages', { listOnly: true, maxPages: 3 }, ['maxPages', '"crawl"']],
    ['listOnly: true に query・formats', { listOnly: true, query: 'q', formats: ['markdown'] }, ['formats', 'query', '"crawl"']],
    ['listOnly: true に includePatterns', { listOnly: true, includePatterns: ['/docs/**'] }, ['includePatterns', '"crawl"']],
    ['listOnly を省いて limit', { limit: 5 }, ['limit', '"list"']],
    ['listOnly: false に since・until', { listOnly: false, since: '2026-05-01', until: '2026-10-01' }, ['since', 'until', '"list"']],
  ];
  for (const [label, args, mentions] of wrong) {
    test(`${label}: 取得せず、正しい使い方のエラー`, async () => {
      const { crawl, map } = mockBoth();
      const res: any = await withClient((client) => client.callTool({ name: 'crawl_site', arguments: { url: 'https://example.com/', ...args } }));
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('入力の誤り');
      for (const m of mentions) expect(text).toContain(m);
      expect(text).toContain('listOnly');
      expect(crawl).not.toHaveBeenCalled();
      expect(map).not.toHaveBeenCalled();
    });
  }
});

describe('旧名で search_tools を引くと、統合先が見つかる', () => {
  test.each([['scrape_batch', 'scrape'], ['map_site', 'crawl_site']])('%s → %s', async (oldName, newName) => {
    const server = createMcpServer({ deferTools: true });
    const res = await (server as any)._registeredTools['search_tools'].handler({ query: oldName, detail: 'names', activate: false });
    expect(res.content[0].text).toMatch(new RegExp(`^- ${newName} \\[web\\]`, 'm'));
  });
});
