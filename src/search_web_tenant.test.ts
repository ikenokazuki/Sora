import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { clearCache } from './cache.js';
import { dbSaveTenantCookies } from './db.js';
import { closeHttpSession } from './http_fetcher.js';
import { scrapeUrl } from './scraper.js';
import { buildSearchWebCacheKey, searchWebForRest, searchWebWithFormats, type SearchWebFormatDependencies } from './search_web_formats.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';

/**
 * search_web の formats（検索の結果のページを読む）と tenant（設計 5。穴 17）。
 * これまで、結果のページの取得は、tenant を渡さず legacy として動き、応答全体は、tenant を含まないキー（search:web:…）で
 * 共有キャッシュに入った。tenant の保存済みの状態で見えた内容が、別の tenant に返りえた（E25 と同じ形）。
 */

const PRIVATE = 'PRIVATE-FOR-ALICE';
const PUBLIC = 'PUBLIC-FOR-EVERYONE';
const page = (marker: string) =>
  `<html><head><title>${marker}</title></head><body><main><h1>${marker}</h1><p>${marker}: このページの本文です。注文の履歴、住所、会員の情報など、読めるだけの長さの文章をここに置きます。</p><p>${marker}: 二つ目の段落です。抽出器が本文として扱うのに足りる長さの文を、続けて並べておきます。</p></main></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let previousAllow: string | undefined;
let searches = 0;
const tenants: string[] = [];

beforeAll(() => {
  previousAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const cookie = request.headers.get('cookie') ?? '';
      return new Response(page(cookie.includes('sess=ALICE') ? PRIVATE : PUBLIC), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
});
beforeEach(() => {
  searches = 0;
  resetSecurityMetrics();
});
afterEach(async () => {
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

/** 検索は手元のサイトを 1 件返す（回数を数える）。ページの取得は、本物の scrapeUrl */
const deps = (path: string, scrape: SearchWebFormatDependencies['scrapeUrl'] = scrapeUrl): SearchWebFormatDependencies => ({
  searchYahooWeb: (async () => {
    searches += 1;
    return { items: [{ title: 'ページ', url: `http://127.0.0.1:${server.port}/${path}`, snippet: '抜粋' }], count: 1 };
  }) as never,
  scrapeUrl: scrape,
});

const rest = async (query: string, tenantId: string, d: SearchWebFormatDependencies, formats: boolean = true) => {
  const body = formats ? { query, formats: ['markdown' as const], limit: 1 } : { query };
  const response = (await searchWebForRest(body, tenantId, d)) as { cached?: boolean };
  const text = JSON.stringify(response);
  return { private: text.includes(PRIVATE), public: text.includes(PUBLIC), cached: response.cached === true };
};

describe('formats を付けた検索（結果のページを読む）', () => {
  test('結果のページの取得に、呼んだ tenant を渡す', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const spy = (async (options: Record<string, unknown>) => {
      seen.push(options);
      return scrapeUrl(options as never);
    }) as SearchWebFormatDependencies['scrapeUrl'];
    const alice = tenant('alice');
    await searchWebWithFormats({ query: 'tenant を渡す', formats: ['markdown'], limit: 1 }, alice, deps('pass', spy));
    expect(seen.map((o) => o.tenantId)).toEqual([alice]);
  });

  test('保存済みのセッションで読んだ応答を、別の tenant に返さない。ログインしていない tenant どうしは、共有のキャッシュで共有する', async () => {
    const query = `search web tenant ${randomUUID()}`;
    const [alice, bob, carol] = [tenant('alice', 'ALICE'), tenant('bob'), tenant('carol')];
    const d = deps('mypage');
    expect(await rest(query, alice, d)).toMatchObject({ private: true, public: false, cached: false });
    // bob は、alice の応答を読まず、自分で検索して読む（公開のページ）
    expect(await rest(query, bob, d)).toMatchObject({ private: false, public: true, cached: false });
    expect(searches).toBe(2);
    // carol は、bob の公開の応答を、共有のキャッシュから読む
    expect(await rest(query, carol, d)).toMatchObject({ private: false, public: true, cached: true });
    expect(searches).toBe(2);
    // alice 自身は、自分の応答を、キャッシュから読む
    expect(await rest(query, alice, d)).toMatchObject({ private: true, public: false, cached: true });
    expect(searches).toBe(2);
    // tenant のキーに置いた回数: alice の、ページ（scrapeUrl）と応答（search:web）の 2 回
    expect(getSecurityMetrics().sora_tenant_cache_write_total).toBe(2);
  });
});

describe('formats を付けない検索（ページを読まない）', () => {
  test('tenant の状態を使わないので、応答は共有のキャッシュに置かれ、別の tenant が読める', async () => {
    const query = `search web no formats ${randomUUID()}`;
    const [alice, bob] = [tenant('alice', 'ALICE'), tenant('bob')];
    const d = deps('nopage');
    await rest(query, alice, d, false);
    expect(searches).toBe(1);
    expect((await rest(query, bob, d, false)).cached).toBe(true);
    expect(searches).toBe(1);
    expect(getSecurityMetrics().sora_tenant_cache_write_total ?? 0).toBe(0);
  });
});

test('キャッシュのキーの版は v3（以前の共有のキーの、状態で見える内容が入っているかもしれない行は、読まない）', () => {
  expect(buildSearchWebCacheKey({ query: 'x' })).toStartWith('search:web:v3:');
});
