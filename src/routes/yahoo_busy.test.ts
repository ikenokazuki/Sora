import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { ResourceBusyError } from '../errors.js';
import * as scraper from '../scraper.js';
import * as searchWebFormats from '../search_web_formats.js';
import * as yahooSearchCache from '../yahoo_search_cache.js';
import { searchRoutes } from './search.js';

/**
 * Yahoo への問い合わせの順番・予算で断られたとき（ResourceBusyError。設計 6。穴 25）の REST: 429 と Retry-After（code: RESOURCE_BUSY）。
 * 以前は、ただの失敗（500。SEARCH_ERROR）になり、待って再試行してよいことが分からなかった。
 */

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const yahooBusy = () => new ResourceBusyError('Yahoo への問い合わせの、この利用者の予算（1 分に 60 回）を使い切りました。42 秒たってから、もう一度試してください', 'tenant_budget', 42, 'yahoo');
const app = () => new Hono().route('/', searchRoutes);
const post = (body: unknown = { query: 'テスト' }) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ROUTES: Array<{ path: string; spy: () => { mockRejectedValue: (e: unknown) => unknown; mockRestore: () => void }; failure?: { status: number; code: string } }> = [
  { path: '/search/web', spy: () => spyOn(searchWebFormats, 'searchWebForRest') as never },
  { path: '/search', spy: () => spyOn(scraper, 'integratedSearch') as never },
  { path: '/search/deep', spy: () => spyOn(scraper, 'integratedSearch') as never },
  { path: '/search/image', spy: () => spyOn(yahooSearchCache, 'searchImageCached') as never },
  { path: '/search/video', spy: () => spyOn(yahooSearchCache, 'searchVideoCached') as never },
  { path: '/search/news', spy: () => spyOn(yahooSearchCache, 'searchNewsCached') as never },
  { path: '/search/chiebukuro', spy: () => spyOn(yahooSearchCache, 'searchChiebukuroCached') as never },
  { path: '/search/suggest', spy: () => spyOn(yahooSearchCache, 'suggestKeywordsCached') as never },
  // リアルタイム検索は、query があると、アンカー判定のために Web 検索（Yahoo の予算）を呼ぶ
  { path: '/search/realtime', spy: () => spyOn(yahooSearchCache, 'searchRealtimeCached') as never, failure: { status: 502, code: 'SEARCH_UPSTREAM_ERROR' } },
  { path: '/realtime', spy: () => spyOn(yahooSearchCache, 'searchRealtimeCached') as never, failure: { status: 502, code: 'SEARCH_UPSTREAM_ERROR' } },
];

describe('Yahoo の順番・予算で断られたら、429 と Retry-After（RESOURCE_BUSY）', () => {
  test.each(ROUTES)('POST $path', async ({ path, spy }) => {
    const mock = spy();
    spies.push(mock);
    mock.mockRejectedValue(yahooBusy());
    const res = await app().request(path, post());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(await res.json()).toMatchObject({ code: 'RESOURCE_BUSY', status: 429, retryable: true });
  });

  test.each(ROUTES)('混み合い以外の失敗は、これまでどおり（500 の SEARCH_ERROR。リアルタイムは 502 の SEARCH_UPSTREAM_ERROR）: POST $path', async ({ path, spy, failure }) => {
    const mock = spy();
    spies.push(mock);
    mock.mockRejectedValue(new Error('upstream exploded'));
    const res = await app().request(path, post());
    expect(res.status).toBe(failure?.status ?? 500);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toMatchObject({ code: failure?.code ?? 'SEARCH_ERROR' });
  });
});
