import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as scraper from './scraper.js';
import { createMcpServer } from './mcp.js';
import { BatchScrapeRequestSchema } from './types.js';

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

  test('REST batch keeps every MCP batch option and enforces limits', () => {
    const parsed = BatchScrapeRequestSchema.parse({ urls: ['https://example.com'], maskPii: true, retries: 1, headers: { a: 'b' }, chunkMarkdown: true, noCache: true });
    expect(parsed).toMatchObject({ maskPii: true, retries: 1, headers: { a: 'b' }, chunkMarkdown: true, noCache: true });
    expect(BatchScrapeRequestSchema.safeParse({ urls: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`) }).success).toBe(false);
    expect(BatchScrapeRequestSchema.safeParse({ urls: ['https://example.com'], concurrency: 6 }).success).toBe(false);
  });
});
