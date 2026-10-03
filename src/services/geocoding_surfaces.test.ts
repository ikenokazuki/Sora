import { describe, expect, test, spyOn } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { clearCache } from '../cache.js';
import { createMcpServer } from '../mcp.js';
import { publicDataRoutes } from '../routes/public_data.js';
import { generateOpenApiDocument } from '../types.js';

describe('shared geocoding across MCP and REST', () => {
  test('POI GET/POST, MCP, and elevation share one lookup and expose its origin', async () => {
    clearCache();
    let geocodingRequests = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'nominatim.openstreetmap.org') {
        geocodingRequests++;
        expect(url.searchParams.get('q')).toBe('原宿');
        await Bun.sleep(5);
        return Response.json([
          { display_name: '東京都渋谷区神宮前 原宿', lat: '35.669968', lon: '139.709008', address: { 'ISO3166-2-lvl4': 'JP-13' } },
          { display_name: '原宿, 群馬県', lat: '36.3', lon: '139.0', address: { 'ISO3166-2-lvl4': 'JP-10' } },
        ]);
      }
      if (url.hostname === 'api.openpoiapi.com') {
        expect(url.searchParams.get('center')).toBe('139.709008,35.669968');
        return Response.json({ count: 1, results: [{ name: '原宿のラーメン店', lat: 35.67, lng: 139.709, licenses: [], attributions: [] }] });
      }
      if (url.hostname === 'cyberjapandata2.gsi.go.jp') {
        expect(url.searchParams.get('lat')).toBe('35.669968');
        expect(url.searchParams.get('lon')).toBe('139.709008');
        return Response.json({ elevation: 34, hsrc: '5m' });
      }
      throw new Error('unexpected upstream: ' + url.hostname);
    }) as typeof fetch);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'geocoding-contract', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const [get, post, mcp, elevation] = await Promise.all([
        publicDataRoutes.request('/geo/poi?query=ラーメン&center=原宿'),
        publicDataRoutes.request('/geo/poi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'ラーメン', center: '原宿' }) }),
        client.callTool({ name: 'search_poi', arguments: { query: 'ラーメン', center: '原宿' } }),
        publicDataRoutes.request('/geo/elevation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: '原宿' }) }),
      ]);
      for (const res of [get, post]) {
        expect(res.status).toBe(200);
        expect((await res.json() as any).centerResolved).toMatchObject({
          source: 'nominatim', lat: 35.669968, lon: 139.709008, needsVerification: true,
        });
      }
      expect(mcp.isError).not.toBe(true);
      const block = (mcp.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text');
      expect(JSON.parse(block!.text!).centerResolved).toMatchObject({ source: 'nominatim', attribution: expect.stringContaining('OpenStreetMap'), needsVerification: true });
      expect(elevation.status).toBe(200);
      expect(await elevation.json()).toMatchObject({
        source: 'gsi', geocodingSource: 'nominatim', geocodingAttribution: expect.stringContaining('OpenStreetMap'), matchedTitle: '東京都渋谷区神宮前 原宿',
        lat: 35.669968, lon: 139.709008, elevationMeters: 34, needsVerification: true,
      });
      expect(geocodingRequests).toBe(1);
      const tools = (await client.listTools()).tools;
      for (const name of ['search_poi', 'get_elevation']) {
        expect(tools.find((tool) => tool.name === name)!.inputSchema.properties).toHaveProperty('noCache');
      }
    } finally {
      fetchSpy.mockRestore();
      await client.close();
      await server.close();
    }
  });

  test('OpenAPI GET documents place centers and cache bypass', () => {
    const doc = generateOpenApiDocument();
    const names = doc.paths['/geo/poi'].get.parameters.map((p: any) => p.name);
    expect(names).toContain('center');
    expect(names).toContain('noCache');
  });
});
