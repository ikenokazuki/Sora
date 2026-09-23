import { describe, expect, test } from 'bun:test';
import { normalizeToutiaoTopicId, parseToutiaoHotJson } from './toutiao_hot.js';
import type { ProviderInput } from '../provider_registry.js';
const inputFor = (region: Record<string, unknown>): ProviderInput =>
  ({ request: { region: 'X' } as never, region: region as never, queries: [] });
const CN = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [] });
const liveShape = JSON.stringify({
  data: [
    { ClusterIdStr: '111', Title: 'topic-a', HotValue: '1000', Label: 'hot' },
    { ClusterIdStr: '111', Title: 'topic-a dup', HotValue: '1000', Label: '' },
    { ClusterIdStr: '', Title: '', HotValue: '', Label: '' },
    { ClusterIdStr: '222', Title: 'topic-b', HotValue: '', Label: '' },
  ],
});
describe('toutiao hot', () => {
  test('parses live-shape topics keyed by cluster id', () => {
    const entries = parseToutiaoHotJson(liveShape);
    expect(entries.map((entry) => entry.id)).toEqual(['111', '222']);
    expect(entries[0]).toMatchObject({ title: 'topic-a', hot: '1000', label: 'hot' });
    expect(entries[0].url).toContain('toutiao.com/trending/111/');
    expect(normalizeToutiaoTopicId('', '  t ')).toBe('t');
  });
  test('emits acquisition items for CN only', async () => {
    const { createToutiaoHotProvider } = await import('./toutiao_hot.js');
    const fetchFn = (async () => new Response(liveShape, { headers: { 'content-type': 'application/json' } })) as unknown as never;
    const result = await createToutiaoHotProvider(fetchFn).run(CN, AbortSignal.timeout(5000));
    expect(result.items).toHaveLength(2);
    expect(result.items[0].evidence?.publisher).toBe('Toutiao Hot Board');
    expect(result.items[0].detail?.providerItemId).toBe('toutiao:111');
  });
  test('skips non-CN regions without fetch', async () => {
    const { createToutiaoHotProvider } = await import('./toutiao_hot.js');
    const fetchFn = (() => Promise.reject(new Error('must not fetch'))) as unknown as never;
    const us = inputFor({ id: 'country:US', name: 'United States', countryCode: 'US', languages: [], aliases: [] });
    expect((await createToutiaoHotProvider(fetchFn).run(us, AbortSignal.timeout(5000))).items).toEqual([]);
  });
  test('rejects unexpected envelopes', () => {
    expect(() => parseToutiaoHotJson('{"data":{}}')).toThrow();
  });
});
