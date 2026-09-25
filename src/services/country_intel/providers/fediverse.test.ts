import { describe, expect, test } from 'bun:test';
import { createFediverseProvider, extractFediverseTags, parseMastodonStatuses, parseMisskeyNotes } from './fediverse.js';

const region = { id: 'country:JP', name: 'Japan', countryCode: 'JP' as string, languages: ['ja'] as string[], aliases: [] as string[], confidence: 'high' as const };
const inputFor = (includeSocial: boolean, query = 'スタバ') => ({
  request: { region: 'Japan', includeSocial } as never, region,
  queries: [{ pass: 1 as const, providerId: 'fediverse', query, topics: [], maxItems: 25 }],
});
const fetchOk = (body: unknown) => (async () => Response.json(body)) as (url: string, init?: RequestInit) => Promise<Response>;
const fetchFail = (status: number) => (async () => new Response('blocked', { status })) as (url: string, init?: RequestInit) => Promise<Response>;

describe('fediverse', () => {
  test('misskey notes become social evidence with post URLs', () => {
    const posts = parseMisskeyNotes([{ id: 'abc123', text: 'スタバ新作うまい', createdAt: '2026-09-25T00:00:00Z', user: { username: 'taro' } }], 'https://misskey.io');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://misskey.io/notes/abc123');
    expect(posts[0].publishedAt).toBe('2026-09-25T00:00:00Z');
  });
  test('mastodon statuses strip HTML and keep language', () => {
    const posts = parseMastodonStatuses([{ url: 'https://mstdn.jp/@x/1', content: '<p>ボイコット <a href="https://e">link</a></p>', created_at: '2026-09-25T01:00:00Z', language: 'ja', account: { acct: 'x' } }]);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).not.toContain('<');
    expect(posts[0].language).toBe('ja');
  });
  test('empty texts are dropped', () => {
    expect(parseMisskeyNotes([{ id: 'a', text: '  ' }], 'https://misskey.io')).toEqual([]);
    expect(parseMastodonStatuses([{ url: 'https://e/1', content: '' }])).toEqual([]);
  });
  test('tags come from the planned query', () => {
    expect(extractFediverseTags(inputFor(true, 'スタバ ボイコット'))).toEqual(['スタバ', 'ボイコット']);
  });
  test('omitted social stays silent without failure', async () => {
    const result = await createFediverseProvider(fetchOk([])).run(inputFor(false), AbortSignal.timeout(2000));
    expect(result.items).toEqual([]);
  });
  test('partial instance failure is recorded as gaps', async () => {
    const fetch = (async (url: string) => {
      if (String(url).includes('misskey.io')) return Response.json([{ id: 'n1', text: '秋の新作', createdAt: '2026-09-25T02:00:00Z', user: { username: 'hanako' } }]);
      return new Response('blocked', { status: 403 });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const result = await createFediverseProvider(fetch).run(inputFor(true), AbortSignal.timeout(5000));
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].evidence?.sourceType).toBe('social');
    expect(result.items[0].detail?.timeBasis).toBe('provider_posted');
    expect((result.gaps ?? []).length).toBeGreaterThan(0);
  });
});
