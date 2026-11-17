import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueuePolicy } from '../security/fair_queue.js';
import { createAddressContext, setAddressContextForTest } from '../services/address_context.js';
import { createTestAddressData, settleAddressData } from '../test_fixtures/address/builders.js';
import { publicDataRoutes } from './public_data.js';

/**
 * 住所データの構築が、順番・予算で断られたとき（AddressBusyError。設計 6。穴 25）の REST: 429 と Retry-After（code: RESOURCE_BUSY）。
 * 以前は、順番の上限も予算も無かったので、断る道そのものが無かった。取得の失敗（502）・待ち時間切れ（502 ADDRESS_DATA_PENDING）とは別。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-route-busy-'));
});
afterEach(async () => {
  setAddressContextForTest(null);
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
});

const noRoom = (): QueuePolicy => ({ perTenant: 0, total: 1000, waitMs: Number.POSITIVE_INFINITY, sharePercent: 100 });
const post = (path: string, body: unknown) =>
  publicDataRoutes.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('構築を断られたら、429 と Retry-After', () => {
  test.each([
    ['/geo/postal-code', { zipcode: '100-0014' }],
    ['/geo/address/normalize', { address: '東京都千代田区永田町1-7-1' }],
    ['/geo/reverse', { lat: 35.6759, lon: 139.7463 }],
  ] as const)('POST %s', async (path, body) => {
    const built = createTestAddressData(dir, { queuePolicy: noRoom });
    setAddressContextForTest(createAddressContext(built.data));
    const res = await post(path, body);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({ code: 'RESOURCE_BUSY', status: 429, retryable: true, error: expect.stringContaining('住所データの構築の順番') });
  });
});
