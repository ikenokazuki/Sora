import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { closeSharedBrowser, resolveChromiumPath } from '../browser_engine.js';
import { wavBytes, wavMono8 } from '../test_fixtures/audio.js';
import { pipeWebmBytes } from '../test_fixtures/audio_pipe_webm.js';
import { AudioDecodeError, AudioTooLongError, UNPROBED_MAX_BYTES, decodeAudioWindows } from './audio_decode.js';

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

  describe('長さの上限（デコードの前に、ファイルの先頭の情報で調べる）', () => {
    const SAVED = process.env.SORA_ISOLATION;
    afterEach(() => {
      if (SAVED === undefined) delete process.env.SORA_ISOLATION;
      else process.env.SORA_ISOLATION = SAVED;
    });

    test('strict（15 分）を超える音は、デコードせずに AudioTooLongError（長さと上限つき）。pickWindows は呼ばれない', async () => {
      process.env.SORA_ISOLATION = 'strict';
      let picked = false;
      const error = await decodeAudioWindows(wavMono8(1000, 8000), () => { picked = true; return [0]; }).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(AudioTooLongError);
      expect((error as AudioTooLongError).limitSec).toBe(900);
      expect((error as AudioTooLongError).durationSec).toBeCloseTo(1000, 0);
      expect((error as AudioTooLongError).message).toContain('音が長すぎます');
      expect(picked).toBe(false);
    });

    test('上限の内（strict の 15 分以下）は、これまでどおり変換できる。standard は 1 時間まで（15 分を超えても通る）', async () => {
      process.env.SORA_ISOLATION = 'strict';
      const within = await decodeAudioWindows(wavMono8(300, 8000), (d) => [Math.floor(d / 2)]);
      expect(within.durationSec).toBeCloseTo(300, 0);
      delete process.env.SORA_ISOLATION;
      const standard = await decodeAudioWindows(wavMono8(1000, 8000), () => [0]);
      expect(standard.durationSec).toBeCloseTo(1000, 0);
    });

    test('standard の上限（1 時間）を超える音も断る', async () => {
      const error = await decodeAudioWindows(wavMono8(3700, 4000), () => [0]).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(AudioTooLongError);
      expect((error as AudioTooLongError).limitSec).toBe(3600);
    });
  });

  test('長さを読めない大きなファイル（形式が分からない 4 MB 超）は、長さを確かめられないので AudioTooLongError（長さなし）。小さければ、これまでどおり AudioDecodeError', async () => {
    const big = new Uint8Array(UNPROBED_MAX_BYTES + 1024).fill(7);
    const error = await decodeAudioWindows(big, () => [0]).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(AudioTooLongError);
    expect((error as AudioTooLongError).durationSec).toBeUndefined();
    expect((error as AudioTooLongError).message).toContain('確かめられない');
    await expect(decodeAudioWindows(new Uint8Array(1024).fill(7), () => [0])).rejects.toBeInstanceOf(AudioDecodeError);
  });

  test('長さを持たない形式（MediaRecorder・パイプ出力の WebM。<audio>.duration が Infinity）は、末尾へ飛んで実際の長さを測る。長さを読めない扱い（大きさの上限）にしない', async () => {
    // 3 秒・約 13 KB の WebM。長さを読めない扱いなら、1 KB の上限で断られる。実際の長さ（3 秒）が測れれば、上限（15 分）の内なので、変換できる
    process.env.SORA_ISOLATION = 'strict';
    try {
      const out = await decodeAudioWindows(pipeWebmBytes(), (d) => [Math.max(0, Math.floor(d) - 3)], 'legacy', { unprobedMaxBytes: 1024 });
      expect(out.durationSec).toBeGreaterThan(2.5);
      expect(out.durationSec).toBeLessThan(3.5);
    } finally {
      delete process.env.SORA_ISOLATION;
    }
  });

  test('bytes that are not audio fail with AudioDecodeError', async () => {
    await expect(decodeAudioWindows(new TextEncoder().encode('<html>not audio</html>'), () => [0])).rejects.toBeInstanceOf(AudioDecodeError);
  });
});
