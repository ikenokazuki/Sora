import { describe, expect, test } from 'bun:test';
import { toneBursts } from '../test_fixtures/audio.js';
import { DATA_URI_PREFIX, MIN_WINDOW_SECONDS, SAMPLE_RATE, SignatureGenerator, SignatureTooShortError, checkSignatureBytes, powerSpectrum, signatureUri } from './shazam_signature.js';

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

describe('checkSignatureBytes', () => {
  const made = () => new Uint8Array(Buffer.from(signatureUri(toneBursts(1000)).uri.slice(DATA_URI_PREFIX.length), 'base64'));
  const withCrc = (b: Uint8Array) => { new DataView(b.buffer).setUint32(4, Bun.hash.crc32(b.subarray(8)) >>> 0, true); return b; };

  test('accepts what signatureUri makes, also through a view with an offset, and the 56-byte empty signature', () => {
    const bytes = made();
    expect(checkSignatureBytes(bytes, 12000)).toBe(true);
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 3);
    expect(checkSignatureBytes(padded.subarray(3), 12000)).toBe(true);
    const three = signatureUri(toneBursts(1000, 3));
    expect(checkSignatureBytes(Buffer.from(three.uri.slice(DATA_URI_PREFIX.length), 'base64'), 3000)).toBe(true);
    const empty = new SignatureGenerator();
    empty.numberSamples = 192000;
    expect(empty.encode().length).toBe(56);
    expect(checkSignatureBytes(empty.encode(), 12000)).toBe(true);
  });

  test('refuses a short buffer, another magic, a CRC mismatch, a wrong size field and another sampleMs', () => {
    const bytes = made();
    expect(checkSignatureBytes(bytes.subarray(0, 55), 12000)).toBe(false);
    const magic = bytes.slice();
    magic[0] ^= 1;
    expect(checkSignatureBytes(magic, 12000)).toBe(false);
    const crc = bytes.slice();
    crc[crc.length - 1] ^= 1;
    expect(checkSignatureBytes(crc, 12000)).toBe(false);
    const size = bytes.slice();
    new DataView(size.buffer).setUint32(8, size.length - 47, true);
    expect(checkSignatureBytes(withCrc(size), 12000)).toBe(false);
    expect(checkSignatureBytes(bytes, 11999)).toBe(false);
    expect(checkSignatureBytes(bytes, 12001)).toBe(false);
  });

  test('accepts the sampleMs signatureUri reports, for 128128 samples (a length where float math truncates one too low) and for every length from 3 s to 12 s', () => {
    const s = signatureUri(toneBursts(1000, 9).subarray(0, 128128));
    expect(s.sampleMs).toBe(8008);
    expect(checkSignatureBytes(Buffer.from(s.uri.slice(DATA_URI_PREFIX.length), 'base64'), s.sampleMs)).toBe(true);
    const gen = new SignatureGenerator();
    for (let n = MIN_WINDOW_SECONDS * SAMPLE_RATE; n <= 12 * SAMPLE_RATE; n++) {
      gen.numberSamples = n;
      if (!checkSignatureBytes(gen.encode(), gen.sampleMs())) throw new Error(`rejected at ${n} samples (sampleMs ${gen.sampleMs()})`);
    }
  });
});
