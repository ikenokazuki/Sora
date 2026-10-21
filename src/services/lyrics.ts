import type { z } from 'zod';
import { cacheKeyDigest, getFromCache, runWithSingleFlight, setToCache } from '../cache.js';
import { SORA_VERSION, type LyricsResultSchema } from '../types.js';
import { findLinkcoreLyrics, matchesArtist, normalizeName, type LinkcoreDeps } from './lyrics_linkcore.js';

/**
 * 歌詞全文の取得（モジュール 'lyrics'。ENABLED_MODULES に名前を挙げたときだけ使える、自己責任の機能）。
 * 歌手名と曲名から、LRCLIB（利用者投稿の歌詞データベース。API キー不要）を引き、無ければ TuneCore Japan の LinkCore を引く。
 */

export type LyricsResult = z.infer<typeof LyricsResultSchema>;
type Candidate = LyricsResult['candidates'][number];

export interface LyricsOptions { title: string; artist?: string; noCache?: boolean }
export interface LyricsDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  linkcore?: LinkcoreDeps;
}

export const LYRICS_NOTICE = '歌詞は著作物です。個人利用の範囲で使い、再配布・公開はしないでください。取得元は利用者や権利者が登録したデータで、内容の正確さは保証されません。';

const LRCLIB_SEARCH = 'https://lrclib.net/api/search';
const LRCLIB_RETRY_STATUS = new Set([429, 502, 503, 504]);
const LRCLIB_TIMEOUT_MS = 8000;
const RETRY_AFTER_CAP_S = 5;
const MAX_CANDIDATES = 10;
const MAX_LRCLIB_CANDIDATES = 5;

/** LRCLIB の応答のうち使う項目だけ。`lyricsfile`・`syncedLyrics` などは受け取っても返さない。 */
export interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  instrumental?: boolean;
  plainLyrics?: string | null;
}

const hasText = (r: LrclibRecord) => !r.instrumental && !!r.trackName && (r.plainLyrics ?? '').trim() !== '';
const body = (r: LrclibRecord) => (r.plainLyrics ?? '').replace(/\r\n?/g, '\n').trim();
const candidateOf = (r: LrclibRecord): Candidate => ({ title: r.trackName, artist: r.artistName, ...(r.albumName ? { album: r.albumName } : {}) });
const pairKey = (r: LrclibRecord) => `${normalizeName(r.trackName)}\u0000${normalizeName(r.artistName)}`;

/**
 * LRCLIB の検索結果から 1 件を選ぶ。曲名の完全一致、前方一致の順。歌手の指定があれば包含一致で絞る。
 * 同じ曲の重複登録は本文ごとにまとめ、最も多く登録された本文を採る（同数なら長い方）。
 * ponytail: 多数決だけ。誤登録が多数派の曲では誤る。
 */
export function pickLrclibRecord(records: LrclibRecord[], title: string, artist?: string): { chosen?: LrclibRecord; candidates: Candidate[] } {
  const pool = records.filter(hasText);
  const want = normalizeName(title);
  const artistOk = (r: LrclibRecord) => !artist || matchesArtist(artist, r.artistName);
  const exact = pool.filter((r) => artistOk(r) && normalizeName(r.trackName) === want);
  const group = exact.length > 0 ? exact : pool.filter((r) => artistOk(r) && normalizeName(r.trackName).startsWith(want));

  let chosen: LrclibRecord | undefined;
  if (group.length > 0) {
    const bodies = new Map<string, LrclibRecord[]>();
    for (const r of group) {
      const k = body(r).replace(/\s+/g, '');
      bodies.set(k, [...(bodies.get(k) ?? []), r]);
    }
    chosen = [...bodies.values()].sort((a, b) => b.length - a.length || body(b[0]).length - body(a[0]).length)[0][0];
  }

  const seen = new Set(chosen ? [pairKey(chosen)] : []);
  const candidates: Candidate[] = [];
  for (const r of pool) {
    if (candidates.length >= MAX_LRCLIB_CANDIDATES) break;
    if (seen.has(pairKey(r))) continue;
    seen.add(pairKey(r));
    candidates.push(candidateOf(r));
  }
  return { chosen, candidates };
}

const retryWaitMs = (res: Response): number => {
  const seconds = Number(res.headers.get('retry-after'));
  const base = Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
  return Math.min(base, RETRY_AFTER_CAP_S) * 1000 * (1 + Math.random() * 0.3); // 公式の求めどおり Retry-After を守り、揺らぎを足す
};

async function lrclibSearch(params: Record<string, string>, fetchFn: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<LrclibRecord[]> {
  const url = `${LRCLIB_SEARCH}?${new URLSearchParams(params)}`;
  const headers = { 'User-Agent': `Sora/${SORA_VERSION} (+https://github.com/ikenokazuki/Sora)` }; // LRCLIB は名前・版・URL の明示を求める
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(LRCLIB_TIMEOUT_MS) });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data as LrclibRecord[] : [];
    }
    if (attempt === 0 && LRCLIB_RETRY_STATUS.has(res.status)) {
      await sleep(retryWaitMs(res));
      continue;
    }
    throw new Error(`LRCLIB HTTP ${res.status}`);
  }
}

async function searchLrclib(title: string, artist: string | undefined, fetchFn: typeof fetch, sleep: (ms: number) => Promise<void>) {
  let records = await lrclibSearch(artist ? { track_name: title, artist_name: artist } : { q: title }, fetchFn, sleep);
  // `q` は構造化パラメータより優先される仕様なので、最初は使わず、0 件のときだけ試す
  if (records.length === 0 && artist) records = await lrclibSearch({ q: `${artist} ${title}` }, fetchFn, sleep);
  return pickLrclibRecord(records, title, artist);
}

async function lookup(title: string, artist: string | undefined, deps: LyricsDeps): Promise<LyricsResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let candidates: Candidate[] = [];
  let lrclibDown = false;

  try {
    const picked = await searchLrclib(title, artist, fetchFn, sleep);
    if (picked.chosen) {
      const r = picked.chosen;
      return {
        found: true,
        track: candidateOf(r),
        lyrics: body(r),
        source: 'lrclib',
        sourceUrl: `https://lrclib.net/api/get/${r.id}`,
        candidates: picked.candidates,
        notice: LYRICS_NOTICE,
      };
    }
    candidates = picked.candidates;
  } catch {
    lrclibDown = true; // 2 回失敗しても TuneCore を試す
  }

  if (artist) {
    const out = await findLinkcoreLyrics(artist, title, deps.linkcore);
    if (out.status === 'found' && out.track && out.lyrics) {
      return { found: true, track: out.track, lyrics: out.lyrics, source: 'tunecore', sourceUrl: out.sourceUrl, candidates: [], notice: LYRICS_NOTICE };
    }
    if (out.status === 'no-lyrics-registered') {
      return { found: false, reason: 'no-lyrics-registered', track: out.track, candidates, notice: LYRICS_NOTICE };
    }
    candidates = [...candidates, ...out.candidates.map((t) => ({ title: t, artist }))].slice(0, MAX_CANDIDATES);
    const reason = out.status === 'search-unavailable' || lrclibDown ? 'search-unavailable' : 'no-match';
    return { found: false, reason, candidates, notice: LYRICS_NOTICE };
  }
  return { found: false, reason: lrclibDown ? 'search-unavailable' : 'no-match', candidates, notice: LYRICS_NOTICE };
}

export async function getLyrics(options: LyricsOptions, deps: LyricsDeps = {}): Promise<LyricsResult> {
  const title = options.title.trim();
  const artist = options.artist?.trim() || undefined;
  if (!title) throw new Error('title is required for lyrics');

  const key = `lyrics:${cacheKeyDigest<LyricsOptions, 'noCache'>({ title: normalizeName(title), artist: artist ? normalizeName(artist) : null })}`;
  if (!options.noCache) {
    const cached = getFromCache<LyricsResult>(key);
    if (cached) return cached;
  }
  const result = await runWithSingleFlight(key, () => lookup(title, artist, deps));
  // 取得元が使えなかった結果は、次の呼び出しで取り直せるようにキャッシュしない
  if (!options.noCache && result.reason !== 'search-unavailable') setToCache(key, result);
  return result;
}
