import * as cheerio from 'cheerio';
import { getFromCache, setToCache } from '../cache.js';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import { searchYahooWeb } from './yahoo.js';

/**
 * TuneCore Japan の LinkCore（linkco.re）から歌詞を引く。歌手名と曲名だけが入力で、URL は内部で組み立てる。
 *
 * 入口: `site:linkco.re` の Web 検索で、その歌手のリリースページを 1 件見つける。
 * 巡回: リリースページは同じ歌手の他のリリースへのリンクを載せているので、幅優先でたどって曲名を探す。
 * 歌詞が出るのは権利者が TuneCore に登録した曲だけ（著作権管理団体の管理曲は出ない）。歌詞ボタンが無ければ未登録として返す。
 */

const ID = '[A-Za-z0-9]{8}';
const RELEASE_LINK = new RegExp(`^https://linkco\\.re/(${ID})(?:[?#]|$)`);
const SEED_URL = new RegExp(`^https?://linkco\\.re/(${ID})(?:[/?#]|$)`);
const LYRICS_URL = new RegExp(`^https://linkco\\.re/${ID}/songs/\\d+/lyrics$`);
const MAX_RELEASES = 30;
const BUDGET_MS = 20_000;
const MAX_CANDIDATES = 10;
const RELEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseTrack { name: string; artist: string; lyricsUrl: string | null }
export interface ReleasePage { artist: string; tracks: ReleaseTrack[]; siblings: string[] }

export interface LinkcoreOutcome {
  status: 'found' | 'no-lyrics-registered' | 'no-match' | 'search-unavailable';
  track?: { title: string; artist: string };
  lyrics?: string;
  sourceUrl?: string;
  /** 見つからないときの手がかり。巡回で分かった同じ歌手の曲名。 */
  candidates: string[];
}

export interface LinkcoreDeps {
  search?: (query: string) => Promise<{ items?: Array<{ url?: string; title?: string }>; throttled?: boolean }>;
  fetchPage?: (url: string) => Promise<string>;
}

/** 曲名・歌手名の突き合わせ用に、全角半角・大小文字・空白と記号を畳む。 */
export function normalizeName(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 正規化後に一致、または片方がもう片方を含む（「A feat. B」のような表記ゆれ）。 */
export function matchesArtist(wanted: string, found: string): boolean {
  const a = normalizeName(wanted);
  const b = normalizeName(found);
  return a !== '' && b !== '' && (a === b || a.includes(b) || b.includes(a));
}

export function parseReleasePage(html: string, selfId: string): ReleasePage {
  const $ = cheerio.load(html);
  const artist = /\sby\s+(.+?)\s*\|\s*TuneCore Japan\s*$/.exec($('title').first().text())?.[1] ?? '';
  const tracks = $('.trackList_block').toArray().map((el): ReleaseTrack => {
    const block = $(el);
    const href = block.find('.lyrics_btn a').attr('href') ?? '';
    return {
      name: block.find('.list_song_title p').first().text().trim(),
      artist: block.find('.list_song_artistname').text().trim() || artist,
      lyricsUrl: LYRICS_URL.test(href) ? href : null,
    };
  }).filter((t) => t.name !== '');
  const siblings = [...new Set($('a[href]').toArray()
    .map((a) => RELEASE_LINK.exec($(a).attr('href') ?? '')?.[1])
    .filter((id): id is string => !!id && id !== selfId))];
  return { artist, tracks, siblings };
}

/** 歌詞ページの `lyric_text` は 1 行が 1 つの `<p>`（空の `<p>` は空行）。 */
export function parseLyricsPage(html: string): string {
  const $ = cheerio.load(html);
  return $('.lyric_text p').toArray().map((p) => $(p).text().trim()).join('\n').trim();
}

const quoteFree = (s: string) => s.replace(/["“”]/g, ' ').trim();

const defaultSearch: NonNullable<LinkcoreDeps['search']> = (query) =>
  searchYahooWeb({ query, includeDomains: ['linkco.re'], disableFallback: true });

const defaultFetchPage = async (url: string): Promise<string> => {
  const { response } = await fetchWithSafeRedirects(url, 10_000, 3);
  if (!response.ok) throw new Error(`LinkCore HTTP ${response.status}`);
  return response.text();
};

/** 検索結果のうち、題名が「… by <歌手> | TuneCore Japan」で歌手が合う linkco.re のリリース ID。 */
async function findSeeds(artist: string, title: string, search: NonNullable<LinkcoreDeps['search']>): Promise<{ seeds: string[]; unavailable: boolean }> {
  const queries = [`"${quoteFree(artist)}" "${quoteFree(title)}" 歌詞`, `"${quoteFree(artist)}" 歌詞`];
  for (const query of queries) {
    let res: Awaited<ReturnType<typeof search>>;
    try {
      res = await search(query);
    } catch {
      return { seeds: [], unavailable: true };
    }
    if (res.throttled) return { seeds: [], unavailable: true };
    const seeds = [...new Set((res.items ?? []).flatMap((item) => {
      const id = SEED_URL.exec(item.url ?? '')?.[1];
      const by = /\sby\s+(.+?)\s*\|\s*TuneCore Japan/.exec(item.title ?? '')?.[1];
      return id && by && matchesArtist(artist, by) ? [id] : [];
    }))];
    if (seeds.length > 0) return { seeds, unavailable: false };
  }
  return { seeds: [], unavailable: false };
}

async function loadRelease(id: string, fetchPage: NonNullable<LinkcoreDeps['fetchPage']>): Promise<ReleasePage> {
  const key = `lyrics:linkcore:release:${id}`;
  const cached = getFromCache<ReleasePage>(key);
  if (cached) return cached;
  const page = parseReleasePage(await fetchPage(`https://linkco.re/${id}?lang=ja`), id);
  setToCache(key, page, RELEASE_TTL_MS); // 歌詞本文は入れない（題名・URL・リンクだけ）
  return page;
}

export async function findLinkcoreLyrics(artist: string, title: string, deps: LinkcoreDeps = {}): Promise<LinkcoreOutcome> {
  const search = deps.search ?? defaultSearch;
  const fetchPage = deps.fetchPage ?? defaultFetchPage;

  const { seeds, unavailable } = await findSeeds(artist, title, search);
  if (seeds.length === 0) return { status: unavailable ? 'search-unavailable' : 'no-match', candidates: [] };

  const want = normalizeName(title);
  const titles = new Set<string>();
  const visited = new Set<string>();
  const queue = [...seeds];
  const deadline = Date.now() + BUDGET_MS;
  // ponytail: 曲名が合った最初のトラックで打ち切る。別のリリースに歌詞付きの同名曲があっても探さない（探すと未登録の曲ごとに全リリースを巡回する）
  while (queue.length > 0 && visited.size < MAX_RELEASES && Date.now() < deadline) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    let page: ReleasePage;
    try {
      page = await loadRelease(id, fetchPage);
    } catch {
      continue; // 読めないリリースは飛ばして続ける
    }
    for (const track of page.tracks) {
      if (!matchesArtist(artist, track.artist)) continue;
      titles.add(track.name);
      if (normalizeName(track.name) !== want) continue;
      const found = { title: track.name, artist: track.artist };
      if (!track.lyricsUrl) return { status: 'no-lyrics-registered', track: found, candidates: [] };
      const lyrics = parseLyricsPage(await fetchPage(`${track.lyricsUrl}?lang=ja`));
      if (lyrics === '') return { status: 'no-lyrics-registered', track: found, candidates: [] };
      return { status: 'found', track: found, lyrics, sourceUrl: track.lyricsUrl, candidates: [] };
    }
    for (const next of page.siblings) if (!visited.has(next) && !queue.includes(next)) queue.push(next);
  }
  return { status: 'no-match', candidates: [...titles].slice(0, MAX_CANDIDATES) };
}
