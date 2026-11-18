import type { Browser, Page } from 'puppeteer-core';
import { browserSemaphore, getBrowser, recordBrowserUsage, resolveChromiumPath } from '../browser_engine.js';
import { limits } from '../security/limits.js';
import { SAMPLE_RATE, WINDOW_SECONDS } from './shazam_signature.js';

/** 音声・動画として読めないバイト列（Chromium の decodeAudioData が断った）。 */
export class AudioDecodeError extends Error {}

/**
 * 音の長さが上限（limits.ts の audioMaxDurationSec）を超える（デコードの前に断った）。durationSec が無いのは、長さを確かめられない大きなファイル。
 * デコードはファイル全体を PCM（16 kHz・32 bit 浮動小数・チャンネルごと）にするので、長い音はメモリを使い切る
 */
export class AudioTooLongError extends Error {
  constructor(readonly durationSec: number | undefined, readonly limitSec: number) {
    super(durationSec === undefined ? `音の長さを確かめられない大きなファイルのため、変換しません（長さを読めないファイルは ${UNPROBED_MAX_BYTES / 1024 / 1024} MB まで）` : `音が長すぎます（${Math.round(durationSec)} 秒。上限 ${limitSec} 秒）`);
    this.name = 'AudioTooLongError';
  }
}

/** ファイルの先頭の情報から長さを読めなかったとき（形式によっては、長さが分からない）に、変換してよい大きさ。これを超えるものは、長さを確かめられないので断る */
export const UNPROBED_MAX_BYTES = 4 * 1024 * 1024;

export interface DecodedWindows {
  durationSec: number;
  windows: Array<{ offsetSec: number; pcm: Int16Array }>;
}

/** コンテキストの通信を向ける、行き先の無いプロキシ（ループバックの discard ポート 9。何も待ち受けない前提）。すべての要求が、ここで失敗する */
const DEAD_PROXY = 'http://127.0.0.1:9';

/**
 * デコード用の、通信のできないブラウザコンテキスト（設計 2。段階 6b）。
 * ページの要求の割り込み・オフライン（lockPageOffline）は、ページの要求しか見えない。prerender・投機的な取得（Speculation Rules）・
 * WebRTC の TCP・ページの移動を試みたときの TCP 接続・ポップアップ（割り込みもオフラインもない別のページ）は、ブラウザ本体が通信するので、止まらない
 * （レビューの実測）。そこで、コンテキストの通信そのものを、行き先の無いプロキシに向ける（ループバックも、プロキシへ向ける）。
 * ブラウザ全体のプロキシ・出口のゲートウェイの設定より、コンテキストの設定が優先されるので、ゲートウェイの有無によらず、どこへもつながらない。
 */
export function createOfflineContext(browser: Browser) {
  return browser.createBrowserContext({ proxyServer: DEAD_PROXY, proxyBypassList: ['<-loopback>'] });
}

/**
 * デコード用のページを、通信できず、移動もしない状態にする（設計 2。段階 6b。穴 28）。
 * デコードは、バイト列をページに置き、blob: の <audio> と decodeAudioData で処理するだけで、ネットワークは要らない。
 * 利用者（や、利用者が指した先）の作ったバイト列が、メディアのデコーダーで何かを起こしても、そのページから、fetch・Worker・画像・iframe・
 * ページの移動で、外（内部のネットワーク・メタデータ・ほかの利用者のページ）へ出られないようにする。
 * ページの層は 2 重にする: 要求の割り込み（ページの要求を、ページの中で完結するもの以外、すべて断る。ページの移動は、完結するものも断る）と、
 * オフライン（割り込みの届かない Worker・WebSocket・WebRTC の UDP も止める）。どちらかが失敗したら、閉じられていないので、デコードしない（黙って通さない）。
 * ブラウザ本体の通信（prerender・投機的な取得など）は、この層では止まらないので、コンテキストの層（createOfflineContext）と組にして使う。
 */
export async function lockPageOffline(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const local = !request.isNavigationRequest() && /^(blob|data|about):/.test(request.url());
    // 返答が失敗しても（ページが閉じたあとなど）、未処理の拒否にしない
    (local ? request.continue() : request.abort('blockedbyclient')).catch(() => undefined);
  });
  await page.setOfflineMode(true);
}

type PageGlobal = { __soraAudio?: AudioBuffer; __soraBytes?: Uint8Array };

// 以下の 3 つはページの中で動く（puppeteer が関数の文字列を送る）。外の変数を参照しない
/** バイト列をページに置き、<audio> の長さ（ファイルの先頭の情報。全体のデコードより、ずっと軽い）を読む。読めなければ ok: false */
const probeInPage = (b64: string) =>
  new Promise<{ ok: true; durationSec: number } | { ok: false }>((resolve) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    (globalThis as unknown as PageGlobal).__soraBytes = data;
    const url = URL.createObjectURL(new Blob([data]));
    const el = new Audio();
    let settled = false;
    const done = (value: { ok: true; durationSec: number } | { ok: false }) => {
      if (settled) return;
      settled = true;
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      if (el.duration === Infinity) {
        // 長さを持たない形式（MediaRecorder・パイプ出力の WebM など）は、末尾へ飛ぶと、実際の長さが分かる
        el.ondurationchange = () => {
          if (Number.isFinite(el.duration)) done({ ok: true, durationSec: el.duration });
        };
        el.currentTime = 1e101;
        return;
      }
      done(Number.isFinite(el.duration) && el.duration >= 0 ? { ok: true, durationSec: el.duration } : { ok: false });
    };
    el.onerror = () => done({ ok: false });
    setTimeout(() => done({ ok: false }), 5000);
    el.src = url;
  });

const decodeInPage = async (rate: number) => {
  try {
    const data = (globalThis as unknown as PageGlobal).__soraBytes as Uint8Array;
    // decodeAudioData は、文脈の標本化周波数（16 kHz）に変換して返す
    const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data.buffer as ArrayBuffer);
    (globalThis as unknown as PageGlobal).__soraAudio = buf;
    return { ok: true as const, durationSec: buf.duration };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
};

const extractInPage = (offsets: number[], windowSec: number, rate: number) => {
  const buf = (globalThis as unknown as PageGlobal).__soraAudio as AudioBuffer;
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return offsets.map((offsetSec) => {
    const start = Math.floor(offsetSec * rate);
    const end = Math.min(buf.length, start + windowSec * rate);
    const out = new Int16Array(Math.max(0, end - start));
    for (let i = 0; i < out.length; i++) {
      let v = 0;
      for (const ch of channels) v += ch[start + i];
      v = Math.max(-1, Math.min(1, v / channels.length));
      out[i] = Math.round(v * 32767);
    }
    const u8 = new Uint8Array(out.buffer);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  });
};

/**
 * 音声・動画のバイト列を、共有の Chromium の Web Audio で 16 kHz に変換し、pickWindows が選んだ位置から
 * 12 秒ずつを、チャンネルの平均のモノラルの Int16 で返す。ファイルはまるごと変換する（途中だけは読まない）。
 */
export async function decodeAudioWindows(
  bytes: Uint8Array,
  pickWindows: (durationSec: number) => number[],
  tenantId?: string,
  options: { unprobedMaxBytes?: number } = {},
): Promise<DecodedWindows> {
  if (!resolveChromiumPath()) throw new Error('Chromium/Chrome が見つからないため音声を変換できません');
  // 呼んだ利用者の枠として数える（ブラウザの枠は、利用者ごとに公平に渡す）
  const lease = await browserSemaphore.acquire(tenantId);
  recordBrowserUsage(tenantId);
  try {
    const { browser, isDedicated } = await getBrowser(undefined, tenantId);
    const context = await createOfflineContext(browser);
    try {
      const page = await context.newPage();
      // バイト列を渡す前に、ページを閉じる（通信も移動もできない）
      await lockPageOffline(page);
      // デコードの前に、長さを調べる（デコードはファイル全体を PCM にするので、長い音は、メモリを使い切る）
      const probe = await page.evaluate(probeInPage, Buffer.from(bytes).toString('base64'));
      const limitSec = limits().audioMaxDurationSec;
      if (probe.ok ? probe.durationSec > limitSec : bytes.byteLength > (options.unprobedMaxBytes ?? UNPROBED_MAX_BYTES)) throw new AudioTooLongError(probe.ok ? probe.durationSec : undefined, limitSec);
      const decoded = await page.evaluate(decodeInPage, SAMPLE_RATE);
      if (!decoded.ok) throw new AudioDecodeError(decoded.error);
      const offsets = pickWindows(decoded.durationSec);
      const pcm = await page.evaluate(extractInPage, offsets, WINDOW_SECONDS, SAMPLE_RATE);
      return {
        durationSec: decoded.durationSec,
        // Buffer の byteOffset は 2 の倍数とは限らないので、写してから Int16 として読む
        windows: offsets.map((offsetSec, i) => ({ offsetSec, pcm: new Int16Array(Uint8Array.from(Buffer.from(pcm[i], 'base64')).buffer) })),
      };
    } finally {
      if (isDedicated) await browser.close();
      else await context.close();
    }
  } finally {
    lease();
  }
}
