import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as engine from '../browser_engine.js';
import { browserSemaphore } from '../browser_engine.js';
import { clearCache } from '../cache.js';
import { ResourceBusyError } from '../errors.js';
import { toneBursts } from '../test_fixtures/audio.js';
import { busyOf, fillQueue, releaseAll, saturate } from '../test_fixtures/browser_slots.js';
import { decodeAudioWindows } from './audio_decode.js';
import { recognizeSong } from './song_recognition.js';

/**
 * 音声のデコード（recognize_song が、利用者の音声を共有のブラウザの Web Audio で開く。穴 26・22）を、呼んだ利用者（tenant）の枠として数える（設計 6）。
 * 以前は、枠を取るが、利用者を渡さなかったので、全員が legacy の 1 人として数えられた。
 */

const bytes = new Uint8Array([1, 2, 3, 4]);
const spies: Array<{ mockRestore: () => void }> = [];
let previous: Record<string, string | undefined> = {};

beforeEach(() => {
  previous = { SORA_ISOLATION: process.env.SORA_ISOLATION, CHROME_PATH: process.env.CHROME_PATH };
  process.env.CHROME_PATH = process.execPath; // 存在するファイル。ブラウザの場所の検査だけを通す
  clearCache();
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await releaseAll();
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearCache();
});

describe('decodeAudioWindows と枠', () => {
  test('呼んだ利用者の待ちが上限なら、ブラウザを起動する前に ResourceBusyError', async () => {
    process.env.SORA_ISOLATION = 'strict';
    await saturate();
    fillQueue('T', 10);
    const busy = await busyOf(decodeAudioWindows(bytes, () => [0], 'T'));
    expect(busy.reason).toBe('tenant_queue_full');
  });

  test('ブラウザを起動している間は枠を持ち、起動に失敗しても、枠は戻る', async () => {
    let during = -1;
    spies.push(
      spyOn(engine, 'getBrowser').mockImplementation(async () => {
        during = browserSemaphore.activeCount;
        throw new Error('launch failed');
      }),
    );
    const before = browserSemaphore.activeCount;
    await expect(decodeAudioWindows(bytes, () => [0], 'T')).rejects.toThrow('launch failed');
    expect(during).toBe(before + 1);
    expect(browserSemaphore.activeCount).toBe(before);
  });
});

describe('recognizeSong は、利用者を decode に渡す', () => {
  const decodeSpy = () => {
    const seen: unknown[] = [];
    const decode = async (_bytes: Uint8Array, pick: (d: number) => number[], tenantId?: string) => {
      seen.push(tenantId);
      return { durationSec: 30, windows: pick(30).map((offsetSec) => ({ offsetSec, pcm: toneBursts(1000) })) };
    };
    return { seen, decode };
  };
  // Shazam・iTunes へは出ない（照会は、どの窓も当たらない応答にする）
  const fetchFn = (async () => Response.json({ matches: [] })) as unknown as typeof fetch;

  test('options の tenantId を渡す。無ければ legacy', async () => {
    const { seen, decode } = decodeSpy();
    await recognizeSong({ audio: { bytes: new Uint8Array([9, 1]), contentType: 'audio/mp4' }, tenantId: 'name:alice', noCache: true }, { decode, fetchFn });
    await recognizeSong({ audio: { bytes: new Uint8Array([9, 2]), contentType: 'audio/mp4' }, noCache: true }, { decode, fetchFn });
    expect(seen).toEqual(['name:alice', 'legacy']);
  });

  test('枠を断られたとき（ResourceBusyError）は、「音声でない」などの結果にせず、そのまま投げる。結果はキャッシュに入らない', async () => {
    const decode = async () => {
      throw new ResourceBusyError('ブラウザの枠が混み合っています', 'queue_full', 5);
    };
    const options = { audio: { bytes: new Uint8Array([9, 3]), contentType: 'audio/mp4' }, tenantId: 'T' };
    await busyOf(recognizeSong(options, { decode, fetchFn }));
    // 次の呼び出しは、キャッシュに当たらず、また decode する（断られた結果を覚えていない）
    const { seen, decode: ok } = decodeSpy();
    await recognizeSong(options, { decode: ok, fetchFn });
    expect(seen).toEqual(['T']);
  });
});
