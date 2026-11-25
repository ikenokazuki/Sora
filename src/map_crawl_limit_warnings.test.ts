import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as cache from './cache.js';
import { crawlSiteUrl, mapSiteUrl } from './scraper.js';
import { limits } from './security/limits.js';
import { resetSecurityMetrics } from './security/metrics.js';
import { CrawlResponseSchema, MapResponseSchema } from './types.js';

/** map_site と crawl が上限で打ち切って、結果が欠けうるときは、応答の warnings で分かるようにする（打ち切っても結果が変わらないときは、付けない） */

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let handler: (path: string) => Response | Promise<Response>;
let previousAllow: string | undefined;

const html = (title: string, hrefs: string[] = []) =>
  new Response(`<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${'上限の知らせを確かめるページの本文です。読めるだけの長さの文章を置きます。'.repeat(6)}</p>${hrefs.map((href) => `<a href="${href}">${href}</a>`).join(' ')}</main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const xml = (body: string) => new Response(`<?xml version="1.0"?>${body}`, { headers: { 'content-type': 'application/xml' } });
const urlset = (urls: string[]) => xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`);
const index = (children: string[]) => xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join('')}</sitemapindex>`);
const notFound = () => new Response('not found', { status: 404 });

beforeAll(() => {
  previousAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => handler(new URL(request.url).pathname) });
  origin = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  cache.clearCache();
  resetSecurityMetrics();
});
afterAll(() => {
  server.stop(true);
  if (previousAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previousAllow;
});

const map = (extra: Record<string, unknown> = {}) => mapSiteUrl({ url: `${origin}/`, limit: 50, tenantId: 'name:map-warn', noCache: true, ...extra });
const lim = (extra: Partial<ReturnType<typeof limits>>) => ({ ...limits(), ...extra });

describe('map_site の上限', () => {
  const emptyChildren = (path: string) => (path === '/sitemap.xml' ? index([`${origin}/c/0.xml`, `${origin}/c/1.xml`, `${origin}/c/2.xml`]) : path.startsWith('/c/') ? urlset([]) : path === '/' ? html('root', ['/x']) : notFound());

  test('打ち切らなければ、何も付かない', async () => {
    handler = emptyChildren;
    expect((await map()).warnings).toBeUndefined();
  }, 60_000);

  test('索引の子の数', async () => {
    handler = emptyChildren;
    const result = await map({ limits: lim({ sitemapChildren: 2 }) });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('一覧に含まれていない URL');
    expect(result.warnings?.[0]).toContain('索引の子は先頭の 2 件まで');
  }, 60_000);

  test('robots.txt の Sitemap 行・サイトマップの本数・大きさ。当たった上限を、全部 1 つの文に書く', async () => {
    handler = (path) =>
      path === '/robots.txt' ? new Response(`Sitemap: ${origin}/r/0.xml\nSitemap: ${origin}/r/1.xml\n`) : path.startsWith('/r/') ? urlset([]) : path === '/sitemap.xml' ? urlset(Array.from({ length: 30 }, (_, i) => `${origin}/p/${i}`)) : path === '/' ? html('root', ['/x']) : notFound();
    const result = await map({ limits: lim({ sitemapRobotsLines: 1, sitemapBytes: 200, sitemapFetches: 3 }) });
    expect(result.source).toBe('links');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('robots.txt の Sitemap 行は先頭の 1 行まで');
    expect(result.warnings?.[0]).toContain('サイトマップは 3 本まで');
    expect(result.warnings?.[0]).toContain('200 バイトを超えるサイトマップは読まない');
  }, 60_000);

  test('打ち切っても、頼んだ件数がそろっていれば、付けない（結果は変わらない）', async () => {
    handler = (path) => (path === '/sitemap.xml' ? index(Array.from({ length: 5 }, (_, i) => `${origin}/c/${i}.xml`)) : path.startsWith('/c/') ? urlset(Array.from({ length: 10 }, (_, i) => `${origin}${path}/${i}`)) : notFound());
    const result = await map({ limit: 5, limits: lim({ sitemapChildren: 2 }) });
    expect(result.count).toBe(5);
    expect(result.warnings).toBeUndefined();
  }, 60_000);

  test('全体の時間を超えたときは付き、その結果は短い時間だけキャッシュする。件数の上限だけなら、いつもの時間', async () => {
    const set = spyOn(cache, 'setToCache');
    const ttls = () => set.mock.calls.filter(([key]) => String(key).includes('map:v')).map(([, , ttl]) => ttl);
    try {
      handler = emptyChildren;
      await map({ noCache: false, limits: lim({ sitemapChildren: 2 }) });
      expect(ttls()).toHaveLength(1);
      expect(ttls()[0]).not.toBe(cache.CACHE_TTL_EMPTY);
      cache.clearCache();
      set.mockClear();
      handler = async (path) => {
        if (path === '/sitemap.xml') await Bun.sleep(1500);
        return path === '/' ? html('root', ['/x']) : notFound();
      };
      const result = await map({ noCache: false, limits: lim({ mapDeadlineMs: 500 }) });
      expect(result.warnings?.[0]).toContain('全体の時間は');
      expect(ttls()).toEqual([cache.CACHE_TTL_EMPTY]);
    } finally {
      set.mockRestore();
    }
  }, 60_000);
});

const crawl = (extra: Record<string, unknown> = {}) => crawlSiteUrl({ url: `${origin}/`, tenantId: 'name:crawl-warn', maxPages: 5, maxDepth: 1, noCache: true, ...extra });

describe('crawl の上限', () => {
  const site = (links: string[]) => (path: string) => html(path, path === '/' ? links : []);

  test('打ち切らなければ、何も付かない（最大ページ数に達して残りをたどらないのは、頼んだとおりなので付けない）', async () => {
    handler = site([`${origin}/docs/a`, `${origin}/docs/b`, `${origin}/docs/c`]);
    expect((await crawl({ includePatterns: ['/docs/**'] })).warnings).toBeUndefined();
    cache.clearCache();
    expect((await crawl({ maxPages: 2 })).warnings).toBeUndefined();
  }, 60_000);

  test('URL パターンの照合の上限', async () => {
    handler = site([`${origin}/docs/a`, `${origin}/docs/b`]);
    const result = await crawl({ includePatterns: ['/docs/**'], limits: lim({ patternSteps: 3 }) });
    expect(result.count).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('includePatterns');
  }, 60_000);

  test('取得を試みる回数の上限（最大ページ数の 3 倍）で、残りのリンクをたどらないとき', async () => {
    // 1 番ポートは閉じている（ホスト名が同じなので、同じサイトのリンクとして試みて、失敗する）
    handler = site(Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:1/dead-${i}`));
    const result = await crawl({ maxPages: 2 });
    expect(result.count).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('最大ページ数の 3 倍');
  }, 60_000);

  const dead = (n: number) => Array.from({ length: n }, (_, i) => `http://127.0.0.1:1/dead-${i}`);

  test('最大ページ数がそろえば、試みの回数を使い切っていても、付けない', async () => {
    // 起点 + 失敗 4 件 + 成功 1 件で、試みは 6 回（2 ページの 3 倍）。リンクは残っている
    handler = site([...dead(4), `${origin}/ok`, `${origin}/rest`]);
    const result = await crawl({ maxPages: 2 });
    expect(result.count).toBe(2);
    expect(result.warnings).toBeUndefined();
  }, 60_000);

  test('試みの回数をちょうど使い切って、残りのリンクが無ければ、付けない', async () => {
    handler = site(dead(5));
    expect((await crawl({ maxPages: 2 })).warnings).toBeUndefined();
  }, 60_000);

  test('取れないリンクがあっても、上限の前に全部試し終えたら、付けない', async () => {
    handler = site([`http://127.0.0.1:1/dead-0`]);
    expect((await crawl()).warnings).toBeUndefined();
  }, 60_000);
});

test('応答の型（OpenAPI）にも warnings がある', () => {
  expect(Object.keys(MapResponseSchema.shape)).toContain('warnings');
  expect(Object.keys(CrawlResponseSchema.shape)).toContain('warnings');
});
