import { describe, expect, test } from 'bun:test';
import { normalizeZhihuTopicId, parseZhihuHotJson } from './zhihu_hot.js';
import type { ProviderInput } from '../provider_registry.js';
const inputFor = (region: Record<string, unknown>): ProviderInput =>
  ({ request: { region: 'X' } as never, region: region as never, queries: [] });
const CN = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [] });
const liveShape = JSON.stringify({
  data: [
    { target: { title_area: { text: 'topic-a' }, excerpt_area: { text: 'excerpt-a' }, metrics_area: { text: '100 万热度' }, link: { url: 'https://www.zhihu.com/question/1' } } },
    { target: { title_area: { text: '  topic-a ' }, excerpt_area: { text: '' }, metrics_area: { text: '' }, link: { url: '' } } },
    { target: { title_area: { text: '' }, excerpt_area: { text: '' }, metrics_area: { text: '' }, link: { url: '' } } },
    { target: { title_area: { text: 'topic-b' }, excerpt_area: { text: '' }, metrics_area: { text: '50 万热度' }, link: { url: 'not-a-url' } } },
  ],
});
describe('zhihu hot', () => {
  test('parses live-shape topics with stable ids', () => {
    const entries = parseZhihuHotJson(liveShape);
    expect(entries.map((entry) => entry.id)).toEqual(['topic-a', 'topic-b']);
    expect(entries[0]).toMatchObject({ title: 'topic-a', hot: '100 万热度', url: 'https://www.zhihu.com/question/1' });
    expect(entries[1].url).toContain('zhihu.com/search');
    expect(normalizeZhihuTopicId('  topic-a ')).toBe('topic-a');
  });
  test('emits acquisition items for CN only', async () => {
    const { createZhihuHotProvider } = await import('./zhihu_hot.js');
    const fetchFn = (async () => new Response(liveShape, { headers: { 'content-type': 'application/json' } })) as unknown as never;
    const result = await createZhihuHotProvider(fetchFn).run(CN, AbortSignal.timeout(5000));
    expect(result.items).toHaveLength(2);
    expect(result.items[0].evidence?.publisher).toBe('Zhihu Hot List');
    expect(result.items[0].detail?.providerItemId).toBe('zhihu:topic-a');
    expect(result.items[0].detail?.timeBasis).toBe('provider_observation');
  });
  test('skips non-CN regions without fetch', async () => {
    const { createZhihuHotProvider } = await import('./zhihu_hot.js');
    const fetchFn = (() => Promise.reject(new Error('must not fetch'))) as unknown as never;
    const jp = inputFor({ id: 'country:JP', name: 'Japan', countryCode: 'JP', languages: [], aliases: [] });
    expect((await createZhihuHotProvider(fetchFn).run(jp, AbortSignal.timeout(5000))).items).toEqual([]);
  });
  test('rejects unexpected envelopes', () => {
    expect(() => parseZhihuHotJson('{"data":{}}')).toThrow();
    expect(() => parseZhihuHotJson('not json')).toThrow();
  });
});
