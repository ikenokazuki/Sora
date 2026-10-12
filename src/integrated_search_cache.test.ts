import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import * as yahoo from './services/yahoo.js';
import { integratedSearch } from './scraper.js';

// search_deep（integratedSearch）のキャッシュ。以前はキーに maxChars が無く、maxChars: 300 で呼んだ直後に
// maxChars: 30000 で呼んでも、300 文字の結果が `cached: true` で返っていた（逆なら、節約のために小さくした値が無視される）。

const paragraph = (i: number) =>
  `<p>Widget specification paragraph ${i}: the blue widget weighs 120 grams and costs 1,980 yen including tax.</p>`;

let server: ReturnType<typeof Bun.serve>;
let prevAllowLocal: string | undefined;
let webSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(() => {
  prevAllowLocal = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
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
  if (prevAllowLocal === undefined) delete process.env.ALLOW_LOCAL_FETCH;
  else process.env.ALLOW_LOCAL_FETCH = prevAllowLocal;
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
  integratedSearch({ query, limit: 1, includeRealtime: false, scrapeContent: true, extractHighlights: false, ...extra }) as Promise<any>;

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
