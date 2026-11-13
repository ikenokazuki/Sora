import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as cache from './cache.js';
import { clearCache } from './cache.js';
import { dbSaveTenantCookies } from './db.js';
import { closeHttpSession } from './http_fetcher.js';
import { integratedSearch } from './scraper.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import * as yahoo from './services/yahoo.js';

/**
 * search_deep（integratedSearch）の応答のキャッシュと tenant（設計 5。穴 16）。
 * 検索の結果の中の各ページを、tenant の保存済みのセッションで読んだなら、その応答を、共有のキャッシュに入れない。
 */

const PRIVATE = 'PRIVATE-FOR-ALICE';
const PUBLIC = 'PUBLIC-FOR-EVERYONE';
const page = (marker: string) =>
  `<html><head><title>${marker}</title></head><body><main><h1>${marker}</h1><p>${marker}: このページの本文です。注文の履歴、住所、会員の情報など、読めるだけの長さの文章をここに置きます。</p><p>${marker}: 二つ目の段落です。抽出器が本文として扱うのに足りる長さの文を、続けて並べておきます。</p></main></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let prevAllow: string | undefined;
let webSpy: ReturnType<typeof spyOn> | undefined;
const tenants: string[] = [];

beforeAll(() => {
  prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
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

// 同じプロセスで先に走ったテストが、カウンターを増やしていることがある。試験の前にも 0 に戻す
beforeEach(() => resetSecurityMetrics());

afterEach(async () => {
  resetSecurityMetrics();
  webSpy?.mockRestore();
  webSpy = undefined;
  clearCache();
  for (const id of tenants.splice(0)) {
    await closeHttpSession('127.0.0.1', id).catch(() => {});
    dbSaveTenantCookies(id, '127.0.0.1', []);
  }
});

afterAll(() => {
  server.stop(true);
  if (prevAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
});

const tenant = (label: string, storedCookie?: string) => {
  const id = `name:${label}-${randomUUID().slice(0, 8)}`;
  tenants.push(id);
  if (storedCookie) dbSaveTenantCookies(id, '127.0.0.1', [{ name: 'sess', value: storedCookie, path: '/' }]);
  return id;
};

function stubWebSearch(path: string) {
  const url = `http://127.0.0.1:${server.port}/${path}`;
  webSpy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: [{ title: 'ページ', url, snippet: 'ページの抜粋' }], count: 1 } as never);
  return webSpy;
}

const search = async (query: string, tenantId: string) => {
  const response = (await integratedSearch({ query, limit: 1, includeRealtime: false, scrapeContent: true, tenantId })) as { cached?: boolean; results: Array<{ markdown?: string }> };
  const text = response.results.map((r) => r.markdown ?? '').join('\n');
  return { private: text.includes(PRIVATE), public: text.includes(PUBLIC), cached: response.cached === true };
};

test('保存済みのセッションで読んだページを含む応答は、共有のキャッシュに入れない（別の tenant に返さない）', async () => {
  const spy = stubWebSearch('agg-private');
  const query = 'integrated search tenant cache private';
  const [alice, bob, carol] = [tenant('alice', 'ALICE'), tenant('bob'), tenant('carol')];

  expect(await search(query, alice)).toMatchObject({ private: true, public: false, cached: false });
  // bob は、alice の応答を読まず、自分で検索して読む（公開のページ）
  expect(await search(query, bob)).toMatchObject({ private: false, public: true, cached: false });
  expect(spy).toHaveBeenCalledTimes(2);
  // carol は、bob の公開の応答を、共有のキャッシュから読む
  expect(await search(query, carol)).toMatchObject({ private: false, public: true, cached: true });
  expect(spy).toHaveBeenCalledTimes(2);
});

test('保存済みのセッションを使った応答は、その tenant 自身には、キャッシュから返す', async () => {
  const spy = stubWebSearch('agg-own');
  const query = 'integrated search tenant cache own';
  const alice = tenant('alice', 'ALICE');

  expect(await search(query, alice)).toMatchObject({ private: true, cached: false });
  // tenant のキーに置いた回数: 読んだページ（scrapeUrl）と、応答（integratedSearch）の 2 回
  expect(getSecurityMetrics().sora_tenant_cache_write_total).toBe(2);
  expect(await search(query, alice)).toMatchObject({ private: true, public: false, cached: true });
  expect(spy).toHaveBeenCalledTimes(1);
});

test('応答のキー: 共有は search:integrated:v14（古い版の、状態で見える内容が入っているかもしれないキーは読まない）、tenant の分は tenant:<ID>: で始まる', async () => {
  stubWebSearch('agg-keys');
  const setSpy = spyOn(cache, 'setToCache');
  try {
    const [alice, bob] = [tenant('alice', 'ALICE'), tenant('bob')];
    await search('integrated search tenant cache keys', alice);
    await search('integrated search tenant cache keys', bob);
    const keys = setSpy.mock.calls.map(([key]) => String(key)).filter((key) => key.includes('search:integrated:'));
    expect(keys).toHaveLength(2);
    expect(keys.filter((key) => key.startsWith(`tenant:${alice}:search:integrated:v14:`))).toHaveLength(1);
    expect(keys.filter((key) => key.startsWith('search:integrated:v14:'))).toHaveLength(1);
  } finally {
    setSpy.mockRestore();
  }
});

