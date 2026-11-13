import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import * as scraper from '../scraper.js';
import * as searchWebFormats from '../search_web_formats.js';
import { scrapeRoutes } from './scrape.js';
import { searchRoutes } from './search.js';

/**
 * 認証が決めた tenant を、REST の /map・/search/web が、取得と結果のキャッシュに渡す（設計 5。穴 17）。
 * 認証のない組み立て（tenant が無い）では legacy。本文で tenantId を名乗っても無視される。
 */

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const appFor = (tenantId: string | undefined, routes: Hono) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (tenantId) c.set('tenant', { tenantId, requestId: 'req-1', authMode: 'api_key' });
    await next();
  });
  app.route('/', routes);
  return app;
};
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /map', () => {
  const mapped = { url: 'https://example.com/', links: [], count: 0, source: 'links' as const };

  test('認証が決めた tenant を渡す。本文の tenantId は無視する', async () => {
    const spy = spyOn(scraper, 'mapSiteUrl').mockResolvedValue(mapped);
    spies.push(spy);
    const res = await appFor('name:alice', scrapeRoutes).request('/map', json({ url: 'https://example.com/', tenantId: 'name:bob' }));
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0][0]).toMatchObject({ url: 'https://example.com/', tenantId: 'name:alice' });
  });

  test('クライアントの切断の合図（req.signal）を渡す（切断したら、サイトマップを取るのをやめる）', async () => {
    const spy = spyOn(scraper, 'mapSiteUrl').mockResolvedValue(mapped);
    spies.push(spy);
    await appFor('name:alice', scrapeRoutes).request('/map', json({ url: 'https://example.com/' }));
    expect(spy.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  test('tenant を決めた認証が無い組み立てでは legacy', async () => {
    const spy = spyOn(scraper, 'mapSiteUrl').mockResolvedValue(mapped);
    spies.push(spy);
    await appFor(undefined, scrapeRoutes).request('/map', json({ url: 'https://example.com/' }));
    expect(spy.mock.calls[0][0]).toMatchObject({ tenantId: 'legacy' });
  });
});

describe('POST /search/web', () => {
  test('認証が決めた tenant を、検索の結果のページの取得と応答のキャッシュに渡す。本文の tenantId は無視する', async () => {
    const spy = spyOn(searchWebFormats, 'searchWebForRest').mockResolvedValue({ query: 'q', source: 'web', type: 'web', data: {}, cached: false });
    spies.push(spy);
    const res = await appFor('name:alice', searchRoutes).request('/search/web', json({ query: 'q', formats: ['markdown'], tenantId: 'name:bob' }));
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0][1]).toBe('name:alice');
  });

  test('tenant を決めた認証が無い組み立てでは legacy', async () => {
    const spy = spyOn(searchWebFormats, 'searchWebForRest').mockResolvedValue({ query: 'q', source: 'web', type: 'web', data: {}, cached: false });
    spies.push(spy);
    await appFor(undefined, searchRoutes).request('/search/web', json({ query: 'q' }));
    expect(spy.mock.calls[0][1]).toBe('legacy');
  });
});
