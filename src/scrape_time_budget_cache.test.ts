import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as browserEngine from './browser_engine.js';
import * as browserStealth from './browser_stealth.js';
import * as cache from './cache.js';
import { mapSiteUrl, scrapeUrl } from './scraper.js';

// 時間の予算（timeoutMs）は、結果の中身を変える（ブラウザの時間切れの代わりの静的な結果・描画の途中のページ）。
// 短い予算の取得の欠けた結果が、キャッシュから、別の予算の取得に返らないことを確かめる。ブラウザは偽の描画に差し替える（手元のサーバーだけ）
const SHELL = '<!doctype html><html><head><title>spa</title></head><body><div id="root">SHELLONLY loading application, please wait while the content is prepared.</div><a href="/static-only">static</a><script src="/app.js"></script></body></html>';
const RENDERED = `<!doctype html><html><head><title>Real</title></head><body><main><h1>Real Article</h1>${'<p>RENDEREDBODY this is the real rendered article body with plenty of meaningful text.</p>'.repeat(12)}<a href="/a">a</a> <a href="/b">b</a></main></body></html>`;
const FALLBACK = 'ブラウザで描画できなかった';

describe('時間の予算が違う取得は、キャッシュを分ける', () => {
  let server: ReturnType<typeof Bun.serve>;
  const prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  const spies: Array<{ mockRestore: () => void }> = [];
  let n = 0;
  const pageUrl = () => `http://127.0.0.1:${server.port}/spa-${++n}-${Date.now()}`;

  beforeAll(() => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => (/\/(robots\.txt|sitemap[\w/_]*\.xml)$/.test(new URL(req.url).pathname) ? new Response('', { status: 404 }) : new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
    });
  });
  afterAll(() => {
    server.stop(true);
    if (prevAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
  });
  beforeEach(() => {
    cache.clearCache();
    spies.push(spyOn(browserEngine, 'resolveChromiumPath').mockReturnValue('/test/chromium'));
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  /** 予算が 5 秒未満なら、時間切れ（fail）か、描画の途中（partial）。足りれば、描画できる */
  const fakeBrowser = (short: 'fail' | 'partial') => {
    spies.push(spyOn(browserStealth, 'fetchWithStealthBrowser').mockImplementation((async (target: string, timeoutMs = 30_000) => {
      if (timeoutMs >= 5000) return { html: RENDERED, title: 'Real', finalUrl: target, status: 200 };
      if (short === 'fail') throw new Error(`Navigation timeout of ${timeoutMs} ms exceeded`);
      return { html: SHELL, title: 'spa', finalUrl: target, status: 200 };
    }) as typeof browserStealth.fetchWithStealthBrowser));
  };
  const cached = (r: unknown) => (r as { cached?: boolean }).cached;

  for (const [name, short] of [['ブラウザが時間切れになった', 'fail'], ['描画の途中で返った', 'partial']] as const) {
    test(`${name}短い予算の結果は、既定の予算の取得に返らない`, async () => {
      fakeBrowser(short);
      const url = pageUrl();
      const first = await scrapeUrl({ url, tenantId: 'name:short', timeoutMs: 900 });
      expect(first.content).toContain('SHELLONLY');
      const second = await scrapeUrl({ url, tenantId: 'name:other' });
      expect(cached(second)).toBeUndefined();
      expect(second.renderedWithBrowser).toBe(true);
      expect(second.content).toContain('RENDEREDBODY');
    });
  }

  test('ブラウザの代わりの静的な結果は warnings で知らせ、短い時間だけキャッシュする', async () => {
    fakeBrowser('fail');
    const setSpy = spyOn(cache, 'setToCache');
    spies.push(setSpy);
    const url = pageUrl();
    const fallback = await scrapeUrl({ url, tenantId: 'legacy', timeoutMs: 900 });
    expect(fallback.renderedWithBrowser).toBe(false);
    expect(fallback.warnings).toEqual([expect.stringContaining(FALLBACK)]);
    expect(setSpy.mock.calls.filter(([key]) => String(key).startsWith(`scrape:v11:${url}:`)).map(([, , ttl]) => ttl)).toEqual([cache.CACHE_TTL_EMPTY]);
    const rendered = await scrapeUrl({ url, tenantId: 'legacy' });
    expect(rendered.content).toContain('RENDEREDBODY');
    expect(rendered.warnings).toBeUndefined();
  });

  test('サイトマップが無いときの map も、予算ごとに分ける。描画できずに欠けた一覧は、知らせて短い時間だけ置く', async () => {
    fakeBrowser('fail');
    const setSpy = spyOn(cache, 'setToCache');
    spies.push(setSpy);
    const url = `${pageUrl()}/`;
    const first = await mapSiteUrl({ url, tenantId: 'name:short', timeoutMs: 900 });
    expect(first.links.map((link) => new URL(link).pathname)).toEqual(['/static-only']);
    expect(first.warnings).toEqual([expect.stringContaining(FALLBACK)]);
    expect(setSpy.mock.calls.filter(([key]) => String(key).startsWith('map:')).map(([, , ttl]) => ttl)).toEqual([cache.CACHE_TTL_EMPTY]);
    const second = await mapSiteUrl({ url, tenantId: 'name:other' });
    expect(second.links.map((link) => new URL(link).pathname).sort()).toEqual(['/a', '/b']);
    expect(second.warnings).toBeUndefined();
  });
});
