import { describe, expect, test } from 'bun:test';
import { SignatureTooShortError as PackageTooShort, createSignature, encodeBase64 } from '../../packages/audio-signature/src/index.js';
import { toneBursts } from '../test_fixtures/audio.js';
import { DATA_URI_PREFIX, MIN_WINDOW_SECONDS, SAMPLE_RATE, SignatureTooShortError, signatureUri } from './shazam_signature.js';

// 計算と形の検査のテストは packages/audio-signature/test/index.test.ts にある
describe('signatureUri', () => {
  test('a 12 s window gives the package signature behind the data URI prefix, and 12000 ms', () => {
    const { uri, sampleMs } = signatureUri(toneBursts(1000));
    expect(uri).toBe(DATA_URI_PREFIX + encodeBase64(createSignature(toneBursts(1000)).bytes));
    expect(DATA_URI_PREFIX).toBe('data:audio/vnd.shazam.sig;base64,');
    expect(sampleMs).toBe(12000);
  });

  test('too short or silent audio is refused with the package error', () => {
    expect(SignatureTooShortError).toBe(PackageTooShort);
    expect(() => signatureUri(toneBursts(1000, MIN_WINDOW_SECONDS - 1))).toThrow(SignatureTooShortError);
    expect(() => signatureUri(new Int16Array(12 * SAMPLE_RATE))).toThrow(SignatureTooShortError);
  });
});
