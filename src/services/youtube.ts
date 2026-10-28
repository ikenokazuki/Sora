import { XMLParser } from 'fast-xml-parser';
import type { z } from 'zod';
import { CACHE_TTL_DEFAULT, CACHE_TTL_EMPTY, cacheKeyDigest, getFromCache, runWithSingleFlight, setToCache } from '../cache.js';
import { cleanMarkdownTokens } from '../enrichment.js';
import { errorMessage } from '../errors.js';
import { parseTimestampChapters, parseYouTubeChannelRef, parseYouTubeUrl } from '../html_parser.js';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import { readBodyWithLimit } from '../net/safe_transport.js';
import { extractTermsWithBigrams, scorePassage } from '../extractor/hierarchical_bm25.js';
import { DEFAULT_MAX_CHARS, type MediaInfo, type YoutubeChannelResultSchema, type YoutubeExcerptSchema, type YoutubeTranscriptResultSchema } from '../types.js';

/**
 * YouTube の動画の題名・説明文・チャプターと、時刻つきの字幕（モジュール 'youtube'）。
 * 字幕は Android アプリと同じ innertube の player から一覧を取り、timedtext を json3 で読む。
 * 動画ページに埋め込まれた字幕の URL は PO トークン必須で空になるため、player が使えないときの代用にだけ使う。
 * 要約は呼び出し側の AI が書く。字幕が無い動画は「字幕なし」と理由を返し、音声認識はしない。
 */

export type YoutubeTranscriptResult = z.infer<typeof YoutubeTranscriptResultSchema>;
export type YoutubeExcerpt = z.infer<typeof YoutubeExcerptSchema>;
type Transcript = NonNullable<YoutubeTranscriptResult['transcript']>;
type TrackInfo = NonNullable<YoutubeTranscriptResult['availableTracks']>[number];

// 範囲の終わり（toSec）は持たない。省略できる引数に最小値を入れてくる呼び出し側があり、toSec: 1 で最初の段落しか返らなかった
export interface YoutubeTranscriptOptions { url: string; lang?: string; fromSec?: number; maxChars?: number; noCache?: boolean }
export interface YoutubeDeps {
  /** player の POST と timedtext の取得 */
  fetchFn?: typeof fetch;
  /** 動画ページの HTML の取得 */
  fetchWatchPage?: (url: string) => Promise<string>;
  /** チャンネルのページの HTML の取得（ハンドルから ID を読む）。ページが無ければ（404）undefined */
  fetchChannelPage?: (url: string) => Promise<string | undefined>;
  now?: () => number;
}

/** URL でも動画 ID でもない入力。REST は 400 にする。 */
export class YoutubeInputError extends Error {}

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
// ponytail: クライアントの版は固定。YouTube に拒否されたら youtube-transcript-api / yt-dlp に合わせて上げる
const ANDROID_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34 };
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';
const PLAYER_TIMEOUT_MS = 8000;
const WATCH_TIMEOUT_MS = 10_000;
const CAPTION_TIMEOUT_MS = 10_000;
const PLAYER_MAX_BYTES = 5 * 1024 * 1024;
const WATCH_MAX_BYTES = 5 * 1024 * 1024;
const CAPTION_MAX_BYTES = 25 * 1024 * 1024; // 5 時間の配信の自動字幕で約 5MB
const PARAGRAPH_MS = 30_000;
const PARAGRAPH_CHARS = 300;
const RECENT_MS = 48 * 60 * 60 * 1000;
const KANA = /[぀-ヿ]/;

const NOTE_AUTO = 'YouTube の音声認識による自動字幕です。聞き間違いを含み、固有名詞や句読点が正しくないことがあります。引用するときは自動字幕であることを伝えてください。';
const NOTE_MUSIC = '音楽の動画なので、歌声の聞き取りで精度が低い可能性があります。';
const DO_NOT_GUESS = '話している内容は推測で補わないでください。';
const NO_CAPTIONS = 'この動画には字幕（自動字幕を含む）がありません。話している内容は分からないので、題名と説明文から分かることだけを答え、推測で補わないでください。';
const RECENT_HINT = '投稿から間もないため、しばらくすると自動字幕が付くことがあります。';
const LIVE_NOW = `配信中のため字幕がありません。配信が終わると自動字幕が付くことがあります。${DO_NOT_GUESS}`;
const BLOCKED = `YouTube が字幕の取得を拒否しました（bot の確認、または空の応答）。時間をおいて再試行してください。${DO_NOT_GUESS}`;
const REQUEST_FAILED = `YouTube から字幕を取得できませんでした（通信の失敗）。時間をおいて再試行してください。${DO_NOT_GUESS}`;
const mismatch = (code: string) => `自動字幕は ${code} のもので、題名の言語と合わないため返していません。lang: '${code}' を指定すると取得できます。`;

interface CaptionTrack { baseUrl?: string; languageCode?: string; kind?: string; name?: { runs?: Array<{ text?: string }>; simpleText?: string } }
interface Playability { status?: string; reason?: string }
interface PlayerResponse {
  playabilityStatus?: Playability;
  videoDetails?: { videoId?: string; title?: string; author?: string; lengthSeconds?: string; shortDescription?: string; isLive?: boolean };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[]; audioTracks?: Array<{ audioTrackId?: string }>; defaultAudioTrackIndex?: number } };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string; category?: string; liveBroadcastDetails?: { isLiveNow?: boolean } } };
}
export interface Json3 { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> }
export interface Paragraph { startSec: number; text: string }

/** キャッシュする形。本文は段落の配列で持ち、範囲と長さの切り出しは呼び出しごとに行う。 */
type VideoRecord = Omit<YoutubeTranscriptResult, 'transcript' | 'requestedStartSec'> & {
  transcript?: Pick<Transcript, 'status' | 'reason' | 'message' | 'source' | 'language' | 'note'> & { paragraphs?: Paragraph[] };
};

const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
const isBotCheck = (p?: Playability) => p?.status === 'LOGIN_REQUIRED' && /bot/i.test(p.reason ?? '');
const baseLang = (code: string) => code.toLowerCase().split('-')[0];
const isAuto = (t: CaptionTrack) => t.kind === 'asr';
const clean = (text?: string) => (text === undefined ? undefined : cleanMarkdownTokens(text));

/** 字幕の取得先は www.youtube.com の /api/timedtext だけ（応答に入っていた URL でも、それ以外には出さない）。 */
function captionUrl(t: CaptionTrack): URL | undefined {
  try {
    const url = new URL(t.baseUrl ?? '');
    return url.protocol === 'https:' && url.hostname === 'www.youtube.com' && url.pathname === '/api/timedtext' ? url : undefined;
  } catch {
    return undefined;
  }
}

async function fetchPlayer(videoId: string, fetchFn: typeof fetch): Promise<PlayerResponse> {
  const res = await fetchFn(PLAYER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ANDROID_UA },
    body: JSON.stringify({ context: { client: { ...ANDROID_CLIENT, hl: 'ja', gl: 'JP' } }, videoId }),
    redirect: 'error',
    signal: AbortSignal.timeout(PLAYER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`player HTTP ${res.status}`);
  return JSON.parse(new TextDecoder().decode(await readBodyWithLimit(res, PLAYER_MAX_BYTES))) as PlayerResponse;
}

async function defaultFetchWatchPage(url: string): Promise<string> {
  const { response } = await fetchWithSafeRedirects(url, WATCH_TIMEOUT_MS, 3);
  if (!response.ok) throw new Error(`watch page HTTP ${response.status}`);
  return new TextDecoder().decode(await readBodyWithLimit(response, WATCH_MAX_BYTES));
}

/** 動画ページの `var ytInitialPlayerResponse = {...};` を取り出す。文字列の中の括弧は数えない。 */
function extractInitialPlayerResponse(html: string): PlayerResponse | undefined {
  const at = html.indexOf('ytInitialPlayerResponse = {');
  if (at < 0) return undefined;
  const start = html.indexOf('{', at);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1)) as PlayerResponse;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * 字幕を試す順に並べる。言語の候補（指定の言語、元の音声の言語、英語）ごとに、言語コードが完全に一致する手動、
 * 基本の言語（zh-Hant なら zh）が同じ手動、同じ順の自動字幕。最後に残りの手動、残りの自動。
 */
function rankTracks(tracks: CaptionTrack[], langs: string[]): CaptionTrack[] {
  const ranked = new Set<CaptionTrack>();
  for (const lang of langs) {
    const exact = (t: CaptionTrack) => (t.languageCode ?? '').toLowerCase() === lang.toLowerCase();
    const base = (t: CaptionTrack) => baseLang(t.languageCode ?? '') === baseLang(lang);
    for (const auto of [false, true]) {
      for (const match of [exact, base]) {
        const hit = tracks.find((t) => isAuto(t) === auto && match(t));
        if (hit) ranked.add(hit);
      }
    }
  }
  for (const t of tracks) if (!isAuto(t)) ranked.add(t);
  for (const t of tracks) ranked.add(t);
  return [...ranked];
}

/** 元の音声の言語。既定の音声トラックの ID（`ja.4`）から読み、無ければ自動字幕の言語（AI 吹き替えの音声が無い動画では、自動字幕は元の音声のもの）。 */
function originalLanguage(renderer: NonNullable<PlayerResponse['captions']>['playerCaptionsTracklistRenderer'], tracks: CaptionTrack[]): string | undefined {
  const audioTrackId = renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0]?.audioTrackId;
  return audioTrackId?.split('.')[0] || tracks.find(isAuto)?.languageCode;
}

/**
 * json3 を約 30 秒か 300 字ごとの段落にする。改行だけの event（自動字幕の aAppend）と表示窓の定義は飛ばす。
 * 同じ秒のうちは文字数が超えても段落を分けない（同じ開始秒の段落ができると、続きを読むときに長さ 0 の段落として落ちる）。
 * TikTok の字幕（WebVTT）も、この形にして同じように段落にする（services/tiktok.ts）。
 */
export function json3ToParagraphs(json: Json3): Paragraph[] {
  const paragraphs: Array<{ startMs: number; parts: string[]; len: number }> = [];
  for (const ev of json.events ?? []) {
    const text = (ev.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const startMs = ev.tStartMs ?? 0;
    const cur = paragraphs.at(-1);
    const sameSecond = cur !== undefined && Math.floor(startMs / 1000) === Math.floor(cur.startMs / 1000);
    if (cur && startMs - cur.startMs < PARAGRAPH_MS && (cur.len < PARAGRAPH_CHARS || sameSecond)) {
      cur.parts.push(text);
      cur.len += text.length + 1;
    } else {
      paragraphs.push({ startMs, parts: [text], len: text.length + 1 });
    }
  }
  return paragraphs.map((p) => ({ startSec: Math.floor(p.startMs / 1000), text: cleanMarkdownTokens(p.parts.join(' ')) }));
}

type CaptionOutcome = { paragraphs: Paragraph[] } | { failed: 'blocked' | 'request-failed' };

async function fetchCaptions(url: URL, fetchFn: typeof fetch): Promise<CaptionOutcome> {
  url.searchParams.set('fmt', 'json3');
  let body: string;
  try {
    const res = await fetchFn(url.toString(), { headers: { 'User-Agent': ANDROID_UA }, redirect: 'error', signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS) });
    if (res.status === 403 || res.status === 429) return { failed: 'blocked' };
    if (!res.ok) return { failed: 'request-failed' };
    body = new TextDecoder().decode(await readBodyWithLimit(res, CAPTION_MAX_BYTES));
  } catch {
    return { failed: 'request-failed' };
  }
  try {
    return { paragraphs: json3ToParagraphs(JSON.parse(body) as Json3) };
  } catch {
    return { failed: 'blocked' }; // PO トークンの要る URL は 200 で空の本文を返す
  }
}

async function lookup(videoId: string, lang: string, deps: YoutubeDeps): Promise<{ record: VideoRecord; ttlMs: number }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const [playerOut, pageOut] = await Promise.allSettled([fetchPlayer(videoId, fetchFn), (deps.fetchWatchPage ?? defaultFetchWatchPage)(watchUrl(videoId))]);
  const fromPlayer = playerOut.status === 'fulfilled' ? playerOut.value : undefined;
  const page = pageOut.status === 'fulfilled' ? extractInitialPlayerResponse(pageOut.value) : undefined;
  const url = watchUrl(videoId);

  // player が再生できると答えた、この動画の応答だけを使う。player は古いクライアントへの拒否や、別の動画の応答を返すことがあるので、
  // そのときは動画ページに埋め込まれた応答で代用する（字幕の URL は PO トークン付きで空になり、unavailable になる）
  const usable = (p?: PlayerResponse): p is PlayerResponse =>
    p?.playabilityStatus?.status === 'OK' && !!p.videoDetails && (!p.videoDetails.videoId || p.videoDetails.videoId === videoId);
  const source = usable(fromPlayer) ? fromPlayer : usable(page) ? page : undefined;
  if (!source) {
    // 再生できない理由は、動画ページ（web）の答えを先に見る
    const refusal = [page, fromPlayer].find((p) => p?.playabilityStatus?.status && p.playabilityStatus.status !== 'OK' && !isBotCheck(p.playabilityStatus));
    if (refusal) {
      const p = refusal.playabilityStatus;
      return { record: { found: false, videoId, url, reason: 'video-unavailable', message: p?.reason || p?.status || '再生できない動画です' }, ttlMs: CACHE_TTL_EMPTY };
    }
    const bot = [fromPlayer, page].find((p) => isBotCheck(p?.playabilityStatus));
    if (bot) throw new Error(`YouTube login required (bot check): ${bot.playabilityStatus?.reason}`);
    const cause = playerOut.status === 'rejected' ? errorMessage(playerOut.reason) : pageOut.status === 'rejected' ? errorMessage(pageOut.reason) : 'no usable player response';
    throw new Error(`YouTube request failed: ${cause}`);
  }

  const details = source.videoDetails ?? {};
  const micro = page?.microformat?.playerMicroformatRenderer;
  const title = clean(details.title);
  const durationSec = Number(details.lengthSeconds) || undefined;
  const isLiveNow = micro?.liveBroadcastDetails?.isLiveNow ?? details.isLive;
  const description = cleanMarkdownTokens(details.shortDescription ?? '');
  // YouTube と同じく、0:00 から始まるときだけチャプターとみなす（ライブ告知の「17:00 開場」を拾わない）
  const timestamps = parseTimestampChapters(description);
  const chapters = timestamps[0]?.seconds === 0 ? timestamps.filter((c) => !durationSec || c.seconds < durationSec) : [];
  const renderer = source.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks ?? [];
  const availableTracks: TrackInfo[] = tracks.map((t) => ({
    language: t.languageCode ?? '',
    source: isAuto(t) ? 'auto' : 'manual',
    name: cleanMarkdownTokens(t.name?.runs?.map((r) => r.text ?? '').join('') || t.name?.simpleText || t.languageCode || ''),
  }));

  // 日本語の動画に、別の言語の音声認識の結果だけが付いていることがある（中身は意味をなさない）
  const mismatched = (t: CaptionTrack) => isAuto(t) && baseLang(lang) === 'ja' && baseLang(t.languageCode ?? '') !== 'ja' && KANA.test(title ?? '');
  const ranked = rankTracks(tracks.filter((t) => captionUrl(t)), [lang, originalLanguage(renderer, tracks), 'en'].filter((l): l is string => !!l));
  const candidates = ranked.filter((t) => !mismatched(t));

  let transcript: NonNullable<VideoRecord['transcript']> | undefined;
  if (tracks.length === 0) {
    const published = Date.parse(micro?.publishDate ?? '');
    transcript = isLiveNow
      ? { status: 'none', reason: 'live-now', message: LIVE_NOW }
      : { status: 'none', reason: 'no-captions', message: now() - published < RECENT_MS ? `${NO_CAPTIONS}${RECENT_HINT}` : NO_CAPTIONS };
  } else if (ranked.length === 0) {
    transcript = { status: 'unavailable', reason: 'blocked', message: BLOCKED }; // 字幕はあるのに、取得先の URL が想定と違う
  } else if (candidates.length === 0) {
    transcript = { status: 'none', reason: 'language-mismatch', message: mismatch(ranked[0].languageCode ?? '') };
  } else {
    // 選んだ字幕が空なら、次の候補を試す。取得に失敗したら、そこで止める
    for (const t of candidates) {
      const out = await fetchCaptions(captionUrl(t) as URL, fetchFn);
      if ('failed' in out) {
        transcript = { status: 'unavailable', reason: out.failed, message: out.failed === 'blocked' ? BLOCKED : REQUEST_FAILED };
        break;
      }
      if (out.paragraphs.length > 0) {
        const note = isAuto(t) ? (micro?.category === 'Music' ? `${NOTE_AUTO}${NOTE_MUSIC}` : NOTE_AUTO) : undefined;
        transcript = { status: 'ok', source: isAuto(t) ? 'auto' : 'manual', language: t.languageCode ?? '', ...(note ? { note } : {}), paragraphs: out.paragraphs };
        break;
      }
    }
    transcript ??= { status: 'none', reason: 'no-captions', message: NO_CAPTIONS };
  }

  const record: VideoRecord = {
    found: true,
    videoId,
    url,
    title,
    channel: clean(details.author),
    publishedAt: micro?.publishDate,
    durationSec,
    isLiveNow,
    category: micro?.category,
    description,
    ...(chapters.length > 0 ? { chapters } : {}),
    transcript,
    availableTracks,
  };
  // 字幕を取れなかった結果は、次の呼び出しで取り直せるようにキャッシュしない。
  // 字幕なしと、動画ページを読めず公開日などが欠けた結果は、短くだけ残す
  const ttlMs = transcript.status === 'unavailable' ? 0 : transcript.status === 'ok' && page ? CACHE_TTL_DEFAULT : CACHE_TTL_EMPTY;
  return { record, ttlMs };
}

const clock = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/**
 * fromSec を含む段落から、maxChars に収まる分だけ返す。
 * 最初の段落は maxChars を超えても丸ごと返す（切ると、nextFromSec で続きを読んだときにその残りが飛ぶ）。
 */
function sliceParagraphs(paragraphs: Paragraph[], fromSec: number, maxChars: number, durationSec?: number): Partial<Transcript> {
  const lines = paragraphs.map((p) => `[${clock(p.startSec)}] ${p.text}`);
  const totalChars = lines.join('\n').length;
  const endOf = (i: number) => paragraphs[i + 1]?.startSec ?? Math.max(durationSec ?? 0, paragraphs[i].startSec + 1);
  const picked = paragraphs.flatMap((_, i) => (endOf(i) > fromSec ? [i] : []));
  if (picked.length === 0) return { fromSec, text: '', chars: 0, totalChars, truncated: false, message: `fromSec（${fromSec} 秒）より後に字幕はありません。` };

  let text = '';
  let end = picked[0]; // 返さなかった最初の段落
  for (const i of picked) {
    const next = text ? `${text}\n${lines[i]}` : lines[i];
    if (text && next.length > maxChars) break;
    text = next;
    end = i + 1;
  }
  const last = picked[picked.length - 1];
  return {
    fromSec: paragraphs[picked[0]].startSec,
    toSec: endOf(end - 1),
    text,
    chars: text.length,
    totalChars,
    truncated: end <= last,
    ...(end <= last ? { nextFromSec: paragraphs[end].startSec } : {}),
  };
}

/** 動画の記録を、キャッシュか YouTube から読む。範囲や長さの切り出しはしない（字幕の全文と検索結果の抜粋で共有する）。 */
async function loadRecord(options: Pick<YoutubeTranscriptOptions, 'url' | 'lang' | 'noCache'>, deps: YoutubeDeps): Promise<{ record: VideoRecord; startSec?: number }> {
  const parsed = parseYouTubeUrl(options.url);
  if (!parsed) throw new YoutubeInputError('url must be a YouTube video URL or an 11-character video ID');
  const lang = options.lang?.trim().toLowerCase() || 'ja';

  const key = `youtube:${cacheKeyDigest<YoutubeTranscriptOptions, 'fromSec' | 'maxChars' | 'noCache'>({ url: parsed.videoId, lang })}`;
  let record: VideoRecord | null = options.noCache ? null : getFromCache<VideoRecord>(key);
  if (!record) {
    const looked = await runWithSingleFlight(key, () => lookup(parsed.videoId, lang, deps));
    if (!options.noCache && looked.ttlMs > 0) setToCache(key, looked.record, looked.ttlMs);
    record = looked.record;
  }
  return { record, startSec: parsed.startSec };
}

export async function getYoutubeTranscript(options: YoutubeTranscriptOptions, deps: YoutubeDeps = {}): Promise<YoutubeTranscriptResult> {
  const { record, startSec } = await loadRecord(options, deps);
  const { transcript, ...rest } = record;
  const result: YoutubeTranscriptResult = { ...rest, ...(startSec ? { requestedStartSec: startSec } : {}) };
  if (transcript) {
    const { paragraphs, ...meta } = transcript;
    result.transcript = paragraphs
      ? { ...meta, ...sliceParagraphs(paragraphs, options.fromSec ?? 0, options.maxChars ?? DEFAULT_MAX_CHARS, record.durationSec) }
      : meta;
  }
  return result;
}

/**
 * 検索語を含む段落を、点数の高い順に maxChars まで選び、時刻順に並べる（BM25。日本語は語と 2 語のつながりで数える）。
 * どの段落にも検索語が無ければ、先頭から返す。最初に選ぶ段落は maxChars を超えても丸ごと返す。
 */
type Chapters = NonNullable<YoutubeTranscriptResult['chapters']>;

/** 段落が入るチャプターの番号（開始秒が段落以下の最後のチャプター）。チャプターが無ければ -1。 */
const chapterIndexOf = (chapters: Chapters, startSec: number) => {
  let found = -1;
  chapters.forEach((c, i) => { if (c.seconds <= startSec) found = i; });
  return found;
};

/**
 * 検索語を含む段落を、点数の高い順に budget まで選び、時刻順の番号で返す。点数は見出しの階層ボーナス付き BM25
 * （`scorePassage`。段落が入るチャプターの名前を見出しとして加点する。日本語は語と 2 語のつながりで数える）。
 * どの段落にも点が付かなければ、先頭から選ぶ。最初に選ぶ段落は budget を超えても選ぶ。
 */
function rankParagraphs(paragraphs: Paragraph[], query: string, budget: number, cost: (i: number) => number, separator: number, chapters: Chapters = []): { indices: number[]; relevant: boolean } {
  const blocks = paragraphs.map((p) => {
    const chapter = chapters[chapterIndexOf(chapters, p.startSec)]?.title;
    return { headingPath: chapter ? [chapter] : [], nearestHeading: chapter ?? '', depth: chapter ? 1 : 0, body: p.text };
  });
  const terms = extractTermsWithBigrams(query);
  const scores = blocks.map((b) => scorePassage(b, terms, blocks));
  const relevant = scores.some((score) => score > 0);
  const order = relevant
    ? scores.map((score, i) => ({ score, i })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.i)
    : paragraphs.map((_, i) => i);
  const chosen: number[] = [];
  let used = 0;
  for (const i of order) {
    const add = cost(i) + (chosen.length > 0 ? separator : 0);
    if (chosen.length > 0 && used + add > budget) {
      if (relevant) continue; // 点数順では、長い段落を飛ばして短い次点を入れる
      break;
    }
    chosen.push(i);
    used += add;
  }
  return { indices: chosen.sort((a, b) => a - b), relevant };
}

function selectRelevantParagraphs(paragraphs: Paragraph[], query: string, maxChars: number, chapters?: Chapters): Pick<YoutubeExcerpt, 'excerpt' | 'text' | 'chars' | 'totalChars'> {
  const lines = paragraphs.map((p) => `[${clock(p.startSec)}] ${p.text}`);
  const { indices, relevant } = rankParagraphs(paragraphs, query, maxChars, (i) => lines[i].length, 1, chapters);
  const text = indices.map((i) => lines[i]).join('\n');
  return { excerpt: relevant ? 'relevant' : 'head', text, chars: text.length, totalChars: lines.join('\n').length };
}

export interface YoutubeExcerptOptions { url: string; query: string; maxChars?: number; lang?: string; noCache?: boolean }
export type YoutubeExcerptResult = Omit<YoutubeTranscriptResult, 'transcript' | 'description' | 'chapters' | 'requestedStartSec' | 'availableTracks'> & { transcript: YoutubeExcerpt };

/** 動画の字幕のうち、検索語に関係する部分だけを返す（search_video の transcripts、search_deep の videos）。全文は getYoutubeTranscript。 */
export async function getYoutubeExcerpt(options: YoutubeExcerptOptions, deps: YoutubeDeps = {}): Promise<YoutubeExcerptResult> {
  const { record } = await loadRecord(options, deps);
  const { transcript, description: _description, chapters: _chapters, availableTracks: _tracks, ...meta } = record;
  if (!record.found || !transcript) {
    return { ...meta, transcript: { status: 'unavailable', reason: 'video-unavailable', message: record.message ?? '再生できない動画です' } };
  }
  const { paragraphs, ...status } = transcript;
  if (!paragraphs) return { ...meta, transcript: status };
  return { ...meta, transcript: { ...status, ...selectRelevantParagraphs(paragraphs, options.query, options.maxChars ?? 2000, record.chapters) } };
}

/**
 * 動画検索の結果のうち、先頭から count 本の YouTube 動画に、検索語に関係する字幕の部分を付ける。YouTube 以外の結果はそのまま。
 * 1 本が失敗しても、ほかの動画と検索結果は返す。
 */
export async function attachVideoTranscripts<T extends { items?: Array<{ url?: string }> }>(
  result: T,
  query: string,
  options: { count: number; maxChars: number },
  deps: { excerpt?: typeof getYoutubeExcerpt } = {},
): Promise<T> {
  const items = Array.isArray(result.items) ? result.items : [];
  const targets = items.filter((item) => item.url && parseYouTubeUrl(item.url)).slice(0, Math.max(0, options.count));
  if (targets.length === 0) return result;
  const excerpt = deps.excerpt ?? getYoutubeExcerpt;
  const attached = new Map(await Promise.all(targets.map(async (item) => {
    try {
      return [item, (await excerpt({ url: item.url as string, query, maxChars: options.maxChars })).transcript] as const;
    } catch (err) {
      const message = errorMessage(err) || String(err);
      return [item, { status: 'unavailable', reason: /bot check|login required/i.test(message) ? 'blocked' : 'request-failed', message } as YoutubeExcerpt] as const;
    }
  })));
  return { ...result, items: items.map((item) => (attached.has(item) ? { ...item, transcript: attached.get(item) } : item)) };
}

/** 字幕の見出しの時刻。YouTube の t= と同じ書き方（`1m23s`・`1h02m03s`）。 */
export const tLabel = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m${s}s` : `${m}m${s}s`;
};

export interface YoutubePage {
  title: string;
  content: string;
  description?: string;
  publishedTime?: string;
  author?: string;
  contentStatus: 'body' | 'metadata_only' | 'unavailable';
  media?: MediaInfo;
}

/**
 * scrape 用に、動画を Markdown の本文にする（動画のページは、おすすめ動画の一覧しか読めない）。
 * 字幕の段落は `### 1m23s` の見出しで分け、ハイライトの選び方（extractQueryHighlightDetails）がそれぞれを候補にできるようにする。
 * `[1:23]` のような時刻の書き方は、「何時」の答えを探す採点（answerability）に時刻と誤認されるので使わない。
 * YouTube に拒否されても投げずに unavailable のページを返す（scrape の再試行で問い合わせを重ねない）。
 */
export async function getYoutubePage(url: string, options: { noCache?: boolean; query?: string; maxChars?: number } = {}, deps: YoutubeDeps = {}): Promise<YoutubePage> {
  let record: VideoRecord;
  try {
    ({ record } = await loadRecord({ url, noCache: options.noCache }, deps));
  } catch (err) {
    return { title: 'YouTube', content: `# YouTube の動画\n\n${url}\n\nYouTube から動画の情報を取得できませんでした（${errorMessage(err) || err}）。時間をおいて再試行してください。`, contentStatus: 'unavailable' };
  }
  if (!record.found) {
    return { title: 'YouTube', content: `# YouTube の動画\n\n${record.url}\n\n${record.message ?? '再生できない動画です'}`, contentStatus: 'unavailable' };
  }

  const t = record.transcript;
  const title = record.title || 'YouTube の動画';
  const meta = [
    record.channel ? `- チャンネル: ${record.channel}` : '',
    record.publishedAt ? `- 公開日: ${record.publishedAt}` : '',
    record.durationSec ? `- 長さ: ${record.durationSec} 秒` : '',
    `- URL: ${record.url}`,
  ].filter(Boolean).join('\n');
  // チャプターは字幕の見出しにするので、説明文からはチャプターの行を外す（目次の行が検索語に一致し、字幕より先に根拠として選ばれていた）
  const chapters = record.chapters ?? [];
  const description = chapters.length > 0
    ? (record.description ?? '').split('\n').filter((line) => parseTimestampChapters(line).length === 0).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : record.description ?? '';
  const head = [`# ${title}`, meta, description ? `## 説明文\n\n${description}` : ''].filter(Boolean).join('\n\n');
  let transcript: string;
  if (t?.status === 'ok' && t.paragraphs) {
    const paragraphs = t.paragraphs;
    const heading = `## 字幕（${t.source === 'auto' ? 'YouTube の自動字幕。聞き間違いを含む' : '手動の字幕'}）`;
    // チャプターがあれば `### 2h02m02s〜 題名` の下に `#### 2h02m15s` の段落を並べる（段落の選び方が、チャプター名も見出しとして評価する）
    const level = chapters.length > 0 ? '####' : '###';
    const block = (p: Paragraph) => `${level} ${tLabel(p.startSec)}\n\n${p.text}`;
    const render = (indices: number[]) => {
      let current = -2;
      return indices.flatMap((i) => {
        const c = chapterIndexOf(chapters, paragraphs[i].startSec);
        const out = c !== current && c >= 0 ? [`### ${tLabel(chapters[c].seconds)}〜 ${chapters[c].title}`] : [];
        current = c;
        return [...out, block(paragraphs[i])];
      }).join('\n\n');
    };
    const all = render(paragraphs.map((_, i) => i));
    const maxChars = options.maxChars ?? Infinity;
    if (head.length + heading.length + all.length + 4 <= maxChars) {
      transcript = `${heading}\n\n${all}`;
    } else {
      // scrape は maxChars で切ってから段落を選ぶので、長い字幕は切る前に、検索語に関係する段落を選んで載せる（無ければ先頭から）
      const note = (relevant: boolean) => relevant
        ? `（字幕は全体で ${all.length} 字あり、長いので、検索語に関係する段落だけを時刻順に載せています。全体は get_youtube_transcript で読めます。）`
        : `（字幕は全体で ${all.length} 字あり、長いので先頭から載せています。続きは get_youtube_transcript の fromSec で読めます。）`;
      const chapterHeadings = chapters.reduce((n, c) => n + c.title.length + 16, 0); // 選んだ段落のチャプターの見出しの分を、多めに取っておく
      const budget = maxChars - head.length - heading.length - note(true).length - chapterHeadings - 8;
      const { indices, relevant } = rankParagraphs(paragraphs, options.query ?? '', budget, (i) => block(paragraphs[i]).length, 2, chapters);
      transcript = `${heading}\n\n${note(relevant)}\n\n${render(indices)}`;
    }
  } else {
    transcript = `## 字幕\n\n${t?.message ?? 'この動画には字幕（自動字幕を含む）がありません。'}`;
  }
  const content = [head, transcript].join('\n\n');
  return {
    title,
    content,
    description: record.description ? record.description.slice(0, 200) : undefined,
    publishedTime: record.publishedAt,
    author: record.channel,
    contentStatus: t?.status === 'ok' ? 'body' : t?.status === 'unavailable' ? 'unavailable' : 'metadata_only',
    media: {
      type: 'youtube',
      videoId: record.videoId,
      thumbnail: `https://img.youtube.com/vi/${record.videoId}/maxresdefault.jpg`,
      ...(record.durationSec ? { duration: `PT${record.durationSec}S` } : {}),
      ...(record.chapters ? { chapters: record.chapters } : {}),
    },
  };
}

// ---- チャンネルの最新動画（get_youtube_channel） ----
// 公開の Atom フィード（最新 15 件）を読む。ハンドルからのチャンネル ID は、チャンネルのページの HTML から読む。
// 字幕は付けない（動画を選んだあとに getYoutubeTranscript）。形式は公知の仕様からの想定で、実機では未確認（docs/superpowers/specs/2026-10-26-youtube-channel-design.md）。

export type YoutubeChannelResult = z.infer<typeof YoutubeChannelResultSchema>;
type ChannelVideo = NonNullable<YoutubeChannelResult['videos']>[number];
export interface YoutubeChannelOptions { url: string; limit?: number; noCache?: boolean }

const CHANNEL_FEED_TIMEOUT_MS = 8000;
const CHANNEL_FEED_MAX_BYTES = 2 * 1024 * 1024;
const CHANNEL_PAGE_MAX_BYTES = 3 * 1024 * 1024;
const CHANNEL_ID_TTL_MS = 24 * 60 * 60 * 1000; // ハンドルと ID の対応。ページが 1〜2MB あるので、フィードより長く覚える
const CHANNEL_DESCRIPTION_CHARS = 500;
const CHANNEL_DEFAULT_LIMIT = 10;
const CHANNEL_FEED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CHANNEL_NOT_FOUND = 'このチャンネルは見つかりませんでした（存在しない、または削除されています）。';

/** チャンネルのページの HTML からチャンネル ID を読む。RSS の alternate リンク → canonical → itemprop → 埋め込みデータの externalId の順。 */
export function extractChannelId(html: string): string | undefined {
  let canonical: string | undefined;
  let itemprop: string | undefined;
  for (const tag of html.match(/<(?:link|meta)\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1];
    if (/^<link/i.test(tag)) {
      const rss = attr('type')?.toLowerCase() === 'application/rss+xml' ? attr('href')?.match(/\bchannel_id=(UC[\w-]{22})(?![\w-])/)?.[1] : undefined;
      if (rss) return rss;
      if (attr('rel')?.toLowerCase() === 'canonical') canonical ??= attr('href')?.match(/\/channel\/(UC[\w-]{22})(?:[/?#]|$)/)?.[1];
    } else if (/^(?:identifier|channelid)$/i.test(attr('itemprop') ?? '')) {
      itemprop ??= attr('content')?.match(/^(UC[\w-]{22})$/)?.[1];
    }
  }
  return canonical ?? itemprop ?? html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
}

async function defaultFetchChannelPage(url: string): Promise<string | undefined> {
  const { finalUrl, response } = await fetchWithSafeRedirects(url, WATCH_TIMEOUT_MS, 3);
  const consent = /^https?:\/\/consent\.youtube\.com\//.test(finalUrl);
  if (response.status === 404 || consent || !response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 404) return undefined;
    throw new Error(consent ? 'consent page redirect' : `channel page HTTP ${response.status}`);
  }
  return new TextDecoder().decode(await readBodyWithLimit(response, CHANNEL_PAGE_MAX_BYTES));
}

async function fetchChannelFeed(channelId: string, fetchFn: typeof fetch): Promise<string | undefined> {
  const res = await fetchFn(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    headers: { 'User-Agent': CHANNEL_FEED_UA, Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
    redirect: 'error',
    signal: AbortSignal.timeout(CHANNEL_FEED_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) return undefined;
    throw new Error(`feed HTTP ${res.status}`);
  }
  return new TextDecoder().decode(await readBodyWithLimit(res, CHANNEL_FEED_MAX_BYTES));
}

// 属性（views）を読むので ignoreAttributes を切り、数字だけの題名や ID を数にしないよう parseTagValue も切る。entry が 1 件でも配列にする
const channelFeedParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, isArray: (name) => name === 'entry' });
type FeedNode = Record<string, unknown>;
const feedStr = (v: unknown) => (typeof v === 'string' ? v : undefined);
const feedNode = (v: unknown): FeedNode => (v && typeof v === 'object' ? (v as FeedNode) : {});

function parseChannelFeed(xml: string): { title?: string; videos: ChannelVideo[] } {
  const feed = (channelFeedParser.parse(xml) as { feed?: unknown }).feed;
  if (!feed || typeof feed !== 'object') throw new Error('unexpected feed (not Atom)');
  const entries = (feed as FeedNode).entry;
  const videos = (Array.isArray(entries) ? entries : []).flatMap((raw): ChannelVideo[] => {
    const entry = feedNode(raw);
    const videoId = feedStr(entry['yt:videoId']);
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) return [];
    const group = feedNode(entry['media:group']);
    const description = clean(feedStr(group['media:description']))?.trim().slice(0, CHANNEL_DESCRIPTION_CHARS);
    const rawViews = feedNode(feedNode(group['media:community'])['media:statistics'])['@_views'];
    const publishedAt = feedStr(entry.published);
    const updatedAt = feedStr(entry.updated);
    return [{
      videoId,
      url: watchUrl(videoId),
      title: clean(feedStr(entry.title)) ?? '',
      ...(publishedAt ? { publishedAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(description ? { description } : {}),
      ...(typeof rawViews === 'string' && /^\d+$/.test(rawViews) ? { views: Number(rawViews) } : {}),
    }];
  });
  const title = clean(feedStr((feed as FeedNode).title))?.trim();
  return { ...(title ? { title } : {}), videos };
}

/** ハンドル・旧式の名前のチャンネルのページから ID を読む（24 時間覚える）。ページが無ければ undefined。同意の画面・形の変化は例外。 */
async function resolveChannelId(pagePath: string, noCache: boolean, deps: YoutubeDeps): Promise<string | undefined> {
  const key = `youtube:channel-id:${pagePath.toLowerCase()}`;
  const known = noCache ? null : getFromCache<{ channelId: string }>(key);
  if (known) return known.channelId;
  const html = await (deps.fetchChannelPage ?? defaultFetchChannelPage)(`https://www.youtube.com${pagePath}`);
  if (html === undefined) return undefined;
  const channelId = extractChannelId(html);
  if (!channelId) throw new Error(/consent\.youtube\.com/.test(html) ? 'consent page (channel id not found)' : 'channel id not found in the channel page');
  if (!noCache) setToCache(key, { channelId }, CHANNEL_ID_TTL_MS);
  return channelId;
}

async function lookupChannel(ref: NonNullable<ReturnType<typeof parseYouTubeChannelRef>>, noCache: boolean, deps: YoutubeDeps): Promise<{ record: YoutubeChannelResult; ttlMs: number }> {
  const notFound = { record: { found: false, reason: 'channel-not-found', message: CHANNEL_NOT_FOUND } satisfies YoutubeChannelResult, ttlMs: CACHE_TTL_EMPTY };
  try {
    const channelId = 'channelId' in ref ? ref.channelId : await resolveChannelId(ref.pagePath, noCache, deps);
    if (!channelId) return notFound;
    const xml = await fetchChannelFeed(channelId, deps.fetchFn ?? fetch);
    if (xml === undefined) return notFound;
    const { title, videos } = parseChannelFeed(xml);
    const record: YoutubeChannelResult = { found: true, channelId, ...(title ? { title } : {}), url: `https://www.youtube.com/channel/${channelId}`, videos };
    return { record, ttlMs: videos.length > 0 ? CACHE_TTL_DEFAULT : CACHE_TTL_EMPTY };
  } catch (err) {
    throw new Error(`YouTube request failed: ${errorMessage(err) || err}`); // 同意の画面・ブロック・429/5xx・読めない応答。found: false にせず、キャッシュもしない
  }
}

/** チャンネルの最新の動画を新しい順に返す（最大 15 件）。チャンネルが無ければ found: false。 */
export async function getYoutubeChannel(options: YoutubeChannelOptions, deps: YoutubeDeps = {}): Promise<YoutubeChannelResult> {
  const ref = parseYouTubeChannelRef(options.url);
  if (!ref) throw new YoutubeInputError('url must be a YouTube channel URL, an @handle or a channel ID (UC…)');
  const key = `youtube:channel:${cacheKeyDigest<YoutubeChannelOptions, 'limit' | 'noCache'>({ url: 'channelId' in ref ? ref.channelId : ref.pagePath.toLowerCase() })}`;
  let record: YoutubeChannelResult | null = options.noCache ? null : getFromCache<YoutubeChannelResult>(key);
  if (!record) {
    const looked = await runWithSingleFlight(key, () => lookupChannel(ref, options.noCache === true, deps));
    if (!options.noCache && looked.ttlMs > 0) setToCache(key, looked.record, looked.ttlMs);
    record = looked.record;
  }
  return record.videos ? { ...record, videos: record.videos.slice(0, options.limit ?? CHANNEL_DEFAULT_LIMIT) } : record;
}
