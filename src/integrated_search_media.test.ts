import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as scraper from './scraper.js';
import * as yahoo from './services/yahoo.js';

// search_deep の includeMedia: false は、応答を作る段階で画像を省くだけでなく、ページを取る scrapeUrl にも渡す。
// 渡さないと、捨てるだけの画像のために rs-trafilatura の 2 回目（画像を戻す取り出し）が走る。
// 真・未指定のときは scrapeUrl に何も渡さない（今までどおり）。キャッシュは includeMedia ごとに分ける。

const paragraph = (i: number) =>
  `<p>Widget specification paragraph ${i}: the blue widget weighs 120 grams and costs 1,980 yen including tax.</p>`;
const goodPage = (title: string) =>
  `<html><head><title>${title}</title><meta property="og:image" content="https://example.com/og.jpg"></head><body><main><h1>${title}</h1><img src="/flyer.jpg" alt="フライヤー">${Array.from({ length: 30 }, (_, i) => paragraph(i)).join('')}</main></body></html>`;
// 本文が短くて使えないページ（失敗分の補充を起こす）
const tinyPage = '<html><head><title>A</title></head><body><main><p>短い</p></main></body></html>';

let server: ReturnType<typeof Bun.serve>;
let prevAllowLocal: string | undefined;
const restore: Array<() => void> = [];

beforeAll(() => {
  prevAllowLocal = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname;
      return new Response(path.includes('/tiny') ? tinyPage : goodPage(path), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
});

afterEach(() => {
  while (restore.length) restore.pop()!();
});

afterAll(() => {
  server.stop(true);
  if (prevAllowLocal === undefined) delete process.env.ALLOW_LOCAL_FETCH;
  else process.env.ALLOW_LOCAL_FETCH = prevAllowLocal;
});

function stubWebSearch(paths: string[]) {
  const items = paths.map((p) => ({ title: `Widget ${p}`, url: `http://127.0.0.1:${server.port}/${p}`, snippet: 'Blue widget page' }));
  const spy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items, count: items.length } as never);
  restore.push(() => spy.mockRestore());
}

const search = (query: string, extra: Record<string, unknown> = {}) =>
  scraper.integratedSearch({ query, limit: 1, includeRealtime: false, scrapeContent: true, ...extra }) as Promise<any>;

describe('search_deep の includeMedia を scrapeUrl に渡す', () => {
  // 最初の取得 (/tiny-a は使えない本文)、失敗分の補充 (/b)、adaptive の追加取得 (/c・/d。問いの語 zzqqword がどこにも無いので不足のまま) の 3 か所
  const scrapedPaths = (spy: { mock: { calls: any[][] } }) => spy.mock.calls.map(([o]) => new URL(o.url).pathname).sort();

  test('false のときは、最初の取得・失敗分の補充・adaptive の追加取得のすべてに includeMedia: false を渡す', async () => {
    stubWebSearch(['tiny-a', 'b', 'c', 'd']);
    const scrapeSpy = spyOn(scraper, 'scrapeUrl');
    restore.push(() => scrapeSpy.mockRestore());

    await search('widget zzqqword media-false-forward', { includeMedia: false, adaptiveScrape: true, scrapeBudget: 4, noCache: true });

    expect(scrapedPaths(scrapeSpy)).toEqual(['/b', '/c', '/d', '/tiny-a']);
    for (const [options] of scrapeSpy.mock.calls as any[]) expect(options.includeMedia).toBe(false);
  });

  test('true・未指定のときは、includeMedia を渡さない（今までどおり）', async () => {
    stubWebSearch(['tiny-a', 'b', 'c', 'd']);
    const scrapeSpy = spyOn(scraper, 'scrapeUrl');
    restore.push(() => scrapeSpy.mockRestore());

    await search('widget zzqqword media-default-forward', { adaptiveScrape: true, scrapeBudget: 4, noCache: true });
    await search('widget zzqqword media-true-forward', { includeMedia: true, adaptiveScrape: true, scrapeBudget: 4, noCache: true });

    expect(scrapeSpy.mock.calls.length).toBe(8);
    for (const [options] of scrapeSpy.mock.calls as any[]) expect(options.includeMedia).toBeUndefined();
  });

  test('includeMedia が違う要求は別の結果として取得する（画像の無い結果を、画像が要る要求に返さない）', async () => {
    stubWebSearch(['media-cache']);
    const query = 'widget media cache split';

    const off = await search(query, { includeMedia: false });
    const on = await search(query);
    const offAgain = await search(query, { includeMedia: false });
    const onAgain = await search(query, { includeMedia: true });

    expect(off.results[0].ogImage).toBeUndefined();
    expect(off.results[0].markdown).toContain('[画像: フライヤー]');
    expect(off.results[0].markdown).not.toContain('flyer.jpg');
    expect(on.results[0].ogImage).toBe('https://example.com/og.jpg');
    expect(on.results[0].markdown).toContain('flyer.jpg');
    expect(on.cached).toBeFalsy();
    expect(offAgain.cached).toBe(true);
    expect(offAgain.results[0].ogImage).toBeUndefined();
    expect(onAgain.cached).toBe(true);
    expect(onAgain.results[0].ogImage).toBe('https://example.com/og.jpg');
  });

  test('YouTube の動画のページは、includeMedia: false で media が省かれても、読んだページの題名にする', async () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const web = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: [{ title: 'Translated English title', url, snippet: 's' }], count: 1 } as never);
    restore.push(() => web.mockRestore());
    const scrapeSpy = spyOn(scraper, 'scrapeUrl').mockImplementation((async (options: any) => ({
      url: options.url, title: '読んだページの題名', content: '字幕の本文です。'.repeat(20), isTruncated: false, contentType: 'text/html', source: 'web',
      ...(options.includeMedia === false ? {} : { media: { type: 'youtube', videoId: 'dQw4w9WgXcQ' } }),
    })) as never);
    restore.push(() => scrapeSpy.mockRestore());

    const off = await search('youtube title probe off', { includeMedia: false, noCache: true });
    const on = await search('youtube title probe on', { noCache: true });

    expect(off.results[0].title).toBe('読んだページの題名');
    expect(on.results[0].title).toBe('読んだページの題名');
  });
});
