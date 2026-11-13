import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolveChromiumPath } from './browser_engine.js';
import { clearCache, getCacheMetrics } from './cache.js';
import { dbSaveTenantCookies, dbSaveTenantStorage } from './db.js';
import { closeHttpSession } from './http_fetcher.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { scrapeUrl } from './scraper.js';

/**
 * 共有キャッシュと tenant（設計 5。穴 16。E25）。
 * 保存済みのセッション（Cookie）で得た個人向けのページを、共有キャッシュに入れて、別の tenant に返していた。
 * 手元のサーバーは、Cookie の値で返す本文を変える。cookie が sess=ALICE なら個人向け、無ければ公開。
 */

const PRIVATE = 'PRIVATE-FOR-ALICE';
const PUBLIC = 'PUBLIC-FOR-EVERYONE';
const page = (marker: string) =>
  `<html><head><title>${marker}</title></head><body><main><h1>${marker}</h1><p>${marker}: このページの本文です。注文の履歴、住所、会員の情報など、読めるだけの長さの文章をここに置きます。</p><p>${marker}: 二つ目の段落です。抽出器が本文として扱うのに足りる長さの文を、続けて並べておきます。</p></main></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let hits = 0;
let delayMs = 0;
let prevAllow: string | undefined;

beforeAll(() => {
  prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      hits++;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const cookie = request.headers.get('cookie') ?? '';
      // /storage/ の経路は、ブラウザの localStorage の値で、本文を作る（サーバーには見えない状態）
      if (new URL(request.url).pathname.startsWith('/storage/')) {
        return new Response(
          `<html><head><title>storage</title></head><body><main id="m"></main><script>document.getElementById('m').innerHTML = ${JSON.stringify(page('__M__'))}.replaceAll('__M__', localStorage.getItem('who') === 'ALICE' ? '${PRIVATE}' : '${PUBLIC}');</script></body></html>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
      // /setcookie/ の経路は、閲覧した人に Cookie を出す（多くのサイトが、分析・同意・言語のために出す）
      if (new URL(request.url).pathname.startsWith('/setcookie/')) headers['set-cookie'] = 'visit=1; Path=/';
      return new Response(page(cookie.includes('sess=ALICE') ? PRIVATE : PUBLIC), { headers });
    },
  });
});

afterAll(() => {
  server.stop(true);
  if (prevAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
});

const tenants: string[] = [];
/** 試験ごとに、新しい tenant（保存済みの Cookie も、取得のセッションも、別）を作る */
const tenant = (label: string, storedCookie?: string) => {
  const id = `name:${label}-${randomUUID().slice(0, 8)}`;
  tenants.push(id);
  if (storedCookie) dbSaveTenantCookies(id, '127.0.0.1', [{ name: 'sess', value: storedCookie, path: '/' }]);
  return id;
};

// 同じプロセスで先に走ったテストが、カウンターを増やしていることがある（全件で落ちた）。試験の前にも 0 に戻す
beforeEach(() => resetSecurityMetrics());

afterEach(async () => {
  hits = 0;
  delayMs = 0;
  clearCache();
  resetSecurityMetrics();
  for (const id of tenants.splice(0)) {
    await closeHttpSession('127.0.0.1', id).catch(() => {});
    dbSaveTenantCookies(id, '127.0.0.1', []); // 保存した Cookie は残るので、後の試験に持ち越さない
    dbSaveTenantStorage(id, '127.0.0.1', {});
  }
});

const urlOf = (path: string) => `http://127.0.0.1:${server.port}/${path}`;
async function scrape(tenantId: string, path: string, extra: Record<string, unknown> = {}) {
  const result = (await scrapeUrl({ url: urlOf(path), tenantId, mode: 'fast', formats: ['markdown'], ...extra } as never)) as { title?: string; content?: string; cached?: boolean };
  const text = `${result.title ?? ''} ${result.content ?? ''}`;
  return { private: text.includes(PRIVATE), public: text.includes(PUBLIC), cached: result.cached === true };
}

describe('保存済みのセッションで得た結果は、別の tenant に返さない（E25）', () => {
  test('alice の個人向けのページを、bob・carol に返さない。ログインしていない tenant どうしは共有する', async () => {
    const alice = tenant('alice', 'ALICE');
    const [bob, carol] = [tenant('bob'), tenant('carol')];
    expect(await scrape(alice, 'mypage')).toMatchObject({ private: true, public: false, cached: false });
    expect(hits).toBe(1);
    expect(getSecurityMetrics().sora_tenant_cache_write_total).toBe(1); // tenant のキーに置いた回数
    // bob は、alice の結果を読まず、自分で取る（公開のページ）
    expect(await scrape(bob, 'mypage')).toMatchObject({ private: false, public: true, cached: false });
    expect(hits).toBe(2);
    // carol は、bob が取った公開のページを、共有のキャッシュから読む
    expect(await scrape(carol, 'mypage')).toMatchObject({ private: false, public: true, cached: true });
    expect(hits).toBe(2);
    expect(getSecurityMetrics().sora_tenant_cache_write_total).toBe(1); // 公開のページは、tenant のキーに置いていない
  });

  test('キャッシュの外れの数: tenant のキーの外れは数えない（1 回の取得は、外れ 1 回）', async () => {
    const bob = tenant('bob');
    const before = getCacheMetrics().misses;
    await scrape(bob, 'miss-count');
    expect(getCacheMetrics().misses).toBe(before + 1);
  });

  test('保存済みのセッションを持つ tenant は、自分の結果を、自分のキャッシュから読む', async () => {
    const alice = tenant('alice', 'ALICE');
    expect(await scrape(alice, 'mypage')).toMatchObject({ private: true, cached: false });
    expect(await scrape(alice, 'mypage')).toMatchObject({ private: true, public: false, cached: true });
    expect(hits).toBe(1);
  });

  test('サイトが Cookie を出しても、同じ tenant の繰り返しの取得は、キャッシュに当たる（Cookie を出すサイトでも、命中率を保つ）', async () => {
    const bob = tenant('bob');
    expect(await scrape(bob, 'setcookie/a')).toMatchObject({ cached: false }); // 取得の前は Cookie が無いので、共有のキーに置く
    expect(await scrape(bob, 'setcookie/a')).toMatchObject({ cached: true }); // 受け取った Cookie を持つが、共有のキーから読む
    expect(await scrape(bob, 'setcookie/a')).toMatchObject({ cached: true });
    expect(hits).toBe(1);
  });

  test('Cookie を持って取った結果は、その tenant のキーにだけ置く（別の tenant は、取り直す。安全側の動き）', async () => {
    const [bob, carol] = [tenant('bob'), tenant('carol')];
    await scrape(bob, 'setcookie/first'); // bob は、このホストの Cookie を受け取る
    expect(await scrape(bob, 'setcookie/second')).toMatchObject({ cached: false }); // Cookie を持って取る
    expect(await scrape(bob, 'setcookie/second')).toMatchObject({ cached: true }); // 自分のキーから
    const before = hits;
    expect(await scrape(carol, 'setcookie/second')).toMatchObject({ cached: false }); // bob の結果は共有されていない
    expect(hits).toBe(before + 1);
  });

  test('同時に同じ URL を取る別の tenant は、互いの取得を共有しない', async () => {
    delayMs = 150;
    const [alice, bob] = [tenant('alice', 'ALICE'), tenant('bob')];
    const [a, b] = await Promise.all([scrape(alice, 'slow'), scrape(bob, 'slow')]);
    expect(a).toMatchObject({ private: true, public: false });
    expect(b).toMatchObject({ private: false, public: true });
    expect(hits).toBe(2);
  });

  test('同じ tenant の同時の取得は、1 回にまとめる（従来どおり）', async () => {
    delayMs = 150;
    const alice = tenant('alice', 'ALICE');
    const results = await Promise.all([scrape(alice, 'slow-same'), scrape(alice, 'slow-same'), scrape(alice, 'slow-same')]);
    for (const r of results) expect(r).toMatchObject({ private: true });
    expect(hits).toBe(1);
  });

  test('noCache は、読みも書きもしない（従来どおり）', async () => {
    const alice = tenant('alice', 'ALICE');
    await scrape(alice, 'nocache', { noCache: true });
    await scrape(alice, 'nocache', { noCache: true });
    expect(hits).toBe(2);
    expect(await scrape(alice, 'nocache')).toMatchObject({ cached: false }); // 書かれていない
  });

  const browserTest = resolveChromiumPath() ? test : test.skip;
  browserTest('ブラウザで取っても同じ（保存済みの Cookie・localStorage を読み込んだ結果は、別の tenant に返さない）', async () => {
    const alice = tenant('alice', 'ALICE');
    const [bob, carol] = [tenant('bob'), tenant('carol')];
    expect(await scrape(alice, 'browser-page', { mode: 'browser' })).toMatchObject({ private: true, public: false });
    expect(await scrape(bob, 'browser-page', { mode: 'browser' })).toMatchObject({ private: false, public: true, cached: false });
    expect(await scrape(carol, 'browser-page', { mode: 'browser' })).toMatchObject({ private: false, public: true, cached: true });
    expect(await scrape(alice, 'browser-page', { mode: 'browser' })).toMatchObject({ private: true, cached: true });
  }, 90_000);

  browserTest('localStorage だけの状態（Cookie なし）でも、別の tenant に返さない', async () => {
    const alice = tenant('alice');
    dbSaveTenantStorage(alice, '127.0.0.1', { who: 'ALICE' });
    const [bob, carol] = [tenant('bob'), tenant('carol')];
    expect(await scrape(alice, 'storage/page', { mode: 'browser' })).toMatchObject({ private: true, public: false });
    expect(await scrape(bob, 'storage/page', { mode: 'browser' })).toMatchObject({ private: false, public: true, cached: false });
    expect(await scrape(carol, 'storage/page', { mode: 'browser' })).toMatchObject({ private: false, public: true, cached: true });
  }, 90_000);
});

describe('呼び出し側が渡したヘッダーと共有キャッシュ', () => {
  test('資格情報の名前でなくても、ヘッダーを渡した取得は、共有のキャッシュを読まず、書かない', async () => {
    const bob = tenant('bob');
    await scrape(bob, 'header', { headers: { 'X-Auth': 'token-1' } });
    await scrape(bob, 'header', { headers: { 'X-Auth': 'token-1' } });
    expect(hits).toBe(2); // 読まない
    expect(await scrape(bob, 'header')).toMatchObject({ cached: false }); // 書いていない（ヘッダーなしの取得が、共有のキャッシュに当たらない）
    expect(hits).toBe(3);
    expect(await scrape(bob, 'header')).toMatchObject({ cached: true });
    expect(hits).toBe(3);
  });

  test('Accept-Language など、結果の言語にだけ影響するヘッダーは、いままでどおり、キーに入れて共有する', async () => {
    const [bob, carol] = [tenant('bob'), tenant('carol')];
    await scrape(bob, 'lang', { headers: { 'Accept-Language': 'ja' } });
    expect(await scrape(carol, 'lang', { headers: { 'accept-language': 'ja' } })).toMatchObject({ cached: true });
    expect(await scrape(carol, 'lang', { headers: { 'Accept-Language': 'en' } })).toMatchObject({ cached: false });
    expect(hits).toBe(2);
  });

  test('Cookie を渡した取得は、共有のキャッシュを使わない', async () => {
    const bob = tenant('bob');
    await scrape(bob, 'cookie', { cookies: [{ name: 'a', value: 'b' }] });
    await scrape(bob, 'cookie', { cookies: [{ name: 'a', value: 'b' }] });
    expect(hits).toBe(2);
  });
});
