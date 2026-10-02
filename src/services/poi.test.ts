import { describe, expect, test } from 'bun:test';
import { normalizePoiItem, searchOpenPoi } from './poi.js';
import { PoiSearchRequestSchema } from '../types.js';

const okResponse = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;

describe('openpoi service', () => {
  test('normalizes numbers, string coords, and empty coords', async () => {
    const fetchFn = async (url: string) => {
      expect(url).toContain('center=139.7%2C35.69');
      expect(url).toContain('radius=2000');
      return okResponse({ count: 3, results: [
        { name: 'A', lat: 35.69, lng: 139.7, licenses: ['Apache-2.0'], attributions: ['x'] },
        { name: 'B', lat: '35.1', lng: '139.1', licenses: [], attributions: [] },
        { name: 'C', lat: '', lng: '', licenses: [], attributions: [] },
      ] });
    };
    const r = await searchOpenPoi({ query: 'test', lat: 35.69, lon: 139.7, radiusMeters: 2000, limit: 3 }, fetchFn as never);
    expect(r.count).toBe(3);
    expect(r.pois[0]).toMatchObject({ name: 'A', lat: 35.69, lng: 139.7 });
    expect(r.pois[1]).toMatchObject({ lat: 35.1, lng: 139.1 });
    expect(r.pois[2].lat).toBeUndefined();
    expect(r.source).toBe('openpoi');
  });
  test('bbox takes priority over center and radius', async () => {
    const fetchFn = async (url: string) => {
      expect(url).toContain('bbox=');
      expect(url).not.toContain('center=');
      return okResponse({ count: 0, results: [] });
    };
    const r = await searchOpenPoi({ bbox: '139.6,35.5,139.9,35.8', limit: 5 }, fetchFn as never);
    expect(r.count).toBe(0);
  });
  test('http errors and broken envelopes throw', async () => {
    await expect(searchOpenPoi({ query: 'x' }, (async () => ({ ok: false, status: 503 })) as never)).rejects.toThrow('OpenPOI HTTP 503');
    await expect(searchOpenPoi({ query: 'x' }, (async () => okResponse({ results: [] })) as never)).rejects.toThrow('envelope');
  });
  test('nameless records are dropped', () => {
    expect(normalizePoiItem({ lat: 1 } as never)).toBeUndefined();
  });
  test('input requires query, bbox, or lat+lon pair', () => {
    expect(PoiSearchRequestSchema.safeParse({}).success).toBe(false);
    expect(PoiSearchRequestSchema.safeParse({ lat: 35 }).success).toBe(false);
    expect(PoiSearchRequestSchema.safeParse({ query: 'ramen' }).success).toBe(true);
    expect(PoiSearchRequestSchema.safeParse({ lat: 35, lon: 139 }).success).toBe(true);
  });
});

describe.skipIf(!process.env.SORA_LIVE_TESTS)('openpoi live', () => {
  test('real search returns geocoded facilities', async () => {
    const r = await searchOpenPoi({ query: 'ramen', lat: 35.69, lon: 139.7, radiusMeters: 2000, limit: 2 });
    expect(r.count).toBeGreaterThan(0);
    expect(typeof r.pois[0].lat).toBe('number');
    expect(typeof r.pois[0].lng).toBe('number');
  });
});

describe('openpoi MCP wiring', () => {
  test('search_poi is deferred and discoverable', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createMcpServer } = await import('../mcp.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'poi-wiring', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const names = (await client.listTools()).tools.map((t: any) => t.name);
      expect(names).toContain('search_poi');
      const deferred = createMcpServer({ deferTools: true });
      expect((deferred as any)._registeredTools['search_poi'].enabled).toBe(false);
      const found = await client.callTool({ name: 'search_tools', arguments: { query: 'POI 施設検索' } });
      expect(JSON.stringify(found)).toContain('search_poi');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
