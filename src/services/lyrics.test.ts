import { describe, expect, test } from 'bun:test';
import { getLyrics, pickLrclibRecord } from './lyrics.js';

// 歌詞の本文は使わない。曲名・歌手名・歌詞はすべてテスト用の作り物。
let seq = 0;
const uniq = (label: string) => `${label}${++seq}`;

const rec = (id: number, trackName: string, artistName: string, plainLyrics: string | null, extra: Record<string, unknown> = {}) => ({
  id, name: trackName, trackName, artistName, albumName: 'テスト盤', duration: 200, instrumental: false,
  plainLyrics, syncedLyrics: '[00:01.00] 同期', lyricsfile: 'version: 1 # 返してはいけない', ...extra,
});

interface Call { params: URLSearchParams; headers: Record<string, string> }
/** LRCLIB の代わり。応答は呼び出し順に並べる（Response か、検索結果の配列）。 */
function fakeLrclib(...responses: Array<Response | unknown[]>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ params: new URL(url).searchParams, headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next instanceof Response ? next.clone() : new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const status = (code: number, headers: Record<string, string> = {}) => new Response('{}', { status: code, headers });
const noSleep = async () => {};
const linkcoreNone = { search: async () => ({ items: [] }), fetchPage: async () => '' };
const awaNone = { search: async () => ({ items: [] }), fetchPage: async () => '' };

describe('pickLrclibRecord', () => {
  const A = 'テスト歌手';
  test('prefers the exact title over a prefix match', () => {
    const r = pickLrclibRecord([rec(1, '曲X (Live)', A, 'らいぶ'), rec(2, '曲X', A, 'すたじお')], '曲X', A);
    expect(r.chosen?.id).toBe(2);
  });
  test('takes the most registered text among duplicates, and the longer one on a tie', () => {
    const majority = pickLrclibRecord([rec(1, '曲X', A, 'ああ'), rec(2, '曲X', A, 'いい'), rec(3, '曲X', A, 'いい')], '曲X', A);
    expect(majority.chosen?.plainLyrics).toBe('いい');
    const tie = pickLrclibRecord([rec(1, '曲X', A, 'ああ'), rec(2, '曲X', A, 'いいい')], '曲X', A);
    expect(tie.chosen?.plainLyrics).toBe('いいい');
  });
  test('folds width, case and symbols in title and artist, and accepts a contained artist name', () => {
    expect(pickLrclibRecord([rec(1, 'ＳＯＮＧ　Ｂ！', 'test GROUP feat. ゲスト', 'うう')], 'song b', 'Ｔｅｓｔ　Ｇｒｏｕｐ').chosen?.id).toBe(1);
  });
  test('skips instrumental records and records without text', () => {
    const r = pickLrclibRecord([rec(1, '曲X', A, 'ああ', { instrumental: true }), rec(2, '曲X', A, '  '), rec(3, '曲X', A, null)], '曲X', A);
    expect(r.chosen).toBeUndefined();
  });
  test('a title match by another artist is not chosen but is offered as a candidate', () => {
    const r = pickLrclibRecord([rec(1, '曲X', '別の歌手', 'ええ')], '曲X', A);
    expect(r.chosen).toBeUndefined();
    expect(r.candidates).toEqual([{ title: '曲X', artist: '別の歌手', album: 'テスト盤' }]);
  });
  test('without an artist the most registered song wins and the others are candidates', () => {
    const r = pickLrclibRecord([rec(1, '曲X', '歌手甲', 'ああ'), rec(2, '曲X', '歌手乙', 'いい'), rec(3, '曲X', '歌手乙', 'いい')], '曲X');
    expect(r.chosen?.artistName).toBe('歌手乙');
    expect(r.candidates.map((c) => c.artist)).toEqual(['歌手甲']);
  });
});

describe('getLyrics: LRCLIB', () => {
  test('returns the chosen text with its source, and nothing else from the record', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const l = fakeLrclib([rec(42, title, artist, 'らら\nるる')]);
    const r = await getLyrics({ title, artist }, { fetchFn: l.fetchFn, sleep: noSleep, awa: awaNone, linkcore: linkcoreNone });
    expect(r).toMatchObject({ found: true, source: 'lrclib', lyrics: 'らら\nるる', sourceUrl: 'https://lrclib.net/api/get/42', track: { title, artist, album: 'テスト盤' } });
    expect(r.notice).toContain('個人利用');
    const json = JSON.stringify(r);
    expect(json).not.toContain('lyricsfile');
    expect(json).not.toContain('同期');
    expect(l.calls[0].params.get('track_name')).toBe(title);
    expect(l.calls[0].params.get('artist_name')).toBe(artist);
  });

  test('identifies itself with a User-Agent naming Sora, its version and its home page', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const l = fakeLrclib([rec(1, title, artist, 'ああ')]);
    await getLyrics({ title, artist }, { fetchFn: l.fetchFn, sleep: noSleep, awa: awaNone, linkcore: linkcoreNone });
    expect(l.calls[0].headers['User-Agent']).toMatch(/^Sora\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/ikenokazuki\/Sora\)$/);
  });

  test('an empty answer is retried once as a free-text query', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const l = fakeLrclib([], [rec(1, title, artist, 'ああ')]);
    const r = await getLyrics({ title, artist }, { fetchFn: l.fetchFn, sleep: noSleep, awa: awaNone, linkcore: linkcoreNone });
    expect(r.found).toBe(true);
    expect(l.calls.map((c) => c.params.get('q'))).toEqual([null, `${artist} ${title}`]);
  });

  test('without an artist it searches by title only and never asks TuneCore', async () => {
    const title = uniq('曲');
    const l = fakeLrclib([]);
    let asked = false;
    const r = await getLyrics({ title }, { fetchFn: l.fetchFn, sleep: noSleep, awa: awaNone, linkcore: { search: async () => { asked = true; return { items: [] }; } } });
    expect(r).toMatchObject({ found: false, reason: 'no-match' });
    expect(l.calls).toHaveLength(1);
    expect(l.calls[0].params.get('q')).toBe(title);
    expect(asked).toBe(false);
  });

  test('waits for Retry-After (capped, with jitter) and retries once on 429', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const l = fakeLrclib(status(429, { 'Retry-After': '2' }), [rec(1, title, artist, 'ああ')]);
    const waits: number[] = [];
    const r = await getLyrics({ title, artist }, { fetchFn: l.fetchFn, sleep: async (ms) => { waits.push(ms); }, awa: awaNone, linkcore: linkcoreNone });
    expect(r.found).toBe(true);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
    expect(waits[0]).toBeLessThanOrEqual(2600);
    const capped: number[] = [];
    const l2 = fakeLrclib(status(429, { 'Retry-After': '600' }), [rec(2, title + 'b', artist, 'いい')]);
    await getLyrics({ title: title + 'b', artist }, { fetchFn: l2.fetchFn, sleep: async (ms) => { capped.push(ms); }, awa: awaNone, linkcore: linkcoreNone });
    expect(capped[0]).toBeLessThanOrEqual(6500);
  });

  test('a second failure hands over to TuneCore', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const l = fakeLrclib(status(503));
    const r = await getLyrics({ title, artist }, {
      fetchFn: l.fetchFn, sleep: noSleep, awa: awaNone,
      linkcore: {
        search: async () => ({ items: [{ url: 'https://linkco.re/Zz000001/songs/1/lyrics', title: `歌詞 | ${title} by ${artist} | TuneCore Japan` }] }),
        fetchPage: async (url) => url.includes('/songs/')
          ? '<div class=lyric_text><p>てすと</div>'
          : `<title>${title} by ${artist} | TuneCore Japan</title><div class=trackList_block><div class=list_song_title><p>${title}<p class=list_song_artistname>${artist}</div><div class=lyrics_btn><a href=https://linkco.re/Zz000001/songs/1/lyrics>歌詞</a></div></div>`,
      },
    });
    expect(l.calls).toHaveLength(2);
    expect(r).toMatchObject({ found: true, source: 'tunecore', lyrics: 'てすと', sourceUrl: 'https://linkco.re/Zz000001/songs/1/lyrics' });
  });

  test('when LRCLIB was down and TuneCore has nothing, the answer is "unavailable", not "no match"', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const r = await getLyrics({ title, artist }, { fetchFn: fakeLrclib(status(503)).fetchFn, sleep: noSleep, awa: awaNone, linkcore: linkcoreNone });
    expect(r).toMatchObject({ found: false, reason: 'search-unavailable' });
  });

  test('LRCLIB hit means TuneCore is not consulted', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    let asked = false;
    await getLyrics({ title, artist }, { fetchFn: fakeLrclib([rec(1, title, artist, 'ああ')]).fetchFn, sleep: noSleep, awa: awaNone, linkcore: { search: async () => { asked = true; return { items: [] }; } } });
    expect(asked).toBe(false);
  });
});

describe('getLyrics: TuneCore answers', () => {
  const lrclibEmpty = () => fakeLrclib([]).fetchFn;
  test('a track without lyrics on TuneCore is found:false with its own reason and the track', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const r = await getLyrics({ title, artist }, {
      fetchFn: lrclibEmpty(), sleep: noSleep, awa: awaNone,
      linkcore: {
        search: async () => ({ items: [{ url: 'https://linkco.re/Zz000002/songs/1/lyrics', title: `歌詞 | x by ${artist} | TuneCore Japan` }] }),
        fetchPage: async () => `<title>${title} by ${artist} | TuneCore Japan</title><div class=trackList_block><div class=list_song_title><p>${title}<p class=list_song_artistname>${artist}</div></div>`,
      },
    });
    expect(r).toMatchObject({ found: false, reason: 'no-lyrics-registered', track: { title, artist } });
    expect(r.lyrics).toBeUndefined();
  });

  test('no match anywhere lists the titles seen on TuneCore as candidates', async () => {
    const artist = uniq('歌手'); const other = uniq('別曲');
    const r = await getLyrics({ title: uniq('曲'), artist }, {
      fetchFn: lrclibEmpty(), sleep: noSleep, awa: awaNone,
      linkcore: {
        search: async () => ({ items: [{ url: 'https://linkco.re/Zz000003/songs/1/lyrics', title: `歌詞 | x by ${artist} | TuneCore Japan` }] }),
        fetchPage: async () => `<title>${other} by ${artist} | TuneCore Japan</title><div class=trackList_block><div class=list_song_title><p>${other}<p class=list_song_artistname>${artist}</div></div>`,
      },
    });
    expect(r).toMatchObject({ found: false, reason: 'no-match' });
    expect(r.candidates).toEqual([{ title: other, artist }]);
  });
});

describe('getLyrics: cache', () => {
  test('a repeated request is served without calling LRCLIB again, noCache bypasses it', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const l = fakeLrclib([rec(1, title, artist, 'ああ')]);
    const deps = { fetchFn: l.fetchFn, sleep: noSleep, awa: awaNone, linkcore: linkcoreNone };
    await getLyrics({ title, artist }, deps);
    const again = await getLyrics({ title, artist }, deps);
    expect(l.calls).toHaveLength(1);
    expect(again.lyrics).toBe('ああ');
    await getLyrics({ title, artist, noCache: true }, deps);
    expect(l.calls).toHaveLength(2);
  });
  test('an unavailable answer is not cached', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const down = fakeLrclib(status(503));
    await getLyrics({ title, artist }, { fetchFn: down.fetchFn, sleep: noSleep, awa: awaNone, linkcore: linkcoreNone });
    const up = fakeLrclib([rec(1, title, artist, 'ああ')]);
    const r = await getLyrics({ title, artist }, { fetchFn: up.fetchFn, sleep: noSleep, awa: awaNone, linkcore: linkcoreNone });
    expect(r.found).toBe(true);
  });
});

// ---- AWA は LRCLIB の次、TuneCore の前 ----
const awaHtml = (id: string, name: string, artist: string, text: string) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { dehydrated: { context: { dispatcher: { stores: { TrackStore: {
    track: { map: { [id]: { id, name, artist: { name: artist }, album: { name: 'テスト盤' } } }, keys: [id] },
    lyrics: { map: text ? { [id]: { id, text } } : {} },
    artistTracks: { map: { [id]: [] } },
  } } } } } } },
})}</script>`;
let awaSeq = 0;
const awaId = () => (0x7a0000 + ++awaSeq).toString(16).padStart(20, '0');
const awaWith = (name: string, artist: string, text: string) => {
  const id = awaId();
  return {
    id,
    deps: {
      search: async () => ({ items: [{ url: `https://s.awa.fm/track/${id}`, title: `”${name}” by ${artist} - トラック・歌詞情報 | AWA` }] }),
      fetchPage: async () => awaHtml(id, name, artist, text),
    },
  };
};
const linkcoreFinding = (title: string, artist: string, rid: string, withLyrics: boolean) => ({
  search: async () => ({ items: [{ url: `https://linkco.re/${rid}/songs/1/lyrics`, title: `歌詞 | ${title} by ${artist} | TuneCore Japan` }] }),
  fetchPage: async (u: string) => u.includes('/songs/')
    ? '<div class=lyric_text><p>てんいち</div>'
    : `<title>${title} by ${artist} | TuneCore Japan</title><div class=trackList_block><div class=list_song_title><p>${title}<p class=list_song_artistname>${artist}</div>${withLyrics ? `<div class=lyrics_btn><a href=https://linkco.re/${rid}/songs/1/lyrics>歌詞</a></div>` : ''}</div>`,
});

describe('getLyrics: AWA before TuneCore', () => {
  const lrclibEmpty = () => fakeLrclib([]).fetchFn;

  test('AWA answers after LRCLIB and TuneCore is not consulted', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const a = awaWith(title, artist, 'えー\nだぶりゅー');
    let tuneCoreAsked = false;
    const r = await getLyrics({ title, artist }, { fetchFn: lrclibEmpty(), sleep: noSleep, awa: a.deps, linkcore: { search: async () => { tuneCoreAsked = true; return { items: [] }; } } });
    expect(r).toMatchObject({ found: true, source: 'awa', lyrics: 'えー\nだぶりゅー', sourceUrl: `https://s.awa.fm/track/${a.id}`, track: { title, artist, album: 'テスト盤' } });
    expect(tuneCoreAsked).toBe(false);
  });

  test('no text on AWA falls through to TuneCore', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const r = await getLyrics({ title, artist }, { fetchFn: lrclibEmpty(), sleep: noSleep, awa: awaWith(title, artist, '').deps, linkcore: linkcoreFinding(title, artist, 'Zy000001', true) });
    expect(r).toMatchObject({ found: true, source: 'tunecore', lyrics: 'てんいち' });
  });

  test('no text on AWA and none on TuneCore is "not registered", with the track', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const r = await getLyrics({ title, artist }, { fetchFn: lrclibEmpty(), sleep: noSleep, awa: awaWith(title, artist, '').deps, linkcore: linkcoreFinding(title, artist, 'Zy000002', false) });
    expect(r).toMatchObject({ found: false, reason: 'no-lyrics-registered', track: { title, artist } });
  });

  test('a throttled AWA search skips TuneCore, which needs the same search, and is not cached', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    let tuneCoreAsked = false;
    const deps = { fetchFn: lrclibEmpty(), sleep: noSleep, awa: { search: async () => ({ items: [], throttled: true }) }, linkcore: { search: async () => { tuneCoreAsked = true; return { items: [] }; } } };
    const r = await getLyrics({ title, artist }, deps);
    expect(r).toMatchObject({ found: false, reason: 'search-unavailable' });
    expect(tuneCoreAsked).toBe(false);
    const again = await getLyrics({ title, artist }, { ...deps, awa: awaWith(title, artist, 'とりもどし').deps });
    expect(again).toMatchObject({ found: true, source: 'awa' });
  });

  test('an AWA page that cannot be read does not stop TuneCore', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const broken = { search: awaWith(title, artist, 'x').deps.search, fetchPage: async () => { throw new Error('AWA HTTP 500'); } };
    const r = await getLyrics({ title, artist }, { fetchFn: lrclibEmpty(), sleep: noSleep, awa: broken, linkcore: linkcoreFinding(title, artist, 'Zy000003', true) });
    expect(r).toMatchObject({ found: true, source: 'tunecore' });
  });

  test('every source down is "unavailable", not an error', async () => {
    const artist = uniq('歌手'); const title = uniq('曲');
    const broken = { search: awaWith(title, artist, 'x').deps.search, fetchPage: async () => { throw new Error('AWA HTTP 500'); } };
    const r = await getLyrics({ title, artist }, { fetchFn: lrclibEmpty(), sleep: noSleep, awa: broken, linkcore: { search: async () => { throw new Error('boom'); } } });
    expect(r).toMatchObject({ found: false, reason: 'search-unavailable' });
  });

  test('candidates from every source are merged without duplicates', async () => {
    const artist = uniq('歌手'); const title = uniq('曲'); const known = uniq('既知曲');
    const id = awaId();
    const pageWithList = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { dehydrated: { context: { dispatcher: { stores: { TrackStore: {
      track: { map: { [id]: { id, name: known, artist: { name: artist } } }, keys: [id] }, lyrics: { map: {} },
      artistTracks: { map: { [id]: [{ id: awaId(), name: '同じ歌手の曲' }] } },
    } } } } } } } })}</script>`;
    const awa = { search: async () => ({ items: [{ url: `https://s.awa.fm/track/${id}`, title: `”${known}” by ${artist} - トラック・歌詞情報 | AWA` }] }), fetchPage: async () => pageWithList };
    const linkcore = { search: async () => ({ items: [{ url: 'https://linkco.re/Zy000004/songs/1/lyrics', title: `歌詞 | ${known} by ${artist} | TuneCore Japan` }] }), fetchPage: async () => `<title>${known} by ${artist} | TuneCore Japan</title><div class=trackList_block><div class=list_song_title><p>${known}<p class=list_song_artistname>${artist}</div></div>` };
    const r = await getLyrics({ title, artist }, { fetchFn: lrclibEmpty(), sleep: noSleep, awa, linkcore });
    expect(r).toMatchObject({ found: false, reason: 'no-match' });
    expect(r.candidates.map((c) => c.title).sort()).toEqual([known, '同じ歌手の曲'].sort());
  });

  test('without an artist neither web source is consulted', async () => {
    let asked = 0;
    const spy = { search: async () => { asked++; return { items: [] }; } };
    await getLyrics({ title: uniq('曲') }, { fetchFn: lrclibEmpty(), sleep: noSleep, awa: spy, linkcore: spy });
    expect(asked).toBe(0);
  });
});
