import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import * as yahoo from './services/yahoo.js';
import * as scraper from './scraper.js';
import { integratedSearch } from './scraper.js';
import { ResourceBusyError } from './errors.js';

// search_deep（integratedSearch）のキャッシュ。以前はキーに maxChars が無く、maxChars: 300 で呼んだ直後に
// maxChars: 30000 で呼んでも、300 文字の結果が `cached: true` で返っていた（逆なら、節約のために小さくした値が無視される）。

const paragraph = (i: number) =>
  `<p>Widget specification paragraph ${i}: the blue widget weighs 120 grams and costs 1,980 yen including tax.</p>`;

let server: ReturnType<typeof Bun.serve>;
let prevAllowLocal: string | undefined;
let webSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(() => {
  prevAllowLocal = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      return new Response(
        `<html><head><title>Widget</title></head><body><main><h1>Blue Widget</h1>${Array.from({ length: 80 }, (_, i) => paragraph(i)).join('')}</main></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    },
  });
});

afterEach(() => {
  webSpy?.mockRestore();
  webSpy = undefined;
});

afterAll(() => {
  server.stop(true);
  if (prevAllowLocal === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllowLocal;
});

function stubWebSearch(path: string) {
  const url = `http://127.0.0.1:${server.port}/${path}`;
  webSpy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({
    items: [{ title: 'Blue Widget', url, snippet: 'Blue widget page' }],
    count: 1,
  } as never);
  return webSpy;
}

const search = (query: string, extra: Record<string, unknown> = {}) =>
  integratedSearch({ tenantId: 'legacy', query, limit: 1, includeRealtime: false, scrapeContent: true, ...extra }) as Promise<any>;

test('maxChars が違う要求は別の結果として取得する（小さい指定の結果を、大きい指定に返さない）', async () => {
  const spy = stubWebSearch('maxchars-small-first');
  const query = 'integrated cache maxChars small first';

  const small = await search(query, { maxChars: 300 });
  const big = await search(query, { maxChars: 30000 });

  expect(small.results[0].markdown.length).toBeLessThanOrEqual(300);
  expect(big.results[0].markdown.length).toBeGreaterThan(1000);
  expect(big.cached).toBeFalsy();
  expect(spy).toHaveBeenCalledTimes(2);
});

test('大きい指定のあとに小さい指定で呼んでも、大きい結果を返さない', async () => {
  const spy = stubWebSearch('maxchars-big-first');
  const query = 'integrated cache maxChars big first';

  const big = await search(query, { maxChars: 30000 });
  const small = await search(query, { maxChars: 300 });

  expect(big.results[0].markdown.length).toBeGreaterThan(1000);
  expect(small.results[0].markdown.length).toBeLessThanOrEqual(300);
  expect(small.cached).toBeFalsy();
  expect(spy).toHaveBeenCalledTimes(2);
});

test('verbose の有無は別のキャッシュとして扱う（診断つきの応答を通常の要求に返さない）', async () => {
  const spy = stubWebSearch('verbose-split');
  const query = 'integrated cache verbose split';

  const compact = await search(query, { maxChars: 2000 });
  const verbose = await search(query, { maxChars: 2000, verbose: true });
  const compactAgain = await search(query, { maxChars: 2000 });

  expect(compact.searchDiagnostics).toBeUndefined();
  expect(verbose.searchDiagnostics).toBeDefined();
  expect(verbose.cached).toBe(false);
  expect(compactAgain.cached).toBe(true);
  expect(compactAgain.searchDiagnostics).toBeUndefined();
  expect(spy).toHaveBeenCalledTimes(2);
});

test('同じ指定の繰り返しはキャッシュから返る', async () => {
  const spy = stubWebSearch('maxchars-repeat');
  const query = 'integrated cache repeat';

  const first = await search(query, { maxChars: 2000 });
  const second = await search(query, { maxChars: 2000 });

  expect(first.cached).toBe(false);
  expect(second.cached).toBe(true);
  expect(second.results[0].markdown).toBe(first.results[0].markdown);
  expect(spy).toHaveBeenCalledTimes(1);
});

test('noCache: true は本文の取得（scrapeUrl）にも届く（上位・補充・追加取得・動画の 4 か所）', async () => {
  const web = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({
    items: [1, 2, 3].map((i) => ({ title: `nocache page ${i}`, url: `https://nocache-${i}.example/`, snippet: 'snippet' })),
    count: 3,
  } as never);
  const video = spyOn(yahoo, 'searchYahooVideo').mockResolvedValue({ items: [{ title: 'v', url: 'https://www.youtube.com/watch?v=abcdefghijk' }] } as never);
  // 本文の取得を全部失敗させ、予備の 2 件の補充と、追加取得（同じ 2 件）まで進める
  const scrape = spyOn(scraper, 'scrapeUrl').mockRejectedValue(new Error('down'));
  try {
    await integratedSearch({ tenantId: 'legacy', query: 'integrated nocache page fetch', limit: 1, includeRealtime: false, adaptiveScrape: true, scrapeBudget: 3, videos: 1, noCache: true });
    const urls = scrape.mock.calls.map(([o]) => o.url);
    expect(urls.filter((u) => u.includes('youtube.com'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('nocache-'))).toHaveLength(5);
    expect(scrape.mock.calls.map(([o]) => o.noCache)).toEqual(urls.map(() => true));
  } finally {
    web.mockRestore();
    video.mockRestore();
    scrape.mockRestore();
  }
});

test('結果のページの読み取りが、順番・予算で断られた応答は、キャッシュに入れない（断られた利用者の欠けた結果が、別の利用者に返らない。設計 6。穴 26）', async () => {
  stubWebSearch('busy-not-cached');
  const query = 'integrated cache busy not cached';
  const scrapeSpy = spyOn(scraper, 'scrapeUrl').mockRejectedValue(new ResourceBusyError('PDF の解析の順番を待つ要求が、この利用者の上限（8 件）に達しています', 'tenant_queue_full', 5, 'pdf'));
  const first = await search(query, { tenantId: 'name:A' });
  scrapeSpy.mockRestore();
  expect(JSON.stringify(first.results[0])).toContain('PDF の解析の順番');
  const second = await search(query, { tenantId: 'name:B' });
  expect(second.cached).toBeFalsy();
  expect(second.results[0].scrapeError).toBeUndefined();
  expect(second.results[0].markdown).toContain('Widget specification');
});

test('verbose（診断つきの応答）も、断られた応答は、キャッシュに入れない', async () => {
  stubWebSearch('busy-not-cached-verbose');
  const query = 'integrated cache busy not cached verbose';
  const scrapeSpy = spyOn(scraper, 'scrapeUrl').mockRejectedValue(new ResourceBusyError('PDF の解析の順番を待つ要求が、この利用者の上限（20 件）に達しています', 'tenant_queue_full', 5, 'pdf'));
  await search(query, { tenantId: 'name:A', verbose: true });
  scrapeSpy.mockRestore();
  const second = await search(query, { tenantId: 'name:B', verbose: true });
  expect(second.cached).toBeFalsy();
  expect(second.results[0].scrapeError).toBeUndefined();
});

test('動画の検索（Yahoo）が順番・予算で断られた応答は、キャッシュに入れない（動画なしの結果が、別の利用者に返らない）', async () => {
  stubWebSearch('video-search-busy');
  const query = 'integrated cache video search busy';
  const video = spyOn(yahoo, 'searchYahooVideo').mockRejectedValueOnce(new ResourceBusyError('Yahoo への問い合わせの、この利用者の予算を使い切りました', 'tenant_budget', 9, 'yahoo'));
  const first = await search(query, { tenantId: 'name:A', videos: 2 });
  video.mockResolvedValue({ items: [] } as never);
  const second = await search(query, { tenantId: 'name:B', videos: 2 });
  const calls = video.mock.calls.length;
  video.mockRestore();
  expect(first.results.length).toBeGreaterThan(0); // 断られた利用者にも、動画なしの結果は返る
  expect(second.cached).toBeFalsy();
  expect(calls).toBe(2); // 別の利用者は、動画を取り直した
});

test('動画のページの読み取りが、順番・予算で断られた応答も、キャッシュに入れない', async () => {
  stubWebSearch('video-page-busy');
  const query = 'integrated cache video page busy';
  const video = spyOn(yahoo, 'searchYahooVideo').mockResolvedValue({ items: [{ title: 'v', url: 'https://www.youtube.com/watch?v=abcdefghijk' }] } as never);
  const real = scraper.scrapeUrl;
  const scrape = spyOn(scraper, 'scrapeUrl').mockImplementation((async (options: Parameters<typeof real>[0]) => {
    if (options.url.includes('youtube.com')) throw new ResourceBusyError('ブラウザの枠が混み合っています', 'queue_full', 6);
    return real(options);
  }) as never);
  try {
    await search(query, { tenantId: 'name:A', videos: 1 });
    scrape.mockImplementation(real as never);
    const second = await search(query, { tenantId: 'name:B', videos: 1 });
    expect(second.cached).toBeFalsy();
  } finally {
    video.mockRestore();
    scrape.mockRestore();
  }
});
