import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as httpFetcher from './http_fetcher.js';
import { app } from './index.js';
import { createMcpServer } from './mcp.js';
import { integratedSearch } from './scraper.js';
import * as yahoo from './services/yahoo.js';
import { buildYahooVideoSearchUrl, parseYahooVideoHtml } from './services/yahoo.js';

// 動画検索の期間とプラットフォームの指定（Yahoo の動画検索のページを直接読む）。ページの中身はテスト用の作り物。
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const nextData = (items: unknown[]) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { initialState: { domainState: { videoAlgo: { items, isLast: false } } } } })}</script></body></html>`;

const pageItems = [
  {
    id: 'a1', title: '<b>君と見るそら</b>のライブ', refererUrl: 'https://www.youtube.com/watch?v=abcdefghijk', duration: '3:27',
    summary: '<b>君と見るそら</b> &middot; ライブ&nbsp;...', thumbnail: { url: 'https://msp.c.yimg.jp/x.jpg', width: 178, height: 100 },
    uploadDate: '2日前', uploader: 'テストのチャンネル', source: 'YouTube', siteName: 'youtube.com',
  },
  {
    id: 'a2', title: 'TikTok の動画', refererUrl: 'https://www.tiktok.com/@user/video/1', duration: '0:15', summary: '',
    thumbnail: { url: 'https://msp.c.yimg.jp/y.jpg' }, uploadDate: '2025/09/14', uploader: 'user', source: 'TikTok', siteName: 'tiktok.com',
  },
];

describe('buildYahooVideoSearchUrl', () => {
  const params = (options: Parameters<typeof buildYahooVideoSearchUrl>[0]) => new URL(buildYahooVideoSearchUrl(options)).searchParams;

  test('maps the period to pd and the page to b', () => {
    expect(['hour', 'day', 'week', 'month', 'year'].map((updated) => params({ query: 'x', updated: updated as never }).get('pd'))).toEqual(['0', '1', '2', '3', '4']);
    expect(params({ query: 'x', updated: 'all' }).get('pd')).toBeNull();
    expect(params({ query: 'x', page: 2 }).get('b')).toBe('21');
    expect(params({ query: 'x' }).get('b')).toBeNull();
  });

  test('uses the site filter for YouTube, niconico and Dailymotion, and site: in the query for the others', () => {
    expect(params({ query: '君と見るそら', platform: 'youtube' }).get('st')).toBe('youtube');
    expect(params({ query: '君と見るそら', platform: 'niconico' }).get('st')).toBe('niconico');
    expect(params({ query: '君と見るそら', platform: 'dailymotion' }).get('st')).toBe('dailymotion');
    expect(params({ query: '君と見るそら', platform: 'tiktok' })).toMatchObject({});
    expect(params({ query: '君と見るそら', platform: 'tiktok' }).get('p')).toBe('君と見るそら site:tiktok.com');
    expect(params({ query: '君と見るそら', platform: 'x' }).get('p')).toBe('君と見るそら site:x.com');
    expect(params({ query: '君と見るそら', platform: 'instagram' }).get('p')).toBe('君と見るそら site:instagram.com');
    expect(params({ query: '君と見るそら', platform: 'tiktok' }).get('st')).toBeNull();
  });
});

describe('parseYahooVideoHtml', () => {
  test('reads the items in the same shape as the bundled MCP search', () => {
    expect(parseYahooVideoHtml(nextData(pageItems))).toEqual([
      {
        id: 'a1', title: '君と見るそらのライブ', url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: '3:27',
        summary: '君と見るそら · ライブ ...', thumbnail: 'https://msp.c.yimg.jp/x.jpg', upload_date: '2日前', uploader: 'テストのチャンネル', source: 'YouTube',
      },
      {
        id: 'a2', title: 'TikTok の動画', url: 'https://www.tiktok.com/@user/video/1', duration: '0:15',
        thumbnail: 'https://msp.c.yimg.jp/y.jpg', upload_date: '2025/09/14', uploader: 'user', source: 'TikTok',
      },
    ]);
  });

  test('throws when the page has no search data (a changed page or a block page)', () => {
    expect(() => parseYahooVideoHtml('<html><body>blocked</body></html>')).toThrow();
  });
});

describe('searchYahooVideo with a period or a platform', () => {
  test('reads the Yahoo video search page with the filters and returns platform-tagged items', async () => {
    const fetched: string[] = [];
    const spy = spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async (url: string) => {
      fetched.push(url);
      return { finalUrl: url, response: new Response(nextData(pageItems)) };
    }) as never);
    cleanups.push(() => spy.mockRestore());
    const r = await yahoo.searchYahooVideo({ query: '君と見るそら', updated: 'week', platform: 'tiktok', limit: 1 });
    expect(fetched).toHaveLength(1);
    expect(new URL(fetched[0]).searchParams.get('pd')).toBe('2');
    expect(new URL(fetched[0]).searchParams.get('p')).toBe('君と見るそら site:tiktok.com');
    expect(r).toMatchObject({ source: 'video', query: '君と見るそら', count: 1, items: [{ title: '君と見るそらのライブ', platform: 'YouTube', source: 'video' }] });
  });

  test('reports a refused request as an error instead of an empty result', async () => {
    const spy = spyOn(httpFetcher, 'fetchWithSafeRedirects').mockResolvedValue({ finalUrl: 'x', response: new Response('busy', { status: 429 }) } as never);
    cleanups.push(() => spy.mockRestore());
    await expect(yahoo.searchYahooVideo({ query: '君と見るそら', updated: 'day' })).rejects.toThrow('429');
  });
});

describe('the period and platform reach the video search', () => {
  const spyVideo = () => {
    const spy = spyOn(yahoo, 'searchYahooVideo').mockResolvedValue({ source: 'video', items: [] } as never);
    cleanups.push(() => spy.mockRestore());
    return spy;
  };

  test('search_deep looks for YouTube videos only, within its updated period', async () => {
    const web = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: [], count: 0 } as never);
    cleanups.push(() => web.mockRestore());
    const video = spyVideo();
    await integratedSearch({ query: '特異値分解 期間テスト', videos: 1, updated: 'week', includeRealtime: false, noCache: true });
    expect(video).toHaveBeenCalledWith(expect.objectContaining({ platform: 'youtube', updated: 'week' }));
  });

  test('REST /search/video passes them on and rejects unknown values', async () => {
    const video = spyVideo();
    const post = (body: unknown) => app.request('/search/video', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ query: '君と見るそら REST', updated: 'month', platform: 'x', noCache: true })).status).toBe(200);
    expect(video).toHaveBeenCalledWith(expect.objectContaining({ updated: 'month', platform: 'x' }));
    expect((await post({ query: '君と見るそら', platform: 'vimeo' })).status).toBe(400);
  });

  test('the MCP search_video tool lists them and passes them on', async () => {
    const video = spyVideo();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'video-filter-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'search_video') as any;
      expect(tool.inputSchema.properties.updated.enum).toEqual(['all', 'hour', 'day', 'week', 'month', 'year']);
      expect(tool.inputSchema.properties.platform.enum).toEqual(['all', 'youtube', 'tiktok', 'x', 'instagram', 'niconico', 'dailymotion']);
      await client.callTool({ name: 'search_video', arguments: { query: '君と見るそら MCP', updated: 'day', platform: 'youtube' } });
      expect(video).toHaveBeenCalledWith(expect.objectContaining({ updated: 'day', platform: 'youtube' }));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
