import { describe, expect, test } from 'bun:test';
import { findAwaLyrics, parseAwaTrackPage } from './lyrics_awa.js';

// 歌詞の本文は使わない。以下の曲名・歌手名・歌詞はすべてテスト用の作り物。
const ARTIST = 'テストグループ';
let seq = 0;
const hex = () => (++seq).toString(16).padStart(20, '0'); // AWA の曲 ID と同じ 20 桁の 16 進数。テスト間で重ならない
const url = (id: string) => `https://s.awa.fm/track/${id}`;

interface Listed { id: string; name: string }

/** 実ページと同じ形（__NEXT_DATA__ の TrackStore に曲・歌詞・同じ歌手の曲の一覧）の HTML。 */
function awaPage(id: string, name: string, artist: string, text: string | null, listed: Listed[] = [], album = 'テスト盤'): string {
  const store = {
    track: { map: { [id]: { id, name, artist: { id: 'a'.repeat(20), name: artist }, album: { id: 'b'.repeat(20), name: album } } }, keys: [id] },
    lyrics: { map: text === null ? {} : { [id]: { id, text } }, keys: [id] },
    artistTracks: { map: { [id]: listed.map((t) => ({ id: t.id, name: t.name, albumName: 'x' })) }, keys: [id] },
  };
  const data = { props: { pageProps: { dehydrated: { context: { dispatcher: { stores: { TrackStore: store } } } } } } };
  return `<!DOCTYPE html><html><head><title>”${name}” by ${artist} - トラック・歌詞情報 | AWA</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

const hit = (id: string, name: string, artist = ARTIST) => ({ url: url(id), title: `”${name}” by ${artist} - トラック・歌詞情報 | AWA` });
const searchReturning = (items: Array<{ url: string; title?: string }>) => {
  const queries: string[] = [];
  return { queries, search: async (q: string) => { queries.push(q); return { items }; } };
};
function fakeSite(pages: Record<string, string>) {
  const fetched: string[] = [];
  return {
    fetched,
    fetchPage: async (u: string) => {
      fetched.push(u);
      const html = pages[u];
      if (html === undefined) throw new Error(`404 ${u}`);
      return html;
    },
  };
}

describe('parseAwaTrackPage', () => {
  test('reads the track, its text and the artist\'s other tracks', () => {
    const [id, other] = [hex(), hex()];
    const page = parseAwaTrackPage(awaPage(id, '曲A', ARTIST, 'らら\nるる', [{ id: other, name: '曲B' }]));
    expect(page).toEqual({ id, name: '曲A', artist: ARTIST, album: 'テスト盤', lyrics: 'らら\nるる', artistTracks: [{ id: other, name: '曲B' }] });
  });
  test('a page without a text block has empty lyrics', () => {
    expect(parseAwaTrackPage(awaPage(hex(), '曲A', ARTIST, null))?.lyrics).toBe('');
  });
  test('pages without usable data yield undefined', () => {
    expect(parseAwaTrackPage('<html><body>none</body></html>')).toBeUndefined();
    expect(parseAwaTrackPage('<script id="__NEXT_DATA__">{broken</script>')).toBeUndefined();
  });
  test('ignores listed tracks whose id is not a 20-digit hex id', () => {
    const page = parseAwaTrackPage(awaPage(hex(), '曲A', ARTIST, 'ら', [{ id: '../x', name: '悪い' }, { id: hex(), name: '良い' }]));
    expect(page?.artistTracks.map((t) => t.name)).toEqual(['良い']);
  });
});

describe('findAwaLyrics', () => {
  test('the search hit is the song itself: one search, one page', async () => {
    const id = hex();
    const site = fakeSite({ [url(id)]: awaPage(id, '曲A', ARTIST, 'らら\nるる') });
    const s = searchReturning([hit(id, '曲A')]);
    const r = await findAwaLyrics(ARTIST, '曲A', { search: s.search, fetchPage: site.fetchPage });
    expect(r).toMatchObject({ status: 'found', lyrics: 'らら\nるる', sourceUrl: url(id), track: { title: '曲A', artist: ARTIST, album: 'テスト盤' } });
    expect(s.queries).toEqual([`"${ARTIST}" "曲A"`]);
    expect(site.fetched).toEqual([url(id)]);
  });

  test('the search hit is another track of the artist: the listed tracks lead to the song', async () => {
    const [seed, target] = [hex(), hex()];
    const site = fakeSite({
      [url(seed)]: awaPage(seed, '曲S', ARTIST, 'さ', [{ id: target, name: '曲T' }]),
      [url(target)]: awaPage(target, '曲T', ARTIST, 'てぃー'),
    });
    const r = await findAwaLyrics(ARTIST, '曲T', { search: searchReturning([hit(seed, '曲S')]).search, fetchPage: site.fetchPage });
    expect(r).toMatchObject({ status: 'found', lyrics: 'てぃー', sourceUrl: url(target) });
    expect(site.fetched).toEqual([url(seed), url(target)]);
  });

  test('a song whose page has no text is reported as not registered', async () => {
    const id = hex();
    const site = fakeSite({ [url(id)]: awaPage(id, '曲A', ARTIST, '  ') });
    const r = await findAwaLyrics(ARTIST, '曲A', { search: searchReturning([hit(id, '曲A')]).search, fetchPage: site.fetchPage });
    expect(r).toMatchObject({ status: 'no-lyrics-registered', track: { title: '曲A', artist: ARTIST } });
  });

  test('an unknown title is no-match and lists the artist\'s titles', async () => {
    const [seed, other] = [hex(), hex()];
    const site = fakeSite({ [url(seed)]: awaPage(seed, '曲S', ARTIST, 'さ', [{ id: other, name: '曲O' }]) });
    const r = await findAwaLyrics(ARTIST, 'ない曲', { search: searchReturning([hit(seed, '曲S')]).search, fetchPage: site.fetchPage });
    expect(r.status).toBe('no-match');
    expect(r.candidates.sort()).toEqual(['曲O', '曲S']);
    expect(site.fetched).toEqual([url(seed)]);
  });

  test('only seeds on s.awa.fm with a valid id and the requested artist are used', async () => {
    const [good, other] = [hex(), hex()];
    const site = fakeSite({ [url(good)]: awaPage(good, '曲A', ARTIST, 'ら') });
    const s = searchReturning([
      hit(other, '曲A', '別のグループ'),
      { url: `https://example.com/track/${hex()}`, title: `”曲A” by ${ARTIST} - トラック・歌詞情報 | AWA` },
      { url: 'https://s.awa.fm/track/short', title: `”曲A” by ${ARTIST} - トラック・歌詞情報 | AWA` },
      { url: 'https://s.awa.fm/playlist/abc', title: `”曲A” by ${ARTIST} - プレイリスト情報 | AWA` },
      hit(good, '曲A'),
    ]);
    await findAwaLyrics(ARTIST, '曲A', { search: s.search, fetchPage: site.fetchPage });
    expect(site.fetched).toEqual([url(good)]);
  });

  test('retries the search once without the title, and no more than that', async () => {
    const s = searchReturning([]);
    const r = await findAwaLyrics(ARTIST, '曲A', { search: s.search, fetchPage: fakeSite({}).fetchPage });
    expect(r.status).toBe('no-match');
    expect(s.queries).toEqual([`"${ARTIST}" "曲A"`, `"${ARTIST}"`]);
  });

  test('a failing or throttled search is search-unavailable', async () => {
    expect((await findAwaLyrics(ARTIST, '曲A', { search: async () => { throw new Error('boom'); }, fetchPage: fakeSite({}).fetchPage })).status).toBe('search-unavailable');
    expect((await findAwaLyrics(ARTIST, '曲A', { search: async () => ({ items: [], throttled: true }), fetchPage: fakeSite({}).fetchPage })).status).toBe('search-unavailable');
  });

  test('a page that fails to load is an error for the caller to handle', async () => {
    const id = hex();
    await expect(findAwaLyrics(ARTIST, '曲A', { search: searchReturning([hit(id, '曲A')]).search, fetchPage: fakeSite({}).fetchPage })).rejects.toThrow('404');
  });
});
