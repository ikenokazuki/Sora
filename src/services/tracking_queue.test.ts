import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { clearCache, getFromCache } from '../cache.js';
import { busyOf, fillQueue, releaseAll, saturate } from '../test_fixtures/browser_slots.js';
import { trackingCacheKey, trackPackage, trackPackageAuto } from './tracking/index.js';
import type { TrackingCarrierAdapter, TrackingContext } from './tracking/types.js';

/**
 * trackPackage（荷物追跡の入口）は、呼んだ利用者（tenant）を、carrier のブラウザ取得の枠まで渡す（設計 6。穴 22・25）。
 * 枠が混み合って断られた結果は、番号ごとの共有キャッシュに入れない（ある利用者が上限を超えたせいで、ほかの利用者の結果が、しばらく「確認できない」にならない）。
 */

const UPS_NUMBER = '1Z999AA10123456784';
const spies: Array<{ mockRestore: () => void }> = [];
let previous: Record<string, string | undefined> = {};
const CREDENTIALS = ['SORA_TRACKING_UPS_CLIENT_ID', 'SORA_TRACKING_UPS_CLIENT_SECRET'];

beforeEach(() => {
  previous = Object.fromEntries(['SORA_ISOLATION', 'CHROME_PATH', ...CREDENTIALS].map((name) => [name, process.env[name]]));
  for (const name of CREDENTIALS) delete process.env[name];
  process.env.CHROME_PATH = process.execPath;
  process.env.SORA_ISOLATION = 'strict';
  spies.push(spyOn(console, 'warn').mockImplementation(() => {}));
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

describe('trackPackage の利用者', () => {
  test('carrier を指定した照会: 利用者の待ちが上限なら ResourceBusyError。結果は共有キャッシュに入らない', async () => {
    await saturate();
    fillQueue('T', 10);
    const busy = await busyOf(trackPackage({ trackingNumber: UPS_NUMBER, carrier: 'ups' }, { tenantId: 'T' }));
    expect(busy.reason).toBe('tenant_queue_full');
    expect(getFromCache(trackingCacheKey({ carrier: 'ups' }, UPS_NUMBER))).toBeNull();
  });

  test('自動判別（UPS の番号は、ほかの会社と紛れない）も同じ。結果は共有キャッシュに入らない', async () => {
    await saturate();
    fillQueue('T', 10);
    const busy = await busyOf(trackPackage({ trackingNumber: UPS_NUMBER, carrier: 'auto' }, { tenantId: 'T' }));
    expect(busy.reason).toBe('tenant_queue_full');
    expect(getFromCache(trackingCacheKey({ carrier: 'auto' }, UPS_NUMBER))).toBeNull();
  });
});

describe('自動判別の候補にも、利用者を渡す', () => {
  const result = { carrier: 'ups', carrierName: 'UPS', trackingNumber: UPS_NUMBER, status: 'in_transit', statusText: 'x', events: [], trackingUrl: 'https://www.ups.com/' } as const;
  const candidate = (strength: 'exclusive' | 'strong', seen: Array<TrackingContext | undefined>) => ({
    carrier: 'ups' as const,
    score: 1,
    strength,
    reasons: [],
    adapter: {
      code: 'ups',
      name: 'UPS',
      detect: () => ({ candidate: true, score: 1, strength, reasons: [] }),
      track: async (_num: string, context?: TrackingContext) => {
        seen.push(context);
        return result;
      },
      verify: () => ({ level: 'strong' as const, reasons: [] }),
      trackingUrl: () => 'https://www.ups.com/',
    } as unknown as TrackingCarrierAdapter,
  });

  test('exclusive な候補（単体で実行）', async () => {
    const seen: Array<TrackingContext | undefined> = [];
    await trackPackageAuto(UPS_NUMBER, { candidatesOverride: [candidate('exclusive', seen)], tenantId: 'name:alice' });
    expect(seen.map((context) => context?.tenantId)).toEqual(['name:alice']);
  });

  test('ほかの候補（Wave で並行に実行）', async () => {
    const seen: Array<TrackingContext | undefined> = [];
    await trackPackageAuto(UPS_NUMBER, { candidatesOverride: [candidate('strong', seen)], tenantId: 'name:alice' });
    expect(seen.map((context) => context?.tenantId)).toEqual(['name:alice']);
  });
});

