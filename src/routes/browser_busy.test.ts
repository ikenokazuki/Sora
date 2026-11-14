import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { ResourceBusyError } from '../errors.js';
import * as scraper from '../scraper.js';
import { browserRoutes } from './browser.js';
import { scrapeRoutes } from './scrape.js';

/**
 * ブラウザの枠が混み合っていて断られたとき（ResourceBusyError。設計 6。穴 25）、REST は、500 でなく 429 と Retry-After（秒）で返す。
 * 利用者が、待ってから再試行できるようにするため（code: BROWSER_BUSY・retryable: true）。ストリームは、すでに 200 で開いているので、error イベントに同じ情報を入れる。
 */

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const appFor = (routes: Hono) => {
  const app = new Hono();
  app.route('/', routes);
  return app;
};
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const busy = (retryAfterSec = 5) => new ResourceBusyError('ブラウザの枠を待つ要求が、全体の上限（100 件）に達しています。しばらくしてから、もう一度試してください', 'queue_full', retryAfterSec);

async function expectBusy429(res: Response, retryAfterSec = '5'): Promise<void> {
  expect(res.status).toBe(429);
  expect(res.headers.get('retry-after')).toBe(retryAfterSec);
  expect(await res.json()).toMatchObject({ code: 'BROWSER_BUSY', status: 429, retryable: true, error: expect.stringContaining('全体の上限') });
}

describe('混み合って断られたら、429 と Retry-After', () => {
  test('POST /browser/action', async () => {
    spies.push(spyOn(scraper, 'executeBrowserActions').mockRejectedValue(busy()));
    await expectBusy429(await appFor(browserRoutes).request('/browser/action', post({ url: 'https://example.com/' })));
  });

  test('POST /browser/action: セッション数の上限（session_limit）も同じ。429 と Retry-After', async () => {
    spies.push(spyOn(scraper, 'executeBrowserActions').mockRejectedValue(new ResourceBusyError('ブラウザセッションが全体の上限（20 件）に達しています', 'session_limit', 30)));
    await expectBusy429(await appFor(browserRoutes).request('/browser/action', post({ createSession: true, url: 'https://example.com/' })), '30');
  });

  test('POST /scrape', async () => {
    spies.push(spyOn(scraper, 'scrapeUrl').mockRejectedValue(busy()));
    await expectBusy429(await appFor(scrapeRoutes).request('/scrape', post({ url: 'https://example.com/' })));
  });

  test('POST /scrape/batch', async () => {
    spies.push(spyOn(scraper, 'scrapeBatchUrls').mockRejectedValue(busy()));
    await expectBusy429(await appFor(scrapeRoutes).request('/scrape/batch', post({ urls: ['https://example.com/'] })));
  });

  test('POST /map', async () => {
    spies.push(spyOn(scraper, 'mapSiteUrl').mockRejectedValue(busy()));
    await expectBusy429(await appFor(scrapeRoutes).request('/map', post({ url: 'https://example.com/' })));
  });

  test('POST /crawl', async () => {
    spies.push(spyOn(scraper, 'crawlSiteUrl').mockRejectedValue(busy()));
    await expectBusy429(await appFor(scrapeRoutes).request('/crawl', post({ url: 'https://example.com/' })));
  });

  test('Retry-After は、例外が持つ秒数', async () => {
    spies.push(spyOn(scraper, 'scrapeUrl').mockRejectedValue(busy(9)));
    await expectBusy429(await appFor(scrapeRoutes).request('/scrape', post({ url: 'https://example.com/' })), '9');
  });
});

describe('ストリームは、200 で開いたあと、error イベントに同じ情報を入れる', () => {
  test('POST /scrape/stream', async () => {
    spies.push(spyOn(scraper, 'scrapeUrl').mockRejectedValue(busy()));
    const res = await appFor(scrapeRoutes).request('/scrape/stream', post({ url: 'https://example.com/' }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: error');
    const data = JSON.parse(text.split('\n').find((line) => line.startsWith('data:') && line.includes('BROWSER_BUSY'))?.slice(5) ?? '{}');
    expect(data).toMatchObject({ code: 'BROWSER_BUSY', status: 429, retryable: true, retryAfterSec: 5 });
  });

  test('POST /crawl/stream', async () => {
    spies.push(spyOn(scraper, 'crawlSiteUrl').mockRejectedValue(busy()));
    const res = await appFor(scrapeRoutes).request('/crawl/stream', post({ url: 'https://example.com/' }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: error');
    const data = JSON.parse(text.split('\n').find((line) => line.startsWith('data:') && line.includes('BROWSER_BUSY'))?.slice(5) ?? '{}');
    expect(data).toMatchObject({ code: 'BROWSER_BUSY', status: 429, retryable: true, retryAfterSec: 5 });
  });
});

describe('混み合い以外の失敗は、これまでどおり', () => {
  test('一般の失敗は 500（SCRAPE_ERROR）・時間切れは 408。Retry-After は付かない', async () => {
    spies.push(spyOn(scraper, 'scrapeUrl').mockRejectedValue(new Error('boom')));
    const res = await appFor(scrapeRoutes).request('/scrape', post({ url: 'https://example.com/' }));
    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toMatchObject({ code: 'SCRAPE_ERROR' });

    spies.push(spyOn(scraper, 'executeBrowserActions').mockRejectedValue(new Error('navigation timeout of 30000 ms exceeded')));
    const timeout = await appFor(browserRoutes).request('/browser/action', post({ url: 'https://example.com/' }));
    expect(timeout.status).toBe(408);
    expect(timeout.headers.get('retry-after')).toBeNull();
  });
});
