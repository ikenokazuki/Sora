import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as engine from '../../../browser_engine.js';
import { browserSemaphore } from '../../../browser_engine.js';
import { busyOf, fillQueue, releaseAll, saturate } from '../../../test_fixtures/browser_slots.js';
import { renderTrackingPage } from './browser_track.js';

/**
 * 荷物追跡のブラウザ描画（renderTrackingPage）も、ブラウザの枠の下に置き、呼んだ利用者（tenant）の枠として数える（設計 6。穴 22・25）。
 * 以前は、枠を取らずにブラウザの文脈を開いていたので、追跡の要求を大量に送ると、枠の上限（同時に動かせるブラウザの数）を超えて、
 * 共有のブラウザに何枚でもページを開けた。ブラウザは起動しない（枠を断られるか、起動をテストの偽物に替える）。
 */

const url = 'https://tracking.example.com/t/123';
const spies: Array<{ mockRestore: () => void }> = [];
let previous: Record<string, string | undefined> = {};

beforeEach(() => {
  previous = { SORA_ISOLATION: process.env.SORA_ISOLATION, CHROME_PATH: process.env.CHROME_PATH };
  process.env.CHROME_PATH = process.execPath; // 存在するファイル。ブラウザの場所の検査だけを通す
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await releaseAll();
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('renderTrackingPage と枠', () => {
  test('呼んだ利用者の待ちが上限なら、ブラウザを起動する前に ResourceBusyError（tenant_queue_full）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    await saturate();
    fillQueue('T', 10);
    const busy = await busyOf(renderTrackingPage(url, { tenantId: 'T' }));
    expect(busy.reason).toBe('tenant_queue_full');
  });

  test('ほかの利用者の待ちは、その利用者の上限に数えない（待つ）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    await saturate();
    fillQueue('T', 10);
    const before = browserSemaphore.pendingCount;
    void renderTrackingPage(url, { tenantId: 'U' }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(browserSemaphore.pendingCount).toBe(before + 1);
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
    await expect(renderTrackingPage(url, { tenantId: 'T' })).rejects.toThrow('launch failed');
    expect(during).toBe(before + 1);
    expect(browserSemaphore.activeCount).toBe(before);
  });

  test('枠を待っている間に、呼び出し側が中止したら（signal）、待ちから外れる', async () => {
    await saturate();
    const controller = new AbortController();
    const rendering = renderTrackingPage(url, { tenantId: 'T', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(browserSemaphore.pendingCount).toBe(1);
    controller.abort(new Error('client closed'));
    await expect(rendering).rejects.toThrow('client closed');
    expect(browserSemaphore.pendingCount).toBe(0);
  });

  test('ブラウザが無い環境（場所が見つからない）では、枠を取らず undefined（案内へ退避する）', async () => {
    process.env.CHROME_PATH = '/nonexistent/chromium';
    await saturate(); // 枠が埋まっていても、待たない
    if (engine.resolveChromiumPath()) return; // この環境に標準の場所のブラウザがあれば、この確認は意味がない
    expect(await renderTrackingPage(url, { tenantId: 'T' })).toBeUndefined();
  });
});
