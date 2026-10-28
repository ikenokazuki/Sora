import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  MIN_WINDOW_SECONDS, SAMPLE_RATE, SignatureGenerator, SignatureTooShortError, WINDOW_SECONDS,
  checkSignature, checkSignatureBase64, crc32, createSignature, decodeBase64, encodeBase64, powerSpectrum,
} from '../src/index.js';

// テスト用の合成の音（Sora の src/test_fixtures/audio.ts と同じ）。Hann 形の包絡の 60 ms の音を 0.5 秒ごとに鳴らす
function toneBursts(freqHz: number, seconds = 12, amplitude = 8000): Int16Array {
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

// Sora v2.51.1 の toneBursts(1000)（12 秒）から作った指紋の base64（184 バイト）。oshiframe の backend の fixture と同じ値
const GOLDEN = 'gCX+yvdV712IAAAAAJwRlAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAD9AgAAAHwAAAAAQIgAAABBAANgeAAAAAslev8fPiV6/x8/JXr/Hz4lev8fPyV6/x8+JXr/Hz8lev8fPiV6/x8/JXr/Hz4lev8fPyV6/x8+JXr/Hz8lev8fPiV6/x8/JXr/Hz4lev8fPyV6/x8+JXr/Hz8lev8fPiV6/x8/JXr/Hz4lev8fPyV6/x8+JXr/Hw==';

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
    expect(u32(bytes, 4)).toBe(crc32(bytes.subarray(8)));
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

  test('sampleMs follows the samples as an exact integer, and band 2 gets its own tag', () => {
    const gen = new SignatureGenerator();
    gen.numberSamples = 192000;
    gen.peaks[2].push({ fftPass: 0, magnitude: 1, correctedBin: 2 });
    expect(gen.sampleMs()).toBe(12000);
    expect(u32(gen.encode(), 56)).toBe(0x60030042);
  });
});

describe('constants', () => {
  test('16 kHz, 12 s window, 3 s minimum', () => {
    expect([SAMPLE_RATE, WINDOW_SECONDS, MIN_WINDOW_SECONDS]).toEqual([16000, 12, 3]);
  });
});

describe('crc32', () => {
  test('the standard check value, unsigned', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('base64', () => {
  test('encodes in chunks like Buffer does, and decodes back', () => {
    const big = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => (i * 7) & 0xff);
    expect(encodeBase64(big)).toBe(Buffer.from(big).toString('base64'));
    expect(decodeBase64(encodeBase64(big))).toEqual(big);
    expect(encodeBase64(new Uint8Array(0))).toBe('');
  });

  test('decodeBase64 is null for text atob cannot read', () => {
    expect(decodeBase64('not base64!')).toBeNull();
    expect(decodeBase64('@@' + GOLDEN)).toBeNull();
    expect(decodeBase64('A')).toBeNull();
  });
});

describe('createSignature', () => {
  test('gives the golden signature for 12 s of 1000 Hz bursts', () => {
    const { bytes, sampleMs } = createSignature(toneBursts(1000));
    expect(encodeBase64(bytes)).toBe(GOLDEN);
    expect(sampleMs).toBe(12000);
  });

  test('uses only the first 12 s (192000 samples) of longer audio', () => {
    // 切り詰めないと、ピークが 255 未満の間は読み続けて sampleMs が 15000 になる
    const { bytes, sampleMs } = createSignature(toneBursts(1000, 15));
    expect(encodeBase64(bytes)).toBe(GOLDEN);
    expect(sampleMs).toBe(12000);
  });

  test('keeps the length between 3 s and 12 s', () => {
    expect(createSignature(toneBursts(1000, 5)).sampleMs).toBe(5000);
  });

  test('too short or silent audio is SignatureTooShortError', () => {
    expect(() => createSignature(toneBursts(1000, MIN_WINDOW_SECONDS - 1))).toThrow(SignatureTooShortError);
    expect(() => createSignature(new Int16Array(12 * SAMPLE_RATE))).toThrow(SignatureTooShortError);
    expect(new SignatureTooShortError()).toBeInstanceOf(Error);
  });
});

describe('checkSignature', () => {
  const made = () => createSignature(toneBursts(1000)).bytes;
  const withCrc = (b: Uint8Array) => { new DataView(b.buffer).setUint32(4, crc32(b.subarray(8)), true); return b; };

  test('accepts what createSignature makes, also through a view with an offset, and the 56-byte empty signature', () => {
    const bytes = made();
    expect(checkSignature(bytes, 12000)).toBe(true);
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 3);
    expect(checkSignature(padded.subarray(3), 12000)).toBe(true);
    expect(checkSignature(createSignature(toneBursts(1000, 3)).bytes, 3000)).toBe(true);
    const empty = new SignatureGenerator();
    empty.numberSamples = 192000;
    expect(empty.encode().length).toBe(56);
    expect(checkSignature(empty.encode(), 12000)).toBe(true);
  });

  test('refuses a short buffer, another magic, a CRC mismatch, a wrong size field and another sampleMs', () => {
    const bytes = made();
    expect(checkSignature(bytes.subarray(0, 55), 12000)).toBe(false);
    const magic = bytes.slice();
    magic[0] ^= 1;
    expect(checkSignature(magic, 12000)).toBe(false);
    const crc = bytes.slice();
    crc[crc.length - 1] ^= 1;
    expect(checkSignature(crc, 12000)).toBe(false);
    const size = bytes.slice();
    new DataView(size.buffer).setUint32(8, size.length - 47, true);
    expect(checkSignature(withCrc(size), 12000)).toBe(false);
    expect(checkSignature(bytes, 11999)).toBe(false);
    expect(checkSignature(bytes, 12001)).toBe(false);
  });

  test('accepts the sampleMs createSignature reports, for 128128 samples (float math would truncate one too low) and for every length from 3 s to 12 s', () => {
    const s = createSignature(toneBursts(1000, 9).subarray(0, 128128));
    expect(s.sampleMs).toBe(8008);
    expect(checkSignature(s.bytes, s.sampleMs)).toBe(true);
    const gen = new SignatureGenerator();
    for (let n = MIN_WINDOW_SECONDS * SAMPLE_RATE; n <= WINDOW_SECONDS * SAMPLE_RATE; n++) {
      gen.numberSamples = n;
      if (!checkSignature(gen.encode(), gen.sampleMs())) throw new Error(`rejected at ${n} samples (sampleMs ${gen.sampleMs()})`);
    }
  });
});

describe('checkSignatureBase64', () => {
  test('accepts the golden signature only with its own sampleMs', () => {
    expect(checkSignatureBase64(GOLDEN, 12000)).toBe(true);
    expect(checkSignatureBase64(GOLDEN, 11999)).toBe(false);
  });

  test('refuses text that is not base64, or not the canonical base64 of its bytes', () => {
    expect(checkSignatureBase64('not base64!', 12000)).toBe(false);
    expect(checkSignatureBase64(GOLDEN.slice(0, -2), 12000)).toBe(false); // 読めるが、戻すと == が付く
    expect(checkSignatureBase64(GOLDEN + '\n', 12000)).toBe(false); // atob は空白を読み飛ばすが、往復しない
    expect(checkSignatureBase64('', 12000)).toBe(false);
  });

  test('refuses a broken CRC', () => {
    const bytes = decodeBase64(GOLDEN)!;
    bytes[bytes.length - 1] ^= 1;
    expect(checkSignatureBase64(encodeBase64(bytes), 12000)).toBe(false);
  });
});

describe('published files', () => {
  test('never name the external service', () => {
    // 語そのものをこのファイルにも書かないため、[z] で分けて書く
    for (const f of ['../src/index.ts', '../README.md', '../package.json', '../LICENSE']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).not.toMatch(/sha[z]am/i);
    }
  });
});
