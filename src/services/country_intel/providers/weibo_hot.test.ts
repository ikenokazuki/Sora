import { describe, expect, test } from 'bun:test';
import { normalizeWeiboTopicId, parseWeiboHotJson, weiboHotItemUrl } from './weibo_hot.js';
import type { ProviderInput } from '../provider_registry.js';
const inputFor = (region: Record<string, unknown>): ProviderInput =>
  ({ request: { region: 'X' } as never, region: region as never, queries: [] });
const CN = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [] });
const liveShape = JSON.stringify({
  ok: 1,
  data: {
    hotgovs: [{ word: '#test gov#', icon_desc: '热' }],
    realtime: [
      { word: 'topic-a', note: 'topic-a', num: 100, label_name: '新', icon_desc: '新', realpos: 1, rank: 0 },
      { word: 'topic-b', note: 'topic-b', num: 50, label_name: '', icon_desc: '', realpos: 2, rank: 1 },
      { word: 'ad-topic', note: 'ad-topic', num: 40, is_ad: 1, topic_ad: 1, realpos: null, rank: 2 },
    ],
  },
});
describe('weibo hot', () => {
  test('parses live-shape realtime plus gov', () => {
    const entries = parseWeiboHotJson(liveShape);
    expect(entries.map((entry) => entry.query)).toEqual(['#test gov#', 'topic-a', 'topic-b']);
    expect(entries[0]).toMatchObject({ pinned: true, rank: null });
    expect(entries[1]).toMatchObject({ query: 'topic-a', hotIndex: '100', tag: '新', rank: 1, pinned: false });
    expect(entries[1].id).toBe(normalizeWeiboTopicId('topic-a'));
    expect(weiboHotItemUrl('topic-a')).toContain('s.weibo.com');
  });
  test('uses realpos rank and drops ad rows', () => {
    const entries = parseWeiboHotJson(liveShape);
    expect(entries.some((entry) => entry.query === 'ad-topic')).toBe(false);
    expect(entries.map((entry) => entry.rank)).toEqual([null, 1, 2]);
  });
  test('emits acquisition items for CN only', async () => {
    const { createWeiboHotProvider } = await import('./weibo_hot.js');
    const fetchFn = (async () => new Response(liveShape, { headers: { 'content-type': 'application/json' } })) as unknown as never;
    const result = await createWeiboHotProvider(fetchFn).run(CN, AbortSignal.timeout(5000));
    expect(result.items).toHaveLength(3);
    expect(result.items[0].evidence?.publisher).toBe('Weibo Hot Search');
    expect(result.items[1].detail?.providerItemId).toBe('weibo:' + normalizeWeiboTopicId('topic-a'));
    expect(result.items[1].detail?.timeBasis).toBe('provider_observation');
    expect(result.items[1].detail?.structuredData).toMatchObject({ topicId: normalizeWeiboTopicId('topic-a'), rank: 1, pinned: false });
    expect(result.coverage).toEqual(['media_activity']);
  });
  test('skips non-CN regions without fetch', async () => {
    const { createWeiboHotProvider } = await import('./weibo_hot.js');
    const fetchFn = (() => Promise.reject(new Error('must not fetch'))) as unknown as never;
    const jp = inputFor({ id: 'country:JP', name: 'Japan', countryCode: 'JP', languages: [], aliases: [] });
    expect((await createWeiboHotProvider(fetchFn).run(jp, AbortSignal.timeout(5000))).items).toEqual([]);
  });
  test('rejects unexpected envelope', () => {
    expect(() => parseWeiboHotJson('{"ok":1,"data":{}}')).toThrow();
  });
});
