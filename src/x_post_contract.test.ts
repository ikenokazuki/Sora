import { describe, expect, test } from 'bun:test';
const tLive = test.skipIf(!process.env.SORA_LIVE_TESTS);
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, McpSessionManager } from './mcp.js';
import { generateOpenApiDocument } from './types.js';
import { app } from './index.js';
import type { XPostDetailProvider } from './services/x_detail.js';

function stubProvider(calls: string[]): XPostDetailProvider {
  return {
    async fetchStatus(id: string) {
      calls.push(id);
      if (id === '999') return null;
      return {
        statusId: id,
        text: '線香花火大会の公式タイムテーブル公開。18:00スタート！',
        provider: 'fxtwitter',
      };
    },
  };
}

describe('fetch_x_post contract', () => {
  test('registers one deferred tool without changing core count', () => {
    const deferred = createMcpServer({ deferTools: true });
    const handles = (deferred as any)._registeredTools;
    expect(handles['fetch_x_post']).toBeDefined();
    expect(handles['fetch_x_post'].enabled).toBe(false);
    const all = createMcpServer({ deferTools: false });
    const names = Object.entries((all as any)._registeredTools)
      .filter(([_, handle]: [string, any]) => handle.enabled !== false)
      .map(([name]) => name);
    expect(names).toContain('fetch_x_post');
    expect(names.filter((name: string) => !name.startsWith('default.')).length).toBe(47);
  });

  test('search_tools discovers the tool by ツイート', async () => {
    const manager = new McpSessionManager();
    const initRes = await manager.handleRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }),
    );
    const sessionId = initRes.headers.get('mcp-session-id')!;
    await manager.handleRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
    );
    const searchRes = await manager.handleRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'search_tools', arguments: { query: 'ツイート' } },
        }),
      }),
    );
    expect(await searchRes.text()).toContain('fetch_x_post');
  });

  test('invocation returns verified detail and flags misses', async () => {
    const calls: string[] = [];
    const server = createMcpServer({ deferTools: false, xDetailProvider: stubProvider(calls) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const ok: any = await client.callTool({
        name: 'fetch_x_post',
        arguments: { statusId: '2100871827090501852' },
      });
      const parsed = JSON.parse(ok.content[0].text);
      expect(parsed.found).toBe(true);
      expect(parsed.detail.text).toContain('18:00スタート');
      expect(ok.isError).toBeUndefined();
      const missing: any = await client.callTool({ name: 'fetch_x_post', arguments: { statusId: '999' } });
      expect(missing.isError).toBe(true);
      const invalid: any = await client.callTool({ name: 'fetch_x_post', arguments: { statusId: 'abc' } });
      expect(invalid.isError).toBe(true);
      expect(calls).toEqual(['2100871827090501852', '999']);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test('REST rejects invalid input without fetching and documents the endpoint', async () => {
    for (const body of [{}, { statusId: 'abc' }, { url: 'https://example.com/x' }, 'not-json']) {
      const res = await app.request('/realtime/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    const doc: any = generateOpenApiDocument();
    expect(doc.paths['/realtime/post'].post.responses['404']).toBeDefined();
  });

  tLive(
    'fetches a post discovered by live search',
    async () => {
      const searchRes = await app.request('/realtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '線香花火大会', sort: 'recent', limit: 5 }),
      });
      expect(searchRes.status).toBe(200);
      const searched: any = await searchRes.json();
      const liveItems = searched.data.items;
      expect(liveItems.length).toBeGreaterThan(0);
      const target = liveItems.find((item: any) => /^\d+$/.test(item.id));
      expect(target).toBeDefined();
      const res = await app.request('/realtime/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusId: target.id }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.found).toBe(true);
      expect(body.statusId).toBe(target.id);
      expect(body.detail.text.length).toBeGreaterThan(0);
    },
    55000,
  );
});
