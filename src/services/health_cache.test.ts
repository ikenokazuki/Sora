import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { setToCache } from '../cache.js';
import { checkDetailedHealth, resetHealthProbeCache } from './health.js';

/**
 * /health?detailed=true の外部への確認（気象庁・P2PQuake・e-Gov の 3 か所）は、1 分に 1 回まで（設計 5。穴 14。ユーザーの決定）。
 * 鍵なしで開く経路が、呼ぶたびに外部へ通信すると、だれでも Sora の IP を相手に制限させられる（天気・地震・法令の機能が全員分止まる）。
 */

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
let urls: string[];
const respond = (url: string) => new Response('ok', { status: url.includes('p2pquake') ? 500 : 200 });

beforeEach(() => {
  resetHealthProbeCache();
  urls = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    return respond(url);
  }) as never);
});
afterEach(() => {
  fetchSpy.mockRestore();
  resetHealthProbeCache();
});

describe('checkDetailedHealth: 外部の 3 か所への確認は、1 分に 1 回まで', () => {
  test('1 分のうちの 2 回目は、外部へ通信せず、1 回目と同じ確認の結果を返す', async () => {
    const t0 = 1_000_000;
    const first = await checkDetailedHealth({ now: t0 });
    expect(urls).toHaveLength(3);
    expect(urls.some((u) => u.includes('jma.go.jp'))).toBe(true);
    expect(urls.some((u) => u.includes('p2pquake'))).toBe(true);
    expect(urls.some((u) => u.includes('e-gov'))).toBe(true);
    const second = await checkDetailedHealth({ now: t0 + 59_999 });
    expect(urls).toHaveLength(3);
    expect(second.dependencies.jma).toEqual(first.dependencies.jma);
    expect(second.dependencies.p2pquake).toEqual(first.dependencies.p2pquake);
    expect(second.dependencies.egov).toEqual(first.dependencies.egov);
  });

  test('1 分たつと、取り直す', async () => {
    const t0 = 1_000_000;
    await checkDetailedHealth({ now: t0 });
    await checkDetailedHealth({ now: t0 + 60_000 });
    expect(urls).toHaveLength(6);
    await checkDetailedHealth({ now: t0 + 60_000 + 59_999 });
    expect(urls).toHaveLength(6);
  });

  test('時計が戻っても（now が前より小さい）、古い結果を使い続けない', async () => {
    await checkDetailedHealth({ now: 2_000_000 });
    await checkDetailedHealth({ now: 1_000_000 });
    expect(urls).toHaveLength(6);
  });

  test('同時に何度呼ばれても、確認は 1 組だけ（呼び出しをまとめる）', async () => {
    const t0 = 3_000_000;
    await Promise.all(Array.from({ length: 20 }, () => checkDetailedHealth({ now: t0 })));
    expect(urls).toHaveLength(3);
  });

  test('失敗した確認（つながらない・HTTP 500）も、1 分のあいだ、そのまま返す（失敗を理由に、連打で取り直さない）', async () => {
    const t0 = 4_000_000;
    const first = await checkDetailedHealth({ now: t0 });
    expect(first.dependencies.p2pquake.status).toBe('error');
    const again = await checkDetailedHealth({ now: t0 + 1_000 });
    expect(again.dependencies.p2pquake.status).toBe('error');
    expect(urls).toHaveLength(3);
  });

  test('内部の項目（キャッシュの件数・稼働時間・時刻）は、毎回、取り直す', async () => {
    const t0 = 5_000_000;
    const first = await checkDetailedHealth({ now: t0 });
    setToCache(`health-cache-test:${Math.random()}`, { v: 1 });
    const second = await checkDetailedHealth({ now: t0 + 1_000 });
    expect(urls).toHaveLength(3);
    expect(second.cachedEntries).toBeGreaterThan(first.cachedEntries);
    expect(second.timestamp >= first.timestamp).toBe(true);
    expect(second.status).toBe('ok');
  });

  test('now を省くと、いまの時刻で動く（呼び出し側は何も渡さない）', async () => {
    await checkDetailedHealth();
    await checkDetailedHealth();
    expect(urls).toHaveLength(3);
  });
});
