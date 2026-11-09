import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as scraper from './scraper.js';
import { createMcpServer } from './mcp.js';
import { BatchScrapeRequestSchema, CrawlRequestSchema, ScrapeRequestSchema } from './types.js';

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

describe('scrape inputs reach the implementation', () => {
  test('MCP scrape forwards fullPage', async () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue({ url: 'https://example.com', title: 't', content: 'c', isTruncated: false, contentType: 'text/html', source: 'web' } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'scrape-inputs', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      await client.callTool({ name: 'scrape', arguments: { url: 'https://example.com', formats: ['screenshot'], fullPage: false } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(spy.mock.calls[0][0]).toMatchObject({ fullPage: false });
  });

  test('MCP scrape forwards includeMedia', async () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue({ url: 'https://example.com', title: 't', content: 'c', isTruncated: false, contentType: 'text/html', source: 'web' } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'scrape-inputs', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      await client.callTool({ name: 'scrape', arguments: { url: 'https://example.com', includeMedia: false } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(spy.mock.calls[0][0]).toMatchObject({ includeMedia: false });
  });

  test('MCP scrape forwards responseMode', async () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue({ url: 'https://example.com', title: 't', content: 'c', isTruncated: false, contentType: 'text/html', source: 'web' } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'scrape-inputs', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      await client.callTool({ name: 'scrape', arguments: { url: 'https://example.com', query: '開場時間', responseMode: 'evidence' } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(spy.mock.calls[0][0]).toMatchObject({ responseMode: 'evidence' });
  });

  test('MCP scrape と scrape_batch は verbose を scrapeUrl・scrapeBatchUrls にも渡す（highlightDiagnostics が付く）', async () => {
    const scrapeSpy = spyOn(scraper, 'scrapeUrl').mockResolvedValue({ url: 'https://example.com', title: 't', content: 'c', isTruncated: false, contentType: 'text/html', source: 'web' } as any);
    const batchSpy = spyOn(scraper, 'scrapeBatchUrls').mockResolvedValue({ total: 0, successful: 0, failed: 0, results: [], errors: [] } as any);
    restore.push(() => scrapeSpy.mockRestore(), () => batchSpy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'scrape-inputs', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      await client.callTool({ name: 'scrape', arguments: { url: 'https://example.com', query: '開場時間', verbose: true } });
      await client.callTool({ name: 'scrape_batch', arguments: { urls: ['https://example.com'], query: '開場時間', verbose: true } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(scrapeSpy.mock.calls[0][0]).toMatchObject({ verbose: true });
    expect(batchSpy.mock.calls[0][0]).toMatchObject({ verbose: true });
  });

  test('MCP scrape_batch と crawl_site も responseMode を渡す', async () => {
    const batchSpy = spyOn(scraper, 'scrapeBatchUrls').mockResolvedValue({ total: 0, successful: 0, failed: 0, results: [], errors: [] } as any);
    const crawlSpy = spyOn(scraper, 'crawlSiteUrl').mockResolvedValue({ baseUrl: 'https://example.com', total: 0, results: [], errors: [] } as any);
    restore.push(() => batchSpy.mockRestore(), () => crawlSpy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'scrape-inputs', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      await client.callTool({ name: 'scrape_batch', arguments: { urls: ['https://example.com'], query: '開場時間', responseMode: 'evidence' } });
      await client.callTool({ name: 'crawl_site', arguments: { url: 'https://example.com', query: '開場時間', responseMode: 'evidence' } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(batchSpy.mock.calls[0][0]).toMatchObject({ responseMode: 'evidence' });
    expect(crawlSpy.mock.calls[0][0]).toMatchObject({ responseMode: 'evidence' });
  });

  test('REST の scrape・batch・crawl のスキーマは responseMode に full と evidence だけを許す', () => {
    for (const schema of [ScrapeRequestSchema, BatchScrapeRequestSchema, CrawlRequestSchema]) {
      const input = schema === BatchScrapeRequestSchema ? { urls: ['https://example.com'] } : { url: 'https://example.com' };
      expect(schema.parse({ ...input, responseMode: 'evidence' })).toMatchObject({ responseMode: 'evidence' });
      expect(schema.safeParse({ ...input, responseMode: 'highlights' }).success).toBe(false);
    }
  });

  test('REST batch keeps every MCP batch option and enforces limits', () => {
    const parsed = BatchScrapeRequestSchema.parse({ urls: ['https://example.com'], maskPii: true, headers: { a: 'b' }, noCache: true });
    expect(parsed).toMatchObject({ maskPii: true, headers: { a: 'b' }, noCache: true });
    expect(BatchScrapeRequestSchema.safeParse({ urls: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`) }).success).toBe(false);
    expect(BatchScrapeRequestSchema.safeParse({ urls: ['https://example.com'], concurrency: 6 }).success).toBe(false);
  });
});
