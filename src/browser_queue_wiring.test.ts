import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as engine from './browser_engine.js';
import { browserQueuePolicy, browserSemaphore, closeSharedBrowser, getBrowser, isSharedBrowserConnected, type Lease, recordBrowserUsage, resolveChromiumPath } from './browser_engine.js';
import { closeAllBrowserSessions, getActiveSessionCount, handleBrowserSessionAction, MAX_ACTIVE_SESSIONS } from './browser_session.js';
import { fetchWithStealthBrowser } from './browser_stealth.js';
import { ResourceBusyError } from './errors.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';

/**
 * 本番の枠（browserSemaphore）が、水準（SORA_ISOLATION）の値に従うこと、呼び出し元が利用者（tenant）を渡すこと（設計 6。穴 25）。
 * ブラウザは起動しない（枠を断られるので、起動の前に失敗する）。枠の数は、メモリから決まる（1〜5）ので、枠の数に頼らない書き方にする。
 * 枠そのものの振る舞い（公平・割合・待つ数・時間切れ）は browser_semaphore.test.ts
 */

const held: Lease[] = [];
const waiting: Array<Promise<Lease>> = [];
let previous: Record<string, string | undefined> = {};

beforeEach(() => {
  previous = { SORA_ISOLATION: process.env.SORA_ISOLATION, CHROME_PATH: process.env.CHROME_PATH };
  process.env.CHROME_PATH = process.execPath; // 存在するファイル。ブラウザの場所の検査だけを通す（起動はしない）
});

afterEach(async () => {
  for (const lease of held.splice(0)) lease();
  await Promise.allSettled(waiting.splice(0).map((promise) => promise.then((lease) => lease())));
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetSecurityMetrics();
});

/** 枠を全部埋める。tenant を分けて取る（1 つの tenant が持てる枠の割合に当たらないように） */
async function saturate(): Promise<void> {
  for (let i = 0; browserSemaphore.activeCount < browserSemaphore.max; i++) held.push(await browserSemaphore.acquire(`hog-${i}`));
}

/** tenant の待ちを、上限まで埋める */
function fillQueue(tenantId: string, count: number): void {
  for (let i = 0; i < count; i++) waiting.push(browserSemaphore.acquire(tenantId));
}

const busyOf = async (promise: Promise<unknown>): Promise<ResourceBusyError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ResourceBusyError);
  return error as ResourceBusyError;
};

describe('枠の方針は、水準の値', () => {
  test('standard（既定）: 待つ数は tenant ごとに 100・全体で 500・待ち時間 10 分・割合は制限なし', () => {
    delete process.env.SORA_ISOLATION;
    expect(browserQueuePolicy()).toEqual({ perTenant: 100, total: 500, waitMs: 600_000, sharePercent: 100 });
  });

  test('strict: 待つ数は tenant ごとに 10・全体で 100・待ち時間 1 分・1 つの tenant は半分まで', () => {
    process.env.SORA_ISOLATION = 'strict';
    expect(browserQueuePolicy()).toEqual({ perTenant: 10, total: 100, waitMs: 60_000, sharePercent: 50 });
  });

  test('枠は、取るたびに水準を読む: strict なら待ちは 10 件まで、standard なら 100 件まで（本番の枠が方針につながっている）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    await saturate();
    fillQueue('T', 10);
    const strictBusy = await busyOf(browserSemaphore.acquire('T'));
    expect(strictBusy.reason).toBe('tenant_queue_full');
    expect(strictBusy.message).toContain('10');
    expect(getSecurityMetrics().sora_browser_busy_tenant_queue_full_total).toBe(1);

    delete process.env.SORA_ISOLATION;
    fillQueue('T', 90); // 合わせて 100
    const standardBusy = await busyOf(browserSemaphore.acquire('T'));
    expect(standardBusy.message).toContain('100');
  });
});

describe('枠を使う呼び出し元は、利用者（tenant）を渡す', () => {
  beforeEach(async () => {
    process.env.SORA_ISOLATION = 'strict';
    await saturate();
    fillQueue('T', 10); // T の待ちは上限
  });

  test('ワンショットの browser_action: T の待ちが上限なら、ブラウザを起動する前に ResourceBusyError', async () => {
    const busy = await busyOf(handleBrowserSessionAction({ url: 'https://example.com/', tenantId: 'T', actions: [] }));
    expect(busy.reason).toBe('tenant_queue_full');
  });

  test('セッションの作成（createSession）も同じ', async () => {
    const busy = await busyOf(handleBrowserSessionAction({ url: 'https://example.com/', tenantId: 'T', createSession: true, actions: [] }));
    expect(busy.reason).toBe('tenant_queue_full');
  });

  test('scrape のブラウザ描画（fetchWithStealthBrowser）も同じ', async () => {
    const busy = await busyOf(fetchWithStealthBrowser('https://example.com/queue-test', 5000, undefined, undefined, 'networkidle2', false, true, 'T'));
    expect(busy.reason).toBe('tenant_queue_full');
  });

  test('ほかの tenant の待ちは、T の待ちに影響されない（断られず、待つ）', async () => {
    const before = browserSemaphore.pendingCount;
    waiting.push(browserSemaphore.acquire('U'));
    expect(browserSemaphore.pendingCount).toBe(before + 1);
  });
});

describe('ブラウザの起動に失敗しても、枠は戻る（枠を持ったまま失敗して、枠が減り続けない）', () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  const failToLaunch = () => spies.push(spyOn(engine, 'getBrowser').mockRejectedValue(new Error('launch failed')));

  test('ワンショットの browser_action', async () => {
    failToLaunch();
    const before = browserSemaphore.activeCount;
    await expect(handleBrowserSessionAction({ url: 'https://example.com/', tenantId: 'T', actions: [] })).rejects.toThrow('launch failed');
    expect(browserSemaphore.activeCount).toBe(before);
  });

  test('セッションの作成', async () => {
    failToLaunch();
    const before = browserSemaphore.activeCount;
    await expect(handleBrowserSessionAction({ url: 'https://example.com/', tenantId: 'T', createSession: true, actions: [] })).rejects.toThrow('launch failed');
    expect(browserSemaphore.activeCount).toBe(before);
  });

  test('scrape のブラウザ描画', async () => {
    failToLaunch();
    const before = browserSemaphore.activeCount;
    await expect(fetchWithStealthBrowser('https://example.com/launch-fail', 5000, undefined, undefined, 'networkidle2', false, true, 'T')).rejects.toThrow('launch failed');
    expect(browserSemaphore.activeCount).toBe(before);
  });
});

// 実際のブラウザで確かめる（ブラウザが無い環境では飛ばす）。共有ブラウザは、200 回使われたあと、枠が全部空いたときに入れ替える（枠の「すべて空いた」の通知につながっている）
const browserAvailable = Boolean(resolveChromiumPath());
describe.skipIf(!browserAvailable)('共有ブラウザの入れ替え', () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
    await closeSharedBrowser();
  });

  test('200 回使われたあと、最後の枠が戻ると、共有ブラウザを閉じる（次の取得で起動し直す）', async () => {
    await getBrowser();
    expect(isSharedBrowserConnected()).toBe(true);
    for (let i = 0; i < 200; i++) recordBrowserUsage();
    const lease = await browserSemaphore.acquire('rotate');
    expect(isSharedBrowserConnected()).toBe(true); // 枠を持っている間は閉じない
    lease();
    const deadline = Date.now() + 10_000;
    while (isSharedBrowserConnected() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isSharedBrowserConnected()).toBe(false);
  }, 30_000);

  test('ワンショットの browser_action は、ブラウザが起動したあと、ページを開く前に失敗しても、枠は戻る', async () => {
    delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK; // ループバックの宛先は、ページを開く前に断られる
    const before = browserSemaphore.activeCount;
    await expect(handleBrowserSessionAction({ url: 'http://127.0.0.1:1/', tenantId: 'T', actions: [] })).rejects.toThrow('private or blocked');
    expect(browserSemaphore.activeCount).toBe(before);
  }, 30_000);

  test('セッションの作成が枠を断られたとき、いちばん古いセッションを閉じない（ほかの人のセッションが、断られた人のせいで消えない）', async () => {
    delete process.env.SORA_ISOLATION;
    for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) await handleBrowserSessionAction({ createSession: true, sessionId: `fill-${i}`, tenantId: 'S', actions: [], extract: { markdown: false } });
    expect(getActiveSessionCount()).toBe(MAX_ACTIVE_SESSIONS);
    process.env.SORA_ISOLATION = 'strict';
    await saturate();
    fillQueue('T', 10);
    const busy = await busyOf(handleBrowserSessionAction({ createSession: true, tenantId: 'T', actions: [] }));
    expect(busy.reason).toBe('tenant_queue_full');
    expect(getActiveSessionCount()).toBe(MAX_ACTIVE_SESSIONS); // 上限に達していても、枠を断られたので、1 つも閉じていない
  }, 60_000);
});
