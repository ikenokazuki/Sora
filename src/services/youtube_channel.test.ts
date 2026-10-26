import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { YoutubeChannelResultSchema } from '../types.js';
import { extractChannelId, getYoutubeChannel, YoutubeInputError, type YoutubeDeps } from './youtube.js';

// フィードとページはすべて、公開されている形からの想定で作った合成のフィクスチャ（実機の YouTube では未確認）。
// 題名・説明・チャンネル名はテスト用の作り物。実在のチャンネルの内容は使わない。
let seq = 0;
/** テストごとに別のチャンネル ID（UC + 22 文字）にして、キャッシュを共有しない。 */
const cid = () => `UC${String(++seq).padStart(22, '0')}`;
/** テストごとに別のハンドルにして、ID の対応のキャッシュを共有しない。 */
const handle = () => `@Test${String(++seq).padStart(6, '0')}`;
const vid = (n: number) => `v${String(n).padStart(10, '0')}`;

afterEach(() => setSystemTime());

interface Entry { n: number; title?: string; published?: string; updated?: string; description?: string; views?: number }
const entry = (channelId: string, e: Entry) => `<entry>
  <id>yt:video:${vid(e.n)}</id>
  <yt:videoId>${vid(e.n)}</yt:videoId>
  <yt:channelId>${channelId.slice(2)}</yt:channelId>
  <title>${e.title ?? `動画${e.n}`}</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=${vid(e.n)}"/>
  <author><name>テストチャンネル</name><uri>https://www.youtube.com/channel/${channelId}</uri></author>
  <published>${e.published ?? `2026-10-${String(20 - e.n).padStart(2, '0')}T10:00:00+00:00`}</published>
  <updated>${e.updated ?? '2026-10-25T00:00:00+00:00'}</updated>
  <media:group>
    <media:title>${e.title ?? `動画${e.n}`}</media:title>
    <media:content url="https://www.youtube.com/v/${vid(e.n)}?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
    <media:thumbnail url="https://i2.ytimg.com/vi/${vid(e.n)}/hqdefault.jpg" width="480" height="360"/>
    <media:description>${e.description ?? `説明${e.n}`}</media:description>
    <media:community>
      <media:starRating count="10" average="5.00" min="1" max="5"/>
      ${e.views === undefined ? '' : `<media:statistics views="${e.views}"/>`}
    </media:community>
  </media:group>
</entry>`;
const feedXml = (channelId: string, entries: Entry[], title = 'テストチャンネル') => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${channelId}"/>
 <id>yt:channel:${channelId.slice(2)}</id>
 <yt:channelId>${channelId.slice(2)}</yt:channelId>
 <title>${title}</title>
 <link rel="alternate" href="https://www.youtube.com/channel/${channelId}"/>
 <author><name>${title}</name><uri>https://www.youtube.com/channel/${channelId}</uri></author>
 <published>2020-01-01T00:00:00+00:00</published>
 ${entries.map((e) => entry(channelId, e)).join('\n')}
</feed>`;

const rssPage = (id: string) => `<html><head><title>テスト - YouTube</title><link rel="alternate" type="application/rss+xml" title="RSS" href="https://www.youtube.com/feeds/videos.xml?channel_id=${id}"><link rel="canonical" href="https://www.youtube.com/channel/${id}"></head><body>本文</body></html>`;

interface FakeOpts {
  /** 文字列ならチャンネルのページ。null は 404。 */
  page?: string | null | Error;
  /** 文字列ならフィード。数値ならその HTTP ステータス。 */
  feed?: string | number | Error;
}
function fakeChannel(o: FakeOpts) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    if (url.startsWith('https://www.youtube.com/feeds/videos.xml?channel_id=')) {
      if (o.feed instanceof Error) throw o.feed;
      if (typeof o.feed === 'number') return new Response('', { status: o.feed });
      return new Response(o.feed ?? '', { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const fetchChannelPage = async (url: string) => {
    calls.push(url);
    if (o.page instanceof Error) throw o.page;
    return o.page ?? undefined;
  };
  const deps: YoutubeDeps = { fetchFn, fetchChannelPage };
  return { calls, deps, opts: o };
}

describe('getYoutubeChannel', () => {
  test('resolves a handle through the RSS link, reads the feed and returns the newest videos first', async () => {
    const id = cid();
    const h = handle();
    const { calls, deps } = fakeChannel({
      page: rssPage(id),
      feed: feedXml(id, [{ n: 1, views: 1234, description: '一本目の説明' }, { n: 2, views: 56 }, { n: 3 }]),
    });
    const r = await getYoutubeChannel({ url: `https://www.youtube.com/${h}/videos` }, deps);
    expect(r).toMatchObject({
      found: true,
      channelId: id,
      title: 'テストチャンネル',
      url: `https://www.youtube.com/channel/${id}`,
    });
    expect(r.videos?.map((v) => v.videoId)).toEqual([vid(1), vid(2), vid(3)]);
    expect(r.videos?.[0]).toEqual({
      videoId: vid(1),
      url: `https://www.youtube.com/watch?v=${vid(1)}`,
      title: '動画1',
      publishedAt: '2026-10-19T10:00:00+00:00',
      updatedAt: '2026-10-25T00:00:00+00:00',
      description: '一本目の説明',
      views: 1234,
    });
    expect(r.videos?.[2]?.views).toBeUndefined(); // statistics が無い動画は views を付けない
    expect(calls).toEqual([`https://www.youtube.com/${h}`, `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`]);
    expect(YoutubeChannelResultSchema.safeParse(r).success).toBe(true);
  });

  test('does not fetch the channel page for a channel id or a /channel/ URL', async () => {
    const id = cid();
    const { calls, deps } = fakeChannel({ feed: feedXml(id, [{ n: 1 }]) });
    const r = await getYoutubeChannel({ url: `https://www.youtube.com/channel/${id}` }, deps);
    expect(r).toMatchObject({ found: true, channelId: id });
    expect(calls).toEqual([`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`]);
    const again = await getYoutubeChannel({ url: id, noCache: true }, deps);
    expect(again.videos).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test('reads a one-entry feed as a list, keeps a numeric title as text, decodes entities and cleans the description', async () => {
    const id = cid();
    const long = 'あ'.repeat(600);
    const { deps } = fakeChannel({ page: rssPage(id), feed: feedXml(id, [{ n: 1, title: '2026', description: `本文&amp;続き [](https://example.com/empty) ${long}` }], '歌 &amp; 踊り') });
    const r = await getYoutubeChannel({ url: handle() }, deps);
    expect(r.title).toBe('歌 & 踊り');
    expect(r.videos).toHaveLength(1);
    expect(r.videos?.[0]?.title).toBe('2026');
    expect(typeof r.videos?.[0]?.title).toBe('string');
    const description = r.videos?.[0]?.description ?? '';
    expect(description.startsWith('本文&続き')).toBe(true);
    expect(description).not.toContain('[](');
    expect(description.length).toBe(500);
  });

  test('skips an entry without a usable video id, and returns found: true with no videos for an empty feed', async () => {
    const id = cid();
    const odd = feedXml(id, [{ n: 1 }]).replace(`<yt:videoId>${vid(1)}</yt:videoId>`, '<yt:videoId>short</yt:videoId>');
    expect((await getYoutubeChannel({ url: id }, fakeChannel({ feed: odd }).deps)).videos).toEqual([]);
    const empty = cid();
    const r = await getYoutubeChannel({ url: empty }, fakeChannel({ feed: feedXml(empty, []) }).deps);
    expect(r).toMatchObject({ found: true, channelId: empty, videos: [] });
  });

  test('cuts the list to limit after caching, and serves the second call from the cache', async () => {
    const id = cid();
    const { calls, deps } = fakeChannel({ feed: feedXml(id, [1, 2, 3, 4].map((n) => ({ n }))) });
    const first = await getYoutubeChannel({ url: id, limit: 2 }, deps);
    expect(first.videos).toHaveLength(2);
    expect(first.cached).toBeUndefined();
    const second = await getYoutubeChannel({ url: id, limit: 4 }, deps);
    expect(second.videos).toHaveLength(4);
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect((await getYoutubeChannel({ url: id }, deps)).videos).toHaveLength(4); // 既定は 10
  });

  test('noCache reads the page and the feed again', async () => {
    const id = cid();
    const h = handle();
    const { calls, deps } = fakeChannel({ page: rssPage(id), feed: feedXml(id, [{ n: 1 }]) });
    await getYoutubeChannel({ url: h, noCache: true }, deps);
    await getYoutubeChannel({ url: h, noCache: true }, deps);
    expect(calls).toHaveLength(4);
  });

  test('remembers the handle → id for a day, so an expired feed is read again without the page', async () => {
    const id = cid();
    const h = handle();
    setSystemTime(new Date('2026-10-26T00:00:00Z'));
    const { calls, deps } = fakeChannel({ page: rssPage(id), feed: feedXml(id, [{ n: 1 }]) });
    await getYoutubeChannel({ url: h }, deps);
    expect(calls).toHaveLength(2);
    setSystemTime(new Date('2026-10-26T00:31:00Z')); // フィードの 30 分は過ぎ、ID の 24 時間は残る
    const r = await getYoutubeChannel({ url: h }, deps);
    expect(r.found).toBe(true);
    expect(calls.filter((u) => u.endsWith(h))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/feeds/videos.xml'))).toHaveLength(2);
  });

  test('returns found: false (and remembers it briefly) when the page or the feed is 404', async () => {
    const h = handle();
    const missingPage = fakeChannel({ page: null });
    const a = await getYoutubeChannel({ url: h }, missingPage.deps);
    expect(a).toMatchObject({ found: false, reason: 'channel-not-found' });
    expect(a.videos).toBeUndefined();
    await getYoutubeChannel({ url: h }, missingPage.deps);
    expect(missingPage.calls).toHaveLength(1); // 2 回目はキャッシュ
    expect(YoutubeChannelResultSchema.safeParse(a).success).toBe(true);

    const missingFeed = fakeChannel({ feed: 404 });
    expect(await getYoutubeChannel({ url: cid() }, missingFeed.deps)).toMatchObject({ found: false, reason: 'channel-not-found' });
  });

  test('throws, and does not cache, for a consent page, a page without an id, a rate-limited feed and a feed that is not Atom', async () => {
    const consent = fakeChannel({ page: '<html><form action="https://consent.youtube.com/save">同意</form></html>' });
    const h1 = handle();
    await expect(getYoutubeChannel({ url: h1 }, consent.deps)).rejects.toThrow(/^YouTube request failed: consent page/);
    await expect(getYoutubeChannel({ url: h1 }, consent.deps)).rejects.toThrow(/YouTube request failed/);
    expect(consent.calls).toHaveLength(2); // 失敗は覚えない

    await expect(getYoutubeChannel({ url: handle() }, fakeChannel({ page: '<html><head></head><body>形が変わった</body></html>' }).deps)).rejects.toThrow(/YouTube request failed: channel id not found/);
    await expect(getYoutubeChannel({ url: handle() }, fakeChannel({ page: new Error('socket closed') }).deps)).rejects.toThrow('YouTube request failed: socket closed');

    const id = cid();
    const limited = fakeChannel({ feed: 429 });
    await expect(getYoutubeChannel({ url: id }, limited.deps)).rejects.toThrow('YouTube request failed: feed HTTP 429');
    limited.opts.feed = feedXml(id, [{ n: 1 }]);
    expect((await getYoutubeChannel({ url: id }, limited.deps)).found).toBe(true); // 直ったあとは取れる（失敗を覚えていない）

    await expect(getYoutubeChannel({ url: cid() }, fakeChannel({ feed: '<html><body>確認の画面</body></html>' }).deps)).rejects.toThrow(/YouTube request failed: unexpected feed/);
  });

  test('rejects a URL that is not a channel with YoutubeInputError', async () => {
    const { deps } = fakeChannel({});
    for (const url of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://example.com/@YouTube', 'jNQXAC9IVRw']) {
      await expect(getYoutubeChannel({ url }, deps)).rejects.toBeInstanceOf(YoutubeInputError);
    }
  });
});

describe('extractChannelId', () => {
  const id = 'UCaaaaaaaaaaaaaaaaaaaaa-'; // 末尾が - の ID も読めること
  const other = 'UCbbbbbbbbbbbbbbbbbbbbbb';

  test('reads the RSS link first, then the canonical link, the itemprop meta and the embedded externalId', () => {
    expect(extractChannelId(rssPage(id))).toBe(id);
    expect(extractChannelId(`<head><link rel="canonical" href="https://www.youtube.com/channel/${id}"></head>`)).toBe(id);
    expect(extractChannelId(`<head><meta itemprop="identifier" content="${id}"></head>`)).toBe(id);
    expect(extractChannelId(`<script>var ytInitialData = {"metadata":{"channelMetadataRenderer":{"externalId":"${id}"}}};</script>`)).toBe(id);
    // 属性の順は問わない。複数あれば RSS が先
    expect(extractChannelId(`<link href="https://www.youtube.com/feeds/videos.xml?channel_id=${id}" type="application/rss+xml" rel="alternate"><link rel="canonical" href="https://www.youtube.com/channel/${other}">`)).toBe(id);
    expect(extractChannelId(`<link rel="canonical" href="https://www.youtube.com/channel/${other}"><meta itemprop="identifier" content="${id}">`)).toBe(other);
  });

  test('reads nothing from a page without any of them, or with a malformed id', () => {
    expect(extractChannelId('<html><head><link rel="canonical" href="https://www.youtube.com/@x"></head></html>')).toBeUndefined();
    expect(extractChannelId('<link rel="canonical" href="https://www.youtube.com/channel/UCshort">')).toBeUndefined();
    expect(extractChannelId('')).toBeUndefined();
  });
});
