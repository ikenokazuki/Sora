import { browserSemaphore, getBrowser, recordBrowserUsage, resolveChromiumPath } from '../browser_engine.js';
import { SAMPLE_RATE, WINDOW_SECONDS } from './shazam_signature.js';

/** 音声・動画として読めないバイト列（Chromium の decodeAudioData が断った）。 */
export class AudioDecodeError extends Error {}

export interface DecodedWindows {
  durationSec: number;
  windows: Array<{ offsetSec: number; pcm: Int16Array }>;
}

type PageGlobal = { __soraAudio?: AudioBuffer };

// 以下の 2 つはページの中で動く（puppeteer が関数の文字列を送る）。外の変数を参照しない
const decodeInPage = async (b64: string, rate: number) => {
  try {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    // decodeAudioData は、文脈の標本化周波数（16 kHz）に変換して返す
    const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data.buffer);
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
export async function decodeAudioWindows(bytes: Uint8Array, pickWindows: (durationSec: number) => number[]): Promise<DecodedWindows> {
  if (!resolveChromiumPath()) throw new Error('Chromium/Chrome が見つからないため音声を変換できません');
  await browserSemaphore.acquire();
  recordBrowserUsage();
  try {
    const { browser, isDedicated } = await getBrowser();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const decoded = await page.evaluate(decodeInPage, Buffer.from(bytes).toString('base64'), SAMPLE_RATE);
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
    browserSemaphore.release();
  }
}
