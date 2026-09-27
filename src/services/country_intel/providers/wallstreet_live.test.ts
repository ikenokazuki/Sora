import { describe, expect, test } from 'bun:test';
import { parseWallstreetLiveJson } from './wallstreet_live.js';
import type { ProviderInput } from '../provider_registry.js';
const inputFor = (region: Record<string, unknown>): ProviderInput =>
  ({ request: { region: 'X' } as never, region: region as never, queries: [] });
const CN = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [] });
const liveShape = JSON.stringify({
  data: { items: [
    { id: 1, title: 'headline-a', content_text: '<p>body-a</p>', display_time: 1790141541, uri: 'https://wallstreetcn.com/livenews/1' },
    { id: 2, title: '', content_text: '<p>body-b is the headline</p>', display_time: 0, uri: 'https://wallstreetcn.com/livenews/2' },
    { id: 3, title: '', content_text: '', display_time: 1, uri: '' },
  ] },
});
describe('wallstreet live', () => {
  test('parses live-shape flash items with publication time', () => {
    const entries = parseWallstreetLiveJson(liveShape);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: '1', title: 'headline-a', publishedAt: '2026-09-23T05:32:21.000Z' });
    expect(entries[0].excerpt).toContain('body-a');
    expect(entries[1].title).toContain('body-b');
    expect(entries[1].publishedAt).toBeUndefined();
  });
  test('emits acquisition items with article urls', async () => {
    const { createWallstreetLiveProvider } = await import('./wallstreet_live.js');
    const fetchFn = (async () => new Response(liveShape, { headers: { 'content-type': 'application/json' } })) as unknown as never;
    const result = await createWallstreetLiveProvider(fetchFn).run(CN, AbortSignal.timeout(5000));
    expect(result.items).toHaveLength(2);
    expect(result.items[0].evidence?.url).toBe('https://wallstreetcn.com/livenews/1');
    expect(result.items[0].detail?.providerItemId).toBe('wscn:1');
    expect(result.items[0].detail?.timeBasis).toBe('provider_publication');
  });
  test('rejects unexpected envelopes', () => {
    expect(() => parseWallstreetLiveJson('{"data":{}}')).toThrow();
  });
});
