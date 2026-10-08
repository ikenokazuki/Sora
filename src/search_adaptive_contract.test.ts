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
    expect(properties.diversityWeight.type).toBe('number');
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
