import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeSharedBrowser,
  defaultBrowserConcurrency,
  resolveBrowserConcurrency,
  getBrowser,
  isSharedBrowserConnected,
  resolveChromiumPath,
} from './browser_engine.js';

afterAll(closeSharedBrowser);

const GB = 1024 ** 3;

describe('defaultBrowserConcurrency', () => {
  test('scales with memory and stays within 1..5', () => {
    expect(defaultBrowserConcurrency(0.5 * GB)).toBe(1);
    expect(defaultBrowserConcurrency(1 * GB)).toBe(1);
    expect(defaultBrowserConcurrency(2 * GB)).toBe(4);
    expect(defaultBrowserConcurrency(4 * GB)).toBe(5);
    expect(defaultBrowserConcurrency(64 * GB)).toBe(5);
  });
  test('unknown memory falls back to the previous default of 5', () => {
    expect(defaultBrowserConcurrency(undefined)).toBe(5);
  });
  test('MAX_CONCURRENT_BROWSERS: a positive integer wins, anything else falls back to the memory-based default', () => {
    expect(resolveBrowserConcurrency('3', 1 * GB)).toBe(3);
    expect(resolveBrowserConcurrency('80', 1 * GB)).toBe(50);
    for (const bad of [undefined, '', 'abc', '0', '-2', '2.5x']) expect(resolveBrowserConcurrency(bad, 2 * GB)).toBe(4);
  });
});

describe.skipIf(!resolveChromiumPath())('shared browser idle shutdown', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const withTtl = async (ttl: string, fn: () => Promise<void>) => {
    const prev = process.env.BROWSER_IDLE_TTL_MS;
    process.env.BROWSER_IDLE_TTL_MS = ttl;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.BROWSER_IDLE_TTL_MS; else process.env.BROWSER_IDLE_TTL_MS = prev;
    }
  };

  test('closes the shared browser after the idle TTL and relaunches on demand', async () => {
    await withTtl('400', async () => {
      await closeSharedBrowser();
      await getBrowser();
      expect(isSharedBrowserConnected()).toBe(true);
      await sleep(1200);
      expect(isSharedBrowserConnected()).toBe(false);
      const { browser } = await getBrowser();
      expect(browser.connected).toBe(true);
    });
  }, 30000);

  test('stays open while a browser context is still in use', async () => {
    await withTtl('400', async () => {
      await closeSharedBrowser();
      const { browser } = await getBrowser();
      const context = await browser.createBrowserContext();
      await context.newPage();
      await sleep(1200);
      expect(isSharedBrowserConnected()).toBe(true);
      await context.close();
      await sleep(1200);
      expect(isSharedBrowserConnected()).toBe(false);
    });
  }, 30000);

  test('does not close a browser that was handed out while the idle check was running', async () => {
    await withTtl('400', async () => {
      await closeSharedBrowser();
      const { browser } = await getBrowser();
      const pages = browser.pages.bind(browser);
      // 空き判定の await 中に、別のリクエストが同じブラウザを受け取る状況を再現する
      (browser as any).pages = async () => { await getBrowser(); return pages(); };
      await sleep(1000);
      expect(isSharedBrowserConnected()).toBe(true);
      (browser as any).pages = pages;
    });
  }, 30000);

  test('BROWSER_IDLE_TTL_MS=0 disables idle shutdown', async () => {
    await withTtl('0', async () => {
      await closeSharedBrowser();
      await getBrowser();
      await sleep(900);
      expect(isSharedBrowserConnected()).toBe(true);
    });
  }, 30000);
});
