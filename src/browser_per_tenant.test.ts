import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { browserSemaphore, closeSharedBrowser, getBrowser, isSharedBrowserConnected, maybeRotateSharedBrowser, perTenantBrowsersEnabled, recordBrowserUsage, resolveChromiumPath } from './browser_engine.js';
import { ResourceBusyError } from './errors.js';
import { STRICT_LIMITS } from './security/limits.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * tenant ごとのブラウザのプロセス（`strict`。設計 2。段階 6）を、実際の Chromium で確かめる。
 * 番号・uid の割り当てと、寿命の細かい挙動は、browser_slots.test.ts・browser_pool.test.ts（偽のブラウザ）・browser_launch_plan.test.ts にある。
 */

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pids: Array<number | undefined>, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pids.every((pid) => !isAlive(pid));
}

const strict = <T>(fn: () => Promise<T>) => withEnv({ SORA_ISOLATION: 'strict', SORA_BROWSER_IDLE_TTL_MS: '0' }, fn);

describe.skipIf(!resolveChromiumPath())('tenant ごとのブラウザのプロセス（strict）', () => {
  beforeEach(async () => {
    await closeSharedBrowser();
  });
  afterEach(async () => {
    await closeSharedBrowser();
  });

  test('水準 standard は、tenant が違っても、同じ共有ブラウザを受け取る（今までどおり）', async () => {
    await withEnv({ SORA_ISOLATION: 'standard', SORA_BROWSER_IDLE_TTL_MS: '0' }, async () => {
      expect(perTenantBrowsersEnabled()).toBe(false);
      const a = await getBrowser(undefined, 'name:A');
      const b = await getBrowser(undefined, 'name:B');
      expect(b.browser).toBe(a.browser);
    });
  }, 60000);

  test('水準 strict は、tenant ごとに別の Chromium のプロセスで起動し、同じ tenant には同じブラウザを返す', async () => {
    await strict(async () => {
      expect(perTenantBrowsersEnabled()).toBe(true);
      const a = await getBrowser(undefined, 'name:A');
      const b = await getBrowser(undefined, 'name:B');
      expect(a.browser).not.toBe(b.browser);
      expect(a.browser.process()?.pid).not.toBe(b.browser.process()?.pid);
      expect(a.isDedicated).toBe(false);
      expect((await getBrowser(undefined, 'name:A')).browser).toBe(a.browser);
      expect(isSharedBrowserConnected()).toBe(true);
    });
  }, 90000);

  test('tenant が違えば、Cookie も別のプロセスに入る（ページの描画を破られても、ほかの tenant のプロセスに届かない）', async () => {
    await strict(async () => {
      const a = (await getBrowser(undefined, 'name:A')).browser;
      const b = (await getBrowser(undefined, 'name:B')).browser;
      const contextA = await a.createBrowserContext();
      const pageA = await contextA.newPage();
      await pageA.setCookie({ name: 'secret', value: 'a-only', url: 'https://example.com/' });
      // B のブラウザの全コンテキストに、A の Cookie は無い（別のプロセスなので、見る手段もない）
      const cookiesOfB = (await Promise.all([b.defaultBrowserContext(), ...b.browserContexts()].map((context) => context.cookies?.() ?? []))).flat();
      expect(JSON.stringify(cookiesOfB)).not.toContain('a-only');
      await contextA.close();
    });
  }, 90000);

  test('閉じると、すべての tenant のプロセスが終わる（残らない）。閉じたあとも、起動し直せる', async () => {
    await strict(async () => {
      const browsers = await Promise.all(['name:A', 'name:B', 'name:C'].map((tenant) => getBrowser(undefined, tenant)));
      const pids = browsers.map((entry) => entry.browser.process()?.pid);
      expect(new Set(pids).size).toBe(3);
      await closeSharedBrowser();
      expect(isSharedBrowserConnected()).toBe(false);
      expect(await waitUntilDead(pids)).toBe(true);
      const again = await getBrowser(undefined, 'name:A');
      expect(again.browser.connected).toBe(true);
    });
  }, 120000);

  test(`プロセスの上限（${STRICT_LIMITS.browserProcessMax} 個）に達し、すべてが使用中（開いたコンテキストがある）なら、ResourceBusyError（process_limit）で断る。1 つが空けば、その分を閉じて渡す`, async () => {
    await strict(async () => {
      const tenants = Array.from({ length: STRICT_LIMITS.browserProcessMax }, (_, i) => `name:T${i}`);
      const entries = [];
      for (const tenant of tenants) {
        const { browser } = await getBrowser(undefined, tenant);
        entries.push({ browser, context: await browser.createBrowserContext(), pid: browser.process()?.pid });
      }
      const startedAt = Date.now();
      const error = await getBrowser(undefined, 'name:extra').then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceBusyError);
      expect(error).toMatchObject({ reason: 'process_limit', resource: 'browser' });
      // すぐ断らず、strict の待ち（browserProcessWaitMs = 5 秒）まで、空くのを待った
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(STRICT_LIMITS.browserProcessWaitMs - 500);
      // 1 つのコンテキストを閉じると、そのプロセスは使用中でなくなり、閉じて、新しい tenant に渡す
      const freed = entries[0];
      await freed.context.close();
      const extra = await getBrowser(undefined, 'name:extra');
      expect(extra.browser.connected).toBe(true);
      expect(await waitUntilDead([freed.pid])).toBe(true);
      for (const entry of entries.slice(1)) expect(entry.browser.connected).toBe(true);
      for (const entry of entries.slice(1)) await entry.context.close();
    });
  }, 180000);

  test('SORA_BROWSER_MAX_PROCESSES で上限を変えられる(2 にすると、3 人目が ResourceBusyError(process_limit)で断られる。表の値は変わらない)', async () => {
    await withEnv({ SORA_ISOLATION: 'strict', SORA_BROWSER_IDLE_TTL_MS: '0', SORA_BROWSER_MAX_PROCESSES: '2' }, async () => {
      expect(STRICT_LIMITS.browserProcessMax).toBe(4);
      const held = [];
      for (const tenant of ['name:M0', 'name:M1']) {
        const { browser } = await getBrowser(undefined, tenant);
        held.push({ browser, context: await browser.createBrowserContext() });
      }
      expect(held[0].browser.process()?.pid).not.toBe(held[1].browser.process()?.pid);
      const error = await getBrowser(undefined, 'name:M2').then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceBusyError);
      expect(error).toMatchObject({ reason: 'process_limit', resource: 'browser' });
      for (const entry of held) await entry.context.close();
      // 空けば、渡る(使っていないものを閉じて)
      const third = await getBrowser(undefined, 'name:M2');
      expect(third.browser.connected).toBe(true);
    });
  }, 120000);

  test('ブラウザの枠を持っている tenant のプロセスは、開いたコンテキストが無くても、閉じない（枠を取ってから、ページを開くまでの間に、閉じない）', async () => {
    await strict(async () => {
      const tenants = Array.from({ length: STRICT_LIMITS.browserProcessMax }, (_, i) => `name:H${i}`);
      const entries = [];
      for (const tenant of tenants) entries.push({ browser: (await getBrowser(undefined, tenant)).browser });
      const lease = await browserSemaphore.acquire(tenants[0]); // コンテキストは開いていないが、枠を持っている
      const others = [];
      try {
        for (const entry of entries.slice(1)) others.push(await entry.browser.createBrowserContext());
        const error = await getBrowser(undefined, 'name:extra').then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(ResourceBusyError);
        expect(entries[0].browser.connected).toBe(true);
      } finally {
        lease();
        for (const context of others) await context.close();
      }
    });
  }, 180000);

  test('使った回数が上限（200）に達した tenant のプロセスは、全体が空いたとき（maybeRotateSharedBrowser）に閉じる。ほかの tenant のプロセスは閉じない', async () => {
    await strict(async () => {
      const a = (await getBrowser(undefined, 'name:A')).browser;
      const b = (await getBrowser(undefined, 'name:B')).browser;
      for (let i = 0; i < 200; i++) recordBrowserUsage('name:A');
      recordBrowserUsage('name:B');
      maybeRotateSharedBrowser();
      expect(await waitUntilDead([a.process()?.pid])).toBe(true);
      expect(b.connected).toBe(true);
    });
  }, 90000);

  test('ブラウザごとのプロキシの指定は、番号（uid）の管理の外になるので、使えない', async () => {
    await strict(async () => {
      await expect(getBrowser('http://proxy.invalid:8080', 'name:A')).rejects.toThrow('SORA_ISOLATION=strict');
    });
  });
});
