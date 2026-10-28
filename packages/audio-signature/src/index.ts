/*!
 * @ikenokazuki/audio-signature — 16 kHz・モノラルの PCM から、楽曲認識に使う音の指紋（SigX の形）を作り、その形を確かめる。
 *
 * omkarcloud の sigx.py（Python）を TypeScript に移植した。2048 点の Hanning 窓の FFT を 128 サンプルごとに取り、
 * 3 つの帯（250〜520 Hz、520〜1450 Hz、1450〜3500 Hz）のピークを、magic 0xCAFE2580・CRC-32・帯ごとの TLV の 2 進の形に詰める。
 *
 * The signature code below is ported from omkarcloud (sigx.py) under the MIT License:
 *
 * MIT License
 *
 * Copyright (c) 2026 Chetan Jain
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const SAMPLE_RATE = 16000;
/** 1 回に送る長さ（参照の実装と同じ） */
export const WINDOW_SECONDS = 12;
export const MIN_WINDOW_SECONDS = 3;

const MAX_PEAKS = 255;
const SAMPLE_RATE_ID = 3; // ヘッダーの 16 kHz の番号
const FFT_SIZE = 2048;
const BIN_COUNT = 1025;
const HISTORY = 256;
// 帯（下限・上限・TLV の番号）。250 Hz 未満は捨て、3.5〜5.5 kHz の帯は昔の形式では使わない
const BANDS: ReadonlyArray<readonly [number, number, number]> = [[250, 520, 0], [520, 1450, 1], [1450, 3500, 2]];
const NEIGHBOUR_OFFSETS = [-10, -7, -4, -3, 1, 2, 5, 8];
const OTHER_FFT_OFFSETS = [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249];
const MAGNITUDE_FLOOR = 1 / 64;
const LOG_SCALE = 1477.3;
const LOG_OFFSET = 6144;
// numpy.hanning(2050)[1:-1]（両端の 0 を除く）
const HANNING = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (FFT_SIZE + 1)));
const REVERSED = Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
  let r = 0;
  for (let b = 0; b < 11; b++) r = (r << 1) | ((i >> b) & 1);
  return r;
});
const COS = Float64Array.from({ length: FFT_SIZE / 2 }, (_, k) => Math.cos((2 * Math.PI * k) / FFT_SIZE));
const SIN = Float64Array.from({ length: FFT_SIZE / 2 }, (_, k) => Math.sin((2 * Math.PI * k) / FFT_SIZE));
const fftRe = new Float64Array(FFT_SIZE);
const fftIm = new Float64Array(FFT_SIZE);

export class SignatureTooShortError extends Error {}

export interface Peak { fftPass: number; magnitude: number; correctedBin: number }

const ring = (i: number) => ((i % HISTORY) + HISTORY) % HISTORY;

/** 実数 2048 点の FFT の |X[k]|² / 2^17（k = 0..1024）。numpy.fft.rfft のあとの参照の実装と同じ値。 */
export function powerSpectrum(frame: Float64Array, out: Float64Array): void {
  for (let i = 0; i < FFT_SIZE; i++) {
    fftRe[REVERSED[i]] = frame[i];
    fftIm[i] = 0;
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step];
        const wi = -SIN[k * step];
        const a = start + k;
        const b = a + half;
        const tr = fftRe[b] * wr - fftIm[b] * wi;
        const ti = fftRe[b] * wi + fftIm[b] * wr;
        fftRe[b] = fftRe[a] - tr;
        fftIm[b] = fftIm[a] - ti;
        fftRe[a] += tr;
        fftIm[a] += ti;
      }
    }
  }
  for (let k = 0; k < BIN_COUNT; k++) out[k] = (fftRe[k] * fftRe[k] + fftIm[k] * fftIm[k]) / (1 << 17);
}

const u16 = (out: number[], v: number) => { out.push(v & 0xff, (v >>> 8) & 0xff); };
const u32 = (out: number[], v: number) => { out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };

/** Int16 のサンプルを読み、時間と周波数のピークを集めて、指紋の 2 進の形にする。 */
export class SignatureGenerator {
  numberSamples = 0;
  readonly peaks: Peak[][] = [[], [], []];
  private readonly samples = new Float64Array(FFT_SIZE);
  private samplesPos = 0;
  private readonly ffts = Array.from({ length: HISTORY }, () => new Float64Array(BIN_COUNT));
  private fftPos = 0;
  private readonly spread = Array.from({ length: HISTORY }, () => new Float64Array(BIN_COUNT));
  private spreadPos = 0;
  private written = 0;
  private readonly frame = new Float64Array(FFT_SIZE);

  constructor(private readonly maxSeconds = WINDOW_SECONDS, private readonly maxPeaks = MAX_PEAKS) {}

  /** 128 サンプルずつ読み、窓が十分に長く、ピークも十分になったら止める（参照の実装の止め方）。読んだ数を返す。 */
  feed(samples: Int16Array): number {
    const total = samples.length - (samples.length % 128);
    let used = 0;
    while (used < total && (this.numberSamples / SAMPLE_RATE < this.maxSeconds || this.peakCount() < this.maxPeaks)) {
      this.step(samples.subarray(used, used + 128));
      used += 128;
    }
    return used;
  }

  peakCount(): number {
    return this.peaks[0].length + this.peaks[1].length + this.peaks[2].length;
  }

  private step(chunk: Int16Array): void {
    this.numberSamples += chunk.length;
    this.fft(chunk);
    this.spreadPeaks();
    if (this.written >= 46) this.pickPeaks();
  }

  private fft(chunk: Int16Array): void {
    this.samples.set(chunk, this.samplesPos);
    this.samplesPos = (this.samplesPos + chunk.length) % FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) this.frame[i] = HANNING[i] * this.samples[(this.samplesPos + i) % FFT_SIZE];
    const out = this.ffts[this.fftPos];
    powerSpectrum(this.frame, out);
    for (let k = 0; k < BIN_COUNT; k++) if (out[k] < 1e-10) out[k] = 1e-10;
    this.fftPos = (this.fftPos + 1) % HISTORY;
  }

  private spreadPeaks(): void {
    const last = this.ffts[ring(this.fftPos - 1)];
    // sigx.py の self._spread[self._spread_pos] = spread と同じ行。下の s1・s3・s6 とは別の行なので、先に書いても結果は同じ
    const spread = this.spread[this.spreadPos];
    for (let k = 0; k < BIN_COUNT - 3; k++) spread[k] = Math.max(last[k], last[k + 1], last[k + 2]);
    for (let k = BIN_COUNT - 3; k < BIN_COUNT; k++) spread[k] = last[k];
    const s1 = this.spread[ring(this.spreadPos - 1)];
    const s3 = this.spread[ring(this.spreadPos - 3)];
    const s6 = this.spread[ring(this.spreadPos - 6)];
    for (let k = 0; k < BIN_COUNT; k++) {
      const a = Math.max(spread[k], s1[k]);
      const b = Math.max(a, s3[k]);
      s1[k] = a;
      s3[k] = b;
      s6[k] = Math.max(b, s6[k]);
    }
    this.spreadPos = (this.spreadPos + 1) % HISTORY;
    this.written++;
  }

  private pickPeaks(): void {
    const fft46 = this.ffts[ring(this.fftPos - 46)];
    const s49 = this.spread[ring(this.spreadPos - 49)];
    const fftNumber = this.written - 46;
    for (let bin = 10; bin <= 1014; bin++) {
      const value = fft46[bin];
      if (value < MAGNITUDE_FLOOR || value < s49[bin - 1]) continue;
      let neighbours = 0;
      for (const o of NEIGHBOUR_OFFSETS) neighbours = Math.max(neighbours, s49[bin + o]);
      if (!(value > neighbours)) continue;
      let others = neighbours;
      for (const o of OTHER_FFT_OFFSETS) others = Math.max(others, this.spread[ring(this.spreadPos + o)][bin - 1]);
      if (!(value > others)) continue;
      const mag = Math.log(Math.max(MAGNITUDE_FLOOR, value)) * LOG_SCALE + LOG_OFFSET;
      const before = Math.log(Math.max(MAGNITUDE_FLOOR, fft46[bin - 1])) * LOG_SCALE + LOG_OFFSET;
      const after = Math.log(Math.max(MAGNITUDE_FLOOR, fft46[bin + 1])) * LOG_SCALE + LOG_OFFSET;
      const variation = mag * 2 - before - after;
      if (variation <= 0) continue;
      const correctedBin = bin * 64 + ((after - before) * 32) / variation;
      const frequency = correctedBin * (SAMPLE_RATE / 2 / 1024 / 64);
      for (const [low, high, band] of BANDS) {
        if (low < frequency && frequency < high) {
          this.peaks[band].push({ fftPass: fftNumber, magnitude: Math.trunc(mag), correctedBin: Math.trunc(correctedBin) });
          break;
        }
      }
    }
  }

  encode(): Uint8Array {
    const body: number[] = [];
    this.peaks.forEach((bandPeaks, band) => {
      if (bandPeaks.length === 0) return; // 参照の実装は、ピークのある帯だけを書く
      const raw: number[] = [];
      let lastPass = 0;
      for (const p of bandPeaks) {
        if (p.fftPass - lastPass >= 255) {
          raw.push(0xff);
          u32(raw, p.fftPass);
          lastPass = p.fftPass;
        }
        raw.push(p.fftPass - lastPass);
        u16(raw, p.magnitude);
        u16(raw, p.correctedBin);
        lastPass = p.fftPass;
      }
      u32(body, 0x60030040 + band);
      u32(body, raw.length);
      for (const b of raw) body.push(b);
      for (let i = raw.length % 4; i > 0 && i < 4; i++) body.push(0);
    });
    const sizeMinusHeader = body.length + 8;
    const rest: number[] = [];
    for (const v of [sizeMinusHeader, 0x94119c00, 0, 0, 0, SAMPLE_RATE_ID << 27, 0, 0, Math.trunc(this.numberSamples + SAMPLE_RATE * 0.24), (15 << 19) + 0x40000, 0x40000000, sizeMinusHeader]) u32(rest, v);
    for (const b of body) rest.push(b);
    const restBytes = Uint8Array.from(rest);
    const out = new Uint8Array(8 + restBytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0xcafe2580, true);
    view.setUint32(4, crc32(restBytes), true);
    out.set(restBytes, 8);
    return out;
  }


  sampleMs(): number {
    return Math.trunc(this.numberSamples / (SAMPLE_RATE / 1000)); // 16 で割る（浮動小数の ×1000 だと 1 小さくなる長さがある）
  }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** 標準の CRC-32（多項式 0xEDB88320）。符号なしで返す。 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** バイト列を base64 にする（0x8000 バイトずつ文字にして btoa に渡す）。 */
export function encodeBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** base64 をバイト列に戻す。atob が読めない文字列は null。 */
export function decodeBase64(text: string): Uint8Array | null {
  let s: string;
  try {
    s = atob(text);
  } catch {
    return null;
  }
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** 16 kHz・モノラルの Int16 → 指紋のバイト列と長さ（ミリ秒）。先頭の 12 秒だけを使う。短すぎる・静かすぎる音は SignatureTooShortError。 */
export function createSignature(pcm: Int16Array): { bytes: Uint8Array; sampleMs: number } {
  const gen = new SignatureGenerator();
  gen.feed(pcm.subarray(0, SAMPLE_RATE * WINDOW_SECONDS));
  if (gen.numberSamples < SAMPLE_RATE * MIN_WINDOW_SECONDS || gen.peakCount() === 0) {
    throw new SignatureTooShortError('音が短すぎるか静かすぎて、指紋を作れません');
  }
  return { bytes: gen.encode(), sampleMs: gen.sampleMs() };
}

/** 作り済みの指紋のバイト列が、encode() の形か。長さ・先頭の印・CRC-32・大きさの欄・長さ（sampleMs）を見る（すべてリトルエンディアン）。 */
export function checkSignature(bytes: Uint8Array, sampleMs: number): boolean {
  if (bytes.length < 56) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === 0xcafe2580
    && view.getUint32(4, true) === crc32(bytes.subarray(8))
    && view.getUint32(8, true) === bytes.length - 48
    && Math.trunc((view.getUint32(40, true) - 3840) / 16) === sampleMs;
}

/** base64 の指紋が、読めて、正規の base64 に戻り（往復する）、checkSignature も満たすか。 */
export function checkSignatureBase64(signature: string, sampleMs: number): boolean {
  const bytes = decodeBase64(signature);
  return bytes !== null && encodeBase64(bytes) === signature && checkSignature(bytes, sampleMs);
}
