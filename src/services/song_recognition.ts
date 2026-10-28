import { createHash, randomUUID } from 'node:crypto';
import { CACHE_TTL_DEFAULT, CACHE_TTL_EMPTY, cacheKeyDigest, getFromCache, runWithSingleFlight, setToCache } from '../cache.js';
import { errorMessage } from '../errors.js';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import { readBodyWithLimit } from '../net/safe_transport.js';
import { AudioDecodeError, decodeAudioWindows, type DecodedWindows } from './audio_decode.js';
import { toMusicItem, type MusicItem } from './music.js';
import { DATA_URI_PREFIX, MIN_WINDOW_SECONDS, SignatureTooShortError, WINDOW_SECONDS, checkSignatureBase64, signatureUri } from './shazam_signature.js';

/**
 * 音声・動画ファイルの音から、流れている曲を Shazam で特定し、iTunes の曲とつなぐ（モジュール 'shazam'）。
 * 送り先は Shazam の iPhone アプリと同じ窓口（amp.shazam.com の tag）。窓の選び方とヘッダーは
 * omkarcloud/shazam-scraper の shazam/recognize.py・fetch.py（MIT）に合わせた。
 */

export const MAX_URL_BYTES = 20 * 1024 * 1024;
const MAX_TRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const SHAZAM_TIMEOUT_MS = 20_000;
const ITUNES_TIMEOUT_MS = 8_000;
// これより大きい時間・周波数のずれの当たりは、確かでないものとして扱う。2026-10-27 の実測では、
// 正しい当たりは 0.00012 以下、Shazam が別の曲を返した当たりは周波数のずれが 0.0051 だった
const MAX_SKEW = 0.002;
const SHAZAM_QUERY = 'sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v0';
// Shazam の iOS アプリの名乗り。tag の窓口はこれを求める（元のコードの TAG_HEADERS と同じ）
const SHAZAM_HEADERS: Record<string, string> = {
  'X-Shazam-Platform': 'IPHONE',
  'X-Shazam-AppVersion': '14.1.0',
  Accept: '*/*',
  'Accept-Language': 'en',
  'Accept-Encoding': 'gzip, deflate',
  'User-Agent': 'Shazam/3685 CFNetwork/1197 Darwin/20.0.0',
  'Content-Type': 'application/json',
};

const NO_MATCH = 'Shazam で曲を特定できませんでした。別の位置（offsetSec）や、はっきり録れた音で試してください。曲名を推測で答えないでください。';
const NOT_AUDIO = '音声・動画として読めませんでした。動画のページ（YouTube など）ではなく、音声・動画ファイル（mp3・m4a・wav・ogg・webm・flac・mp4 など）の URL を渡してください。';
const TOO_SHORT = '音が短すぎるか静かすぎます（3 秒以上の音が要ります）。offsetSec が音の長さを超えていないかも確かめてください。';
const UNCERTAIN = '音の高さ・速さのずれが大きい当たりです（別の曲のことがあります）。別の位置（offsetSec）でも確かめてください。';
const TOO_LARGE = `ファイルが大きすぎます（URL から読むのは ${MAX_URL_BYTES / 1024 / 1024} MB まで）。曲の部分だけを切り出した音を渡してください。`;

export class SongRecognitionInputError extends Error {}

export interface ShazamTrack {
  key: string;
  title: string;
  artist: string;
  isrc?: string;
  appleMusicId?: string;
  album?: string;
  label?: string;
  released?: string;
  genre?: string;
  url?: string;
  artwork?: string;
}

export type SongRecognitionReason = 'no-match' | 'not-audio' | 'too-short' | 'too-large' | 'download-failed';

export interface SongRecognitionResult {
  found: boolean;
  reason?: SongRecognitionReason;
  message?: string;
  itunes: MusicItem | null;
  itunesMatch: 'apple-id' | 'title-artist' | null;
  shazam?: ShazamTrack;
  match?: { songOffsetSec?: number; clipOffsetSec: number; timeSkew?: number; frequencySkew?: number; uncertain?: true };
  attempts: Array<{ offsetSec: number; durationSec: number; matched: boolean; uncertain?: true }>;
  audio?: { bytes: number; durationSec?: number; contentType: string };
  cached?: boolean;
}

export interface SongRecognitionOptions {
  url?: string;
  audio?: { bytes: Uint8Array; contentType?: string };
  offsetSec?: number;
  country?: string;
  noCache?: boolean;
}

type DownloadedAudio = { bytes: Uint8Array; contentType: string };
type DownloadRefusal = { reason: 'not-audio' | 'too-large' | 'download-failed'; message: string };
type Fetcher = (url: string, timeoutMs: number) => Promise<{ finalUrl: string; response: Response }>;

export interface SongRecognitionDeps {
  fetchFn?: typeof fetch;
  download?: (url: string) => Promise<DownloadedAudio | DownloadRefusal>;
  decode?: (bytes: Uint8Array, pickWindows: (durationSec: number) => number[]) => Promise<DecodedWindows>;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const isHtml = (contentType: string) => /text\/html|application\/xhtml/i.test(contentType);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const idOf = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? String(v) : undefined);
const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function refusal(reason: SongRecognitionReason, message: string, audio?: SongRecognitionResult['audio'], attempts: SongRecognitionResult['attempts'] = []): SongRecognitionResult {
  return { found: false, reason, message, itunes: null, itunesMatch: null, attempts, ...(audio ? { audio } : {}) };
}

/** 試す窓の始まり（秒）。指定があればそこだけ。無ければ、36 秒を超える音は真ん中、続けて先頭から 12 秒ずつ、合わせて最大 3 つ（元のコードと同じ）。 */
export function pickWindows(durationSec: number, offsetSec?: number): number[] {
  if (offsetSec !== undefined) return [offsetSec];
  const starts: number[] = [];
  if (durationSec > 3 * WINDOW_SECONDS) starts.push(round3(Math.max(0, durationSec / 2 - WINDOW_SECONDS / 2)));
  for (let cursor = 0; starts.length < MAX_TRIES && cursor < durationSec; cursor += WINDOW_SECONDS) {
    if (!starts.includes(cursor) && cursor < durationSec - MIN_WINDOW_SECONDS) starts.push(cursor);
  }
  return starts.length > 0 ? starts : [0];
}

/** URL の音声・動画ファイルを読む（SSRF の防御は今の取得と同じ）。読めない・ページ・大きすぎるときは、エラーでなく理由を返す。 */
export async function downloadAudio(
  url: string,
  fetcher: Fetcher = (u, t) => fetchWithSafeRedirects(u, t, 5, { Accept: '*/*' }),
): Promise<DownloadedAudio | DownloadRefusal> {
  let response: Response;
  try {
    ({ response } = await fetcher(url, DOWNLOAD_TIMEOUT_MS));
  } catch (e) {
    return { reason: 'download-failed', message: `音声の URL を読めませんでした（${errorMessage(e)}）。` };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { reason: 'download-failed', message: `音声の URL が HTTP ${response.status} を返しました。` };
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (isHtml(contentType)) {
    await response.body?.cancel().catch(() => {});
    return { reason: 'not-audio', message: NOT_AUDIO };
  }
  try {
    return { bytes: await readBodyWithLimit(response, MAX_URL_BYTES), contentType };
  } catch (e) {
    if (/exceeds/.test(errorMessage(e) ?? '')) return { reason: 'too-large', message: TOO_LARGE };
    return { reason: 'download-failed', message: `音声の URL を読み切れませんでした（${errorMessage(e)}）。` };
  }
}

/** 指紋を 1 つ Shazam に送り、応答の JSON を返す。拒否・制限・障害は、状態の番号を入れたエラーにする（再試行しない）。 */
async function sendSignature(sig: { uri: string; sampleMs: number }, country: string, fetchFn: typeof fetch): Promise<unknown> {
  const url = `https://amp.shazam.com/discovery/v5/en/${country.toUpperCase()}/iphone/-/tag/${randomUUID().toUpperCase()}/${randomUUID().toUpperCase()}?${SHAZAM_QUERY}`;
  const body = JSON.stringify({ timezone: 'Asia/Tokyo', signature: { uri: sig.uri, samplems: sig.sampleMs }, timestamp: Date.now(), context: {}, geolocation: {} });
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers: SHAZAM_HEADERS, body, redirect: 'error', signal: AbortSignal.timeout(SHAZAM_TIMEOUT_MS) });
  } catch (e) {
    const timedOut = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Error(timedOut ? 'Shazam timed out' : `Shazam request failed: ${errorMessage(e)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const what = res.status === 403 ? 'forbidden' : res.status === 429 ? 'rate limited' : 'request failed';
    throw new Error(`Shazam HTTP ${res.status} (${what})`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error('Shazam request failed: the response was not JSON');
  }
}

function appleMusicId(t: Record<string, any>): string | undefined {
  const direct = idOf(t.trackadamid);
  if (direct) return direct;
  const hub = t.hub ?? {};
  for (const a of Array.isArray(hub.actions) ? hub.actions : []) {
    if (a?.type === 'applemusicplay' && idOf(a.id)) return idOf(a.id);
  }
  for (const option of Array.isArray(hub.options) ? hub.options : []) {
    for (const a of Array.isArray(option?.actions) ? option.actions : []) {
      const uri = str(a?.uri);
      if (!uri?.startsWith('https://music.apple.com/')) continue;
      const u = new URL(uri);
      const id = idOf(u.searchParams.get('i')) ?? (u.pathname.includes('/song/') ? idOf(u.pathname.split('/').pop()) : undefined);
      if (id) return id;
    }
  }
  return undefined;
}

type ShazamMatch = { track: ShazamTrack; songOffsetSec?: number; timeSkew?: number; frequencySkew?: number };

/** Shazam の tag の応答から、曲と、その音が曲の何秒目か、時間・周波数のずれを読む。当たらなかったら null。 */
export function parseShazamResponse(body: unknown): ShazamMatch | null {
  const b = body as { matches?: Array<{ offset?: unknown; timeskew?: unknown; frequencyskew?: unknown }>; track?: Record<string, any> } | null;
  const t = b?.track;
  const key = idOf(t?.key) ?? str(t?.key);
  const title = str(t?.title);
  const artist = str(t?.subtitle);
  if (!t || !key || !title || !artist) return null;
  const meta: Record<string, string | undefined> = {};
  for (const section of Array.isArray(t.sections) ? t.sections : []) {
    if (section?.type !== 'SONG') continue;
    for (const row of Array.isArray(section.metadata) ? section.metadata : []) meta[String(row?.title ?? '').toLowerCase()] = str(row?.text);
  }
  const { offset, timeskew, frequencyskew } = b?.matches?.[0] ?? {};
  return {
    track: {
      key, title, artist,
      isrc: str(t.isrc), appleMusicId: appleMusicId(t), album: meta.album, label: meta.label, released: meta.released,
      genre: str(t.genres?.primary), url: str(t.url), artwork: str(t.images?.coverarthq) ?? str(t.images?.coverart),
    },
    ...(typeof offset === 'number' ? { songOffsetSec: round3(offset) } : {}),
    ...(typeof timeskew === 'number' ? { timeSkew: timeskew } : {}),
    ...(typeof frequencyskew === 'number' ? { frequencySkew: frequencyskew } : {}),
  };
}

const isUncertain = (m: ShazamMatch) => Math.abs(m.timeSkew ?? 0) > MAX_SKEW || Math.abs(m.frequencySkew ?? 0) > MAX_SKEW;

async function itunesResults(url: string, fetchFn: typeof fetch): Promise<any[]> {
  const res = await fetchFn(url, { headers: { 'User-Agent': 'Sora-Music-Metadata-Fetcher/1.0' }, signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`);
  const data = (await res.json()) as { results?: unknown };
  return Array.isArray(data.results) ? data.results : [];
}

/** Shazam の曲を iTunes の曲につなぐ。Apple の曲 ID で引き、無ければ曲名とアーティストの一致する検索結果。iTunes の失敗は failed。 */
async function linkItunes(track: ShazamTrack, country: string, fetchFn: typeof fetch): Promise<{ item: MusicItem | null; by: 'apple-id' | 'title-artist' | null; failed?: boolean }> {
  try {
    if (track.appleMusicId) {
      const [song] = (await itunesResults(`https://itunes.apple.com/lookup?id=${track.appleMusicId}&country=${country}&entity=song`, fetchFn)).filter((r) => r?.wrapperType === 'track');
      if (song) return { item: toMusicItem(song, 'song'), by: 'apple-id' };
    }
    const term = encodeURIComponent(`${track.title} ${track.artist}`);
    const results = await itunesResults(`https://itunes.apple.com/search?term=${term}&country=${country}&entity=song&limit=10`, fetchFn);
    const same = results.find((r) => typeof r?.trackName === 'string' && typeof r?.artistName === 'string'
      && normalize(r.trackName) === normalize(track.title) && normalize(r.artistName) === normalize(track.artist));
    return same ? { item: toMusicItem(same, 'song'), by: 'title-artist' } : { item: null, by: null };
  } catch {
    return { item: null, by: null, failed: true };
  }
}

type Window = { offsetSec: number; sig: { uri: string; sampleMs: number } };
type Hit = { result: SongRecognitionResult; ttlMs: number; linkFailed?: boolean };

/** 指紋の窓を順に Shazam に送る。確かな当たりが出たらそこで止め、ずれの大きい当たりだけなら最後にそれを返す。当たりが無ければ hit は null。 */
async function queryWindows(windows: Iterable<Window>, country: string, fetchFn: typeof fetch): Promise<{ hit: Hit | null; attempts: SongRecognitionResult['attempts'] }> {
  const attempts: SongRecognitionResult['attempts'] = [];
  let weak: { match: ShazamMatch; clipOffsetSec: number } | undefined;
  const found = async (m: ShazamMatch, clipOffsetSec: number, uncertain: boolean): Promise<Hit> => {
    const linked = await linkItunes(m.track, country, fetchFn);
    const match = { songOffsetSec: m.songOffsetSec, clipOffsetSec, timeSkew: m.timeSkew, frequencySkew: m.frequencySkew, ...(uncertain ? { uncertain: true as const } : {}) };
    return {
      result: { found: true, ...(uncertain ? { message: UNCERTAIN } : {}), itunes: linked.item, itunesMatch: linked.by, shazam: m.track, match, attempts },
      ttlMs: linked.failed || uncertain ? CACHE_TTL_EMPTY : CACHE_TTL_DEFAULT,
      linkFailed: linked.failed,
    };
  };
  for (const w of windows) {
    const matched = parseShazamResponse(await sendSignature(w.sig, country, fetchFn));
    const uncertain = matched !== null && isUncertain(matched);
    attempts.push({ offsetSec: w.offsetSec, durationSec: w.sig.sampleMs / 1000, matched: matched !== null, ...(uncertain ? { uncertain: true as const } : {}) });
    if (!matched) continue;
    // ずれの大きい当たりは別の曲のことがある。次の窓で確かな当たりが出ればそちらを返す
    if (uncertain) {
      weak ??= { match: matched, clipOffsetSec: w.offsetSec };
      continue;
    }
    return { hit: await found(matched, w.offsetSec, false), attempts };
  }
  return { hit: weak ? await found(weak.match, weak.clipOffsetSec, true) : null, attempts };
}

async function identify(audio: DownloadedAudio, offsetSec: number | undefined, country: string, deps: SongRecognitionDeps): Promise<Hit> {
  let decoded: DecodedWindows;
  try {
    decoded = await (deps.decode ?? decodeAudioWindows)(audio.bytes, (d) => pickWindows(d, offsetSec));
  } catch (e) {
    if (e instanceof AudioDecodeError) return { result: refusal('not-audio', NOT_AUDIO), ttlMs: CACHE_TTL_EMPTY };
    throw e;
  }
  const info = { bytes: audio.bytes.byteLength, durationSec: round3(decoded.durationSec), contentType: audio.contentType };
  if (decoded.durationSec < MIN_WINDOW_SECONDS) return { result: refusal('too-short', TOO_SHORT, info), ttlMs: CACHE_TTL_EMPTY };
  // 指紋は、当たるまでの窓の分だけ作る。無音の窓は飛ばす
  function* windows(): Generator<Window> {
    for (const w of decoded.windows) {
      let sig: Window['sig'];
      try {
        sig = signatureUri(w.pcm);
      } catch (e) {
        if (e instanceof SignatureTooShortError) continue;
        throw e;
      }
      yield { offsetSec: w.offsetSec, sig };
    }
  }
  const { hit, attempts } = await queryWindows(windows(), country, deps.fetchFn ?? fetch);
  if (hit) return { result: { ...hit.result, audio: info }, ttlMs: hit.ttlMs };
  if (attempts.length === 0) return { result: refusal('too-short', TOO_SHORT, info), ttlMs: CACHE_TTL_EMPTY };
  return { result: refusal('no-match', NO_MATCH, info, attempts), ttlMs: CACHE_TTL_EMPTY };
}

const countryOf = (country?: string): string => {
  const c = (country ?? 'jp').toLowerCase();
  if (!/^[a-z]{2}$/.test(c)) throw new SongRecognitionInputError('country は 2 文字の国コードです（例: "jp"）');
  return c;
};

/** 音から曲を特定する。音は URL（20 MB まで）か、アップロードのバイト列（REST）。 */
export async function recognizeSong(options: SongRecognitionOptions, deps: SongRecognitionDeps = {}): Promise<SongRecognitionResult> {
  const country = countryOf(options.country);
  let audio: DownloadedAudio;
  if (options.audio) {
    audio = { bytes: options.audio.bytes, contentType: options.audio.contentType || 'application/octet-stream' };
  } else {
    const url = options.url?.trim();
    if (!url) throw new SongRecognitionInputError('url（音声・動画ファイルの URL）か、アップロードするファイルが要ります');
    let protocol = '';
    try {
      protocol = new URL(url).protocol;
    } catch {}
    if (protocol !== 'http:' && protocol !== 'https:') throw new SongRecognitionInputError('url は http(s) の URL です');
    const got = await (deps.download ?? downloadAudio)(url);
    if ('reason' in got) return refusal(got.reason, got.message);
    audio = got;
  }
  if (isHtml(audio.contentType)) return refusal('not-audio', NOT_AUDIO);
  const digest = createHash('sha256').update(audio.bytes).digest('hex');
  const key = `song-recognition:${cacheKeyDigest<{ audio: string; offsetSec?: number; country: string }>({ audio: digest, offsetSec: options.offsetSec, country })}`;
  const hit = options.noCache ? null : getFromCache<SongRecognitionResult>(key);
  if (hit) return hit;
  const { result, ttlMs } = await runWithSingleFlight(key, () => identify(audio, options.offsetSec, country, deps));
  if (!options.noCache && ttlMs > 0) setToCache(key, result, ttlMs);
  return result;
}

/**
 * 端末で作った指紋（data URI の接頭辞なしの base64）と長さ（ミリ秒）から曲を特定する。音そのものは受け取らない。
 * 録音は毎回違い、残すと「この時刻にこの曲」が残るだけなので、キャッシュも single-flight も使わない。
 */
export async function recognizeSignature(options: { signature: string; sampleMs: number; country?: string }, deps: SongRecognitionDeps = {}): Promise<SongRecognitionResult> {
  const country = countryOf(options.country);
  if (!checkSignatureBase64(options.signature, options.sampleMs)) {
    throw new SongRecognitionInputError('signature が指紋の形になっていないか、sampleMs と長さが合いません');
  }
  const { hit, attempts } = await queryWindows([{ offsetSec: 0, sig: { uri: DATA_URI_PREFIX + options.signature, sampleMs: options.sampleMs } }], country, deps.fetchFn ?? fetch);
  // iTunes の失敗（時間切れ・403・429 など）を itunes: null で返すと、iTunes に無い曲と見分けが付かない。
  // 上流の失敗（502）にして、呼び出し側が指紋を残して照会し直せるようにする（音声の経路は当たりを返す）
  if (hit?.linkFailed) throw new Error('iTunes lookup failed');
  return hit ? hit.result : refusal('no-match', NO_MATCH, undefined, attempts);
}
