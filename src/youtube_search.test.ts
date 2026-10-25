import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { integratedSearch, scrapeUrl } from './scraper.js';
import * as yahoo from './services/yahoo.js';
import { getYoutubePage } from './services/youtube.js';

// YouTube の動画を scrape と search_deep で読む。字幕・題名・説明文はすべてテスト用の作り物。
let seq = 0;
const vid = () => `s${String(++seq).padStart(10, '0')}`;

interface Fake { title?: string; tracks?: boolean; status?: string; reason?: string; events?: Array<[number, string]>; delayMs?: number }
/** player と timedtext だけを差し替え、それ以外（テスト用のローカルのページなど）は本物の fetch に渡す。 */
function stubYoutube(o: Fake = {}) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) {
      calls.push('player');
      if (o.delayMs) await new Promise((resolve) => setTimeout(resolve, o.delayMs));
      return new Response(JSON.stringify({
        playabilityStatus: { status: o.status ?? 'OK', ...(o.reason ? { reason: o.reason } : {}) },
        videoDetails: { title: o.title ?? '特異値分解の講義', author: '講義チャンネル', lengthSeconds: '150', shortDescription: '線形代数の講義です\n0:00 はじめに\n0:30 特異値分解' },
        ...(o.tracks === false ? {} : { captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=ja&kind=asr', languageCode: 'ja', kind: 'asr', name: { simpleText: '日本語 (自動生成)' } }] } } }),
      }));
    }
    if (url.startsWith('https://www.youtube.com/api/timedtext')) {
      calls.push('timedtext');
      const events = o.events ?? [[0, '挨拶です'], [30_000, '今日は特異値分解の話をします'], [60_000, '関係ない雑談'], [90_000, '特異値分解の応用']];
      return new Response(JSON.stringify({ events: events.map(([ms, text]) => ({ tStartMs: ms, segs: [{ utf8: text }] })) }));
    }
    return real(input as never, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

let restore: (() => void) | undefined;
let spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  restore?.();
  restore = undefined;
  for (const s of spies) s.mockRestore();
  spies = [];
});

describe('getYoutubePage: a YouTube video as a page for scrape', () => {
  test('writes the metadata, the description and each transcript paragraph under a 1m23s-style heading', async () => {
    const stub = stubYoutube();
    restore = stub.restore;
    const id = vid();
    const page = await getYoutubePage(`https://www.youtube.com/watch?v=${id}`);
    expect(page).toMatchObject({ title: '特異値分解の講義', author: '講義チャンネル', contentStatus: 'body', media: { type: 'youtube', videoId: id, duration: 'PT150S' } });
    expect(page.media?.chapters?.map((c) => c.title)).toEqual(['はじめに', '特異値分解']);
    expect(page.content).toContain('# 特異値分解の講義');
    expect(page.content).toContain('## 説明文');
    expect(page.content).toContain('### 0m30s\n\n今日は特異値分解の話をします');
    expect(page.content).toContain('自動字幕');
    // [0:30] のような時刻の書き方は、「何時」の答えを探す採点に時刻と誤認されるので使わない
    expect(page.content.split('## 字幕')[1]).not.toMatch(/\d{1,2}:\d{2}/);
  });

  test('for a transcript longer than maxChars, keeps the paragraphs that match the query even late in the video', async () => {
    // 100 分の講義。検索語は 90 分の段落にだけある（maxChars で先頭から切ると、ここは載らない）
    const filler = 'あいうえおかきくけこさしすせそたちつてとなにぬねの'.repeat(6);
    const events: Array<[number, string]> = Array.from({ length: 200 }, (_, i) => [i * 30_000, i === 180 ? `ここで特異値分解を説明します ${filler}` : `${i}番目の話 ${filler}`]);
    restore = stubYoutube({ events }).restore;
    const page = await getYoutubePage(`https://www.youtube.com/watch?v=${vid()}`, { query: '特異値分解', maxChars: 5000 });
    expect(page.content.length).toBeLessThanOrEqual(5000);
    expect(page.content).toContain('### 1h30m00s\n\nここで特異値分解を説明します');
    expect(page.content).toContain('検索語に関係する段落');
    expect(page.contentStatus).toBe('body');
  });

  test('for a long transcript without a query, keeps the opening paragraphs and says where to read on', async () => {
    const filler = 'あいうえおかきくけこ'.repeat(15);
    restore = stubYoutube({ events: Array.from({ length: 200 }, (_, i) => [i * 30_000, `${i}番目 ${filler}`] as [number, string]) }).restore;
    const page = await getYoutubePage(`https://www.youtube.com/watch?v=${vid()}`, { maxChars: 5000 });
    expect(page.content.length).toBeLessThanOrEqual(5000);
    expect(page.content).toContain('### 0m00s\n\n0番目');
    expect(page.content).not.toContain('### 1h30m00s');
    expect(page.content).toContain('fromSec');
  });

  test('says there are no captions and marks the page as metadata only', async () => {
    restore = stubYoutube({ tracks: false }).restore;
    const page = await getYoutubePage(`https://youtu.be/${vid()}`);
    expect(page.contentStatus).toBe('metadata_only');
    expect(page.content).toContain('字幕（自動字幕を含む）がありません');
  });

  test('returns an unavailable page instead of throwing when YouTube asks for a bot check', async () => {
    restore = stubYoutube({ status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you are not a bot' }).restore;
    const page = await getYoutubePage(`https://www.youtube.com/watch?v=${vid()}`);
    expect(page.contentStatus).toBe('unavailable');
    expect(page.content).toContain('取得できませんでした');
  });
});

describe('scrapeUrl with a YouTube video URL', () => {
  test('reads the captions instead of the watch page, and highlights the paragraphs for the query', async () => {
    const stub = stubYoutube();
    restore = stub.restore;
    const r = await scrapeUrl({ url: `https://www.youtube.com/watch?v=${vid()}`, query: '特異値分解', noCache: true });
    expect(r).toMatchObject({ title: '特異値分解の講義', siteName: 'YouTube', author: '講義チャンネル', contentStatus: 'body', source: 'web' });
    expect(r.content).toContain('### 1m30s');
    expect(r.media?.type).toBe('youtube');
    expect((r.highlights ?? []).join('\n')).toContain('特異値分解');
    expect(stub.calls).toContain('timedtext');
  });
});

describe('search_deep (integratedSearch) with videos', () => {
  // 字幕はキャッシュに残るので、テストごとに別の動画 ID にする
  const stubSearches = (ytA = vid(), ytB = vid()) => {
    const web = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: [], count: 0 } as never);
    const video = spyOn(yahoo, 'searchYahooVideo').mockResolvedValue({
      source: 'video',
      items: [
        { title: 'A', url: `https://www.youtube.com/watch?v=${ytA}`, platform: 'YouTube', source: 'video' },
        { title: 'X の投稿', url: 'https://x.com/someone/status/1', platform: 'X', source: 'video' },
        { title: 'B', url: `https://www.youtube.com/watch?v=${ytB}`, platform: 'YouTube', source: 'video' },
      ],
    } as never);
    spies.push(web, video);
    return { web, video, ytA };
  };

  test('adds the top YouTube videos as results with source youtube', async () => {
    restore = stubYoutube().restore;
    const { video, ytA } = stubSearches();
    const r = await integratedSearch({ query: '特異値分解 動画テスト', videos: 1, includeRealtime: false, noCache: true }) as any;
    expect(video).toHaveBeenCalledTimes(1);
    const videos = r.results.filter((x: any) => x.source === 'youtube');
    expect(videos.map((x: any) => x.url)).toEqual([`https://www.youtube.com/watch?v=${ytA}`]);
    expect(videos[0]).toMatchObject({ title: '特異値分解の講義', siteName: 'YouTube' });
    expect(videos[0].markdown ?? (videos[0].highlights ?? []).join('\n')).toContain('特異値分解');
  });

  test('stops waiting for videos at scrapeDeadlineMs and does not cache the cut-short answer', async () => {
    restore = stubYoutube({ delayMs: 1500 }).restore;
    const { video } = stubSearches();
    const ask = () => integratedSearch({ query: '特異値分解 締切テスト', videos: 1, includeRealtime: false, scrapeDeadlineMs: 300 }) as Promise<any>;
    const started = Date.now();
    const first = await ask();
    expect(Date.now() - started).toBeLessThan(1400);
    expect(first.results.filter((x: any) => x.source === 'youtube')).toEqual([]);
    const second = await ask();
    expect(second.cached).toBeFalsy();
    expect(video).toHaveBeenCalledTimes(2);
  });

  test('does not search videos unless asked', async () => {
    restore = stubYoutube().restore;
    const { video } = stubSearches();
    await integratedSearch({ query: '特異値分解 動画なし', includeRealtime: false, noCache: true });
    expect(video).not.toHaveBeenCalled();
  });
});
