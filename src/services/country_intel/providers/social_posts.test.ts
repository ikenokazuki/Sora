import { describe, expect, test } from 'bun:test';
import { createSocialPostsProvider } from './social_posts.js';
import type { ProviderInput } from '../provider_registry.js';
import type { SocialPost } from '../../social/index.js';

const region: ProviderInput['region'] = { id: 'country:CN', name: 'China', nativeName: '中国', countryCode: 'CN', languages: ['zh'], aliases: [], confidence: 'high' };
const post = (platform: SocialPost['platform'], id: string, comments = 0): SocialPost => ({
  id, platform, url: 'https://example.org/' + platform + '/' + id, requestedUrl: 'https://example.org/' + platform + '/' + id,
  author: 'author', text: 'body text ' + id, textKind: 'excerpt', retrievedAt: '2026-09-25T15:00:00.000Z',
  timeStatus: 'known', inRequestedWindow: true, method: 'test', metrics: { comments },
  comments: { state: 'not_requested', order: 'none', items: [] }, truncated: false, warnings: [],
});
const inputFor = (request: ProviderInput['request']): ProviderInput => ({
  request, region, queries: [{ pass: 1, providerId: 'social_posts', query: 'q', topics: [], maxItems: 10 }],
});

describe('social_posts provider', () => {
  test('does nothing without includeSocial', async () => {
    let calls = 0;
    const provider = createSocialPostsProvider({ service: { search: async () => { calls++; throw new Error('must not run'); }, fetch: async () => { throw new Error('must not run'); }, enrichWeiboTop: async (x) => x } as never });
    const r = await provider.run(inputFor({ region: 'China' } as never), AbortSignal.timeout(5000));
    expect(r.items).toEqual([]);
    expect(calls).toBe(0);
    expect(r.coverage).toContain('social_observations:excluded');
  });
  test('searches default platforms and enriches weibo top comments', async () => {
    const searched: string[] = [];
    const service = {
      search: async (q: any) => { searched.push(q.platform); return { status: 'ok', platform: q.platform, query: q.query, searchMode: 'test', items: [post(q.platform, '1', 9), post(q.platform, '2', 1)], matchedInWindow: 2, unknownTime: 0, excluded: 0, failures: [], warnings: [] }; },
      fetch: async () => { throw new Error('unused'); },
      enrichWeiboTop: async (items: SocialPost[]) => items.map((p) => ({ ...p, comments: { state: 'fetched' as const, order: 'hot', items: [{ id: 'c1', author: 'fan', text: 'great', postId: p.id }] } })),
    };
    const provider = createSocialPostsProvider({ service: service as never });
    const r = await provider.run(inputFor({ region: 'China', includeSocial: true } as never), AbortSignal.timeout(10000));
    expect(searched.sort()).toEqual(['facebook', 'instagram', 'threads', 'weibo']);
    expect(r.items).toHaveLength(8);
    const weibo = r.items.filter((i) => i.detail?.providerItemId.startsWith('weibo:'));
    expect(weibo).toHaveLength(2);
    expect(weibo[0].detail?.blocks.length).toBeGreaterThan(1);
    expect(r.items.every((i) => i.evidence?.sourceType === 'social')).toBe(true);
    expect(r.items.every((i) => i.detail?.providerId === 'social_posts')).toBe(true);
  });
  test('honors platform selection and query caps', async () => {
    const searched: Array<{ platform: string; query: string }> = [];
    const service = {
      search: async (q: any) => { searched.push({ platform: q.platform, query: q.query }); return { status: 'empty', platform: q.platform, query: q.query, searchMode: 'test', items: [], matchedInWindow: 0, unknownTime: 0, excluded: 0, failures: [], warnings: [] }; },
      fetch: async () => { throw new Error('unused'); },
      enrichWeiboTop: async (x: SocialPost[]) => x,
    };
    const provider = createSocialPostsProvider({ service: service as never });
    const r = await provider.run(inputFor({
      region: 'China', includeSocial: true,
      social: { platforms: ['weibo'], queries: [{ platform: 'weibo', query: 'a' }, { platform: 'weibo', query: 'b' }, { platform: 'weibo', query: 'c' }] },
    } as never), AbortSignal.timeout(10000));
    expect(searched.map((s) => s.query).sort()).toEqual(['a', 'b']);
    expect(r.items).toEqual([]);
  });
  test('records failures as gaps, never as evidence', async () => {
    const service = {
      search: async () => ({ status: 'unavailable', platform: 'weibo', query: 'q', searchMode: 'test', items: [], matchedInWindow: 0, unknownTime: 0, excluded: 0, failures: ['rate limited (429)'], warnings: [] }),
      fetch: async () => ({ status: 'unavailable' as const, failures: ['gone'], warnings: [] }),
      enrichWeiboTop: async (x: SocialPost[]) => x,
    };
    const provider = createSocialPostsProvider({ service: service as never });
    const r = await provider.run(inputFor({ region: 'China', includeSocial: true, social: { platforms: ['weibo'], urls: ['https://m.weibo.cn/detail/1'] } } as never), AbortSignal.timeout(10000));
    expect(r.items).toEqual([]);
    expect((r.gaps ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

test('cache key separates includeSocial and social conditions', async () => {
  const { providerCacheKey } = await import('../provider_registry.js');
  const plan = (request: any): any => ({ request, region: { id: 'country:CN' }, pass1: [], pass2: [], limits: { maxPass1Queries: 24, maxPass2Queries: 8, maxItemsPerQuery: 100 } });
  const keys = new Set([
    providerCacheKey('social_posts', plan({})),
    providerCacheKey('social_posts', plan({ includeSocial: true })),
    providerCacheKey('social_posts', plan({ includeSocial: true, social: { platforms: ['weibo'] } })),
  ]);
  expect(keys.size).toBe(3);
});
