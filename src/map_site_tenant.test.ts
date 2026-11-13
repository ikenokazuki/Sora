import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { clearCache, getFromCache } from './cache.js';
import { dbSaveTenantCookies } from './db.js';
import { closeHttpSession } from './http_fetcher.js';
import { mapSiteUrl } from './scraper.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';

/**
 * map_site（mapSiteUrl）と tenant（設計 5。穴 17）。
 * これまで、robots.txt・サイトマップ・ページの取得は、tenant を渡さず legacy として動き、結果は、tenant を含まないキー（map:v2:…）で
 * 共有キャッシュに入った。tenant の保存済みの状態（Cookie・localStorage）で見えた内容が、別の tenant に返りえた（E25 と同じ形）。
 */

const PRIVATE = 'private';
const PUBLIC = 'public';
const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${'マップを作るページの本文です。読めるだけの長さの文章を、ここに置いておきます。'.repeat(4)}</p>${body}</main></body></html>`;

interface Seen {
  path: string;
  cookie: string | undefined;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let seen: Seen[] = [];
let withSitemap = true;
let sitemapIndex = false;
let previousAllow: string | undefined;
const tenants: string[] = [];

beforeAll(() => {
  previousAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;
      const cookie = request.headers.get('cookie') ?? undefined;
      seen.push({ path, cookie });
      const kind = (cookie ?? '').includes('sess=ALICE') ? PRIVATE : PUBLIC;
      const origin = `http://127.0.0.1:${server.port}`;
      if (path === '/robots.txt') return new Response(withSitemap ? `User-agent: *\nSitemap: ${origin}/sitemap.xml\n` : 'nope', { status: withSitemap ? 200 : 404 });
      if (path === '/sitemap.xml' && withSitemap && sitemapIndex) {
        return new Response(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/child.xml</loc></sitemap></sitemapindex>`, { headers: { 'content-type': 'application/xml' } });
      }
      if ((path === '/sitemap.xml' || path === '/child.xml') && withSitemap) {
        return new Response(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/${kind}-1</loc></url><url><loc>${origin}/${kind}-2</loc></url></urlset>`, { headers: { 'content-type': 'application/xml' } });
      }
      if (path === '/') return new Response(html('Home', `<a href="${origin}/${kind}-page-1">${kind}-page-1</a> <a href="${origin}/${kind}-page-2">${kind}-page-2</a>`), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('not found', { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  seen = [];
  withSitemap = true;
  sitemapIndex = false;
  resetSecurityMetrics();
  clearCache();
  for (const id of tenants.splice(0)) {
    await closeHttpSession('127.0.0.1', id).catch(() => {});
    dbSaveTenantCookies(id, '127.0.0.1', []);
  }
});

afterAll(() => {
  server.stop(true);
  if (previousAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previousAllow;
});

const tenant = (label: string, storedCookie?: string) => {
  const id = `name:${label}-${randomUUID().slice(0, 8)}`;
  tenants.push(id);
  if (storedCookie) dbSaveTenantCookies(id, '127.0.0.1', [{ name: 'sess', value: storedCookie, path: '/' }]);
  return id;
};
const map = async (tenantId: string) => {
  const result = (await mapSiteUrl({ url: `${base}/`, limit: 10, tenantId })) as { links: string[]; source: string; cached?: boolean };
  const text = result.links.join('\n');
  return { private: text.includes(PRIVATE), public: text.includes(PUBLIC), cached: result.cached === true, source: result.source };
};
const requestsFor = (path: string) => seen.filter((s) => s.path === path);

describe('サイトマップから作る map（robots.txt → sitemap.xml）', () => {
  test('robots.txt もサイトマップも、呼んだ tenant の保存済みのセッションで取る', async () => {
    const alice = tenant('alice', 'ALICE');
    expect(await map(alice)).toMatchObject({ private: true, public: false, source: 'sitemap' });
    for (const path of ['/robots.txt', '/sitemap.xml']) {
      expect(requestsFor(path).map((s) => s.cookie ?? '')).toEqual([expect.stringContaining('sess=ALICE')]);
    }
  });

  test('保存済みのセッションで見えた map を、別の tenant に返さない。ログインしていない tenant どうしは、共有のキャッシュで共有する', async () => {
    const [alice, bob, carol] = [tenant('alice', 'ALICE'), tenant('bob'), tenant('carol')];
    expect(await map(alice)).toMatchObject({ private: true, public: false, cached: false });
    // bob は、alice の map を読まず、自分で取る（公開の map）
    expect(await map(bob)).toMatchObject({ private: false, public: true, cached: false });
    expect(requestsFor('/sitemap.xml')).toHaveLength(2);
    // carol は、bob の公開の map を、共有のキャッシュから読む
    expect(await map(carol)).toMatchObject({ private: false, public: true, cached: true });
    expect(requestsFor('/sitemap.xml')).toHaveLength(2);
    // alice 自身は、自分の map を、キャッシュから読む
    expect(await map(alice)).toMatchObject({ private: true, public: false, cached: true });
    expect(requestsFor('/sitemap.xml')).toHaveLength(2);
    // tenant のキーに置いた回数（alice の 1 回）
    expect(getSecurityMetrics().sora_tenant_cache_write_total).toBe(1);
  });
});

describe('サイトマップのインデックス（子のサイトマップをたどる）', () => {
  test('子のサイトマップも、呼んだ tenant の保存済みのセッションで取る', async () => {
    sitemapIndex = true;
    const alice = tenant('alice', 'ALICE');
    expect(await map(alice)).toMatchObject({ private: true, public: false, source: 'sitemap' });
    for (const path of ['/sitemap.xml', '/child.xml']) {
      expect(requestsFor(path).map((s) => s.cookie ?? '')).toEqual([expect.stringContaining('sess=ALICE')]);
    }
  });
});

describe('キャッシュのキー', () => {
  test('版は v3（以前の共有のキーの、状態で見える内容が入っているかもしれない行は、読まない）', async () => {
    const bob = tenant('bob');
    await map(bob);
    const key = `map:v3:${base}/:10:false::`;
    expect(getFromCache(key)).not.toBeNull();
    expect(getFromCache(key.replace('map:v3:', 'map:v2:'))).toBeNull();
  });
});

describe('ページのリンクから作る map（サイトマップが無いとき）', () => {
  test('ページの取得も、呼んだ tenant の保存済みのセッションで行い、結果を別の tenant に返さない', async () => {
    withSitemap = false;
    const [alice, bob, carol] = [tenant('alice', 'ALICE'), tenant('bob'), tenant('carol')];
    expect(await map(alice)).toMatchObject({ private: true, public: false, source: 'links', cached: false });
    expect(requestsFor('/').map((s) => s.cookie ?? '')).toEqual([expect.stringContaining('sess=ALICE')]);
    expect(await map(bob)).toMatchObject({ private: false, public: true, source: 'links', cached: false });
    expect(await map(carol)).toMatchObject({ private: false, public: true, source: 'links', cached: true });
    expect(await map(alice)).toMatchObject({ private: true, public: false, cached: true });
  });
});
