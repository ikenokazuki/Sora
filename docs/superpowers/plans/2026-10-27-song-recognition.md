# 音から曲を特定する（recognize_song）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 音声・動画ファイルの音から Shazam で曲を特定し、iTunes の曲とつないで返す MCP ツール `recognize_song` と REST `POST /music/recognize` を、名前を挙げたときだけ有効なモジュール `shazam` として足す。

**Architecture:** 音は URL（安全な取得、20 MB まで）かアップロード（10 MB まで）で受け取り、共有の Chromium の Web Audio で 16 kHz・モノラルにして、12 秒の窓を最大 3 つ切り出す。窓ごとに omkarcloud/shazam-scraper の `sigx.py`（MIT）を移植した指紋を作り、Shazam の iPhone アプリと同じ窓口に送る。当たった曲は、Apple の曲 ID で iTunes の lookup を引き（無ければ曲名とアーティストの一致する検索結果）、`search_song` と同じ形で返す。

**Tech Stack:** Bun、TypeScript、Hono、zod、puppeteer-core（既存の共有 Chromium）、MCP SDK。依存は足さない。

## Global Constraints

- 仕様書: `docs/superpowers/specs/2026-10-27-song-recognition-design.md`。
- モジュール名 `shazam`、ツール名 `recognize_song`、REST `POST /music/recognize`。`EXPLICIT_ONLY_MODULES` に入れる（`all` では有効にならない）。
- URL から読むのは 20 MB まで（`MAX_URL_BYTES = 20 * 1024 * 1024`）。アップロードは Sora 全体の上限（10 MB、超えると 413）。
- 窓は 12 秒（`WINDOW_SECONDS`）、最小 3 秒（`MIN_WINDOW_SECONDS`）、最大 3 回。
- iTunes の国の既定は `jp`。
- Shazam の窓口は `https://amp.shazam.com/discovery/v5/en/{国の大文字}/iphone/-/tag/{UUID}/{UUID}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v0`。ヘッダーは元のコードの `TAG_HEADERS` と同じ。ふつうの `fetch` で送り、TLS の偽装と再試行はしない。
- キャッシュは、当たり `CACHE_TTL_DEFAULT`（30 分）、外れ `CACHE_TTL_EMPTY`（60 秒）。エラーは残さない。
- テストは合成のデータだけ。実在の曲の音・歌詞を出力しない（実機の確認でも、出すのは曲名・ID・件数・時間だけ）。
- テストの実行は `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy` と、`CHROME_PATH` に nix の chromium（`ls -d /nix/store/*-chromium-*/bin/chromium | head -1`）。全件は `setsid` で切り離して `bun test --timeout 60000`。
- コミットに Claude の署名を付けない。コミットの本文に skip ci の文字列を書かない。
- PR・リリース・本番反映は、実機の確認のあとにユーザーに確かめてから行う（この計画の範囲外）。

---

### Task 1: 指紋（SigX）の移植

**Files:**
- Create: `src/services/shazam_signature.ts`
- Create: `src/test_fixtures/audio.ts`
- Test: `src/services/shazam_signature.test.ts`

**Interfaces:**
- Produces:
  - `SAMPLE_RATE = 16000`, `WINDOW_SECONDS = 12`, `MIN_WINDOW_SECONDS = 3`
  - `class SignatureTooShortError extends Error`
  - `powerSpectrum(frame: Float64Array, out: Float64Array): void`（2048 点 → 1025 個）
  - `interface Peak { fftPass: number; magnitude: number; correctedBin: number }`
  - `class SignatureGenerator { numberSamples: number; readonly peaks: Peak[][]; feed(samples: Int16Array): number; peakCount(): number; encode(): Uint8Array; uri(): string; sampleMs(): number }`
  - `signatureUri(samples: Int16Array, maxSeconds?: number): { uri: string; sampleMs: number }`
  - テスト用: `toneBursts(freqHz: number, seconds?: number, amplitude?: number): Int16Array`、`wavBytes(seconds: number, hz?: number, rate?: number): Uint8Array`（`src/test_fixtures/audio.ts`）

- [ ] **Step 1: テスト用の合成の音を作る**

`src/test_fixtures/audio.ts`:

```ts
// テスト用の合成の音。実在の曲の音は使わない。

/** 16 kHz・モノラルの Int16。Hann 形の包絡の 60 ms の音（tone burst）を 0.5 秒ごとに鳴らす。 */
export function toneBursts(freqHz: number, seconds = 12, amplitude = 8000): Int16Array {
  const rate = 16000;
  const out = new Int16Array(seconds * rate);
  const burst = Math.round(0.06 * rate);
  const period = Math.round(0.5 * rate);
  for (let start = 0; start + burst <= out.length; start += period) {
    for (let i = 0; i < burst; i++) {
      const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (burst - 1));
      out[start + i] = Math.round(amplitude * env * Math.sin((2 * Math.PI * freqHz * (start + i)) / rate));
    }
  }
  return out;
}

/** 44.1 kHz・ステレオ・16 bit の WAV（正弦波）。 */
export function wavBytes(seconds: number, hz = 440, rate = 44100): Uint8Array {
  const frames = seconds * rate;
  const out = new Uint8Array(44 + frames * 4);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + frames * 4, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(12000 * Math.sin((2 * Math.PI * hz * i) / rate));
    v.setInt16(44 + i * 4, s, true);
    v.setInt16(46 + i * 4, s, true);
  }
  return out;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`src/services/shazam_signature.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { toneBursts } from '../test_fixtures/audio.js';
import { MIN_WINDOW_SECONDS, SAMPLE_RATE, SignatureGenerator, SignatureTooShortError, powerSpectrum, signatureUri } from './shazam_signature.js';

const peakHz = (correctedBin: number) => correctedBin * (SAMPLE_RATE / 2 / 1024 / 64);
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);

describe('powerSpectrum', () => {
  test('matches a direct DFT', () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    const frame = Float64Array.from({ length: 2048 }, () => rand() * 1000);
    const out = new Float64Array(1025);
    powerSpectrum(frame, out);
    for (const k of [0, 1, 7, 100, 511, 1024]) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < 2048; n++) {
        re += frame[n] * Math.cos((2 * Math.PI * k * n) / 2048);
        im -= frame[n] * Math.sin((2 * Math.PI * k * n) / 2048);
      }
      expect(out[k]).toBeCloseTo((re * re + im * im) / (1 << 17), 3);
    }
  });
});

describe('SignatureGenerator peaks', () => {
  test.each([[440, 0], [1000, 1], [2000, 2]])('%d Hz bursts land in band %d near the tone', (hz, band) => {
    const gen = new SignatureGenerator();
    gen.feed(toneBursts(hz));
    expect(gen.peaks[band].length).toBeGreaterThan(0);
    for (const p of gen.peaks[band]) expect(Math.abs(peakHz(p.correctedBin) - hz)).toBeLessThan(15);
    expect(gen.peakCount()).toBe(gen.peaks[band].length);
  });

  test('tones outside the three bands give no peaks', () => {
    for (const hz of [200, 4000]) {
      const gen = new SignatureGenerator();
      gen.feed(toneBursts(hz));
      expect(gen.peakCount()).toBe(0);
    }
  });

  test('reads whole 128-sample steps only', () => {
    const gen = new SignatureGenerator();
    expect(gen.feed(new Int16Array(1000))).toBe(896);
    expect(gen.numberSamples).toBe(896);
  });
});

describe('encode', () => {
  test('writes the header, the CRC and one TLV per band that has peaks', () => {
    const gen = new SignatureGenerator();
    gen.numberSamples = 192000;
    gen.peaks[0].push({ fftPass: 3, magnitude: 1000, correctedBin: 3604 }, { fftPass: 300, magnitude: 1200, correctedBin: 3605 });
    const bytes = gen.encode();
    expect(u32(bytes, 0)).toBe(0xcafe2580);
    expect(u32(bytes, 4)).toBe(Bun.hash.crc32(bytes.subarray(8)) >>> 0);
    expect(u32(bytes, 8)).toBe(bytes.length - 48);
    expect(u32(bytes, 12)).toBe(0x94119c00);
    expect(u32(bytes, 28)).toBe(3 << 27);
    expect(u32(bytes, 40)).toBe(192000 + 3840);
    expect(u32(bytes, 44)).toBe((15 << 19) + 0x40000);
    expect(u32(bytes, 48)).toBe(0x40000000);
    expect(u32(bytes, 52)).toBe(bytes.length - 48);
    expect(u32(bytes, 56)).toBe(0x60030040);
    expect(u32(bytes, 60)).toBe(15);
    // 1 つ目: 差 3・1000・3604。2 つ目は 255 以上離れるので 0xff と通し番号 300 を書き、差 0・1200・3605。4 バイト境界まで 0
    expect([...bytes.subarray(64, 80)]).toEqual([0x03, 0xe8, 0x03, 0x14, 0x0e, 0xff, 0x2c, 0x01, 0x00, 0x00, 0x00, 0xb0, 0x04, 0x15, 0x0e, 0x00]);
    expect(bytes.length).toBe(80);
  });

  test('the data URI is the base64 of the bytes, and samplems follows the samples', () => {
    const gen = new SignatureGenerator();
    gen.numberSamples = 192000;
    gen.peaks[2].push({ fftPass: 0, magnitude: 1, correctedBin: 2 });
    expect(gen.uri()).toBe('data:audio/vnd.shazam.sig;base64,' + Buffer.from(gen.encode()).toString('base64'));
    expect(gen.sampleMs()).toBe(12000);
    expect(u32(gen.encode(), 56)).toBe(0x60030042);
  });
});

describe('signatureUri', () => {
  test('a 12 s window gives a data URI and 12000 ms', () => {
    const { uri, sampleMs } = signatureUri(toneBursts(1000));
    expect(uri.startsWith('data:audio/vnd.shazam.sig;base64,')).toBe(true);
    expect(sampleMs).toBe(12000);
  });

  test('too short or silent audio is refused', () => {
    expect(() => signatureUri(toneBursts(1000, MIN_WINDOW_SECONDS - 1))).toThrow(SignatureTooShortError);
    expect(() => signatureUri(new Int16Array(12 * SAMPLE_RATE))).toThrow(SignatureTooShortError);
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `bun test src/services/shazam_signature.test.ts`
Expected: FAIL（`Cannot find module './shazam_signature.js'`）

- [ ] **Step 4: 実装する**

`src/services/shazam_signature.ts`（先頭に元の MIT のライセンス表示を残す）:

```ts
/**
 * Shazam の音の指紋（SigX）。16 kHz・モノラルの PCM から、Shazam の tag の窓口に送る署名を作る。
 *
 * omkarcloud/shazam-scraper の shazam/sigx.py を TypeScript に移植した（元は shazamio / SongRec の参照実装の移植）。
 * 2048 点の Hanning 窓の FFT を 128 サンプルごとに取り、3 つの帯（250〜520 Hz、520〜1450 Hz、1450〜3500 Hz）の
 * ピークを、magic 0xCAFE2580・CRC-32・帯ごとの TLV の 2 進の形に詰める。
 *
 * The code below is ported from omkarcloud/shazam-scraper (shazam/sigx.py) under the MIT License:
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
const DATA_URI_PREFIX = 'data:audio/vnd.shazam.sig;base64,';
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

/** Int16 のサンプルを読み、時間と周波数のピークを集めて、Shazam の署名の 2 進の形にする。 */
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
    view.setUint32(4, Bun.hash.crc32(restBytes) >>> 0, true);
    out.set(restBytes, 8);
    return out;
  }

  uri(): string {
    return DATA_URI_PREFIX + Buffer.from(this.encode()).toString('base64');
  }

  sampleMs(): number {
    return Math.trunc((this.numberSamples / SAMPLE_RATE) * 1000);
  }
}

/** 16 kHz・モノラルの Int16 → tag の窓口に送る data URI と長さ（ミリ秒）。短すぎる・静かすぎる音は SignatureTooShortError。 */
export function signatureUri(samples: Int16Array, maxSeconds = WINDOW_SECONDS): { uri: string; sampleMs: number } {
  const gen = new SignatureGenerator(maxSeconds);
  gen.feed(samples);
  if (gen.numberSamples < SAMPLE_RATE * MIN_WINDOW_SECONDS || gen.peakCount() === 0) {
    throw new SignatureTooShortError('音が短すぎるか静かすぎて、指紋を作れません');
  }
  return { uri: gen.uri(), sampleMs: gen.sampleMs() };
}
```

注意（元のコードとの対応）: `spreadPeaks` で書き込む行は、`sigx.py` の `self._spread[self._spread_pos] = spread` と同じ行（`spreadPos`）。`s1`・`s3`・`s6` は `spreadPos` と別の行なので、先に `spread` を書いても結果は同じ。

- [ ] **Step 5: 通ることを確かめる**

Run: `bun test src/services/shazam_signature.test.ts`
Expected: PASS（9 件）。tone burst でピークが出ないときは、テストの音（長さ・間隔）ではなく実装と `sigx.py` の対応をまず見直す。

- [ ] **Step 6: コミット**

```bash
git add src/services/shazam_signature.ts src/services/shazam_signature.test.ts src/test_fixtures/audio.ts
git commit -m "feat(shazam): Shazam の音の指紋（SigX）を TypeScript に移植する"
```

---

### Task 2: Chromium での 16 kHz への変換

**Files:**
- Create: `src/services/audio_decode.ts`
- Test: `src/services/audio_decode.test.ts`

**Interfaces:**
- Consumes: `browserSemaphore`, `getBrowser`, `recordBrowserUsage`, `resolveChromiumPath`（`src/browser_engine.ts`）、`SAMPLE_RATE`・`WINDOW_SECONDS`（Task 1）、`wavBytes`（Task 1 の fixture）
- Produces:
  - `class AudioDecodeError extends Error`
  - `interface DecodedWindows { durationSec: number; windows: Array<{ offsetSec: number; pcm: Int16Array }> }`
  - `decodeAudioWindows(bytes: Uint8Array, pickWindows: (durationSec: number) => number[]): Promise<DecodedWindows>`

- [ ] **Step 1: 失敗するテストを書く**

`src/services/audio_decode.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { closeSharedBrowser, resolveChromiumPath } from '../browser_engine.js';
import { wavBytes } from '../test_fixtures/audio.js';
import { AudioDecodeError, decodeAudioWindows } from './audio_decode.js';

const crossings = (pcm: Int16Array) => {
  let n = 0;
  for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) n++;
  return n;
};

describe.skipIf(!resolveChromiumPath())('decodeAudioWindows (Chromium Web Audio)', () => {
  afterAll(async () => {
    await closeSharedBrowser();
  });

  test('resamples to 16 kHz mono and cuts the chosen windows', async () => {
    let seen = -1;
    const out = await decodeAudioWindows(wavBytes(20), (d) => {
      seen = d;
      return [0, 12];
    });
    expect(seen).toBeCloseTo(20, 1);
    expect(out.durationSec).toBeCloseTo(20, 1);
    expect(out.windows.map((w) => w.offsetSec)).toEqual([0, 12]);
    expect(out.windows[0].pcm.length).toBe(12 * 16000);
    expect(out.windows[1].pcm.length).toBe(8 * 16000);
    expect(Math.abs(crossings(out.windows[0].pcm) - 2 * 440 * 12)).toBeLessThan(2 * 440 * 12 * 0.01);
  });

  test('bytes that are not audio fail with AudioDecodeError', async () => {
    await expect(decodeAudioWindows(new TextEncoder().encode('<html>not audio</html>'), () => [0])).rejects.toBeInstanceOf(AudioDecodeError);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `CHROME_PATH=<nix の chromium> bun test src/services/audio_decode.test.ts`
Expected: FAIL（`Cannot find module './audio_decode.js'`）

- [ ] **Step 3: 実装する**

`src/services/audio_decode.ts`:

```ts
import { browserSemaphore, getBrowser, recordBrowserUsage, resolveChromiumPath } from '../browser_engine.js';
import { SAMPLE_RATE, WINDOW_SECONDS } from './shazam_signature.js';

/** 音声・動画として読めないバイト列（Chromium の decodeAudioData が断った）。 */
export class AudioDecodeError extends Error {}

export interface DecodedWindows {
  durationSec: number;
  windows: Array<{ offsetSec: number; pcm: Int16Array }>;
}

// 以下の 2 つはページの中で動く（puppeteer が関数の文字列を送る）。外の変数を参照しない
const decodeInPage = async (b64: string, rate: number) => {
  try {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    // decodeAudioData は、文脈の標本化周波数（16 kHz）に変換して返す
    const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data.buffer);
    (globalThis as { __soraAudio?: AudioBuffer }).__soraAudio = buf;
    return { ok: true as const, durationSec: buf.duration };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
};

const extractInPage = (offsets: number[], windowSec: number, rate: number) => {
  const buf = (globalThis as { __soraAudio?: AudioBuffer }).__soraAudio as AudioBuffer;
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
        windows: offsets.map((offsetSec, i) => {
          const raw = Buffer.from(pcm[i], 'base64');
          return { offsetSec, pcm: new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2) };
        }),
      };
    } finally {
      if (isDedicated) await browser.close();
      else await context.close();
    }
  } finally {
    browserSemaphore.release();
  }
}
```

注意: `Buffer.from(base64)` は 2 の倍数の長さでも `byteOffset` が奇数になることがあり、そのとき `Int16Array` が作れない。作れなければ `new Int16Array(Uint8Array.from(raw).buffer)` で写す（Step 4 で失敗したら直す）。

- [ ] **Step 4: 通ることを確かめる**

Run: `CHROME_PATH=<nix の chromium> bun test src/services/audio_decode.test.ts`
Expected: PASS（2 件）

- [ ] **Step 5: コミット**

```bash
git add src/services/audio_decode.ts src/services/audio_decode.test.ts
git commit -m "feat(shazam): 音声を共有の Chromium の Web Audio で 16 kHz のモノラルにする"
```

---

### Task 3: 認識の本体（取得・窓・Shazam・iTunes・キャッシュ）

**Files:**
- Create: `src/services/song_recognition.ts`
- Modify: `src/services/music.ts`（検索の変換を `toMusicItem` に切り出す）
- Test: `src/services/song_recognition.test.ts`

**Interfaces:**
- Consumes: Task 1・Task 2 の全部、`fetchWithSafeRedirects`（`src/http_fetcher.ts:358`）、`readBodyWithLimit`（`src/net/safe_transport.ts:9`）、`cacheKeyDigest`・`getFromCache`・`setToCache`・`runWithSingleFlight`・`CACHE_TTL_DEFAULT`・`CACHE_TTL_EMPTY`・`clearCache`（`src/cache.ts`）、`errorMessage`（`src/errors.ts`）
- Produces:
  - `toMusicItem(r: any, entity: string): MusicItem`（`src/services/music.ts`）
  - `MAX_URL_BYTES`、`class SongRecognitionInputError extends Error`
  - `interface ShazamTrack { key; title; artist; isrc?; appleMusicId?; album?; label?; released?; genre?; url?; artwork? }`（全部 string）
  - `type SongRecognitionReason = 'no-match' | 'not-audio' | 'too-short' | 'too-large' | 'download-failed'`
  - `interface SongRecognitionResult { found; reason?; message?; itunes: MusicItem | null; itunesMatch: 'apple-id' | 'title-artist' | null; shazam?; match?: { songOffsetSec?: number; clipOffsetSec: number }; attempts: Array<{ offsetSec; durationSec; matched }>; audio?: { bytes; durationSec?; contentType }; cached? }`
  - `interface SongRecognitionOptions { url?: string; audio?: { bytes: Uint8Array; contentType?: string }; offsetSec?: number; country?: string; noCache?: boolean }`
  - `interface SongRecognitionDeps { fetchFn?; download?; decode? }`
  - `pickWindows(durationSec: number, offsetSec?: number): number[]`
  - `downloadAudio(url: string, fetcher?): Promise<{ bytes; contentType } | { reason: 'not-audio' | 'too-large' | 'download-failed'; message }>`
  - `parseShazamResponse(body: unknown): { track: ShazamTrack; songOffsetSec?: number } | null`
  - `recognizeSong(options: SongRecognitionOptions, deps?: SongRecognitionDeps): Promise<SongRecognitionResult>`

- [ ] **Step 1: 失敗するテストを書く**

`src/services/song_recognition.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { clearCache } from '../cache.js';
import { toneBursts } from '../test_fixtures/audio.js';
import { AudioDecodeError } from './audio_decode.js';
import { MAX_URL_BYTES, SongRecognitionInputError, downloadAudio, parseShazamResponse, pickWindows, recognizeSong } from './song_recognition.js';

// 合成の音と、作り物の Shazam・iTunes の応答だけを使う
const TRACK = {
  key: '900001', title: 'テスト曲', subtitle: 'テスト歌手', isrc: 'JPZZ02600001',
  genres: { primary: 'J-Pop' }, images: { coverart: 'https://img.example/c.jpg', coverarthq: 'https://img.example/hq.jpg' },
  url: 'https://www.shazam.com/track/900001/test', trackadamid: '1700000001',
  sections: [{ type: 'SONG', metadata: [{ title: 'Album', text: 'テストアルバム' }, { title: 'Label', text: 'テストレーベル' }, { title: 'Released', text: '2026' }] }],
};
const HIT = { matches: [{ id: '900001', offset: 61.25, timeskew: 0.0001, frequencyskew: 0 }], track: TRACK, tagid: 'X' };
const ITUNES_TRACK = {
  wrapperType: 'track', kind: 'song', trackId: 1700000001, trackName: 'テスト曲', artistName: 'テスト歌手', collectionName: 'テストアルバム',
  artworkUrl100: 'https://img.example/a/100x100bb.jpg', previewUrl: 'https://audio.example/p.m4a', releaseDate: '2026-01-01T00:00:00Z',
  primaryGenreName: 'J-Pop', trackTimeMillis: 200000, trackViewUrl: 'https://music.apple.com/jp/album/x/1?i=1700000001',
};

function fakeFetch(handlers: { shazam?: (n: number) => Response; lookup?: () => Response; search?: () => Response }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let shazamCalls = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.startsWith('https://amp.shazam.com/')) return (handlers.shazam ?? (() => Response.json({ matches: [] })))(++shazamCalls);
    if (url.startsWith('https://itunes.apple.com/lookup')) return (handlers.lookup ?? (() => Response.json({ resultCount: 1, results: [ITUNES_TRACK] })))();
    if (url.startsWith('https://itunes.apple.com/search')) return (handlers.search ?? (() => Response.json({ resultCount: 0, results: [] })))();
    throw new Error('unexpected fetch ' + url);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const decodeOk = (durationSec = 30) => async (_bytes: Uint8Array, pick: (d: number) => number[]) =>
  ({ durationSec, windows: pick(durationSec).map((offsetSec) => ({ offsetSec, pcm: toneBursts(1000) })) });
const audio = (n: number) => ({ bytes: new Uint8Array([1, 2, 3, n]), contentType: 'audio/mp4' });
const shazamCallsOf = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.startsWith('https://amp.shazam.com/')).length;

beforeEach(() => {
  clearCache();
});

describe('pickWindows', () => {
  test('follows the reference client', () => {
    expect(pickWindows(30)).toEqual([0, 12, 24]);
    expect(pickWindows(100)).toEqual([44, 0, 12]);
    expect(pickWindows(10)).toEqual([0]);
    expect(pickWindows(2)).toEqual([0]);
    expect(pickWindows(100, 7)).toEqual([7]);
  });
});

describe('parseShazamResponse', () => {
  test('reads the track, the Apple id and where in the song the clip is', () => {
    expect(parseShazamResponse(HIT)).toEqual({
      track: {
        key: '900001', title: 'テスト曲', artist: 'テスト歌手', isrc: 'JPZZ02600001', appleMusicId: '1700000001',
        album: 'テストアルバム', label: 'テストレーベル', released: '2026', genre: 'J-Pop',
        url: 'https://www.shazam.com/track/900001/test', artwork: 'https://img.example/hq.jpg',
      },
      songOffsetSec: 61.25,
    });
  });

  test('finds the Apple id in the hub when trackadamid is missing', () => {
    const { trackadamid: _, ...rest } = TRACK;
    const viaAction = { ...HIT, track: { ...rest, hub: { actions: [{ type: 'applemusicplay', id: '1700000002' }] } } };
    expect(parseShazamResponse(viaAction)?.track.appleMusicId).toBe('1700000002');
    const viaOption = { ...HIT, track: { ...rest, hub: { options: [{ actions: [{ type: 'uri', uri: 'https://music.apple.com/jp/album/x/1700000000?i=1700000003&mttnagencyid=s2n' }] }] } } };
    expect(parseShazamResponse(viaOption)?.track.appleMusicId).toBe('1700000003');
  });

  test('no track is no match', () => {
    expect(parseShazamResponse({ matches: [] })).toBeNull();
    expect(parseShazamResponse(null)).toBeNull();
  });
});

describe('recognizeSong', () => {
  test('sends one signature per window until Shazam matches, then links iTunes by the Apple id', async () => {
    const { fn, calls } = fakeFetch({ shazam: (n) => Response.json(n === 2 ? HIT : { matches: [] }) });
    const out = await recognizeSong({ audio: audio(1) }, { fetchFn: fn, decode: decodeOk(30) });
    expect(out).toMatchObject({
      found: true, itunesMatch: 'apple-id', itunes: { id: '1700000001', title: 'テスト曲', artist: 'テスト歌手' },
      shazam: { key: '900001' }, match: { songOffsetSec: 61.25, clipOffsetSec: 12 },
    });
    expect(out.attempts).toEqual([{ offsetSec: 0, durationSec: 12, matched: false }, { offsetSec: 12, durationSec: 12, matched: true }]);
    expect(out.audio).toEqual({ bytes: 4, durationSec: 30, contentType: 'audio/mp4' });
    const tag = calls.filter((c) => c.url.startsWith('https://amp.shazam.com/'));
    expect(tag).toHaveLength(2);
    expect(tag[0].url).toMatch(/^https:\/\/amp\.shazam\.com\/discovery\/v5\/en\/JP\/iphone\/-\/tag\/[0-9A-F-]{36}\/[0-9A-F-]{36}\?sync=true/);
    expect((tag[0].init?.headers as Record<string, string>)['X-Shazam-Platform']).toBe('IPHONE');
    const body = JSON.parse(String(tag[0].init?.body));
    expect(body.signature.uri.startsWith('data:audio/vnd.shazam.sig;base64,')).toBe(true);
    expect(body.signature.samplems).toBe(12000);
    expect(calls.find((c) => c.url.startsWith('https://itunes.apple.com/lookup'))?.url).toBe('https://itunes.apple.com/lookup?id=1700000001&country=jp&entity=song');
  });

  test('falls back to an exact title and artist match in the iTunes search, else null', async () => {
    const lookupEmpty = () => Response.json({ resultCount: 0, results: [] });
    const near = { ...ITUNES_TRACK, trackId: 1700000009, trackName: 'テスト曲 (Live)' };
    const exact = { ...ITUNES_TRACK, trackId: 1700000010, trackName: 'ﾃｽﾄ曲', artistName: 'テスト 歌手' };
    const both = fakeFetch({ shazam: () => Response.json(HIT), lookup: lookupEmpty, search: () => Response.json({ resultCount: 2, results: [near, exact] }) });
    expect(await recognizeSong({ audio: audio(2) }, { fetchFn: both.fn, decode: decodeOk() })).toMatchObject({ itunesMatch: 'title-artist', itunes: { id: '1700000010' } });
    const onlyNear = fakeFetch({ shazam: () => Response.json(HIT), lookup: lookupEmpty, search: () => Response.json({ resultCount: 1, results: [near] }) });
    expect(await recognizeSong({ audio: audio(3) }, { fetchFn: onlyNear.fn, decode: decodeOk() })).toMatchObject({ found: true, itunesMatch: null, itunes: null });
  });

  test('an iTunes failure keeps the match', async () => {
    const { fn } = fakeFetch({ shazam: () => Response.json(HIT), lookup: () => new Response('down', { status: 503 }) });
    expect(await recognizeSong({ audio: audio(4) }, { fetchFn: fn, decode: decodeOk() })).toMatchObject({ found: true, itunes: null, itunesMatch: null });
  });

  test('caches by the audio bytes, offset and country; noCache skips it', async () => {
    const { fn, calls } = fakeFetch({ shazam: () => Response.json(HIT) });
    const first = await recognizeSong({ audio: audio(5), offsetSec: 5 }, { fetchFn: fn, decode: decodeOk() });
    expect(first.attempts).toEqual([{ offsetSec: 5, durationSec: 12, matched: true }]);
    expect((await recognizeSong({ audio: audio(5), offsetSec: 5 }, { fetchFn: fn, decode: decodeOk() })).cached).toBe(true);
    expect(shazamCallsOf(calls)).toBe(1);
    await recognizeSong({ audio: audio(5), offsetSec: 6 }, { fetchFn: fn, decode: decodeOk() });
    await recognizeSong({ audio: audio(5), offsetSec: 5, country: 'us' }, { fetchFn: fn, decode: decodeOk() });
    await recognizeSong({ audio: audio(5), offsetSec: 5, noCache: true }, { fetchFn: fn, decode: decodeOk() });
    expect(shazamCallsOf(calls)).toBe(4);
  });

  test('no match, not audio and too short are found:false with a reason', async () => {
    const { fn } = fakeFetch({});
    expect(await recognizeSong({ audio: audio(6) }, { fetchFn: fn, decode: decodeOk(30) })).toMatchObject({ found: false, reason: 'no-match', itunes: null, itunesMatch: null });
    const broken = async () => { throw new AudioDecodeError('EncodingError: Unable to decode audio data'); };
    expect(await recognizeSong({ audio: audio(7) }, { fetchFn: fn, decode: broken })).toMatchObject({ found: false, reason: 'not-audio' });
    expect(await recognizeSong({ audio: audio(8) }, { fetchFn: fn, decode: decodeOk(2) })).toMatchObject({ found: false, reason: 'too-short' });
    const html = { bytes: new Uint8Array([60]), contentType: 'text/html; charset=utf-8' };
    expect(await recognizeSong({ audio: html }, { fetchFn: fn, decode: decodeOk() })).toMatchObject({ found: false, reason: 'not-audio' });
  });

  test('a silent window is skipped, and only silence is too short', async () => {
    const { fn, calls } = fakeFetch({ shazam: () => Response.json(HIT) });
    const silentFirst = async (_b: Uint8Array, pick: (d: number) => number[]) => ({
      durationSec: 30, windows: pick(30).map((offsetSec, i) => ({ offsetSec, pcm: i === 0 ? new Int16Array(12 * 16000) : toneBursts(1000) })),
    });
    expect(await recognizeSong({ audio: audio(9) }, { fetchFn: fn, decode: silentFirst })).toMatchObject({ found: true, match: { clipOffsetSec: 12 } });
    const silence = async (_b: Uint8Array, pick: (d: number) => number[]) => ({ durationSec: 30, windows: pick(30).map((offsetSec) => ({ offsetSec, pcm: new Int16Array(12 * 16000) })) });
    expect(await recognizeSong({ audio: audio(10) }, { fetchFn: fn, decode: silence })).toMatchObject({ found: false, reason: 'too-short' });
    expect(shazamCallsOf(calls)).toBe(1);
  });

  test('Shazam refusals and outages are errors that name the status', async () => {
    let n = 20;
    for (const status of [403, 429, 503]) {
      const { fn } = fakeFetch({ shazam: () => new Response('no', { status }) });
      await expect(recognizeSong({ audio: audio(n++) }, { fetchFn: fn, decode: decodeOk() })).rejects.toThrow(`Shazam HTTP ${status}`);
    }
    const slow = (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch;
    await expect(recognizeSong({ audio: audio(n++) }, { fetchFn: slow, decode: decodeOk() })).rejects.toThrow('timed out');
  });

  test('needs a url or an upload, only http(s) urls, and a two-letter country', async () => {
    await expect(recognizeSong({})).rejects.toBeInstanceOf(SongRecognitionInputError);
    await expect(recognizeSong({ url: 'file:///etc/passwd' })).rejects.toBeInstanceOf(SongRecognitionInputError);
    await expect(recognizeSong({ audio: audio(30), country: 'japan' })).rejects.toBeInstanceOf(SongRecognitionInputError);
  });
});

describe('downloadAudio', () => {
  const via = (res: Response) => async () => ({ finalUrl: 'https://cdn.example/a.m4a', response: res });

  test('returns the bytes and the content type', async () => {
    const res = new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mp4' } });
    expect(await downloadAudio('https://cdn.example/a.m4a', via(res))).toEqual({ bytes: new Uint8Array([1, 2]), contentType: 'audio/mp4' });
  });

  test('an error page, an HTML page, a big file and a failed fetch are reasons, not errors', async () => {
    expect(await downloadAudio('https://x.example/a', via(new Response('gone', { status: 404 })))).toMatchObject({ reason: 'download-failed' });
    expect(await downloadAudio('https://x.example/a', via(new Response('<html>', { headers: { 'content-type': 'text/html' } })))).toMatchObject({ reason: 'not-audio' });
    expect(await downloadAudio('https://x.example/a', via(new Response(new Uint8Array(MAX_URL_BYTES + 1))))).toMatchObject({ reason: 'too-large' });
    expect(await downloadAudio('https://x.example/a', async () => { throw new Error('getaddrinfo ENOTFOUND x.example'); })).toMatchObject({ reason: 'download-failed' });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test src/services/song_recognition.test.ts`
Expected: FAIL（`Cannot find module './song_recognition.js'`）

- [ ] **Step 3: `music.ts` の変換を切り出す**

`src/services/music.ts` の `searchMusic` の中の `rawResults.map((r: any) => { … })` を、次の関数に移し、`const items: MusicItem[] = rawResults.map((r: any) => toMusicItem(r, entity));` にする。

```ts
/** iTunes Search / Lookup API の 1 件を MusicItem にする（検索と、Shazam の曲の lookup で共用）。 */
export function toMusicItem(r: any, entity: string): MusicItem {
  const isSong = r.wrapperType === 'track' || r.kind === 'song';
  const isAlbum = r.wrapperType === 'collection' || entity === 'album';

  const thumb = r.artworkUrl100 || r.artworkUrl60;
  const highRes = thumb ? thumb.replace(/\/\d+x\d+bb\./, '/600x600bb.') : undefined;

  return {
    id: String(r.trackId || r.collectionId || r.artistId || ''),
    type: isSong ? 'song' : isAlbum ? 'album' : 'artist',
    title: r.trackName || r.collectionName || r.artistName || 'Unknown Title',
    artist: r.artistName || 'Unknown Artist',
    album: r.collectionName || undefined,
    artwork: thumb ? { thumbnail: thumb, highRes } : undefined,
    previewUrl: r.previewUrl || undefined,
    releaseDate: r.releaseDate || undefined,
    genre: r.primaryGenreName || undefined,
    trackNumber: typeof r.trackNumber === 'number' ? r.trackNumber : undefined,
    trackTimeMillis: typeof r.trackTimeMillis === 'number' ? r.trackTimeMillis : undefined,
    url: r.trackViewUrl || r.collectionViewUrl || r.artistViewUrl || undefined,
  };
}
```

- [ ] **Step 4: 認識の本体を実装する**

`src/services/song_recognition.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { CACHE_TTL_DEFAULT, CACHE_TTL_EMPTY, cacheKeyDigest, getFromCache, runWithSingleFlight, setToCache } from '../cache.js';
import { errorMessage } from '../errors.js';
import { fetchWithSafeRedirects } from '../http_fetcher.js';
import { readBodyWithLimit } from '../net/safe_transport.js';
import { AudioDecodeError, decodeAudioWindows, type DecodedWindows } from './audio_decode.js';
import { toMusicItem, type MusicItem } from './music.js';
import { MIN_WINDOW_SECONDS, SignatureTooShortError, WINDOW_SECONDS, signatureUri } from './shazam_signature.js';

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
  match?: { songOffsetSec?: number; clipOffsetSec: number };
  attempts: Array<{ offsetSec: number; durationSec: number; matched: boolean }>;
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
    if (/exceeds/.test(errorMessage(e))) return { reason: 'too-large', message: TOO_LARGE };
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

/** Shazam の tag の応答から、曲と、その音が曲の何秒目かを読む。当たらなかったら null。 */
export function parseShazamResponse(body: unknown): { track: ShazamTrack; songOffsetSec?: number } | null {
  const b = body as { matches?: Array<{ offset?: unknown }>; track?: Record<string, any> } | null;
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
  const offset = b?.matches?.[0]?.offset;
  return {
    track: {
      key, title, artist,
      isrc: str(t.isrc), appleMusicId: appleMusicId(t), album: meta.album, label: meta.label, released: meta.released,
      genre: str(t.genres?.primary), url: str(t.url), artwork: str(t.images?.coverarthq) ?? str(t.images?.coverart),
    },
    ...(typeof offset === 'number' ? { songOffsetSec: round3(offset) } : {}),
  };
}

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

async function identify(audio: DownloadedAudio, offsetSec: number | undefined, country: string, deps: SongRecognitionDeps): Promise<{ result: SongRecognitionResult; ttlMs: number }> {
  let decoded: DecodedWindows;
  try {
    decoded = await (deps.decode ?? decodeAudioWindows)(audio.bytes, (d) => pickWindows(d, offsetSec));
  } catch (e) {
    if (e instanceof AudioDecodeError) return { result: refusal('not-audio', NOT_AUDIO), ttlMs: CACHE_TTL_EMPTY };
    throw e;
  }
  const info = { bytes: audio.bytes.byteLength, durationSec: round3(decoded.durationSec), contentType: audio.contentType };
  if (decoded.durationSec < MIN_WINDOW_SECONDS) return { result: refusal('too-short', TOO_SHORT, info), ttlMs: CACHE_TTL_EMPTY };
  const fetchFn = deps.fetchFn ?? fetch;
  const attempts: SongRecognitionResult['attempts'] = [];
  for (const w of decoded.windows) {
    let sig: { uri: string; sampleMs: number };
    try {
      sig = signatureUri(w.pcm);
    } catch (e) {
      if (e instanceof SignatureTooShortError) continue; // 無音の窓は飛ばす
      throw e;
    }
    const matched = parseShazamResponse(await sendSignature(sig, country, fetchFn));
    attempts.push({ offsetSec: w.offsetSec, durationSec: sig.sampleMs / 1000, matched: matched !== null });
    if (!matched) continue;
    const linked = await linkItunes(matched.track, country, fetchFn);
    return {
      result: {
        found: true, itunes: linked.item, itunesMatch: linked.by, shazam: matched.track,
        match: { songOffsetSec: matched.songOffsetSec, clipOffsetSec: w.offsetSec }, attempts, audio: info,
      },
      ttlMs: linked.failed ? CACHE_TTL_EMPTY : CACHE_TTL_DEFAULT,
    };
  }
  if (attempts.length === 0) return { result: refusal('too-short', TOO_SHORT, info), ttlMs: CACHE_TTL_EMPTY };
  return { result: refusal('no-match', NO_MATCH, info, attempts), ttlMs: CACHE_TTL_EMPTY };
}

/** 音から曲を特定する。音は URL（20 MB まで）か、アップロードのバイト列（REST）。 */
export async function recognizeSong(options: SongRecognitionOptions, deps: SongRecognitionDeps = {}): Promise<SongRecognitionResult> {
  const country = (options.country ?? 'jp').toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) throw new SongRecognitionInputError('country は 2 文字の国コードです（例: "jp"）');
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
```

- [ ] **Step 5: 通ることを確かめる**

Run: `bun test src/services/song_recognition.test.ts src/services/shazam_signature.test.ts && bun test src/index.test.ts -t "music|song|iTunes"`
Expected: PASS（`music.ts` の切り出しで、既存の音楽の検索のテストも通る）

- [ ] **Step 6: コミット**

```bash
git add src/services/song_recognition.ts src/services/song_recognition.test.ts src/services/music.ts
git commit -m "feat(shazam): 音から曲を Shazam で特定し、iTunes の曲につなぐ本体を足す"
```

---

### Task 4: モジュール `shazam` のつなぎ込み（MCP・REST・OpenAPI・指示文）

**Files:**
- Modify: `src/mcp/registry.ts:5`（`SoraModule` に `'shazam'`）、`:167`（`EXPLICIT_ONLY_MODULES` に `'shazam'`）
- Create: `src/mcp/tools_shazam.ts`
- Modify: `src/mcp.ts:22-23,77-78,92-94`（import・フラグ・登録・search_tools のフラグ）
- Modify: `src/mcp/tools_search.ts:50`（カテゴリのヒント）
- Modify: `src/mcp/instructions.ts:16-17,121-127`（11 番目の指示）
- Modify: `src/types.ts`（`LyricsResultSchema` の後にスキーマ、`/lyrics` の OpenAPI の後に `/music/recognize`）
- Create: `src/routes/song_recognition.ts`
- Modify: `src/index.ts:29-30,140-141`（ルートの登録）、`src/routes/system.ts:85`（`GET /` の一覧）
- Test: `src/shazam_module.test.ts`

**Interfaces:**
- Consumes: `recognizeSong`・`SongRecognitionInputError`・`SongRecognitionOptions`（Task 3）
- Produces: `SongRecognitionRequestSchema`・`SongRecognitionFormSchema`・`ShazamTrackSchema`・`SongRecognitionResultSchema`（`src/types.ts`）、`registerShazamTools(context)`、`createSongRecognitionRoutes(run?)`・`songRecognitionRoutes`

- [ ] **Step 1: 失敗するテストを書く**

`src/shazam_module.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { app } from './index.js';
import { buildSoraMcpInstructions, createMcpServer, toolCatalogOf } from './mcp.js';
import { isModuleActive } from './mcp/registry.js';
import { createSongRecognitionRoutes } from './routes/song_recognition.js';
import { SongRecognitionInputError, type SongRecognitionOptions, type SongRecognitionResult } from './services/song_recognition.js';
import { generateOpenApiDocument } from './types.js';

const savedModules = process.env.ENABLED_MODULES;
afterEach(() => {
  if (savedModules === undefined) delete process.env.ENABLED_MODULES;
  else process.env.ENABLED_MODULES = savedModules;
});

// 作り物の結果だけを使う
const fakeResult: SongRecognitionResult = {
  found: true, itunes: { id: '1700000001', type: 'song', title: 'テスト曲', artist: 'テスト歌手' }, itunesMatch: 'apple-id',
  shazam: { key: '900001', title: 'テスト曲', artist: 'テスト歌手' }, match: { songOffsetSec: 10, clipOffsetSec: 0 },
  attempts: [{ offsetSec: 0, durationSec: 12, matched: true }], audio: { bytes: 4, durationSec: 30, contentType: 'audio/mp4' },
};
const postJson = (a: { request: Hono['request'] }, body: unknown) =>
  a.request('/music/recognize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('shazam module is explicit opt-in', () => {
  test('all, wildcard and unset do not enable it; naming it does', () => {
    delete process.env.ENABLED_MODULES;
    expect(isModuleActive('shazam')).toBe(false);
    process.env.ENABLED_MODULES = 'all';
    expect(isModuleActive('shazam')).toBe(false);
    process.env.ENABLED_MODULES = '*';
    expect(isModuleActive('shazam')).toBe(false);
    expect(isModuleActive('shazam', ['all'])).toBe(false);
    process.env.ENABLED_MODULES = ' All , Lyrics , Shazam ';
    expect(isModuleActive('shazam')).toBe(true);
    expect(isModuleActive('lyrics')).toBe(true);
    expect(isModuleActive('music')).toBe(true);
    expect(isModuleActive('shazam', ['shazam'])).toBe(true);
  });
});

describe('MCP tool', () => {
  test('is absent by default and under all, present and deferred when the module is named', () => {
    delete process.env.ENABLED_MODULES;
    expect(toolCatalogOf(createMcpServer({ deferTools: false })).has('recognize_song')).toBe(false);
    expect(toolCatalogOf(createMcpServer({ modules: ['all'], deferTools: false })).has('recognize_song')).toBe(false);
    const named = toolCatalogOf(createMcpServer({ modules: ['all', 'shazam'], deferTools: false }));
    expect(named.get('recognize_song')?.category).toBe('shazam');
    expect(toolCatalogOf(createMcpServer({ modules: ['shazam'] })).get('recognize_song')?.handle.enabled).toBe(false);
  });

  test('search_tools finds it by 楽曲認識, it requires url, and a bad url is an error result', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ modules: ['shazam'] });
    const client = new Client({ name: 'shazam-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('recognize_song');
      const found = await client.callTool({ name: 'search_tools', arguments: { query: '楽曲認識' } }) as any;
      expect(found.content[0].text).toContain('recognize_song');
      const tool = (await client.listTools()).tools.find((t) => t.name === 'recognize_song') as any;
      expect(tool.inputSchema.required).toEqual(['url']);
      const bad = await client.callTool({ name: 'recognize_song', arguments: { url: 'ftp://example.com/a.mp3' } }) as any;
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain('Song recognition error');
      const none = await client.callTool({ name: 'search_tools', arguments: { query: 'zzzqqq' } }) as any;
      expect(none.content[0].text).toContain('shazam');
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('the instructions mention it only when the module is active', () => {
    expect(buildSoraMcpInstructions(['shazam'])).toContain('recognize_song');
    expect(buildSoraMcpInstructions(['all'])).not.toContain('recognize_song');
  });
});

describe('REST /music/recognize', () => {
  test('is a 404 MODULE_DISABLED that says how to enable it, by default and under all', async () => {
    delete process.env.ENABLED_MODULES;
    for (const value of [undefined, 'all']) {
      if (value) process.env.ENABLED_MODULES = value;
      const res = await postJson(app, { url: 'https://example.com/a.mp3' });
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json.code).toBe('MODULE_DISABLED');
      expect(json.error).toContain('ENABLED_MODULES');
    }
  });

  test('when enabled it takes JSON or a multipart upload, validates, and maps failures', async () => {
    process.env.ENABLED_MODULES = 'all,shazam';
    let seen: SongRecognitionOptions | undefined;
    const ok = new Hono().route('/', createSongRecognitionRoutes(async (input) => { seen = input; return fakeResult; }));
    expect(await (await postJson(ok, { url: 'https://example.com/a.mp3', offsetSec: 8 })).json()).toMatchObject({ found: true, itunes: { id: '1700000001' } });
    expect(seen).toMatchObject({ url: 'https://example.com/a.mp3', offsetSec: 8 });
    expect((await postJson(ok, {})).status).toBe(400);
    expect((await postJson(ok, '{broken')).status).toBe(400);

    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'clip.m4a', { type: 'audio/mp4' }));
    form.append('offsetSec', '4');
    form.append('noCache', 'true');
    expect((await ok.request('/music/recognize', { method: 'POST', body: form })).status).toBe(200);
    expect(seen?.audio?.contentType).toBe('audio/mp4');
    expect([...(seen?.audio?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(seen).toMatchObject({ offsetSec: 4, noCache: true });
    const empty = new FormData();
    empty.append('offsetSec', '4');
    expect((await ok.request('/music/recognize', { method: 'POST', body: empty })).status).toBe(400);

    const wrong = new Hono().route('/', createSongRecognitionRoutes(async () => { throw new SongRecognitionInputError('url は http(s) の URL です'); }));
    expect((await postJson(wrong, { url: 'x' })).status).toBe(400);
    const down = new Hono().route('/', createSongRecognitionRoutes(async () => { throw new Error('Shazam HTTP 503 (request failed)'); }));
    const res = await postJson(down, { url: 'https://example.com/a.mp3' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'SONG_RECOGNITION_UPSTREAM_ERROR', retryable: true });
  });
});

describe('documentation follows the module', () => {
  test('OpenAPI and the endpoint list include /music/recognize only when it is enabled', async () => {
    delete process.env.ENABLED_MODULES;
    expect((generateOpenApiDocument() as any).paths['/music/recognize']).toBeUndefined();
    expect(JSON.stringify(await (await app.request('/')).json())).not.toContain('/music/recognize');
    process.env.ENABLED_MODULES = 'all,shazam';
    const doc = generateOpenApiDocument() as any;
    expect(doc.paths['/music/recognize'].post.requestBody.content['application/json'].schema.required).toEqual(['url']);
    expect(doc.paths['/music/recognize'].post.requestBody.content['multipart/form-data'].schema.required).toEqual(['file']);
    expect(JSON.stringify(await (await app.request('/')).json())).toContain('POST /music/recognize');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `bun test src/shazam_module.test.ts`
Expected: FAIL（`Cannot find module './routes/song_recognition.js'`）

- [ ] **Step 3: モジュールの名前を足す**

`src/mcp/registry.ts`:

```ts
export type SoraModule = 'web' | 'browser' | 'yahoo' | 'life' | 'disaster' | 'watch' | 'music' | 'gov' | 'trade' | 'media' | 'intel' | 'lyrics' | 'youtube' | 'shazam';
```

```ts
/** `all` や未設定では有効にならず、名前を挙げたときだけ有効になるモジュール（自己責任で使う機能）。 */
const EXPLICIT_ONLY_MODULES: readonly SoraModule[] = ['lyrics', 'shazam'];
```

- [ ] **Step 4: スキーマと OpenAPI を足す**

`src/types.ts` の `LyricsResultSchema` の直後:

```ts
export const SongRecognitionRequestSchema = z.object({
  url: z.string().min(1, 'url は必須です').describe('音声・動画ファイルの URL（mp3・m4a・wav・ogg・webm・flac・mp4 など。20 MB まで）。YouTube などの動画のページの URL は読めない'),
  offsetSec: z.number().int().min(0).optional().describe('聞き始める位置（秒）。省略すると、36 秒を超える音は真ん中、続けて先頭から 12 秒ずつ、合わせて最大 3 回試す'),
  country: z.string().regex(/^[A-Za-z]{2}$/, 'country は 2 文字の国コードです').optional().describe('iTunes の国コード (デフォルト: "jp")').meta({ default: 'jp' }),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか').meta({ default: false }),
});

/** multipart/form-data で音を送るときの、ファイル以外の欄（文字列で届く）。 */
export const SongRecognitionFormSchema = z.object({
  offsetSec: z.coerce.number().int().min(0).optional().describe('聞き始める位置（秒）'),
  country: SongRecognitionRequestSchema.shape.country,
  noCache: z.enum(['true', 'false']).transform((v) => v === 'true').optional().describe('キャッシュをバイパスするか ("true" / "false")'),
});

export const ShazamTrackSchema = z.object({
  key: z.string().describe('Shazam の曲の ID'),
  title: z.string().describe('曲名（Shazam の表記）'),
  artist: z.string().describe('アーティスト名（Shazam の表記）'),
  isrc: z.string().optional().describe('ISRC'),
  appleMusicId: z.string().optional().describe('Apple Music / iTunes の曲の ID'),
  album: z.string().optional().describe('アルバム名'),
  label: z.string().optional().describe('レーベル'),
  released: z.string().optional().describe('発売の年（Shazam の表記）'),
  genre: z.string().optional().describe('ジャンル'),
  url: z.string().optional().describe('Shazam の曲のページ'),
  artwork: z.string().optional().describe('ジャケット画像の URL'),
});

export const SongRecognitionResultSchema = z.object({
  found: z.boolean().describe('曲を特定できたか'),
  reason: z.enum(['no-match', 'not-audio', 'too-short', 'too-large', 'download-failed']).optional().describe('found が false の理由: "no-match"(Shazam が特定できない), "not-audio"(音声・動画として読めない。ページの URL など), "too-short"(3 秒未満・無音), "too-large"(URL のファイルが 20 MB 超), "download-failed"(URL を読めない)'),
  message: z.string().optional().describe('found が false のときの説明と次の手'),
  itunes: MusicItemSchema.nullable().describe('iTunes の曲（search_song の items と同じ形。id は trackId）。iTunes で見つからなければ null'),
  itunesMatch: z.enum(['apple-id', 'title-artist']).nullable().describe('iTunes の曲の見つけ方: "apple-id"(Shazam の Apple の曲 ID), "title-artist"(曲名とアーティストの一致)。見つからなければ null'),
  shazam: ShazamTrackSchema.optional().describe('Shazam が特定した曲'),
  match: z.object({
    songOffsetSec: z.number().optional().describe('当たった音が、曲の何秒目か'),
    clipOffsetSec: z.number().describe('渡した音の何秒目から聞いた窓で当たったか'),
  }).optional().describe('当たった位置'),
  attempts: z.array(z.object({
    offsetSec: z.number().describe('窓の始まり（秒）'),
    durationSec: z.number().describe('送った長さ（秒）'),
    matched: z.boolean().describe('この窓で当たったか'),
  })).describe('Shazam に送った窓'),
  audio: z.object({
    bytes: z.number().describe('受け取った音の大きさ（バイト）'),
    durationSec: z.number().optional().describe('音の長さ（秒）'),
    contentType: z.string().describe('受け取った音の形式（Content-Type）'),
  }).optional().describe('受け取った音'),
  ...CACHE_META_SHAPE,
});
```

`generateOpenApiDocument` の `/lyrics` のブロックの直後:

```ts
  // 楽曲認識は ENABLED_MODULES に名前を挙げたときだけ公開する（Shazam の iPhone アプリと同じ窓口を使うため）
  if (isModuleActive('shazam')) {
    paths['/music/recognize'] = {
      post: {
        summary: '音声・動画ファイルの音から曲を特定し、iTunes の曲とつなぐ (Shazam。ENABLED_MODULES に shazam を挙げたときだけ)',
        requestBody: {
          content: {
            'application/json': { schema: zodToOpenApiSchema(SongRecognitionRequestSchema) },
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary', description: '音声・動画ファイル（10 MB まで）' },
                  offsetSec: { type: 'integer', minimum: 0, description: '聞き始める位置（秒）' },
                  country: { type: 'string', description: 'iTunes の国コード (デフォルト: "jp")' },
                  noCache: { type: 'boolean', description: 'キャッシュをバイパスするか' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: '曲の特定の結果 (特定できない場合も 200 で found: false と reason を返す)',
            content: { 'application/json': { schema: zodToOpenApiSchema(SongRecognitionResultSchema) } },
          },
        },
      },
    };
  }
```

（`paths` の型が合わなければ、`/lyrics` のブロックと同じ書き方に合わせる。）

- [ ] **Step 5: MCP のツールを足す**

`src/mcp/tools_shazam.ts`:

```ts
import { errorMessage } from '../errors.js';
import { recognizeSong } from '../services/song_recognition.js';
import { SongRecognitionRequestSchema } from '../types.js';
import { registerTool, toolJson } from './registry.js';

import type { ToolRegistrationContext } from './registry.js';

/** 🎧 Category 14: Song Recognition (モジュール: 'shazam'。ENABLED_MODULES に名前を挙げたときだけ有効。Shazam の iPhone アプリと同じ窓口を使う) */
export function registerShazamTools(context: ToolRegistrationContext): void {
  const { mcpServer, toolCatalog, sessionActivated, deferredDefault } = context;
  // recognize_song (音から曲を特定し、iTunes の曲とつなぐ) - DEFERRED
  registerTool(
    mcpServer,
    toolCatalog,
    sessionActivated,
    'recognize_song',
    'shazam',
    '【楽曲認識・Shazam】音声・動画ファイルの URL から、流れている曲を Shazam で特定し、iTunes の曲（search_song と同じ形。id は trackId、ジャケット・30 秒試聴 URL・Apple Music のリンク）とつないで返します。mp3・m4a・wav・ogg・webm・flac・mp4 など 20 MB まで。YouTube などの動画のページの URL は読めません。offsetSec を省略すると、長い音は真ん中、続けて先頭から 12 秒ずつ、最大 3 回試します。found が false のときは reason（no-match / not-audio / too-short / too-large / download-failed）と message に従い、曲名を推測で答えないでください。返却: { found, reason, message, itunes, itunesMatch, shazam, match, attempts, audio }',
    SongRecognitionRequestSchema.shape,
    async (opts) => {
      try {
        return { content: [{ type: 'text', text: toolJson(await recognizeSong(opts)) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Song recognition error: ${errorMessage(err) || err}` }] };
      }
    },
    { defaultEnabled: deferredDefault, keywords: ['楽曲認識', '曲の特定', '曲名を当てる', '何の曲', 'この曲', '音楽認識', 'Shazam', 'シャザム'] },
  );
}
```

`src/mcp.ts`（lyrics・youtube の行の隣）:

```ts
import { registerShazamTools } from './mcp/tools_shazam.js';
```

```ts
  const shouldEnableShazam = isModuleActive('shazam', options?.modules); // 'all' では有効にならない（名前を挙げたときだけ）
```

```ts
  if (shouldEnableShazam) registerShazamTools(context);
```

`registerToolSearch(context, { …, youtube: shouldEnableYoutube, shazam: shouldEnableShazam })`。

`src/mcp/tools_search.ts` の youtube の行の後:

```ts
        if (enabled.shazam) activeCategories.push('shazam (楽曲認識・Shazam)');
```

`src/mcp/instructions.ts`: `const hasShazam = hasMod('shazam');` を `hasYoutube` の後に足し、YouTube の指示（10 番目）の後に:

```ts
  if (hasShazam) {
    tier1Directives.push(
      "11. Song Identification (opt-in): to name the song playing in an audio or video file, use 'shazam' tool recognize_song with the file URL (not a video page). If found is false, never guess the title.",
    );
  }
```

- [ ] **Step 6: REST のルートを足す**

`src/routes/song_recognition.ts`:

```ts
import { Hono } from 'hono';
import { errorMessage } from '../errors.js';
import { isModuleActive } from '../mcp/registry.js';
import { recognizeSong, SongRecognitionInputError, type SongRecognitionOptions } from '../services/song_recognition.js';
import { SongRecognitionFormSchema, SongRecognitionRequestSchema } from '../types.js';
import { formatError } from './utils.js';

/**
 * 音から曲を特定する (POST /music/recognize)。JSON の url か、multipart/form-data の file を受け取る。
 * モジュール 'shazam' を ENABLED_MODULES に名前で挙げたときだけ応答する。特定できない場合も 200 で found: false。
 */
export function createSongRecognitionRoutes(run: (input: SongRecognitionOptions) => Promise<unknown> = recognizeSong) {
  const routes = new Hono();
  routes.post('/music/recognize', async (c) => {
    if (!isModuleActive('shazam')) {
      return formatError(c, 'shazam module is not enabled. Add it to ENABLED_MODULES by name (e.g. ENABLED_MODULES=all,shazam); "all" alone does not include it.', 'MODULE_DISABLED', 404, false);
    }
    let input: SongRecognitionOptions;
    if ((c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
      let form: Record<string, string | File>;
      try {
        form = (await c.req.parseBody()) as Record<string, string | File>;
      } catch {
        return formatError(c, 'Invalid multipart body', 'INVALID_INPUT', 400, false);
      }
      const file = form.file;
      if (!(file instanceof File) || file.size === 0) return formatError(c, 'file: 音声・動画ファイルを付けてください', 'INVALID_INPUT', 400, false);
      const fields = SongRecognitionFormSchema.safeParse({ offsetSec: form.offsetSec, country: form.country, noCache: form.noCache });
      if (!fields.success) {
        const issue = fields.error.issues[0];
        return formatError(c, issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid form fields', 'INVALID_INPUT', 400, false, fields.error.format());
      }
      input = { ...fields.data, audio: { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type } };
    } else {
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
      }
      const parsed = SongRecognitionRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return formatError(c, issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required', 'INVALID_INPUT', 400, false, parsed.error.format());
      }
      input = parsed.data;
    }
    try {
      return c.json(await run(input));
    } catch (err) {
      if (err instanceof SongRecognitionInputError) return formatError(c, err.message, 'INVALID_INPUT', 400, false);
      return formatError(c, errorMessage(err) || 'Song recognition failed', 'SONG_RECOGNITION_UPSTREAM_ERROR', 502, true);
    }
  });
  return routes;
}

export const songRecognitionRoutes = createSongRecognitionRoutes();
```

`src/index.ts`（lyrics・youtube の隣）:

```ts
import { songRecognitionRoutes } from './routes/song_recognition.js';
```

```ts
app.route('/', songRecognitionRoutes);
```

`src/routes/system.ts` の lyrics の行の後:

```ts
      ...(isModuleActive('shazam') ? { musicRecognize: 'POST /music/recognize' } : {}),
```

- [ ] **Step 7: 通ることを確かめる**

Run: `bun test src/shazam_module.test.ts src/lyrics_module.test.ts src/llm_contract_sync.test.ts src/context_budget.test.ts src/tool_contracts.test.ts`
Expected: PASS（既定のツール数・指示文の長さ・文字数の予算は変わらない）

- [ ] **Step 8: コミット**

```bash
git add src/mcp/registry.ts src/mcp/tools_shazam.ts src/mcp.ts src/mcp/tools_search.ts src/mcp/instructions.ts src/types.ts src/routes/song_recognition.ts src/index.ts src/routes/system.ts src/shazam_module.test.ts
git commit -m "feat(shazam): recognize_song と POST /music/recognize を、名前を挙げたときだけ有効なモジュールとして足す"
```

---

### Task 5: tool-health の台帳と実 API の検査

**Files:**
- Modify: `scripts/tool-health/catalog.ts:37-47`（`CANONICAL_TOOLS`）、`:99`（`REST_MAP`）、`:993-1001` の後（`TOOL_CASES`）
- Modify: `scripts/tool-health/catalog.test.ts:11`（登録集合を `all,shazam` で数える）
- Modify: `scripts/tool-health/run.ts:131`（候補コンテナに `ENABLED_MODULES=all,shazam`）
- Modify: `docs/testing/tool-health.md:7`（canonical の数）

**Interfaces:**
- Consumes: `ensureEnabled`・`mcpJson`・`toolPayload`・`mustContain`・`LiveFail`・`LiveUnavailable`（`scripts/tool-health/catalog.ts`）

- [ ] **Step 1: 台帳の照合が落ちることを確かめる（先に台帳だけ足す）**

`CANONICAL_TOOLS` の `'get_youtube_channel',` の後に `'recognize_song',` を足す。

Run: `bun test scripts/tool-health/catalog.test.ts`
Expected: FAIL（登録集合に `recognize_song` が無い、live case が無い、REST の対応が無い）

- [ ] **Step 2: 台帳を直す**

`scripts/tool-health/catalog.test.ts` の `canonicalNames`:

```ts
  // 候補コンテナは ENABLED_MODULES=all,shazam で起動する（run.ts）。名前を挙げたときだけのモジュールも数える
  const server = createMcpServer({ deferTools: false, modules: ['all', 'shazam'] });
```

`REST_MAP` の `get_youtube_channel` の後:

```ts
  recognize_song: { method: 'POST', path: '/music/recognize' },
```

`TOOL_CASES` の `youtube.channel` の後:

```ts
  toolCase('shazam.recognize', ['recognize_song'], ['shazam', 'itunes'], true, 120000, async (ctx) => {
    await ensureEnabled(ctx, '楽曲認識', 30000);
    // iTunes の試聴音源（YOASOBI「アイドル」）の 8 秒目からの 12 秒を、Shazam に 1 回だけ送る。
    // GitHub の実行環境を Shazam が拒否したら、エラーの文（HTTP 403）で blocked になる（soft hold）
    const { text: songText } = await mcpJson(ctx, 'search_song', { query: 'YOASOBI アイドル', limit: 1 }, 30000);
    const preview = (toolPayload(songText, 'search_song') as { items?: Array<{ previewUrl?: string }> }).items?.[0]?.previewUrl;
    if (!preview) throw new LiveUnavailable('search_song returned no preview URL for the recognition sample');
    const { text } = await mcpJson(ctx, 'recognize_song', { url: preview, offsetSec: 8 }, 90000);
    const raw = toolPayload(text, 'recognize_song') as { found?: boolean; reason?: string; message?: string };
    if (raw.found !== true) {
      const detail = `recognize_song ${raw.reason ?? 'found=false'}: ${raw.message ?? ''}`;
      throw raw.reason === 'download-failed' ? new LiveUnavailable(detail) : new LiveFail(detail);
    }
    mustContain(raw, ['YOASOBI'], 'shazam');
    return { sources: [{ source: 'shazam-tag', count: 1, format: 'json', upstreamStatus: 'unknown' }] };
  }),
```

`scripts/tool-health/run.ts` の `dockerArgs` の `'-e', 'SORA_DB_PATH=/tmp/tool-health.db',` の後:

```ts
    // 名前を挙げたときだけのモジュール（楽曲認識）も検査する。歌詞は入れない
    '-e', 'ENABLED_MODULES=all,shazam',
```

`docs/testing/tool-health.md:7` の `canonical 52` を、`bun -e "import('./scripts/tool-health/catalog.ts').then(m => console.log(m.CANONICAL_TOOLS.length))"` の数に直す。

- [ ] **Step 3: 通ることを確かめる**

Run: `bun test scripts/tool-health src/tool_contracts.test.ts src/tool_transport_smoke.test.ts`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add scripts/tool-health/catalog.ts scripts/tool-health/catalog.test.ts scripts/tool-health/run.ts docs/testing/tool-health.md
git commit -m "test(tool-health): 楽曲認識を台帳と毎日の実 API の検査に足す"
```

---

### Task 6: README と仕様書

**Files:**
- Modify: `README.md:323`（モジュールの概要）、`:624` の YouTube の節の後（Module 14 の節）、`:2212` の 3.33 の後（3.34 の節）、`:2296`（環境変数の表）、`## 5. 謝意・クレジット` の iTunes の項の後
- Modify: `docs/superpowers/specs/2026-10-27-song-recognition-design.md`（指示文と `download-failed` を実装に合わせる）

- [ ] **Step 1: README を直す**

`README.md:323` の lyrics の文の後に足す:

```markdown
同じく **`shazam` モジュール（楽曲認識、1 ツール）** も `all` には含まれず、`ENABLED_MODULES=all,shazam` のように名前を挙げたときだけ有効になります（[Module 14](#-module-14-song-recognition-enabled_modulesallshazam)）。
```

Module 13（YouTube）の節の後に:

````markdown
### 🎧 Module 14: Song Recognition (`ENABLED_MODULES=all,shazam`)
音声・動画ファイルの音から、流れている曲を Shazam で特定し、iTunes の曲（`search_song` と同じ形。trackId・ジャケット・30 秒試聴 URL・Apple Music のリンク）とつないで返します。**`all` には含まれません。** 公開された API ではなく、Shazam の iPhone アプリと同じ窓口を使うため、`ENABLED_MODULES` に `shazam` を名前で挙げたときだけ、MCP ツールと REST の `/music/recognize` が有効になり、OpenAPI 仕様書にも現れます。

- 音は、音声・動画ファイルの URL（mp3・m4a・wav・ogg・webm・flac・mp4 など。20 MB まで）か、REST へのアップロード（multipart の `file`、10 MB まで）で受け取ります。YouTube などの動画のページからは音を取りません。
- 音は同梱の Chromium の Web Audio で 16 kHz・モノラルにし、12 秒の窓から Shazam の指紋を作って送ります（[omkarcloud/shazam-scraper](https://github.com/omkarcloud/shazam-scraper) の `sigx.py`、MIT を移植）。`offsetSec` を省略すると、長い音は真ん中、続けて先頭から 12 秒ずつ、最大 3 回試します。
- iTunes とは、Shazam が返す Apple の曲 ID で lookup を引いてつなぎます。無いときは、曲名とアーティストが一致する iTunes の検索結果を使い、それも無ければ `itunes: null` です。
- 起動時の処理・常駐タイマー・事前取得はありません。呼ばれたときだけ Shazam と iTunes に問い合わせ、結果を音のハッシュでキャッシュします（当たり 30 分、外れ 60 秒）。

| ツール名 | 説明 | 呼び出し例 | 主な引数 |
| :--- | :--- | :--- | :--- |
| `recognize_song` ・ DEFERRED | 音から曲を特定し、iTunes の曲とつなぎます。特定できないときは `reason`（`no-match` / `not-audio` / `too-short` / `too-large` / `download-failed`）を返します。 | `source: "shazam"` | - `url` (string, 必須)<br>- `offsetSec` (number, 任意)<br>- `country` (string, 任意。既定 `jp`)<br>- `noCache` (boolean, 任意) |

```bash
docker run -d -p 3016:8000 -e ENABLED_MODULES="all,shazam" ghcr.io/ikenokazuki/sora:latest
curl -X POST http://localhost:3016/music/recognize -F file=@clip.m4a -F offsetSec=0
```
````

3.33 の節の後に:

````markdown
### 3.34 音から曲を特定 (`POST /music/recognize`, v2.51.0, 明示オプトイン)

音声・動画ファイルの音から曲を Shazam で特定し、iTunes の曲とつなぎます。**`ENABLED_MODULES` に `shazam` を名前で挙げたときだけ有効**です（`all` には含まれません）。挙げなければ 404（`MODULE_DISABLED`）を返し、この仕様書（`/openapi.json`）にも現れません。設定は「Module 14: Song Recognition」を参照してください。

- **リクエスト**: JSON の `{ "url": "https://…/clip.m4a", "offsetSec": 0, "country": "jp" }`、または multipart/form-data の `file`（ほかの引数は同じ名前の欄）。
- **レスポンス**（当たったとき）:
  ```json
  {
    "found": true,
    "itunes": { "id": "1700000001", "type": "song", "title": "曲名", "artist": "アーティスト", "previewUrl": "https://…", "url": "https://music.apple.com/…" },
    "itunesMatch": "apple-id",
    "shazam": { "key": "900001", "title": "曲名", "artist": "アーティスト", "isrc": "JPXX02600001", "appleMusicId": "1700000001" },
    "match": { "songOffsetSec": 61.2, "clipOffsetSec": 12 },
    "attempts": [{ "offsetSec": 0, "durationSec": 12, "matched": false }, { "offsetSec": 12, "durationSec": 12, "matched": true }],
    "audio": { "bytes": 1047712, "durationSec": 30, "contentType": "audio/mp4" }
  }
  ```
- **特定できないとき**は HTTP 200 で `found: false` と `reason`（`no-match` / `not-audio` / `too-short` / `too-large` / `download-failed`）と `message` を返します。Shazam の拒否・制限・障害は 502 `SONG_RECOGNITION_UPSTREAM_ERROR`（`retryable: true`）、入力の誤りは 400 です。
````

環境変数の表の `ENABLED_MODULES` の説明の末尾に `。楽曲認識の \`shazam\` も同じく \`all,shazam\` のように名前を挙げたときだけ有効` を足す。

謝意の iTunes の項の後に:

```markdown
- **Shazam Scraper**: [omkarcloud/shazam-scraper](https://github.com/omkarcloud/shazam-scraper)（MIT）
  - 楽曲認識の音の指紋（`sigx.py`）と、窓の選び方・送り方を TypeScript に移植しました（元は shazamio / SongRec の参照実装の移植です）。ライセンスの表示は `src/services/shazam_signature.ts` の先頭にあります。
```

- [ ] **Step 2: 仕様書を実装に合わせる**

`docs/superpowers/specs/2026-10-27-song-recognition-design.md` の「そのほか」の 1 つ目を次に替える:

```markdown
- MCP の指示文には、モジュールが有効なときだけ 11 番目の指示（音の曲名は recognize_song、found: false なら推測しない）を足す（歌詞と同じ。既定の指示の長さは変わらない）。
```

「返す内容」の `reason` に `'download-failed'`（URL を読めない・HTTP 400 以上）を足し、中の流れの 1. に「読めない・HTTP 400 以上は `download-failed`」を足す。

- [ ] **Step 3: コミット**

```bash
git add README.md docs/superpowers/specs/2026-10-27-song-recognition-design.md
git commit -m "docs: 楽曲認識（Module 14、POST /music/recognize）を README と仕様書に書く"
```

---

### Task 7: 全体の確認

- [ ] **Step 1: 型・lint・仕様の表記・生成クライアント**

Run:

```bash
bun run typecheck && bun run lint && bun run schema:notation && bun run gen:client && git status --short client/
```

Expected: どれもエラーなし。`client/` の差分なし（既定のモジュールだけで作るので、楽曲認識は載らない）。

- [ ] **Step 2: 全件のテスト（いまの bun と、CI と同じ bun 1.4.2）**

Run（切り離して実行し、終わりを待つ）:

```bash
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy
export CHROME_PATH=$(ls -d /nix/store/*-chromium-*/bin/chromium | head -1)
setsid bun test --timeout 60000 > <scratchpad>/full-test.log 2>&1 &
```

Expected: 失敗 0（前から揺れる canvas のテストが落ちたら、その 1 件だけを再実行して確かめる）。bun 1.4.2（`npm install --no-save --prefix <scratchpad>/bun142 bun@1.4.2`）でも同じ。

- [ ] **Step 3: 直したものがあればコミット**

---

### Task 8: 実機の確認（手元のサーバー）

**前提:** Shazam への送信が自動モードに止められたら、そこで止めてユーザーに相談する。出力するのは曲名・ID・件数・時間だけ。

- [ ] **Step 1: 別ポート・一時の DB でサーバーを起動する**

```bash
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy
export CHROME_PATH=$(ls -d /nix/store/*-chromium-*/bin/chromium | head -1)
ENABLED_MODULES=all,shazam PORT=3127 SORA_DB_PATH=<scratchpad>/live.db SORA_ALLOWED_HOSTS=127.0.0.1:3127,localhost:3127 bun src/index.ts
```

- [ ] **Step 2: iTunes の試聴音源の URL で当てる**

`POST /music/recognize` に、YOASOBI「アイドル」（trackId 1679278167）と君と見るそら「遠回りがいいっ!」（1768025995）の試聴の URL（iTunes の lookup で引き直す）を、`offsetSec` なしと `offsetSec: 8` で送る。期待: `found: true`、`itunes.id` が同じ trackId（違えば `shazam` と `itunes` の曲名を見て、別の版かどうかを記録する）、`attempts` の数と所要時間。

- [ ] **Step 3: 形式ごとのアップロード**

scratchpad の `audio-probe/` の `idol.mp3`・`idol.webm`・`idol-video.mp4` を multipart で送る（`offsetSec=8`）。雑音を足した音（`nix shell nixpkgs#ffmpeg -c ffmpeg -i idol.m4a -f lavfi -i anoisesrc=a=0.08 -filter_complex amix=inputs=2:duration=first idol-noisy.m4a`）も送る。期待: どれも `found: true`。

- [ ] **Step 4: 当たらないときの理由**

`{"url":"https://example.com/"}` → `not-audio`。2 秒の音（`ffmpeg -i idol.m4a -t 2 idol-2s.m4a`）→ `too-short`。存在しないファイルの URL → `download-failed`。`{}` → 400。同じ音の 2 回目 → `cached: true`。

- [ ] **Step 5: MCP**

`/mcp` で initialize → `search_tools`（`楽曲認識`）→ `recognize_song` に試聴の URL を渡し、REST と同じ結果になることを確かめる。

- [ ] **Step 6: サーバーを止め、結果をユーザーに報告する**

PR・リリース（v2.51.0）・本番反映（`ENABLED_MODULES=all,lyrics,shazam` を drop-in と Nix に足し、app の main にコミット）は、報告のあとにユーザーに確かめる。
