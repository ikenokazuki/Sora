import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as browserEngine from './browser_engine.js';
import * as browserStealth from './browser_stealth.js';
import * as httpFetcher from './http_fetcher.js';
import { scrapeUrl } from './scraper.js';
import { getTiktokPage, parseTikTokVideoUrl, parseWebVtt } from './services/tiktok.js';

// TikTok の動画を、ブラウザで開いたページの埋め込みデータと自動字幕（WebVTT）から本文にする。データと字幕はテスト用の作り物。
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const CAPTION_URL = 'https://v16-webapp.tiktok.com/abc/caption.vtt?expire=1&sig=x';
const VTT = 'WEBVTT\n\n00:00:00.320 --> 00:00:01.280\nこんにちは、テストの動画です\n\n00:00:02.000 --> 00:00:03.500\n今日は<c.color>新曲</c>の話をします\n\n1\n00:00:40.000 --> 00:00:41.000\n最後まで見てね\n';

function pageHtml(video: Record<string, unknown>) {
  const itemStruct = {
    desc: 'テストの動画の説明文 #テスト',
    createTime: '1760000000',
    author: { uniqueId: 'test_user', nickname: 'テストの人' },
    video: { duration: 45, ...video },
  };
  const data = { __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct } } } };
  return `<html><head><title>テストの動画の説明文 #テスト | テストの人 | TikTok</title></head><body><div id="app"></div><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}
const withCaptions = pageHtml({
  subtitleInfos: [{ Url: CAPTION_URL, LanguageCodeName: 'jpn-JP', Format: 'webvtt', Source: 'ASR' }],
  claInfo: { enableAutoCaption: true, captionInfos: [{ url: CAPTION_URL, languageCode: 'ja', isAutoGen: true, isOriginalCaption: true, captionFormat: 'webvtt' }] },
});
const withoutCaptions = pageHtml({ subtitleInfos: [], claInfo: { enableAutoCaption: true, captionInfos: [], noCaptionReason: 3 } });

/** 字幕の取得（fetchWithSafeRedirects）を差し替え、呼ばれた URL を記録する。 */
function stubCaptionFetch(body = VTT, status = 200) {
  const calls: string[] = [];
  const spy = spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async (url: string) => {
    calls.push(url);
    return { finalUrl: url, response: new Response(body, { status, headers: { 'Content-Type': 'video/mp4' } }) };
  }) as never);
  cleanups.push(() => spy.mockRestore());
  return calls;
}

describe('parseTikTokVideoUrl', () => {
  test('reads the user and the video id of a video page, and nothing else', () => {
    expect(parseTikTokVideoUrl('https://www.tiktok.com/@kyodonews/video/7693905048161635590')).toEqual({ user: 'kyodonews', videoId: '7693905048161635590' });
    expect(parseTikTokVideoUrl('https://www.tiktok.com/@sweets_suki3/video/7700203226435570996?is_from_webapp=1')).toEqual({ user: 'sweets_suki3', videoId: '7700203226435570996' });
    expect(parseTikTokVideoUrl('https://www.tiktok.com/@kimisora_jpn')).toBeUndefined();
    expect(parseTikTokVideoUrl('https://www.tiktok.com/@user/photo/7700203226435570996')).toBeUndefined();
    expect(parseTikTokVideoUrl('https://evil.example/@user/video/1')).toBeUndefined();
  });
});

describe('parseWebVtt', () => {
  test('reads the cue start times and text, dropping tags and cue numbers', () => {
    expect(parseWebVtt(VTT)).toEqual([
      { startMs: 320, text: 'こんにちは、テストの動画です' },
      { startMs: 2000, text: '今日は新曲の話をします' },
      { startMs: 40_000, text: '最後まで見てね' },
    ]);
    expect(parseWebVtt('WEBVTT\n\n01:02:03.004 --> 01:02:04.000\n一時間後')).toEqual([{ startMs: 3_723_004, text: '一時間後' }]);
  });
});

describe('getTiktokPage', () => {
  test('writes the description, the author and the auto captions under 1m23s-style headings', async () => {
    const calls = stubCaptionFetch();
    const page = await getTiktokPage(withCaptions, 'https://www.tiktok.com/@test_user/video/1', { title: 'テストの動画の説明文 #テスト | テストの人 | TikTok' });
    expect(calls).toEqual([CAPTION_URL]);
    expect(page).toMatchObject({ title: 'テストの動画の説明文 #テスト | テストの人 | TikTok', author: 'テストの人 (@test_user)', contentStatus: 'body', publishedTime: '2025-10-09T08:53:20.000Z' });
    expect(page?.content).toContain('## 説明文\n\nテストの動画の説明文 #テスト');
    expect(page?.content).toContain('## 字幕（TikTok の自動字幕。聞き間違いを含む）');
    expect(page?.content).toContain('### 0m00s\n\nこんにちは、テストの動画です 今日は新曲の話をします');
    expect(page?.content).toContain('### 0m40s\n\n最後まで見てね');
    expect(page?.content).toContain('- 長さ: 45 秒');
  });

  test('says there are no captions and marks the page as metadata only', async () => {
    const calls = stubCaptionFetch();
    const page = await getTiktokPage(withoutCaptions, 'https://www.tiktok.com/@test_user/video/2', {});
    expect(calls).toEqual([]);
    expect(page?.contentStatus).toBe('metadata_only');
    expect(page?.content).toContain('字幕（自動字幕を含む）がありません');
  });

  test('does not fetch a caption URL outside the TikTok hosts', async () => {
    const calls = stubCaptionFetch();
    const evil = pageHtml({ subtitleInfos: [{ Url: 'https://169.254.169.254/latest/meta-data', Format: 'webvtt', Source: 'ASR' }], claInfo: { captionInfos: [] } });
    const page = await getTiktokPage(evil, 'https://www.tiktok.com/@test_user/video/3', {});
    expect(calls).toEqual([]);
    expect(page?.contentStatus).toBe('metadata_only');
  });

  test('says the captions could not be fetched when the caption request fails', async () => {
    stubCaptionFetch('denied', 403);
    const page = await getTiktokPage(withCaptions, 'https://www.tiktok.com/@test_user/video/4', {});
    expect(page?.contentStatus).toBe('metadata_only');
    expect(page?.content).toContain('字幕を取得できませんでした');
  });

  test('returns nothing for a page without the embedded data, so scrape reads it as a page', async () => {
    expect(await getTiktokPage('<html><body>Please wait...</body></html>', 'https://www.tiktok.com/@test_user/video/5', {})).toBeUndefined();
  });
});

describe('scrapeUrl with a TikTok video URL', () => {
  // ブラウザ（と Chromium の有無）を差し替える。Chromium の無い CI でも同じに動く
  const stubBrowser = (html: string, status = 200) => {
    const chromium = spyOn(browserEngine, 'resolveChromiumPath').mockReturnValue('/test/chromium');
    const spy = spyOn(browserStealth, 'fetchWithStealthBrowser').mockResolvedValue({ html, title: 'テストの動画の説明文 #テスト | テストの人 | TikTok', finalUrl: 'https://www.tiktok.com/@test_user/video/9', status } as never);
    cleanups.push(() => spy.mockRestore(), () => chromium.mockRestore());
    return spy;
  };

  test('opens the video in the browser (the plain fetch only gets the WAF page) and reads the captions', async () => {
    const calls = stubCaptionFetch();
    const browser = stubBrowser(withCaptions);
    const r = await scrapeUrl({ url: 'https://www.tiktok.com/@test_user/video/7000000000000000001', noCache: true });
    expect(browser).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([CAPTION_URL]);
    expect(r).toMatchObject({ siteName: 'TikTok', contentStatus: 'body', author: 'テストの人 (@test_user)' });
    expect(r.content).toContain('最後まで見てね');
  });

  test('a TikTok page still on the challenge ("Please wait...") comes back unavailable', async () => {
    stubCaptionFetch();
    stubBrowser('<html><head><title>TikTok</title></head><body><p>Please wait...</p></body></html>', 200);
    const r = await scrapeUrl({ url: 'https://www.tiktok.com/@test_user/video/7000000000000000003', noCache: true });
    expect(r.contentStatus).toBe('unavailable');
    expect(r.content).toContain('確認の画面');
  });

  test('a TikTok page answered with 403 stays unavailable', async () => {
    stubCaptionFetch();
    stubBrowser('<html><body><h1>You don\'t have authorization to view this page.</h1><p>HTTP ERROR 403</p></body></html>', 403);
    const r = await scrapeUrl({ url: 'https://www.tiktok.com/@test_user/video/7000000000000000002', noCache: true });
    expect(r.contentStatus).toBe('unavailable');
  });
});
