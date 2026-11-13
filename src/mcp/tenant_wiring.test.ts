import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp.js';
import * as scraper from '../scraper.js';
import * as searchWebFormats from '../search_web_formats.js';

/**
 * MCP のセッションの tenant（鍵が決めたもの）を、map_site（crawl_site の listOnly）・search_web が、取得と結果のキャッシュに渡す（設計 5。穴 17）。
 * 引数では、別の tenant を名乗れない。
 */

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

const asTenant = async <T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false, sessionState: { activatedTools: new Set<string>(), tenantId } });
  const client = new Client({ name: 'tenant-wiring', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
};

describe('セッションの tenant を渡す', () => {
  test('crawl_site の listOnly（map_site）: mapSiteUrl に、セッションの tenant を渡す。引数の tenantId は無視される', async () => {
    const spy = spyOn(scraper, 'mapSiteUrl').mockResolvedValue({ url: 'https://example.com/', links: [], count: 0, source: 'links' });
    restore.push(() => spy.mockRestore());
    await asTenant('name:alice', (client) => client.callTool({ name: 'crawl_site', arguments: { url: 'https://example.com/', listOnly: true, tenantId: 'name:bob' } }));
    expect(spy.mock.calls[0][0]).toMatchObject({ url: 'https://example.com/', tenantId: 'name:alice' });
  });

  test('search_web: searchWebWithFormats に、セッションの tenant を渡す。引数の tenantId は無視される', async () => {
    const spy = spyOn(searchWebFormats, 'searchWebWithFormats').mockResolvedValue({ items: [], count: 0 });
    restore.push(() => spy.mockRestore());
    await asTenant('name:alice', (client) => client.callTool({ name: 'search_web', arguments: { query: 'q', formats: ['markdown'], tenantId: 'name:bob' } }));
    expect(spy.mock.calls[0][1]).toBe('name:alice');
  });

  test('セッションの tenant が無い（鍵なし）ときは legacy', async () => {
    const spy = spyOn(searchWebFormats, 'searchWebWithFormats').mockResolvedValue({ items: [], count: 0 });
    restore.push(() => spy.mockRestore());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'tenant-wiring', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: 'search_web', arguments: { query: 'q' } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(spy.mock.calls[0][1]).toBe('legacy');
  });
});
