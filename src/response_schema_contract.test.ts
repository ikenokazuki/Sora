// REST の実際の応答のキー（入れ子も含む）が、OpenAPI の 200 応答スキーマに載っているかを確かめる。
// 外部 API は固定応答（test_fixtures/external_apis.ts）、本文取得は手元のテスト用ページで動かす。
// 応答にスキーマに無い項目が増えたら（重複項目や書き忘れ）ここで落ちる。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { app } from './index.js';
import { generateOpenApiDocument } from './types.js';
import { resolveChromiumPath } from './browser_engine.js';
import { installExternalApiFixtures } from './test_fixtures/external_apis.js';
import { missingExampleKeys } from '../scripts/schema-notation/readme_examples.js';

const doc: any = generateOpenApiDocument();

function responseSchema(method: string, path: string): any {
  const bare = path.split('?')[0];
  const template = Object.keys(doc.paths).find((t) => new RegExp(`^${t.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(bare));
  return template ? doc.paths[template][method.toLowerCase()]?.responses?.['200']?.content?.['application/json']?.schema : undefined;
}

/**
 * 同じ問い合わせを2回送り、両方の応答を照合する。2回目はキャッシュから返る応答（cached・cachedAt・ageSeconds が付く）を確かめる。
 * どちらにも無いキーを、呼び出しの区別つきで返す。
 */
async function undeclaredKeys(method: 'GET' | 'POST', path: string, body?: unknown): Promise<string[]> {
  const schema = responseSchema(method, path);
  expect(schema).toBeDefined();
  const out: string[] = [];
  for (const call of ['first', 'repeat']) {
    const res = await app.request(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    expect(res.status).toBe(200);
    out.push(...missingExampleKeys(await res.json(), schema).map((key) => `${call}: ${key}`));
  }
  return [...new Set(out)];
}

let restoreFetch: (() => void) | undefined;
let page: ReturnType<typeof Bun.serve> | undefined;
let pageUrl = '';
let prevAllowLocal: string | undefined;

beforeAll(() => {
  restoreFetch = installExternalApiFixtures();
  const html = '<!doctype html><html><head><title>Contract Page</title><meta name="description" content="Contract test page"></head>'
    + '<body><h1>Contract Page</h1><p>本文のテスト用ページです。リンクと本文を含みます。</p>'
    + '<p><a href="/next">次のページ</a></p></body></html>';
  page = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) });
  pageUrl = `http://127.0.0.1:${page.port}/`;
  prevAllowLocal = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
});

afterAll(() => {
  restoreFetch?.();
  page?.stop(true);
  if (prevAllowLocal === undefined) delete process.env.ALLOW_LOCAL_FETCH;
  else process.env.ALLOW_LOCAL_FETCH = prevAllowLocal;
});

describe('REST responses only contain keys declared in the OpenAPI 200 schema', () => {
  const cases: Array<[string, 'GET' | 'POST', string, unknown?]> = [
    ['weather (GET)', 'GET', '/weather?city=%E5%B1%B1%E4%B8%AD%E6%B9%96&days=7'],
    ['weather (POST)', 'POST', '/weather', { city: '東京', days: 2 }],
    ['disaster warnings', 'POST', '/disaster/warnings', { city: '東京' }],
    ['earthquake', 'POST', '/disaster/earthquake', { limit: 2 }],
    ['road traffic by prefecture', 'POST', '/traffic/road', { pref: '東京都' }],
    ['road traffic by road', 'GET', '/traffic/road?road=%E6%9D%B1%E5%90%8D%E9%AB%98%E9%80%9F'],
    ['song search', 'POST', '/search/song', { query: 'アイドル', limit: 2 }],
    ['artist search', 'POST', '/search/artist', { query: 'YOASOBI', limit: 2 }],
    ['music search', 'POST', '/search/music', { query: 'YOASOBI', limit: 2 }],
    ['HTS verify', 'POST', '/trade/hts-verify', { htsCode: '9503.00.0073', productDescription: 'plastic toy car for children' }],
    ['HTS predict', 'POST', '/trade/hts-predict', { productName: 'Ceramic Coffee Mug', description: 'Stoneware coffee mug for kitchen use', material: 'ceramic', foodContact: true }],
    ['compliance', 'POST', '/trade/compliance', { productName: 'Wooden Building Blocks for Toddlers', description: 'Educational wooden puzzle block toy for children aged 3+.' }],
    ['health', 'GET', '/health'],
    ['detailed health', 'GET', '/health?detailed=true'],
    ['metrics', 'GET', '/metrics'],
  ];
  for (const [name, method, path, body] of cases) {
    test(name, async () => {
      expect(await undeclaredKeys(method, path, body)).toEqual([]);
    }, 30_000);
  }

  test('scrape', async () => {
    expect(await undeclaredKeys('POST', '/scrape', { url: pageUrl, mode: 'fast', noCache: true })).toEqual([]);
  }, 30_000);

  test('scrape batch', async () => {
    expect(await undeclaredKeys('POST', '/scrape/batch', { urls: [`${pageUrl}a`, `${pageUrl}b`], fastOnly: true, noCache: true })).toEqual([]);
  }, 30_000);

  test('map', async () => {
    expect(await undeclaredKeys('POST', '/map', { url: pageUrl, limit: 10 })).toEqual([]);
  }, 30_000);

  test('crawl', async () => {
    expect(await undeclaredKeys('POST', '/crawl', { url: pageUrl, maxPages: 2 })).toEqual([]);
  }, 30_000);

  test.skipIf(!resolveChromiumPath())('browser action', async () => {
    expect(await undeclaredKeys('POST', '/browser/action', { url: pageUrl, actions: [{ type: 'wait', ms: 50 }], extract: { markdown: true } })).toEqual([]);
  }, 60_000);
});
