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
