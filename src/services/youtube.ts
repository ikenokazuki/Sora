import type { z } from 'zod';
import { CACHE_TTL_DEFAULT, CACHE_TTL_EMPTY, cacheKeyDigest, getFromCache, runWithSingleFlight, setToCache } from '../cache.js';
import { cleanMarkdownTokens } from '../enrichment.js';
import { errorMessage } from '../errors.js';
import { parseTimestampChapters, parseYouTubeUrl } from '../html_parser.js';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import { readBodyWithLimit } from '../net/safe_transport.js';
import { DEFAULT_MAX_CHARS, type YoutubeTranscriptResultSchema } from '../types.js';

/**
 * YouTube の動画の題名・説明文・チャプターと、時刻つきの字幕（モジュール 'youtube'）。
 * 字幕は Android アプリと同じ innertube の player から一覧を取り、timedtext を json3 で読む。
 * 動画ページに埋め込まれた字幕の URL は PO トークン必須で空になるため、player が拒否されたときの代用にだけ使う。
 * 要約は呼び出し側の AI が書く。字幕が無い動画は「字幕なし」と理由を返し、音声認識はしない。
 */

export type YoutubeTranscriptResult = z.infer<typeof YoutubeTranscriptResultSchema>;
type Transcript = NonNullable<YoutubeTranscriptResult['transcript']>;
type TrackInfo = NonNullable<YoutubeTranscriptResult['availableTracks']>[number];

export interface YoutubeTranscriptOptions { url: string; lang?: string; fromSec?: number; toSec?: number; maxChars?: number; noCache?: boolean }
export interface YoutubeDeps {
  /** player の POST と timedtext の取得 */
  fetchFn?: typeof fetch;
  /** 動画ページの HTML の取得 */
  fetchWatchPage?: (url: string) => Promise<string>;
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
const mismatch = (code: string) => `自動字幕は ${code} のものしか無く、題名の言語と合わないため返していません。lang: '${code}' を指定すると取得できます。`;

interface CaptionTrack { baseUrl?: string; languageCode?: string; kind?: string; name?: { runs?: Array<{ text?: string }>; simpleText?: string } }
interface Playability { status?: string; reason?: string }
interface PlayerResponse {
  playabilityStatus?: Playability;
  videoDetails?: { title?: string; author?: string; lengthSeconds?: string; shortDescription?: string; isLive?: boolean };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[]; audioTracks?: Array<{ audioTrackId?: string }>; defaultAudioTrackIndex?: number } };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string; category?: string; liveBroadcastDetails?: { isLiveNow?: boolean } } };
}
interface Json3 { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> }
interface Paragraph { startSec: number; text: string }

/** キャッシュする形。本文は段落の配列で持ち、範囲と長さの切り出しは呼び出しごとに行う。 */
type VideoRecord = Omit<YoutubeTranscriptResult, 'transcript' | 'requestedStartSec'> & {
  transcript?: Pick<Transcript, 'status' | 'reason' | 'message' | 'source' | 'language' | 'note'> & { paragraphs?: Paragraph[] };
};

const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
const isBotCheck = (p?: Playability) => p?.status === 'LOGIN_REQUIRED' && /bot/i.test(p.reason ?? '');
const baseLang = (code: string) => code.toLowerCase().split('-')[0];
const isAuto = (t: CaptionTrack) => t.kind === 'asr';

async function fetchPlayer(videoId: string, fetchFn: typeof fetch): Promise<PlayerResponse> {
  const res = await fetchFn(PLAYER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ANDROID_UA },
    body: JSON.stringify({ context: { client: { ...ANDROID_CLIENT, hl: 'ja', gl: 'JP' } }, videoId }),
    signal: AbortSignal.timeout(PLAYER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`player HTTP ${res.status}`);
  return await res.json() as PlayerResponse;
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
 * 言語の候補の順に、手動の字幕、自動字幕の順で選ぶ。どれも無ければ他の言語の手動、自動の順。
 * 候補は指定の言語、元の音声の言語、英語（翻訳の字幕の中では読める AI が多い）。
 */
function pickTrack(tracks: CaptionTrack[], langs: string[]): CaptionTrack | undefined {
  for (const lang of langs) {
    const same = (t: CaptionTrack) => baseLang(t.languageCode ?? '') === baseLang(lang);
    const hit = tracks.find((t) => same(t) && !isAuto(t)) ?? tracks.find((t) => same(t) && isAuto(t));
    if (hit) return hit;
  }
  return tracks.find((t) => !isAuto(t)) ?? tracks.find(isAuto);
}

/** 元の音声の言語。既定の音声トラックの ID（`ja.4`）から読み、無ければ自動字幕の言語（AI 吹き替えの音声が無い動画では、自動字幕は元の音声のもの）。 */
function originalLanguage(renderer: NonNullable<PlayerResponse['captions']>['playerCaptionsTracklistRenderer'], tracks: CaptionTrack[]): string | undefined {
  const audioTrackId = renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0]?.audioTrackId;
  return audioTrackId?.split('.')[0] || tracks.find(isAuto)?.languageCode;
}

/** json3 を約 30 秒か 300 字ごとの段落にする。改行だけの event（自動字幕の aAppend）と表示窓の定義は飛ばす。 */
function json3ToParagraphs(json: Json3): Paragraph[] {
  const paragraphs: Array<{ startMs: number; parts: string[]; len: number }> = [];
  for (const ev of json.events ?? []) {
    const text = (ev.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const startMs = ev.tStartMs ?? 0;
    const cur = paragraphs.at(-1);
    if (cur && startMs - cur.startMs < PARAGRAPH_MS && cur.len < PARAGRAPH_CHARS) {
      cur.parts.push(text);
      cur.len += text.length + 1;
    } else {
      paragraphs.push({ startMs, parts: [text], len: text.length + 1 });
    }
  }
  return paragraphs.map((p) => ({ startSec: Math.floor(p.startMs / 1000), text: cleanMarkdownTokens(p.parts.join(' ')) }));
}

type CaptionOutcome = { paragraphs: Paragraph[] } | { failed: 'blocked' | 'request-failed' };

async function fetchCaptions(baseUrl: string | undefined, fetchFn: typeof fetch): Promise<CaptionOutcome> {
  let url: URL;
  try {
    url = new URL(baseUrl ?? '');
  } catch {
    return { failed: 'blocked' };
  }
  if (url.hostname !== 'www.youtube.com' || url.pathname !== '/api/timedtext') return { failed: 'blocked' }; // 応答に入っていた URL でも、字幕の取得先以外には出さない
  url.searchParams.set('fmt', 'json3');
  let body: string;
  try {
    const res = await fetchFn(url.toString(), { headers: { 'User-Agent': ANDROID_UA }, signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS) });
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

async function lookup(videoId: string, lang: string, deps: YoutubeDeps): Promise<VideoRecord> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const [playerOut, pageOut] = await Promise.allSettled([fetchPlayer(videoId, fetchFn), (deps.fetchWatchPage ?? defaultFetchWatchPage)(watchUrl(videoId))]);
  const fromPlayer = playerOut.status === 'fulfilled' ? playerOut.value : undefined;
  const page = pageOut.status === 'fulfilled' ? extractInitialPlayerResponse(pageOut.value) : undefined;

  // player が使えなければ、動画ページに埋め込まれた応答で代用する
  const source = fromPlayer && !isBotCheck(fromPlayer.playabilityStatus) ? fromPlayer : page;
  if (!source || isBotCheck(source.playabilityStatus)) {
    const bot = [fromPlayer, page].find((p) => isBotCheck(p?.playabilityStatus));
    if (bot) throw new Error(`YouTube login required (bot check): ${bot.playabilityStatus?.reason}`);
    const cause = playerOut.status === 'rejected' ? errorMessage(playerOut.reason) : pageOut.status === 'rejected' ? errorMessage(pageOut.reason) : 'no player response';
    throw new Error(`YouTube request failed: ${cause}`);
  }
  const url = watchUrl(videoId);
  const playability = source.playabilityStatus;
  if (playability?.status !== 'OK') {
    return { found: false, videoId, url, reason: 'video-unavailable', message: playability?.reason || playability?.status || '再生できない動画です' };
  }

  const details = source.videoDetails ?? {};
  const micro = page?.microformat?.playerMicroformatRenderer;
  const title = details.title === undefined ? undefined : cleanMarkdownTokens(details.title);
  const isLiveNow = micro?.liveBroadcastDetails?.isLiveNow ?? details.isLive;
  const description = cleanMarkdownTokens(details.shortDescription ?? '');
  const chapters = parseTimestampChapters(description);
  const renderer = source.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks ?? [];
  const availableTracks: TrackInfo[] = tracks.map((t) => ({
    language: t.languageCode ?? '',
    source: isAuto(t) ? 'auto' : 'manual',
    name: t.name?.runs?.map((r) => r.text ?? '').join('') || t.name?.simpleText || t.languageCode || '',
  }));

  const picked = pickTrack(tracks, [lang, originalLanguage(renderer, tracks), 'en'].filter((l): l is string => !!l));
  let transcript: NonNullable<VideoRecord['transcript']>;
  if (!picked) {
    const published = Date.parse(micro?.publishDate ?? '');
    transcript = isLiveNow
      ? { status: 'none', reason: 'live-now', message: LIVE_NOW }
      : { status: 'none', reason: 'no-captions', message: now() - published < RECENT_MS ? `${NO_CAPTIONS}${RECENT_HINT}` : NO_CAPTIONS };
  } else if (isAuto(picked) && baseLang(picked.languageCode ?? '') !== baseLang(lang) && baseLang(lang) === 'ja' && KANA.test(title ?? '')) {
    // 日本語の動画に、別の言語の音声認識の結果だけが付いていることがある（中身は意味をなさない）
    transcript = { status: 'none', reason: 'language-mismatch', message: mismatch(picked.languageCode ?? '') };
  } else {
    const out = await fetchCaptions(picked.baseUrl, fetchFn);
    if ('failed' in out) {
      transcript = { status: 'unavailable', reason: out.failed, message: out.failed === 'blocked' ? BLOCKED : REQUEST_FAILED };
    } else if (out.paragraphs.length === 0) {
      transcript = { status: 'none', reason: 'no-captions', message: NO_CAPTIONS };
    } else {
      const note = isAuto(picked) ? (micro?.category === 'Music' ? `${NOTE_AUTO}${NOTE_MUSIC}` : NOTE_AUTO) : undefined;
      transcript = { status: 'ok', source: isAuto(picked) ? 'auto' : 'manual', language: picked.languageCode ?? '', ...(note ? { note } : {}), paragraphs: out.paragraphs };
    }
  }

  return {
    found: true,
    videoId,
    url,
    title,
    channel: details.author,
    publishedAt: micro?.publishDate,
    durationSec: Number(details.lengthSeconds) || undefined,
    isLiveNow,
    category: micro?.category,
    description,
    ...(chapters.length > 0 ? { chapters } : {}),
    transcript,
    availableTracks,
  };
}

const clock = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/** 範囲に重なる段落を、maxChars に収まる分だけ返す。1 段落も収まらなければ最初の段落を切る。 */
function sliceParagraphs(paragraphs: Paragraph[], fromSec: number, toSec: number, maxChars: number, durationSec?: number): Partial<Transcript> {
  const lines = paragraphs.map((p) => `[${clock(p.startSec)}] ${p.text}`);
  const totalChars = lines.join('\n').length;
  const endOf = (i: number) => paragraphs[i + 1]?.startSec ?? Math.max(durationSec ?? 0, paragraphs[i].startSec + 1);
  const picked = paragraphs.flatMap((p, i) => (endOf(i) > fromSec && p.startSec < toSec ? [i] : []));
  if (picked.length === 0) return { fromSec, toSec, text: '', chars: 0, totalChars, truncated: false };

  let text = '';
  let end = picked[0]; // 返さなかった最初の段落
  let cut = false;
  for (const i of picked) {
    const next = text ? `${text}\n${lines[i]}` : lines[i];
    if (next.length > maxChars) {
      if (!text) {
        text = lines[i].slice(0, maxChars);
        end = i + 1;
        cut = true;
      }
      break;
    }
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
    truncated: cut || end <= last,
    ...(end <= last ? { nextFromSec: paragraphs[end].startSec } : {}),
  };
}

export async function getYoutubeTranscript(options: YoutubeTranscriptOptions, deps: YoutubeDeps = {}): Promise<YoutubeTranscriptResult> {
  const parsed = parseYouTubeUrl(options.url);
  if (!parsed) throw new YoutubeInputError('url must be a YouTube video URL or an 11-character video ID');
  const lang = options.lang?.trim().toLowerCase() || 'ja';

  const key = `youtube:${cacheKeyDigest<YoutubeTranscriptOptions, 'fromSec' | 'toSec' | 'maxChars' | 'noCache'>({ url: parsed.videoId, lang })}`;
  let record: VideoRecord | null = options.noCache ? null : getFromCache<VideoRecord>(key);
  if (!record) {
    record = await runWithSingleFlight(key, () => lookup(parsed.videoId, lang, deps));
    // 字幕を取れなかった結果は、次の呼び出しで取り直せるようにキャッシュしない。字幕なしは短く
    const ttl = record.transcript?.status === 'ok' ? CACHE_TTL_DEFAULT : record.transcript?.status === 'unavailable' ? 0 : CACHE_TTL_EMPTY;
    if (!options.noCache && ttl > 0) setToCache(key, record, ttl);
  }

  const { transcript, ...rest } = record;
  const result: YoutubeTranscriptResult = { ...rest, ...(parsed.startSec ? { requestedStartSec: parsed.startSec } : {}) };
  if (transcript) {
    const { paragraphs, ...meta } = transcript;
    result.transcript = paragraphs
      ? { ...meta, ...sliceParagraphs(paragraphs, options.fromSec ?? 0, options.toSec ?? Infinity, options.maxChars ?? DEFAULT_MAX_CHARS, record.durationSec) }
      : meta;
  }
  return result;
}
