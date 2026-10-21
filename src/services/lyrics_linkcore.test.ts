import { describe, expect, test } from 'bun:test';
import { findLinkcoreLyrics, normalizeName, parseLyricsPage, parseReleasePage } from './lyrics_linkcore.js';

// 歌詞の本文は使わない。以下の曲名・歌手名・歌詞はすべてテスト用の作り物。
const ARTIST = 'テストグループ';
let seq = 0;
const newId = () => `T${String(++seq).padStart(7, '0')}`; // 8 桁。テスト間でキャッシュが衝突しない

interface FakeTrack { name: string; artist?: string; song?: number; lyrics?: boolean }
const lyricsUrl = (rid: string, song: number) => `https://linkco.re/${rid}/songs/${song}/lyrics`;

/** 実ページと同じ形（属性値に引用符なし、<p> が閉じない）の圧縮 HTML。 */
function releaseHtml(rid: string, title: string, artist: string, tracks: FakeTrack[], siblings: string[] = []): string {
  const lis = tracks.map((t, i) =>
    `<li><input id=c${i} type=checkbox><label for=c${i}><div class=trackList_block>`
    + `<div class=trackList_wrap><div class=list_number>${i + 1}</div><div class=list_song_title><p>${t.name}<p class=list_song_artistname>${t.artist ?? artist}</div></div>`
    + `<div class=trackList_wrap>${t.lyrics ? `<div class=lyrics_btn><a href=${lyricsUrl(rid, t.song ?? 1)}>歌詞</a></div>` : ''}<div class=arrow_down></div></div>`
    + `</div></label></li>`).join('');
  return `<!DOCTYPE html><html><head><title>${title} by ${artist} | TuneCore Japan</title></head><body>`
    + `<a href=https://linkco.re/${rid}?lang=en>EN</a><a href=https://linkco.re/${rid}?lang=ja>JA</a>`
    + siblings.map((s) => `<a href=https://linkco.re/${s}?lang=ja>x</a>`).join('')
    + `<ul>${lis}</ul></body></html>`;
}

const lyricsHtml = (lines: string[]) =>
  `<html><head><title>歌詞</title></head><body><div class=lyric_content><section class=lyric_lyric><div class=lyric_text>${lines.map((l) => `<p>${l}`).join('')}</div></section></div></body></html>`;

function fakeSite(pages: Record<string, string>) {
  const fetched: string[] = [];
  return {
    fetched,
    fetchPage: async (url: string) => {
      fetched.push(url);
      const html = pages[url.replace(/\?.*$/, '')];
      if (html === undefined) throw new Error(`404 ${url}`);
      return html;
    },
  };
}

const hit = (rid: string, name: string, artist = ARTIST) => ({ url: `https://linkco.re/${rid}/songs/1/lyrics`, title: `歌詞 | ${name} by ${artist} | TuneCore Japan` });
const searchReturning = (items: Array<{ url: string; title?: string }>) => {
  const queries: string[] = [];
  return { queries, search: async (q: string) => { queries.push(q); return { items }; } };
};

describe('parseReleasePage', () => {
  test('reads tracks with and without a lyric button, and sibling releases', () => {
    const html = releaseHtml('AAAAAAAA', '曲1', ARTIST, [{ name: '曲1', song: 11, lyrics: true }, { name: '曲2', song: 12 }], ['BBBBBBBB', 'CCCCCCCC', 'BBBBBBBB']);
    const page = parseReleasePage(html, 'AAAAAAAA');
    expect(page.tracks).toEqual([
      { name: '曲1', artist: ARTIST, lyricsUrl: 'https://linkco.re/AAAAAAAA/songs/11/lyrics' },
      { name: '曲2', artist: ARTIST, lyricsUrl: null },
    ]);
    expect(page.siblings).toEqual(['BBBBBBBB', 'CCCCCCCC']);
  });

  test('ignores a lyric link that does not point at linkco.re', () => {
    const html = releaseHtml('AAAAAAAA', '曲1', ARTIST, [{ name: '曲1', lyrics: true }]).replace('https://linkco.re/AAAAAAAA/songs/1/lyrics', 'https://evil.example/AAAAAAAA/songs/1/lyrics');
    expect(parseReleasePage(html, 'AAAAAAAA').tracks[0].lyricsUrl).toBeNull();
  });
});

describe('parseLyricsPage', () => {
  test('one <p> is one line, an empty <p> is a blank line, entities are decoded', () => {
    expect(parseLyricsPage(lyricsHtml(['いち&amp;に', 'さん', '', 'よん']))).toBe('いち&に\nさん\n\nよん');
  });
  test('a page without the lyric block yields an empty string', () => {
    expect(parseLyricsPage('<html><body>none</body></html>')).toBe('');
  });
});

describe('normalizeName', () => {
  test('folds width, case, spaces and symbols', () => {
    expect(normalizeName('ふわり、初恋 。')).toBe(normalizeName('ふわり、初恋。'));
    expect(normalizeName('遠回りがいいっ！')).toBe(normalizeName('遠回りがいいっ!'));
    expect(normalizeName('Ｍrs. GREEN apple')).toBe('mrsgreenapple');
  });
});

describe('findLinkcoreLyrics', () => {
  test('search -> release page -> lyric page', async () => {
    const rid = newId();
    const site = fakeSite({
      [`https://linkco.re/${rid}`]: releaseHtml(rid, '曲A', ARTIST, [{ name: '曲A', song: 7, lyrics: true }]),
      [lyricsUrl(rid, 7)]: lyricsHtml(['らら', 'るる']),
    });
    const s = searchReturning([hit(rid, '曲A')]);
    const r = await findLinkcoreLyrics(ARTIST, '曲A', { search: s.search, fetchPage: site.fetchPage });
    expect(r).toMatchObject({ status: 'found', lyrics: 'らら\nるる', sourceUrl: lyricsUrl(rid, 7), track: { title: '曲A', artist: ARTIST } });
    expect(s.queries).toEqual([`"${ARTIST}" "曲A" 歌詞`]);
  });

  test('walks sibling releases breadth-first and stops at the first match', async () => {
    const [r1, r2, r3, r4] = [newId(), newId(), newId(), newId()];
    const site = fakeSite({
      [`https://linkco.re/${r1}`]: releaseHtml(r1, '曲1', ARTIST, [{ name: '曲1', lyrics: true }], [r2, r3]),
      [`https://linkco.re/${r2}`]: releaseHtml(r2, '曲2', ARTIST, [{ name: '曲2', lyrics: true }], [r1, r4]),
      [`https://linkco.re/${r3}`]: releaseHtml(r3, '曲3', ARTIST, [{ name: '曲3', song: 33, lyrics: true }], [r1]),
      [`https://linkco.re/${r4}`]: releaseHtml(r4, '曲4', ARTIST, [{ name: '曲4', lyrics: true }]),
      [lyricsUrl(r3, 33)]: lyricsHtml(['あ']),
    });
    const r = await findLinkcoreLyrics(ARTIST, '曲3', { search: searchReturning([hit(r1, '曲1')]).search, fetchPage: site.fetchPage });
    expect(r.status).toBe('found');
    expect(site.fetched.filter((u) => u.includes(r4))).toEqual([]); // 曲3 が見つかった時点で打ち切る
  });

  test('a track without a lyric button is reported as not registered, with the artist\'s other titles', async () => {
    const [r1, r2] = [newId(), newId()];
    const site = fakeSite({
      [`https://linkco.re/${r1}`]: releaseHtml(r1, '曲1', ARTIST, [{ name: '曲1', lyrics: false }], [r2]),
      [`https://linkco.re/${r2}`]: releaseHtml(r2, '曲2', ARTIST, [{ name: '曲2', lyrics: true }], [r1]),
    });
    const r = await findLinkcoreLyrics(ARTIST, '曲1', { search: searchReturning([hit(r1, '曲1')]).search, fetchPage: site.fetchPage });
    expect(r.status).toBe('no-lyrics-registered');
    expect(r.track?.title).toBe('曲1');
  });

  test('an unknown title is no-match and lists the titles it saw', async () => {
    const [r1, r2] = [newId(), newId()];
    const site = fakeSite({
      [`https://linkco.re/${r1}`]: releaseHtml(r1, '曲1', ARTIST, [{ name: '曲1', lyrics: true }], [r2]),
      [`https://linkco.re/${r2}`]: releaseHtml(r2, '曲2', ARTIST, [{ name: '曲2', lyrics: true }], [r1]),
    });
    const r = await findLinkcoreLyrics(ARTIST, 'ない曲', { search: searchReturning([hit(r1, '曲1')]).search, fetchPage: site.fetchPage });
    expect(r.status).toBe('no-match');
    expect(r.candidates.sort()).toEqual(['曲1', '曲2']);
  });

  test('stops after 30 releases', async () => {
    const ids = Array.from({ length: 40 }, newId);
    const pages: Record<string, string> = {};
    ids.forEach((id, i) => { pages[`https://linkco.re/${id}`] = releaseHtml(id, `曲${i}`, ARTIST, [{ name: `曲${i}`, lyrics: true }], [ids[i + 1] ?? ids[0]]); });
    const site = fakeSite(pages);
    const r = await findLinkcoreLyrics(ARTIST, 'ない曲', { search: searchReturning([hit(ids[0], '曲0')]).search, fetchPage: site.fetchPage });
    expect(r.status).toBe('no-match');
    expect(site.fetched.length).toBe(30);
  });

  test('only seeds from linkco.re pages credited to the requested artist', async () => {
    const [good, other, bad] = [newId(), newId(), newId()];
    const site = fakeSite({ [`https://linkco.re/${good}`]: releaseHtml(good, '曲A', ARTIST, [{ name: '曲A', lyrics: false }]) });
    const s = searchReturning([
      hit(other, '曲A', '別のグループ'),
      { url: `https://example.com/${bad}/songs/1/lyrics`, title: `歌詞 | 曲A by ${ARTIST} | TuneCore Japan` },
      { url: 'https://linkco.re/short/songs/1/lyrics', title: `歌詞 | 曲A by ${ARTIST} | TuneCore Japan` },
      hit(good, '曲A'),
    ]);
    await findLinkcoreLyrics(ARTIST, '曲A', { search: s.search, fetchPage: site.fetchPage });
    expect(site.fetched).toEqual([`https://linkco.re/${good}?lang=ja`]);
  });

  test('retries the search once without the title, and no more than that', async () => {
    const s = searchReturning([]);
    const r = await findLinkcoreLyrics(ARTIST, '曲A', { search: s.search, fetchPage: fakeSite({}).fetchPage });
    expect(r.status).toBe('no-match');
    expect(s.queries).toEqual([`"${ARTIST}" "曲A" 歌詞`, `"${ARTIST}" 歌詞`]);
  });

  test('a failing or throttled search is search-unavailable', async () => {
    const thrown = await findLinkcoreLyrics(ARTIST, '曲A', { search: async () => { throw new Error('boom'); }, fetchPage: fakeSite({}).fetchPage });
    expect(thrown.status).toBe('search-unavailable');
    const throttled = await findLinkcoreLyrics(ARTIST, '曲A', { search: async () => ({ items: [], throttled: true }), fetchPage: fakeSite({}).fetchPage });
    expect(throttled.status).toBe('search-unavailable');
  });

  test('skips a release page that fails to load', async () => {
    const [r1, r2] = [newId(), newId()];
    const site = fakeSite({
      [`https://linkco.re/${r2}`]: releaseHtml(r2, '曲2', ARTIST, [{ name: '曲2', song: 5, lyrics: true }]),
      [lyricsUrl(r2, 5)]: lyricsHtml(['ん']),
    });
    const s = searchReturning([hit(r1, '曲1'), hit(r2, '曲2')]);
    const r = await findLinkcoreLyrics(ARTIST, '曲2', { search: s.search, fetchPage: site.fetchPage });
    expect(r.status).toBe('found');
  });

  test('parsed release pages are cached, so a second song of the artist re-fetches nothing', async () => {
    const [r1, r2] = [newId(), newId()];
    const site = fakeSite({
      [`https://linkco.re/${r1}`]: releaseHtml(r1, '曲1', ARTIST, [{ name: '曲1', song: 1, lyrics: true }], [r2]),
      [`https://linkco.re/${r2}`]: releaseHtml(r2, '曲2', ARTIST, [{ name: '曲2', song: 2, lyrics: true }], [r1]),
      [lyricsUrl(r1, 1)]: lyricsHtml(['い']),
      [lyricsUrl(r2, 2)]: lyricsHtml(['ろ']),
    });
    const deps = { search: searchReturning([hit(r1, '曲1')]).search, fetchPage: site.fetchPage };
    await findLinkcoreLyrics(ARTIST, '曲2', deps);
    const before = site.fetched.filter((u) => !u.includes('/songs/')).length;
    await findLinkcoreLyrics(ARTIST, '曲1', deps);
    expect(site.fetched.filter((u) => !u.includes('/songs/')).length).toBe(before);
  });
});
