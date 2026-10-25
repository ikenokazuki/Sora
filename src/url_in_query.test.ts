import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { closeSharedBrowser, resolveChromiumPath } from './browser_engine.js';
import { summarizeContextSufficiency } from './context_sufficiency.js';
import * as httpFetcher from './http_fetcher.js';
import { splitQueryUrls } from './html_parser.js';
import { integratedSearch, scrapeUrl } from './scraper.js';
import * as xDetail from './services/x_detail.js';
import * as yahoo from './services/yahoo.js';

// 検索語の URL と、読めないページ（画像などのファイル・エラーのページ）。ページ・字幕・題名はすべてテスト用の作り物。
afterAll(closeSharedBrowser);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

let seq = 0;
const vid = () => `q${String(++seq).padStart(10, '0')}`;

/** player と timedtext だけを差し替え、それ以外（テスト用のローカルのページ）は本物の fetch に渡す。 */
function stubYoutube(title: string) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) {
      return new Response(JSON.stringify({
        playabilityStatus: { status: 'OK' },
        videoDetails: { title, author: 'テストのチャンネル', lengthSeconds: '90', shortDescription: '説明文です' },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=ja&kind=asr', languageCode: 'ja', kind: 'asr', name: { simpleText: '日本語 (自動生成)' } }] } },
      }));
    }
    if (url.startsWith('https://www.youtube.com/api/timedtext')) {
      return new Response(JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: '今日はメイクをしながら話します' }] }, { tStartMs: 40_000, segs: [{ utf8: '最近の悩みの話です' }] }] }));
    }
    return real(input as never, init);
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = real; });
}

function allowLocalFetch() {
  const previous = process.env.ALLOW_LOCAL_FETCH;
  process.env.ALLOW_LOCAL_FETCH = 'true';
  cleanups.push(() => {
    if (previous === undefined) delete process.env.ALLOW_LOCAL_FETCH;
    else process.env.ALLOW_LOCAL_FETCH = previous;
  });
}

function serve(handler: (req: Request) => Response): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

/** search_deep の 3 つの検索を見張る（検索語が URL なら、どれも呼ばれない）。 */
function spySearches(webItems: unknown[] = []) {
  const spies = {
    web: spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: webItems, count: webItems.length } as never),
    video: spyOn(yahoo, 'searchYahooVideo').mockResolvedValue({ source: 'video', items: [] } as never),
    realtime: spyOn(yahoo, 'searchYahooRealtime').mockResolvedValue({ items: [] } as never),
  };
  for (const spy of Object.values(spies)) cleanups.push(() => spy.mockRestore());
  return spies;
}

const page = (title: string, body: string) =>
  `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const forbidden = page('Forbidden', `<p>${"You don't have authorization to view this page. ".repeat(6)}</p>`);

describe('splitQueryUrls', () => {
  test('takes the http(s) URLs out of the query and keeps the other words', () => {
    expect(splitQueryUrls('https://www.youtube.com/watch?v=5Jq35KcE8vI&t=367s')).toEqual({ urls: ['https://www.youtube.com/watch?v=5Jq35KcE8vI&t=367s'], text: '' });
    expect(splitQueryUrls('https://example.com/a の料金')).toEqual({ urls: ['https://example.com/a'], text: 'の料金' });
    expect(splitQueryUrls('君と見るそら ライブ')).toEqual({ urls: [], text: '君と見るそら ライブ' });
  });

  test('stops at brackets, quotes and the next URL, and keeps apostrophes and balanced parentheses', () => {
    const urls = (query: string) => splitQueryUrls(query).urls;
    expect(urls('（https://example.com/a）と https://example.com/b、 (https://example.com/c)'))
      .toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar) について')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(urls("https://en.wikipedia.org/wiki/Schindler's_List")).toEqual(["https://en.wikipedia.org/wiki/Schindler's_List"]);
    expect(urls('“https://www.youtube.com/watch?v=5Jq35KcE8vI” を要約')).toEqual(['https://www.youtube.com/watch?v=5Jq35KcE8vI']);
    expect(urls('[https://example.com/a](https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(urls('https://a.com/x,https://b.com/y')).toEqual(['https://a.com/x', 'https://b.com/y']);
    expect(urls('(https://example.com/a)の内容')).toEqual(['https://example.com/a']);
    expect(urls('https://dic.pixiv.net/a/ラブライブ！サンシャイン を見て')).toEqual(['https://dic.pixiv.net/a/ラブライブ！サンシャイン']);
  });

  test('does not take a host without a dot as a URL to read', () => {
    expect(splitQueryUrls('https://とは').urls).toEqual([]);
    expect(splitQueryUrls('http://localhost:3000 が繋がらない').urls).toEqual([]);
  });
});

describe('search_deep (integratedSearch) with a URL in the query', () => {
  test('reads a YouTube URL by its captions with the YouTube title, and searches nothing even with videos', async () => {
    stubYoutube('メイクしながら話した動画');
    const searches = spySearches();
    const url = `https://www.youtube.com/watch?v=${vid()}&t=367s`;
    const r = await integratedSearch({ query: url, limit: 5, videos: 3, noCache: true }) as any;
    expect(searches.web).not.toHaveBeenCalled();
    expect(searches.video).not.toHaveBeenCalled();
    expect(searches.realtime).not.toHaveBeenCalled();
    expect(r.results.map((x: any) => x.url)).toEqual([url]);
    expect(r.results[0]).toMatchObject({ title: 'メイクしながら話した動画', siteName: 'YouTube', contentStatus: 'body' });
    expect(r.results[0].markdown).toContain('最近の悩みの話です');
    expect(r.realtime).toBeUndefined();
    // URL そのものを「本文に出てくるべき語」として数えない
    expect(JSON.stringify(r.contextSufficiency)).not.toContain('youtube.com');
  });

  test('reads every page URL in the query in the given order, and selects highlights with the other words', async () => {
    allowLocalFetch();
    spySearches();
    // 料金があるのは /a だけ。並べ替えが残っていれば /a が先になる
    const base = serve((req) => {
      const path = new URL(req.url).pathname;
      const fee = path === '/a' ? `<h2>料金</h2><p>入場料は 3000 円です。${'補足の説明です。'.repeat(10)}</p>` : '';
      return new Response(page(`ページ${path}`, `<p>${'前置きの文章です。'.repeat(30)}</p>${fee}<h2>アクセス</h2><p>${'駅から歩いて 5 分です。'.repeat(10)}</p>`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
    const r = await integratedSearch({ query: `${base}/b と ${base}/a の料金`, noCache: true }) as any;
    expect(r.results.map((x: any) => x.url)).toEqual([`${base}/b`, `${base}/a`]);
    expect(r.results.map((x: any) => x.title)).toEqual(['ページ/b', 'ページ/a']);
    expect((r.results[1].highlights ?? []).join('\n')).toContain('3000 円');
  });

  test('an X post URL takes the title of the post, not the URL', async () => {
    spySearches();
    const detail = spyOn(xDetail.defaultXDetailProvider, 'fetchStatus').mockResolvedValue({ text: 'テストの投稿の本文です', author: { name: 'テスト', screenName: 'test_user' } } as never);
    cleanups.push(() => detail.mockRestore());
    const r = await integratedSearch({ query: 'https://x.com/test_user/status/1234567890123456789', noCache: true }) as any;
    expect(r.results[0].title).toBe('テスト (@test_user) on X: "テストの投稿の本文です..."');
    expect(r.results[0].markdown).toContain('テストの投稿の本文です');
  });

  test('says there is no usable content when the URL is a file it cannot read', async () => {
    allowLocalFetch();
    spySearches();
    const base = serve(() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }));
    const r = await integratedSearch({ query: `${base}/photo.png`, noCache: true }) as any;
    expect(r.results[0]).toMatchObject({ contentStatus: 'unavailable' });
    expect(r.results[0].markdown).toContain('image/png');
    expect(r.contextSufficiency).toEqual({ level: 'insufficient', reasons: ['no-usable-content'] });
  });

  test('an error page from the web search ranks after a readable page, even when it matches the query better', async () => {
    allowLocalFetch();
    const base = serve((req) => new URL(req.url).pathname === '/gone'
      ? new Response(page('入場料と料金の案内', `<p>${'入場料 料金 のページは移動しました。'.repeat(10)}</p>`), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      : new Response(page('ご案内', `<p>${'当日のご案内は受付でお知らせします。'.repeat(10)}</p>`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    // 読めるほうのページには検索語が無い。それでも、エラーの画面を上にしない
    spySearches([
      { title: '入場料と料金の案内', url: `${base}/gone`, snippet: '入場料 料金', source: 'web' },
      { title: 'ご案内', url: `${base}/ok`, snippet: 'ご案内', source: 'web' },
    ]);
    const r = await integratedSearch({ query: '入場料 料金 順位テスト', includeRealtime: false, noCache: true }) as any;
    expect(r.results.map((x: any) => x.url)).toEqual([`${base}/ok`, `${base}/gone`]);
    expect(r.results[1].contentStatus).toBe('unavailable');
  });

  test('a YouTube video found by the web search gets the YouTube title, not the search engine one', async () => {
    stubYoutube('元の題名の講義');
    const url = `https://www.youtube.com/watch?v=${vid()}`;
    spySearches([{ title: 'A lecture title translated into English', url, snippet: '講義の動画', source: 'web' }]);
    const r = await integratedSearch({ query: '特異値分解 講義 題名テスト', includeRealtime: false, noCache: true }) as any;
    expect(r.results[0]).toMatchObject({ url, title: '元の題名の講義' });
  });
});

describe('contextSufficiency', () => {
  test('still counts a page with only a description (a video without captions) as evidence', () => {
    const page = { url: 'https://www.youtube.com/watch?v=abcdefghijk', markdown: '# 新曲の MV\n\n## 説明文\n\n新曲の MV です。作詞は山田、作曲は田中です。', contentStatus: 'metadata_only' };
    expect(summarizeContextSufficiency([page], [], '新曲 MV 作詞').reasons).not.toContain('no-usable-content');
  });
});

describe('search_video with a URL as the query', () => {
  test('does not search, and says how to read the URL instead', async () => {
    const r = await yahoo.searchYahooVideo({ query: 'https://www.youtube.com/watch?v=5Jq35KcE8vI' });
    expect(r).toMatchObject({ source: 'video', count: 0, items: [] });
    expect(r.message).toContain('get_youtube_transcript');
    expect(r.message).toContain('scrape');
  });
});

describe('scrapeUrl: files and error pages it cannot read', () => {
  test('an image file is not read as text: only its type and size come back, as unavailable', async () => {
    allowLocalFetch();
    const base = serve(() => new Response(new Uint8Array(1234).fill(7), { headers: { 'Content-Type': 'image/jpeg' } }));
    const r = await scrapeUrl({ url: `${base}/cat.jpg`, noCache: true });
    expect(r.contentStatus).toBe('unavailable');
    expect(r.content).toContain('image/jpeg');
    expect(r.content).toContain('1,234');
    expect(r.content).not.toContain('\u0007');
  });

  test('an image served with an error status says so', async () => {
    allowLocalFetch();
    const base = serve(() => new Response(new Uint8Array(100), { status: 404, headers: { 'Content-Type': 'image/jpeg' } }));
    const r = await scrapeUrl({ url: `${base}/missing.jpg`, noCache: true });
    expect(r.contentStatus).toBe('unavailable');
    expect(r.content).toContain('HTTP 404');
  });

  test('a video file over the size limit comes back as a file it cannot read, not as an error', async () => {
    const tooLarge = Object.assign(new Error('レスポンスサイズが上限 (30MB) を超過しています: 41000000 bytes'), {
      code: 'RESPONSE_TOO_LARGE', finalUrl: 'https://example.com/movie.mp4', contentType: 'video/mp4', contentLength: '41000000',
    });
    const spy = spyOn(httpFetcher, 'fetchWithSafeRedirects').mockRejectedValue(tooLarge);
    cleanups.push(() => spy.mockRestore());
    const r = await scrapeUrl({ url: 'https://example.com/movie.mp4', noCache: true });
    expect(r.contentStatus).toBe('unavailable');
    expect(r.content).toContain('video/mp4');
    expect(r.content).toContain('41,000,000');
  });

  test('the size-limit error carries the content type, so the caller can tell a large file', async () => {
    allowLocalFetch();
    // Bun.serve は指定した Content-Length を送らないので、41MB と名乗る応答を TCP で直接書く
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket) {
          socket.write('HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 41000000\r\nConnection: close\r\n\r\n');
          socket.end(new Uint8Array(1024));
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const error = await httpFetcher.fetchWithSafeRedirects(`http://127.0.0.1:${server.port}/movie.mp4`, 5000).then(() => null, (e) => e);
    expect(error).toMatchObject({ code: 'RESPONSE_TOO_LARGE', contentType: 'video/mp4', contentLength: '41000000' });
  });

  test('an HTTP error page is unavailable and gives no highlights (static fetch)', async () => {
    allowLocalFetch();
    const base = serve(() => new Response(page('入場料の案内', `<p>${'入場料のページは見つかりませんでした。'.repeat(10)}</p>`), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    const r = await scrapeUrl({ url: `${base}/gone`, mode: 'fast', query: '入場料', extractHighlights: true, noCache: true });
    expect(r.contentStatus).toBe('unavailable');
    expect(r.content).toContain('HTTP 404');
    expect(r.highlights ?? []).toEqual([]);
  });

  test.skipIf(!resolveChromiumPath())('an HTTP error page is unavailable (browser)', async () => {
    allowLocalFetch();
    const base = serve((req) => new URL(req.url).pathname === '/empty'
      ? new Response('', { status: 403 })
      : new Response(forbidden, { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    const r = await scrapeUrl({ url: `${base}/blocked`, mode: 'browser', timeoutMs: 8000, noCache: true });
    expect(r.contentStatus).toBe('unavailable');
    expect(r.content).toContain('HTTP 403');
    // 本文の無い 403 では Chrome がエラー画面（"HTTP ERROR 403"）を出す。TikTok の本番の形
    const empty = await scrapeUrl({ url: `${base}/empty`, mode: 'browser', timeoutMs: 8000, noCache: true });
    expect(empty.contentStatus).toBe('unavailable');
  }, 30000);
});
