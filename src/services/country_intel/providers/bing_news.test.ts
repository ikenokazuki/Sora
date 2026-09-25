import { expect, test } from 'bun:test';
import { bingArticleUrl, buildBingNewsUrl, createBingNewsProvider } from './bing_news.js';
import { resolveRegion } from '../region.js';
import type { ProviderInput } from '../provider_registry.js';

test('Bing RSS URL keeps a seven-day market-specific query and resolves publisher links', () => {
  const url = new URL(buildBingNewsUrl('India economy', 'en-IN'));
  expect(url.searchParams.get('q')).toBe('India economy');
  expect(url.searchParams.get('mkt')).toBe('en-IN');
  expect(url.searchParams.get('qft')).toBe('interval="7"');
  const article = 'https://publisher.example/news/story';
  expect(bingArticleUrl(`http://www.bing.com/news/apiclick.aspx?url=${encodeURIComponent(article)}&mkt=en-IN`)).toBe(article);
  expect(bingArticleUrl('javascript:alert(1)')).toBeUndefined();
});

test('Bing falls back from an empty local market and retains direct articles in every subject', async () => {
  const region = resolveRegion('CN');
  const input: ProviderInput = { request: { region: 'CN' }, region, queries: [] };
  const seen: string[] = [];
  const fetchFn = (async (url: string) => {
    const parsed = new URL(url);
    const market = parsed.searchParams.get('mkt') ?? '';
    seen.push(market);
    const query = parsed.searchParams.get('q') ?? '';
    const target = `https://publisher.example/${encodeURIComponent(query)}`;
    const link = `http://www.bing.com/news/apiclick.aspx?url=${encodeURIComponent(target)}`;
    const item = market === 'zh-CN' ? '' : `<item><title>中国 &#32463;&#27982;</title><link>${link.replace(/&/g, '&amp;')}</link><description>Fresh original reporting</description><pubDate>${new Date().toUTCString()}</pubDate></item>`;
    return new Response(`<rss version="2.0"><channel>${item}</channel></rss>`, { headers: { 'content-type': 'application/xml' } });
  }) as never;
  const result = await createBingNewsProvider(fetchFn).run(input, AbortSignal.timeout(5000));
  expect(seen.filter((market) => market === 'zh-CN')).toHaveLength(6);
  expect(seen.filter((market) => market === 'en-US')).toHaveLength(6);
  expect(result.items).toHaveLength(6);
  expect(result.items[0].evidence?.url).toMatch(/^https:\/\/publisher\.example\//);
  expect(result.items[0].evidence?.title).toContain('经济');
  expect(result.items[0].evidence?.excerpt).toBe('Fresh original reporting');
  expect(result.items[0].detail?.structuredData?.searchMarket).toBe('en-US');
  expect(result.gaps).toContainEqual({ area: 'economy', reason: 'economy sparse_recent_items:1' });
});

test('Bing exposes missing fresh subjects instead of treating old articles as current', async () => {
  const region = resolveRegion('IN');
  const input: ProviderInput = { request: { region: 'IN', topics: ['economy'] }, region, queries: [] };
  const old = new Date(Date.now() - 9 * 86_400_000).toUTCString();
  const rss = `<rss version="2.0"><channel><item><title>Old India item</title><link>https://example.org/old</link><pubDate>${old}</pubDate></item></channel></rss>`;
  const result = await createBingNewsProvider((async () => new Response(rss, { headers: { 'content-type': 'application/xml' } })) as never).run(input, AbortSignal.timeout(5000));
  expect(result.items).toEqual([]);
  expect(result.gaps?.some((gap) => gap.area === 'economy' && gap.reason.includes('no_recent_items'))).toBe(true);
});
