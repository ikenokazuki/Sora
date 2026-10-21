import * as cheerio from 'cheerio';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import { matchesArtist, normalizeName } from './lyrics_linkcore.js';
import { searchYahooWeb } from './yahoo.js';

/**
 * AWA（s.awa.fm）の公開の曲ページから歌詞を引く。歌手名と曲名だけが入力で、URL は内部で組み立てる。
 *
 * 入口: `site:s.awa.fm` の Web 検索で、その歌手の曲ページを 1 件見つける（題名は「”曲名” by 歌手 - トラック・歌詞情報」）。
 * 曲ページの `__NEXT_DATA__` には、曲・歌詞全文・同じ歌手の他の曲の一覧が入っている。探す曲が見つからなければ、その一覧から曲 ID を引いて次のページを読む。
 * 利用規約は、著作権法で認められた私的利用の範囲を超える複製・公衆送信を禁じている。
 */

const ID = '[0-9a-f]{20}';
const TRACK_ID = new RegExp(`^${ID}$`);
const TRACK_URL = new RegExp(`^https?://s\\.awa\\.fm/track/(${ID})(?:[/?#]|$)`);
const RESULT_TITLE = /^[”"“](.+)[”"”]\s+by\s+(.+?)\s+-\s*トラック・歌詞情報/;
const MAX_CANDIDATES = 10;

export interface AwaTrackPage {
  id: string;
  name: string;
  artist: string;
  album?: string;
  lyrics: string;
  /** 同じ歌手の他の曲（ページの曲自身は含まれない）。 */
  artistTracks: Array<{ id: string; name: string }>;
}

export interface AwaOutcome {
  status: 'found' | 'no-lyrics-registered' | 'no-match' | 'search-unavailable';
  track?: { title: string; artist: string; album?: string };
  lyrics?: string;
  sourceUrl?: string;
  /** 見つからないときの手がかり。分かった同じ歌手の曲名。 */
  candidates: string[];
}

export interface AwaDeps {
  search?: (query: string) => Promise<{ items?: Array<{ url?: string; title?: string }>; throttled?: boolean }>;
  fetchPage?: (url: string) => Promise<string>;
}

const trackUrl = (id: string) => `https://s.awa.fm/track/${id}`;
const quoteFree = (s: string) => s.replace(/["“”]/g, ' ').trim();

/** ponytail: Next.js の内部データ（TrackStore）の形に頼る。AWA が変えたら取れなくなる（テストと実機確認で気づく）。 */
export function parseAwaTrackPage(html: string): AwaTrackPage | undefined {
  let store: any;
  try {
    const raw = cheerio.load(html)('#__NEXT_DATA__').html() ?? '';
    store = JSON.parse(raw)?.props?.pageProps?.dehydrated?.context?.dispatcher?.stores?.TrackStore;
  } catch {
    return undefined;
  }
  const id: unknown = store?.track?.keys?.[0] ?? Object.keys(store?.track?.map ?? {})[0];
  if (typeof id !== 'string' || !TRACK_ID.test(id)) return undefined;
  const track = store.track.map[id];
  if (typeof track?.name !== 'string') return undefined;
  const text = store.lyrics?.map?.[id]?.text;
  const listed: unknown[] = store.artistTracks?.map?.[id] ?? [];
  return {
    id,
    name: track.name,
    artist: track.artist?.name ?? '',
    ...(track.album?.name ? { album: track.album.name } : {}),
    lyrics: typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '',
    artistTracks: listed
      .filter((t: any) => typeof t?.id === 'string' && TRACK_ID.test(t.id) && typeof t?.name === 'string')
      .map((t: any) => ({ id: t.id, name: t.name })),
  };
}

const defaultSearch: NonNullable<AwaDeps['search']> = (query) =>
  searchYahooWeb({ query, includeDomains: ['s.awa.fm'], disableFallback: true });

const defaultFetchPage = async (url: string): Promise<string> => {
  const { response } = await fetchWithSafeRedirects(url, 10_000, 3);
  if (!response.ok) throw new Error(`AWA HTTP ${response.status}`);
  return response.text();
};

/** 検索結果のうち、題名が「”曲名” by <歌手> - トラック・歌詞情報」で歌手が合う s.awa.fm の曲ページ。 */
async function findSeeds(artist: string, title: string, search: NonNullable<AwaDeps['search']>): Promise<{ seeds: Array<{ id: string; title: string }>; unavailable: boolean }> {
  for (const query of [`"${quoteFree(artist)}" "${quoteFree(title)}"`, `"${quoteFree(artist)}"`]) {
    let res: Awaited<ReturnType<typeof search>>;
    try {
      res = await search(query);
    } catch {
      return { seeds: [], unavailable: true };
    }
    if (res.throttled) return { seeds: [], unavailable: true };
    const seeds = new Map<string, { id: string; title: string }>();
    for (const item of res.items ?? []) {
      const id = TRACK_URL.exec(item.url ?? '')?.[1];
      const m = RESULT_TITLE.exec((item.title ?? '').trim());
      if (id && m && matchesArtist(artist, m[2])) seeds.set(id, { id, title: m[1].trim() });
    }
    if (seeds.size > 0) return { seeds: [...seeds.values()], unavailable: false };
  }
  return { seeds: [], unavailable: false };
}

export async function findAwaLyrics(artist: string, title: string, deps: AwaDeps = {}): Promise<AwaOutcome> {
  const search = deps.search ?? defaultSearch;
  const fetchPage = deps.fetchPage ?? defaultFetchPage;

  const { seeds, unavailable } = await findSeeds(artist, title, search);
  if (seeds.length === 0) return { status: unavailable ? 'search-unavailable' : 'no-match', candidates: [] };

  const want = normalizeName(title);
  const titles = new Set(seeds.map((s) => s.title));
  let targetId = seeds.find((s) => normalizeName(s.title) === want)?.id;
  if (!targetId) {
    // 検索結果に曲そのものが無い。見つけた曲のページが載せる、同じ歌手の曲の一覧から探す
    const seedPage = parseAwaTrackPage(await fetchPage(trackUrl(seeds[0].id)));
    for (const t of seedPage?.artistTracks ?? []) titles.add(t.name);
    targetId = seedPage?.artistTracks.find((t) => normalizeName(t.name) === want)?.id;
  }
  if (!targetId) return { status: 'no-match', candidates: [...titles].slice(0, MAX_CANDIDATES) };

  const page = parseAwaTrackPage(await fetchPage(trackUrl(targetId)));
  if (!page) throw new Error('AWA page has no readable track data');
  if (!matchesArtist(artist, page.artist)) return { status: 'no-match', candidates: [...titles].slice(0, MAX_CANDIDATES) };
  const track = { title: page.name, artist: page.artist, ...(page.album ? { album: page.album } : {}) };
  if (page.lyrics === '') return { status: 'no-lyrics-registered', track, candidates: [] };
  return { status: 'found', track, lyrics: page.lyrics, sourceUrl: trackUrl(page.id), candidates: [] };
}
