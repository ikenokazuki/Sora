import { describe, expect, test } from 'bun:test';
import { TOOL_CASES } from './catalog.js';
import type { CaseContext } from './types.js';

const OSM = '出典: © OpenStreetMap contributors (ODbL) https://www.openstreetmap.org/copyright';
const elevation = { lat: 35.669968, lon: 139.709008, elevationMeters: 34, geocodingSource: 'nominatim', geocodingAttribution: OSM };
const poi = {
  centerResolved: { input: '原宿', address: '東京都渋谷区神宮前 原宿', lat: 35.669968, lon: 139.709008, source: 'nominatim', attribution: OSM },
  count: 1, pois: [{ name: '原宿のラーメン店', lat: 35.67, lng: 139.709 }],
};

function context(result: unknown, restResult: unknown = result): CaseContext {
  return {
    mcp: { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(result) }] }), listTools: async () => [] },
    rest: { call: async () => ({ status: 200, json: restResult }) },
    secrets: { getCase: () => undefined, hasCase: () => false },
    signal: new AbortController().signal,
  };
}

describe('live geocoding checks', () => {
  test('elevation rejects numeric coordinates from the wrong city', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.elevation')!;
    await expect(check.run(context({ ...elevation, lat: 43.076111, lon: 141.363617 }))).rejects.toThrow();
  });

  test('elevation requires the attribution that matches the geocoding source', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.elevation')!;
    await expect(check.run(context(elevation))).resolves.toHaveProperty('sources');
    await expect(check.run(context({ ...elevation, geocodingAttribution: undefined }))).rejects.toThrow('attribution');
    await expect(check.run(context({ ...elevation, geocodingAttribution: '出典: 国土地理院' }))).rejects.toThrow('attribution');
  });

  test('station check requires Shibuya Station resolved by nominatim', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.station')!;
    const shibuya = { ...elevation, lat: 35.6584716, lon: 139.700401 };
    await expect(check.run(context(shibuya))).resolves.toHaveProperty('sources');
    await expect(check.run(context(elevation))).rejects.toThrow('Shibuya');
  });

  test('address check accepts the GSI fallback near Nagatacho', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.address')!;
    const nagatacho = { ...elevation, lat: 35.677414, lon: 139.744385, geocodingSource: 'gsi', geocodingAttribution: '出典: 国土地理院 (https://msearch.gsi.go.jp/address-search/AddressSearch)' };
    await expect(check.run(context(nagatacho))).resolves.toHaveProperty('sources');
    await expect(check.run(context({ ...nagatacho, geocodingAttribution: OSM }))).rejects.toThrow('attribution');
    await expect(check.run(context({ ...nagatacho, lat: 35.669968, lon: 139.709008 }))).rejects.toThrow('Nagatacho');
  });

  test('POI checks the center source, expected region, and each returned point', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.poi')!;
    await expect(check.run(context(poi))).resolves.toHaveProperty('sources');
    await expect(check.run(context({ ...poi, centerResolved: { ...poi.centerResolved, source: 'gsi' } }))).rejects.toThrow();
    await expect(check.run(context({ ...poi, pois: [{ name: '離れた店舗', lat: 35.67, lng: 139.74 }] }))).rejects.toThrow();
    await expect(check.run(context(poi, { ...poi, centerResolved: { ...poi.centerResolved, lat: 43.076111 } }))).rejects.toThrow();
    await expect(check.run(context({ ...poi, centerResolved: { ...poi.centerResolved, attribution: undefined } }))).rejects.toThrow('attribution');
  });
});
