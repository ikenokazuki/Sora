import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { clearCache, getFromCache } from './cache.js';
import { inspectImage } from './services/image_inspect.js';
import { fetchFlightStatus, fetchRoadTraffic } from './services/traffic.js';
import * as registry from './services/tracking/registry.js';
import { trackPackage } from './services/tracking/index.js';
import type { TrackingResult } from './types.js';

// キャッシュの保持時間は setToCache() の第3引数（ミリ秒）で決まる。以前は交通・フライト・画像・荷物追跡の定数だけが
// 秒（180・3600・300・86400）で書かれていて、3分のつもりが 0.18 秒しか保持されず、事実上キャッシュが効いていなかった。

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('TTL 定数の単位', () => {
  test('export されている TTL 定数は、どれもミリ秒（1 秒以上で、秒の整数倍）で書かれている', async () => {
    // 秒で書いた定数（180・3600・86400 など）は、ミリ秒と見ると 1000 の倍数にならないか、1 秒に満たない。
    // 新しい定数もこの検査に自動で入る。秒で持ちたい値は、名前に SECONDS を含める。
    const srcDir = import.meta.dir;
    const exported = /^export const ([A-Z][A-Z0-9_]*TTL[A-Z0-9_]*)\s*=/gm;
    const found: string[] = [];
    for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: srcDir })) {
      if (file.endsWith('.test.ts')) continue;
      const names = [...readFileSync(join(srcDir, file), 'utf8').matchAll(exported)].map((m) => m[1]).filter((n) => !n.includes('SECONDS'));
      if (names.length === 0) continue;
      const mod = await import(join(srcDir, file));
      for (const name of names) {
        const value = mod[name];
        const where = `${relative(srcDir, join(srcDir, file))}: ${name}`;
        expect(typeof value, where).toBe('number');
        expect(value, where).toBeGreaterThanOrEqual(1000);
        expect(value % 1000, where).toBe(0);
        found.push(name);
      }
    }
    // 走査が何も拾えていない状態で通ってしまわないように
    expect(found.length).toBeGreaterThanOrEqual(15);
    expect(found).toEqual(expect.arrayContaining(['CACHE_TTL_TRAFFIC', 'CACHE_TTL_FLIGHT', 'CACHE_TTL_IMAGE', 'TRACKING_CACHE_TTL', 'TRACKING_DELIVERED_CACHE_TTL']));
  });

  test('意図した保持時間になっている', async () => {
    const traffic = await import('./services/traffic.js');
    const image = await import('./services/image_inspect.js');
    const tracking = await import('./services/tracking/index.js');
    expect(traffic.CACHE_TTL_TRAFFIC).toBe(3 * MINUTE);
    expect(traffic.CACHE_TTL_FLIGHT).toBe(3 * MINUTE);
    expect(image.CACHE_TTL_IMAGE).toBe(HOUR);
    expect(tracking.TRACKING_CACHE_TTL).toBe(5 * MINUTE);
    expect(tracking.TRACKING_DELIVERED_CACHE_TTL).toBe(24 * HOUR);
  });
});

describe('キャッシュが意図した時間のあいだ効く', () => {
  const realFetch = globalThis.fetch;
  let origin = 0;

  beforeEach(() => {
    clearCache();
    origin = Date.now();
    setSystemTime(new Date(origin));
  });

  afterEach(() => {
    setSystemTime();
    globalThis.fetch = realFetch;
    clearCache();
  });

  const at = (offsetMs: number) => setSystemTime(new Date(origin + offsetMs));

  function stubYahooPages() {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('<html><head><title>交通情報</title></head><body></body></html>');
    }) as unknown as typeof fetch;
    return () => calls;
  }

  test('道路交通は 3 分保持する（2 分後はキャッシュ、4 分後は取り直す）', async () => {
    const calls = stubYahooPages();
    await fetchRoadTraffic({ pref: 13 });
    expect(calls()).toBe(1);

    at(2 * MINUTE);
    const cached = await fetchRoadTraffic({ pref: 13 });
    expect(calls()).toBe(1);
    expect((cached as { cached?: boolean }).cached).toBe(true);

    at(4 * MINUTE);
    await fetchRoadTraffic({ pref: 13 });
    expect(calls()).toBe(2);
  });

  test('フライト運航状況は 3 分保持する', async () => {
    const calls = stubYahooPages();
    await fetchFlightStatus({ airport: '羽田' });
    at(2 * MINUTE);
    await fetchFlightStatus({ airport: '羽田' });
    expect(calls()).toBe(1);

    at(4 * MINUTE);
    await fetchFlightStatus({ airport: '羽田' });
    expect(calls()).toBe(2);
  });

  describe('画像（手元のサーバー）', () => {
    let server: ReturnType<typeof Bun.serve>;
    let hits = 0;
    let prevAllowLocal: string | undefined;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    beforeAll(() => {
      prevAllowLocal = process.env.ALLOW_LOCAL_FETCH;
      process.env.ALLOW_LOCAL_FETCH = 'true';
      server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { hits++; return new Response(png, { headers: { 'content-type': 'image/png' } }); } });
    });

    afterAll(() => {
      server.stop(true);
      if (prevAllowLocal === undefined) delete process.env.ALLOW_LOCAL_FETCH;
      else process.env.ALLOW_LOCAL_FETCH = prevAllowLocal;
    });

    test('画像は 1 時間保持する（30 分後はキャッシュ、61 分後は期限切れ）', async () => {
      const url = `http://127.0.0.1:${server.port}/pixel.png`;
      const before = hits;
      await inspectImage({ url });
      expect(hits - before).toBe(1);

      at(30 * MINUTE);
      const cached = await inspectImage({ url });
      expect(cached.cached).toBe(true);
      expect(hits - before).toBe(1);

      // 期限後の取り直しは、時計を進めたまま取得させない。ドメインごとの間隔制御は最終アクセス時刻を Date.now() で
      // 覚えるため、進めた時刻で取得すると、時計を戻したあとの別のテストが進めた分だけ待たされる。ここでは期限切れだけを見る
      at(61 * MINUTE);
      expect(getFromCache(`img_inspect:${url}`)).toBeNull();
      expect(hits - before).toBe(1);
    });
  });

  describe('荷物追跡', () => {
    let trackSpy: ReturnType<typeof spyOn> | undefined;
    let tracks = 0;

    function useFakeCarrier(status: TrackingResult['status']) {
      tracks = 0;
      const adapter = {
        code: 'ups',
        name: 'Fake',
        detect: () => ({ candidate: true, score: 1, strength: 'exclusive', reasons: [] }),
        track: async (trackingNumber: string): Promise<TrackingResult> => {
          tracks++;
          return { carrier: 'ups', carrierName: 'Fake', trackingNumber, status, statusText: status, events: [], trackingUrl: 'https://example.com/track' };
        },
        verify: () => ({ level: 'strong', reasons: [] }),
        trackingUrl: () => 'https://example.com/track',
      };
      trackSpy = spyOn(registry, 'getCarrierAdapter').mockReturnValue(adapter as never);
    }

    afterEach(() => {
      trackSpy?.mockRestore();
      trackSpy = undefined;
    });

    test('配送中は 5 分保持する（4 分後はキャッシュ、6 分後は取り直す）', async () => {
      useFakeCarrier('in_transit');
      const req = { trackingNumber: '1Z0000000000000001', carrier: 'ups' as const };
      await trackPackage(req);
      at(4 * MINUTE);
      const cached = await trackPackage(req);
      expect(cached.cached).toBe(true);
      expect(tracks).toBe(1);

      at(6 * MINUTE);
      await trackPackage(req);
      expect(tracks).toBe(2);
    });

    test('配達完了は 24 時間保持する（23 時間後はキャッシュ、25 時間後は取り直す）', async () => {
      useFakeCarrier('delivered');
      const req = { trackingNumber: '1Z0000000000000002', carrier: 'ups' as const };
      await trackPackage(req);
      at(23 * HOUR);
      await trackPackage(req);
      expect(tracks).toBe(1);

      at(25 * HOUR);
      await trackPackage(req);
      expect(tracks).toBe(2);
    });
  });
});
