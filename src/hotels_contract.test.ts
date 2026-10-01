import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHotelService, type HotelFetchFn } from './services/hotels/index.js';
import { McpSessionManager } from './mcp.js';
import { createMcpServer } from './mcp.js';
import { createHotelRoutes } from './routes/hotels.js';
import { generateOpenApiDocument } from './types.js';
import { TOKYO_DS } from './services/hotels/fixtures/ds.js';

const FLAG = 'SORA_RAKUTEN_TRAVEL_ENABLED';
const savedFlag = process.env[FLAG];
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

const htmlWith = (ds: unknown) =>
  '<html><head><script>var ds = ' + JSON.stringify(ds) + ';</script></head><body></body></html>';

function stubService(calls: string[]) {
  return createHotelService({
    fetchImpl: (async (url: string) => {
      calls.push(url);
      return { status: 200, headers: { get: () => null }, text: async () => htmlWith(TOKYO_DS) };
    }) as HotelFetchFn,
    minIntervalMs: 1,
  });
}

const validBody = {
  location: '東京駅',
  checkIn: '2026-10-20',
  checkOut: '2026-10-21',
  adults: 2,
};

describe('hotels REST/MCP contract', () => {
  test('REST keeps dates, occupancy, and limit with a stubbed upstream', async () => {
    process.env[FLAG] = 'true';
    const calls: string[] = [];
    const routes = createHotelRoutes({ service: stubService(calls) });
    const res = await routes.request('/hotels/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBody, limit: 1 }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.source).toBe('rakuten_travel');
    expect(body.status).toBe('ok');
    expect(body.query).toMatchObject({ location: '東京駅', checkIn: '2026-10-20', checkOut: '2026-10-21', adults: 2, limit: 1 });
    expect(body.hotels).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  test('REST rejects invalid input and unknown fields without fetching', async () => {
    process.env[FLAG] = 'true';
    const calls: string[] = [];
    const routes = createHotelRoutes({ service: stubService(calls) });
    for (const bad of [
      { ...validBody, checkIn: '2026-02-30' },
      { ...validBody, adults: 0 },
      { ...validBody, children: 1 },
      'not-json',
    ]) {
      const res = await routes.request('/hotels/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof bad === 'string' ? bad : JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test('REST and OpenAPI stay hidden while the flag is off', async () => {
    delete process.env[FLAG];
    const routes = createHotelRoutes();
    const res = await routes.request('/hotels/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
    const doc: any = generateOpenApiDocument();
    expect(doc.paths['/hotels/availability']).toBeUndefined();
    const tools = Object.entries((createMcpServer({ deferTools: false }) as any)._registeredTools).map(([name]) => name);
    expect(tools).not.toContain('search_hotel_availability');
    expect(tools.filter((name: string) => !name.startsWith('default.')).length).toBe(45);
  });

  test('flag on registers one deferred MCP tool and documents the endpoint', () => {
    process.env[FLAG] = 'true';
    const deferred = createMcpServer({ deferTools: true });
    const handles = (deferred as any)._registeredTools;
    expect(handles['search_hotel_availability']).toBeDefined();
    expect(handles['search_hotel_availability'].enabled).toBe(false);
    const all = createMcpServer({ deferTools: false });
    const names = Object.entries((all as any)._registeredTools)
      .filter(([_, handle]: [string, any]) => handle.enabled !== false)
      .map(([name]) => name);
    expect(names).toContain('search_hotel_availability');
    expect(names.filter((name: string) => !name.startsWith('default.')).length).toBe(46);
    const doc: any = generateOpenApiDocument();
    const path = doc.paths['/hotels/availability'];
    expect(path.post.requestBody.content['application/json']).toBeDefined();
    expect(path.post.responses['400']).toBeDefined();
    expect(path.post.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
  });

  test('MCP search_tools discovers the hotel tool in a live session', async () => {
    process.env[FLAG] = 'true';
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
          params: { name: 'search_tools', arguments: { query: 'ホテル' } },
        }),
      }),
    );
    const text = await searchRes.text();
    expect(text).toContain('search_hotel_availability');
  });

  test('MCP invocation shares the REST contract and flags failures', async () => {
    process.env[FLAG] = 'true';
    const calls: string[] = [];
    const server = createMcpServer({ deferTools: false, hotelService: stubService(calls) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const ok: any = await client.callTool({ name: 'search_hotel_availability', arguments: validBody });
      const parsed = JSON.parse(ok.content[0].text);
      expect(parsed.status).toBe('ok');
      expect(parsed.query.adults).toBe(2);
      expect(ok.isError).toBeUndefined();
      const unavailable: any = await client.callTool({
        name: 'search_hotel_availability',
        arguments: { ...validBody, location: '大阪' },
      });
      expect(unavailable.isError).toBe(true);
      expect(JSON.parse(unavailable.content[0].text).status).toBe('unavailable');
      expect(calls).toHaveLength(1);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
