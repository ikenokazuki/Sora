import { describe, expect, test } from 'bun:test';
import { parseThepaperHotJson } from './thepaper_hot.js';
import type { ProviderInput } from '../provider_registry.js';
const inputFor = (region: Record<string, unknown>): ProviderInput =>
  ({ request: { region: 'X' } as never, region: region as never, queries: [] });
const CN = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [] });
const liveShape = JSON.stringify({
  resultCode: '0',
  data: { hotNews: [
    { contId: '34073740', name: 'headline-a', pubTimeLong: 1790078875562, interactionNum: '125', praiseTimes: '201' },
    { contId: '34073740', name: 'headline-a dup', pubTimeLong: 1, interactionNum: '', praiseTimes: '' },
    { contId: '', name: 'no-id', pubTimeLong: 1, interactionNum: '', praiseTimes: '' },
    { contId: '34125615', name: 'headline-b', pubTimeLong: 0, interactionNum: '', praiseTimes: '' },
  ] },
});
describe('thepaper hot', () => {
  test('parses live-shape hot news with article urls', () => {
    const entries = parseThepaperHotJson(liveShape);
    expect(entries.map((entry) => entry.id)).toEqual(['34073740', '34125615']);
    expect(entries[0].url).toBe('https://www.thepaper.cn/newsDetail_forward_34073740');
    expect(entries[0].publishedAt).toBe(new Date(1790078875562).toISOString());
    expect(entries[1].publishedAt).toBeUndefined();
  });
  test('emits title-only acquisition items for CN only', async () => {
    const { createThepaperHotProvider } = await import('./thepaper_hot.js');
    const fetchFn = (async () => new Response(liveShape, { headers: { 'content-type': 'application/json' } })) as unknown as never;
    const result = await createThepaperHotProvider(fetchFn).run(CN, AbortSignal.timeout(5000));
    expect(result.items).toHaveLength(2);
    expect(result.items[0].evidence?.publisher).toBe('The Paper');
    expect(result.items[0].detail?.providerItemId).toBe('thepaper:34073740');
    expect(result.items[0].detail?.contentKind).toBe('title_only');
  });
  test('skips non-CN regions without fetch', async () => {
    const { createThepaperHotProvider } = await import('./thepaper_hot.js');
    const fetchFn = (() => Promise.reject(new Error('must not fetch'))) as unknown as never;
    const fr = inputFor({ id: 'country:FR', name: 'France', countryCode: 'FR', languages: [], aliases: [] });
    expect((await createThepaperHotProvider(fetchFn).run(fr, AbortSignal.timeout(5000))).items).toEqual([]);
  });
  test('rejects unexpected envelopes', () => {
    expect(() => parseThepaperHotJson('{"data":{}}')).toThrow();
  });
});
