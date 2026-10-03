import { describe, expect, test } from 'bun:test';
import { TOOL_CASES } from './catalog.js';
import type { CaseContext } from './types.js';

const elevation = { lat: 35.669968, lon: 139.709008, elevationMeters: 34, geocodingSource: 'nominatim' };
const poi = {
  centerResolved: { input: '原宿', address: '東京都渋谷区神宮前 原宿', lat: 35.669968, lon: 139.709008, source: 'nominatim' },
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

  test('POI checks the center source, expected region, and each returned point', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.poi')!;
    await expect(check.run(context(poi))).resolves.toHaveProperty('sources');
    await expect(check.run(context({ ...poi, centerResolved: { ...poi.centerResolved, source: 'gsi' } }))).rejects.toThrow();
    await expect(check.run(context({ ...poi, pois: [{ name: '離れた店舗', lat: 35.67, lng: 139.74 }] }))).rejects.toThrow();
    await expect(check.run(context(poi, { ...poi, centerResolved: { ...poi.centerResolved, lat: 43.076111 } }))).rejects.toThrow();
  });
});
