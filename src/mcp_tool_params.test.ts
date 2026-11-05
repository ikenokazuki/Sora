import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import * as scraper from './scraper.js';
import { BatchScrapeRequestSchema, ScrapeRequestSchema } from './types.js';

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

// v4.0.0 の MCP の引数（docs/superpowers/specs/2026-11-04-v4-extraction-and-params-design.md の 5）
const expected: Record<string, string[]> = {
  scrape: ['url', 'maxChars', 'mode', 'formats', 'fullPage', 'stripLinks', 'maskPii', 'query', 'onlyMainContent', 'headers', 'verbose', 'keepDataImages', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
  scrape_batch: ['urls', 'concurrency', 'maxChars', 'mode', 'formats', 'headers', 'query', 'stripLinks', 'maskPii', 'webhookUrl', 'onlyMainContent', 'verbose', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
  crawl_site: ['url', 'maxPages', 'maxChars', 'includePatterns', 'excludePatterns', 'formats', 'query', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
};

describe('MCP のツールの引数', () => {
  test('scrape・scrape_batch・crawl_site の引数が決めたとおり、search_deep は 26 個', async () => {
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

  test('scrape_batch に CSS セレクタの引数を送っても通り、scrapeBatchUrls には届かない', async () => {
    const spy = spyOn(scraper, 'scrapeBatchUrls').mockResolvedValue({ total: 1, successful: 1, failed: 0, results: [], errors: [] } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'tool-params', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const res = await client.callTool({ name: 'scrape_batch', arguments: { urls: ['https://example.com'], selectors: { a: 'h1' }, clipSelector: '#a', removeSelectors: ['.ad'] } });
      expect(res.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
    const args = spy.mock.calls[0][0] as Record<string, unknown>;
    for (const field of ['selectors', 'clipSelector', 'removeSelectors']) expect(args[field], field).toBeUndefined();
  });
});
