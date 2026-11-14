import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as engine from '../../../browser_engine.js';
import { browserSemaphore } from '../../../browser_engine.js';
import { busyOf, fillQueue, releaseAll, saturate } from '../../../test_fixtures/browser_slots.js';
import type { TrackingCarrierAdapter } from '../types.js';
import { dhlAdapter } from './dhl.js';
import { fedexAdapter } from './fedex.js';
import { upsAdapter } from './ups.js';

/**
 * UPS・FedEx・DHL の、資格情報なしのブラウザ取得（設計 6。穴 22・25）。呼んだ利用者（tenant）の枠として数え、枠が混み合って断られたときは、
 * 案内（公式ページの URL だけの結果）に退避しない。退避した結果は、荷物の番号ごとの共有キャッシュに入るので、ある利用者が上限を超えたせいで、
 * ほかの利用者の結果が、しばらく「確認できない」になってしまう。ブラウザの起動の失敗は、これまでどおり、案内へ退避する。
 */

const carriers: Array<[string, TrackingCarrierAdapter, string]> = [
  ['UPS', upsAdapter, '1Z999AA10123456784'],
  ['FedEx', fedexAdapter, '123456789012'],
  ['DHL', dhlAdapter, '1234567890'],
];
const CREDENTIALS = ['SORA_TRACKING_UPS_CLIENT_ID', 'SORA_TRACKING_UPS_CLIENT_SECRET', 'SORA_TRACKING_FEDEX_CLIENT_ID', 'SORA_TRACKING_FEDEX_CLIENT_SECRET', 'SORA_TRACKING_DHL_API_KEY'];

const spies: Array<{ mockRestore: () => void }> = [];
let previous: Record<string, string | undefined> = {};

beforeEach(() => {
  previous = Object.fromEntries(['SORA_ISOLATION', 'CHROME_PATH', ...CREDENTIALS].map((name) => [name, process.env[name]]));
  for (const name of CREDENTIALS) delete process.env[name]; // 資格情報なし = ブラウザ取得の経路
  process.env.CHROME_PATH = process.execPath; // 存在するファイル。ブラウザの場所の検査だけを通す
  spies.push(spyOn(console, 'warn').mockImplementation(() => {}));
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await releaseAll();
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe.each(carriers)('%s のブラウザ取得', (_label, adapter, number) => {
  test('呼んだ利用者の待ちが上限なら、案内に退避せず、ResourceBusyError を投げる（共有キャッシュに入れさせない）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    await saturate();
    fillQueue('T', 10);
    const busy = await busyOf(adapter.track(number, { tenantId: 'T' }));
    expect(busy.reason).toBe('tenant_queue_full');
  });

  test('枠を待っている間に、呼び出し側が中止したら（signal）、待ちから外れる（中止の合図が、枠の待ちまで届く）', async () => {
    await saturate();
    const controller = new AbortController();
    const tracking = adapter.track(number, { tenantId: 'T', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(browserSemaphore.pendingCount).toBe(1);
    controller.abort(new Error('client closed'));
    expect((await tracking).status).toBe('unknown'); // 中止は、案内へ退避する（混み合いとは違う）
    expect(browserSemaphore.pendingCount).toBe(0);
  });

  test('ブラウザの起動に失敗したときは、これまでどおり、案内（公式ページの URL）へ退避する', async () => {
    spies.push(spyOn(engine, 'getBrowser').mockRejectedValue(new Error('launch failed')));
    const result = await adapter.track(number, { tenantId: 'T' });
    expect(result.status).toBe('unknown');
    expect(result.trackingUrl).toContain(number);
  });
});
