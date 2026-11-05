import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as scraper from './scraper.js';
import { searchRoutes } from './routes/search.js';
import { createMcpServer } from './mcp.js';
import { generateOpenApiDocument, IntegratedSearchRequestSchema } from './types.js';

describe('adaptive deep search public contract', () => {
  let searchSpy: ReturnType<typeof spyOn<typeof scraper, 'integratedSearch'>>;
  beforeEach(() => {
    searchSpy = spyOn(scraper, 'integratedSearch').mockResolvedValue({
      query: 'fixture', source: 'integrated', results: [], count: 0, cached: false,
    });
  });
  afterEach(() => searchSpy.mockRestore());

  test('shared schema retains opt-in values and documents their bounds', () => {
    const parsed = IntegratedSearchRequestSchema.parse({ query: 'fixture', adaptiveScrape: true, scrapeBudget: 12 });
    expect(parsed).toMatchObject({ adaptiveScrape: true, scrapeBudget: 12 });
    const properties = generateOpenApiDocument().paths['/search'].post.requestBody.content['application/json'].schema.properties;
    expect(properties.adaptiveScrape.type).toBe('boolean');
    expect(properties.scrapeBudget.type).toBe('integer');
    expect(properties.scrapeBudget.minimum).toBe(1);
    expect(properties.scrapeBudget.maximum).toBe(20);
  });

  test.each(['/search', '/search/integrated'])('%s forwards the validated adaptive options', async (path) => {
    const response = await searchRoutes.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'fixture', adaptiveScrape: true, scrapeBudget: 12 }),
    });
    expect(response.status).toBe(200);
    expect(searchSpy.mock.calls[0][0]).toMatchObject({ adaptiveScrape: true, scrapeBudget: 12 });
  });

  test.each([
    { adaptiveScrape: 'true' }, { scrapeBudget: 0 }, { scrapeBudget: 21 },
    { scrapeBudget: 1.5 }, { scrapeBudget: '8' },
  ])('REST rejects invalid adaptive options %j before searching', async (options) => {
    const response = await searchRoutes.request('/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'fixture', ...options }),
    });
    expect(response.status).toBe(400);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(IntegratedSearchRequestSchema.safeParse({ query: 'fixture', ...options }).success).toBe(false);
  });

  test.each([
    { limit: -3 }, { limit: 0 }, { limit: 21 }, { highlightMaxCount: 99 }, { formats: ['bogus'] },
    { updated: 'month' }, { maxChars: 999999 }, { realtimeSort: 'old' }, { includeDomains: 'a.example' },
  ])('REST validates %j with the shared schema before searching', async (options) => {
    const response = await searchRoutes.request('/search/deep', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'fixture', ...options }),
    });
    expect(response.status).toBe(400);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  test('REST treats a top-level null as not set, but a null query is still missing', async () => {
    const post = (body: unknown) => searchRoutes.request('/search/deep', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const ok = await post({ query: 'fixture', limit: null, formats: null, includeMedia: null, realtimeFocus: null, maxTotalChars: null, responseMode: null });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).responseMode).toBe('evidence');
    expect(['limit', 'formats', 'includeMedia', 'realtimeFocus'].filter((k) => k in searchSpy.mock.calls[0][0])).toEqual([]);
    const missing = await post({ query: null, limit: 3 });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe('query is required');
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  test('REST keeps the earlier error messages', async () => {
    const error = async (body: unknown) => ((await (await searchRoutes.request('/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()) as { error: string }).error;
    expect(await error({})).toBe('query is required');
    expect(await error({ query: 'fixture', responseMode: 'short' })).toBe('responseMode must be "full" or "evidence"');
    expect(await error({ query: 'fixture', realtimeLimit: 0 })).toBe('realtimeLimit must be an integer between 1 and 100');
    expect(await error({ query: 'fixture', maxTotalChars: 10 })).toBe('maxTotalChars must be an integer between 1000 and 500000');
    expect(await error({ query: 'fixture', limit: 50 })).toStartWith('limit:');
  });

  test('MCP search_deep forwards opt-in settings to retrieval', async () => {
    const server = createMcpServer();
    try {
      const tool = (server as any)._registeredTools.search_deep;
      const args = tool.inputSchema.parse({ query: 'fixture', adaptiveScrape: true, scrapeBudget: 12 });
      await tool.handler(args);
      expect(searchSpy.mock.calls[0][0]).toMatchObject({ adaptiveScrape: true, scrapeBudget: 12 });
    } finally {
      await server.close();
    }
  });

  test('includeMedia: false is validated and applied to the REST response, and exposed in OpenAPI and MCP', async () => {
    searchSpy.mockResolvedValue({
      query: 'fixture', source: 'integrated', count: 1, cached: false,
      results: [{ url: 'https://a.example/', ogImage: 'https://a.example/og.png', markdown: '本文' }],
    });
    const post = (body: unknown) => searchRoutes.request('/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const kept: any = await (await post({ query: 'fixture' })).json();
    expect(kept.results[0].ogImage).toBe('https://a.example/og.png');
    // 指定が無いときは integratedSearch に includeMedia を渡さない（ページを取る側の既定のまま）
    expect(searchSpy.mock.calls[0][0].includeMedia).toBeUndefined();
    const stripped: any = await (await post({ query: 'fixture', includeMedia: false })).json();
    expect(stripped.results[0].ogImage).toBeUndefined();
    expect(stripped.results[0].markdown).toBe('本文');
    // false は応答を作る段階だけでなく、integratedSearch（ページを取る scrapeUrl）にも渡す
    expect(searchSpy.mock.calls.at(-1)![0]).toMatchObject({ includeMedia: false });
    for (const includeMedia of ['false', 0]) {
      expect((await post({ query: 'fixture', includeMedia })).status).toBe(400);
    }
    const properties = generateOpenApiDocument().paths['/search'].post.requestBody.content['application/json'].schema.properties;
    expect(properties.includeMedia.type).toBe('boolean');
    expect(properties.includeMedia.default).toBe(true);
    const server = createMcpServer();
    try {
      const tool = (server as any)._registeredTools.search_deep;
      const result = await tool.handler(tool.inputSchema.parse({ query: 'fixture', includeMedia: false }));
      expect(JSON.parse(result.content[0].text).results[0].ogImage).toBeUndefined();
      expect(searchSpy.mock.calls.at(-1)![0]).toMatchObject({ includeMedia: false });
    } finally {
      await server.close();
    }
  });

  test('scrapeDeadlineMs is validated and forwarded by REST and MCP', async () => {
    const ok = await searchRoutes.request('/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'fixture', scrapeDeadlineMs: 6000 }),
    });
    expect(ok.status).toBe(200);
    expect(searchSpy.mock.calls[0][0]).toMatchObject({ scrapeDeadlineMs: 6000 });
    for (const scrapeDeadlineMs of [-1, 1.5, '5000', 200_000]) {
      const bad = await searchRoutes.request('/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'fixture', scrapeDeadlineMs }),
      });
      expect(bad.status).toBe(400);
    }
    const server = createMcpServer();
    try {
      const tool = (server as any)._registeredTools.search_deep;
      await tool.handler(tool.inputSchema.parse({ query: 'fixture', scrapeDeadlineMs: 0 }));
      expect(searchSpy.mock.calls.at(-1)![0]).toMatchObject({ scrapeDeadlineMs: 0 });
    } finally {
      await server.close();
    }
  });

  test.each([
    [{}, 'evidence'],
    [{ responseMode: null }, 'evidence'],
    [{ responseMode: 'full' }, 'full'],
  ])('REST %j answers in %s mode (evidence is the default)', async (options, mode) => {
    searchSpy.mockResolvedValue({
      query: 'fixture', source: 'integrated', count: 1, cached: false,
      results: [{
        title: 'Fixture', url: 'https://example.com/article', source: 'web', snippet: 'search snippet',
        markdown: '# Full source\n\n## Target\nAnswer evidence', highlights: ['## Target\n\nAnswer evidence'],
      }],
    } as any);
    const response = await searchRoutes.request('/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'fixture', ...options }),
    });
    expect(response.status).toBe(200);
    const json = await response.json() as any;
    expect(json.responseMode).toBe(mode === 'evidence' ? 'evidence' : undefined);
    expect(json.results[0].markdown === undefined).toBe(mode === 'evidence');
    expect(json.results[0].highlights).toEqual(['## Target\n\nAnswer evidence']);
  });

  test('omitting options preserves internal defaults', async () => {
    const response = await searchRoutes.request('/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'fixture' }),
    });
    expect(response.status).toBe(200);
    expect(searchSpy.mock.calls[0][0].adaptiveScrape).toBeUndefined();
    expect(searchSpy.mock.calls[0][0].scrapeBudget).toBeUndefined();
  });
});
