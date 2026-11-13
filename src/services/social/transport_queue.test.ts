import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as engine from '../../browser_engine.js';
import { browserSemaphore } from '../../browser_engine.js';
import { busyOf, fillQueue, releaseAll, saturate } from '../../test_fixtures/browser_slots.js';
import { createProdMetaBrowser, createProdSessionOpener } from './transport.js';

/**
 * Weibo の匿名セッションを開くブラウザと、Meta（Threads・Instagram・Facebook）の本文を読むブラウザも、ブラウザの枠の下に置き、
 * 呼んだ利用者（tenant）の枠として数える（設計 6。穴 22・25）。以前は、枠を取らずにブラウザの文脈を開いていたので、検索を大量に送ると、
 * 枠の上限（同時に動かせるブラウザの数）を超えて、共有のブラウザに何枚でもページを開けた。ブラウザは起動しない（枠を断られるか、起動をテストの偽物に替える）。
 */

const metaUrl = 'https://www.threads.net/@someone/post/abc';
const never = () => new AbortController().signal;
const openers: Array<[string, (tenantId: string | undefined, signal: AbortSignal) => Promise<unknown>]> = [
  ['Weibo の匿名セッション', (tenantId, signal) => createProdSessionOpener(tenantId).openWeiboSession(signal)],
  ['Meta の本文（ブラウザ描画）', (tenantId, signal) => createProdMetaBrowser(tenantId).readPage(metaUrl, 5000, signal)],
];

const spies: Array<{ mockRestore: () => void }> = [];
let previousIsolation: string | undefined;

beforeEach(() => {
  previousIsolation = process.env.SORA_ISOLATION;
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await releaseAll();
  if (previousIsolation === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = previousIsolation;
});

describe.each(openers)('%s', (_label, open) => {
  test('呼んだ利用者の待ちが上限なら、ブラウザを起動する前に ResourceBusyError（tenant_queue_full）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    await saturate();
    fillQueue('T', 10);
    const busy = await busyOf(open('T', never()));
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
    await expect(open('T', never())).rejects.toThrow('launch failed');
    expect(during).toBe(before + 1);
    expect(browserSemaphore.activeCount).toBe(before);
  });

  test('枠を待っている間に、呼び出し側が中止したら（signal）、待ちから外れる', async () => {
    await saturate();
    const controller = new AbortController();
    const opening = open('T', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(browserSemaphore.pendingCount).toBe(1);
    controller.abort(new Error('client closed'));
    await expect(opening).rejects.toThrow('client closed');
    expect(browserSemaphore.pendingCount).toBe(0);
  });
});
