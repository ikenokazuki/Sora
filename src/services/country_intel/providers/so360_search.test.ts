import { describe, expect, test } from 'bun:test';
import { parseSo360Html } from './so360_search.js';
import type { ProviderInput } from '../provider_registry.js';
const inputFor = (region: Record<string, unknown>, queries: ProviderInput['queries'] = []): ProviderInput =>
  ({ request: { region: 'X' } as never, region: region as never, queries });
const CN = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [] });
const item = (mdurl: string, title: string, desc: string): string =>
  '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=abc" data-mdurl="' + mdurl + '">' + title + '</a></h3> <p class="res-desc">' + desc + '</p></li>';
describe('so360 search', () => {
  test('parses mdurl results and skips redirect-only items', () => {
    const html = '<html><body><ul>'
      + item('https://example.org/a', 'A<em>中国</em>B', 's1 <em>经济</em> x')
      + '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=zzz">NoDirect</a></h3></li>'
      + item('https://example.org/c', 'C', 's3')
      + '</ul></body></html>';
    const entries = parseSo360Html(html);
    expect(entries.map((e) => e.url)).toEqual(['https://example.org/a', 'https://example.org/c']);
    expect(entries[0].title).toBe('A中国B');
    expect(entries[0].snippet).toBe('s1 经济 x');
  });
  test('uses the planned request query in the search url', async () => {
    const { createSo360SearchProvider } = await import('./so360_search.js');
    let captured = '';
    const fetchFn = (async (url: string) => {
      captured = String(url);
      return new Response('<html><body><ul>' + item('https://example.org/q', 'Q', 's') + '</ul></body></html>', { headers: { 'content-type': 'text/html' } });
    }) as unknown as never;
    const input = inputFor(CN.region as never, [{ pass: 1 as const, providerId: 'so360_search', query: 'China 经济', topics: [], maxItems: 10 }]);
    await createSo360SearchProvider(fetchFn).run(input, AbortSignal.timeout(5000));
    expect(captured).toContain(encodeURIComponent('China 经济').replace(/%20/g, '+'));
  });
  test('follows the cookie-setting redirect', async () => {
    const { createSo360SearchProvider } = await import('./so360_search.js');
    const body = '<html><body><ul>' + item('https://example.org/a', 'A', 's1') + '</ul></body></html>';
    let secondCookie = '';
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!headers.get('cookie')) {
        return new Response('', { status: 302, headers: { location: '/s?q=x', 'set-cookie': 'WZWS4=abc123; path=/' } });
      }
      secondCookie = headers.get('cookie') ?? '';
      return new Response(body, { headers: { 'content-type': 'text/html' } });
    }) as unknown as never;
    const result = await createSo360SearchProvider(fetchFn).run(CN, AbortSignal.timeout(5000));
    expect(secondCookie).toContain('WZWS4=abc123');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].evidence?.url).toBe('https://example.org/a');
  });
  test('skips non-CN regions', async () => {
    const { createSo360SearchProvider } = await import('./so360_search.js');
    const fetchFn = (() => Promise.reject(new Error('must not fetch'))) as unknown as never;
    const jp = inputFor({ id: 'country:JP', name: 'Japan', countryCode: 'JP', languages: ['ja'], aliases: [] });
    expect((await createSo360SearchProvider(fetchFn).run(jp, AbortSignal.timeout(5000))).items).toEqual([]);
  });
});
