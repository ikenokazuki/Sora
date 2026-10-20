import * as cheerio from 'cheerio';
import { getFromCache, setToCache, CACHE_TTL_DEFAULT } from '../cache.js';

const BASE = 'https://www.uta-net.com';
const UA = 'Mozilla/5.0 (compatible; Sora-Lyrics/1.0)';

export interface LyricsResult {
  query: string;
  title: string;
  artist: string;
  lyricist?: string;
  composer?: string;
  lyrics: string;
  url: string;
  source: 'uta-net';
  /** 他候補 (曲名・アーティスト・URL) */
  candidates: { title: string; artist: string; url: string }[];
}

async function getHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`lyrics source failed (HTTP ${res.status}): ${url}`);
  return res.text();
}

/** 検索結果 HTML → 候補 (Uta-Net: /song/{id}/ へのリンク行) */
export function parseLyricsCandidates(html: string): { title: string; artist: string; url: string }[] {
  const $ = cheerio.load(html);
  const out: { title: string; artist: string; url: string }[] = [];
  $('a[href^="/song/"]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    if (!/^\/song\/\d+\/?$/.test(href)) return;
    const row = $(a).closest('tr, li, div.border-bottom');
    const title = $(a).find('.songlist-title').text().trim() || $(a).text().trim();
    const artist = row.find('a[href^="/artist/"]').first().text().trim();
    if (title && !out.some((c) => c.url === BASE + href)) out.push({ title, artist, url: BASE + href });
  });
  return out;
}

/** 曲ページ HTML → 歌詞本文と作詞作曲 */
export function parseLyricsPage(html: string): Pick<LyricsResult, 'title' | 'artist' | 'lyricist' | 'composer' | 'lyrics'> {
  const $ = cheerio.load(html);
  const kashi = $('#kashi_area');
  kashi.find('br').replaceWith('\n');
  const lyrics = kashi.text().replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!lyrics) throw new Error('lyrics not found on page');
  const meta = (label: string) => {
    const el = $(`h4:contains("${label}")`).first();
    return el.next().text().trim() || undefined;
  };
  return {
    title: $('h2').first().text().trim() || $('title').text().split(/[／/]/)[0].trim(),
    artist: $('[itemprop="byArtist"]').first().text().trim() || $('a[href^="/artist/"]').first().text().trim(),
    lyricist: meta('作詞'),
    composer: meta('作曲'),
    lyrics,
  };
}

/** 曲名 (+ 任意でアーティスト) から歌詞全文を取得。権利処理は利用者の責任。 */
export async function getLyrics(options: { query: string; artist?: string; pick?: number; noCache?: boolean }): Promise<LyricsResult> {
  const query = options.query?.trim();
  if (!query) throw new Error('query is required for lyrics');
  const artist = options.artist?.trim();
  const pick = Math.max(options.pick ?? 0, 0);

  const cacheKey = `lyrics:${query}:${artist ?? ''}:${pick}`;
  if (!options.noCache) {
    const cached = getFromCache<LyricsResult>(cacheKey);
    if (cached) return cached;
  }

  const searchUrl = `${BASE}/search/?keyword=${encodeURIComponent(query)}&target=title&type=in`;
  let candidates = parseLyricsCandidates(await getHtml(searchUrl));
  if (artist) {
    const matched = candidates.filter((c) => c.artist.includes(artist));
    if (matched.length) candidates = matched;
  }
  const chosen = candidates[pick];
  if (!chosen) throw new Error(`no lyrics found for "${query}"${artist ? ` / ${artist}` : ''}`);

  const page = parseLyricsPage(await getHtml(chosen.url));
  const result: LyricsResult = {
    query,
    ...page,
    artist: page.artist || chosen.artist,
    url: chosen.url,
    source: 'uta-net',
    candidates: candidates.slice(0, 10),
  };
  if (!options.noCache) setToCache(cacheKey, result, CACHE_TTL_DEFAULT);
  return result;
}
