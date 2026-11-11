import { afterAll, describe, expect, test } from 'bun:test';
import { closeSharedBrowser, getBrowser, isBrowserLowMemory, resolveChromiumPath } from './browser_engine.js';

const FLAG = '--enable-low-end-device-mode';

describe('isBrowserLowMemory', () => {
  test('true・1・on・yes（大文字小文字・前後の空白は問わない）だけが有効', () => {
    for (const v of ['true', '1', 'on', 'yes', 'TRUE', ' On ', 'Yes']) {
      expect(isBrowserLowMemory({ SORA_BROWSER_LOW_MEMORY: v })).toBe(true);
    }
  });

  test('未設定・空・false・0・off・no・不正な値は無効（例外は投げない）', () => {
    expect(isBrowserLowMemory({})).toBe(false);
    for (const v of ['', ' ', 'false', '0', 'off', 'no', 'abc', '2', 'truee']) {
      expect(isBrowserLowMemory({ SORA_BROWSER_LOW_MEMORY: v })).toBe(false);
    }
  });
});

describe.skipIf(!resolveChromiumPath())('Chromium の起動引数', () => {
  const prev = process.env.SORA_BROWSER_LOW_MEMORY;
  afterAll(async () => {
    if (prev === undefined) delete process.env.SORA_BROWSER_LOW_MEMORY; else process.env.SORA_BROWSER_LOW_MEMORY = prev;
    await closeSharedBrowser();
  });

  test('無効なら --enable-low-end-device-mode を付けず、有効なら付けて起動し直す', async () => {
    delete process.env.SORA_BROWSER_LOW_MEMORY;
    await closeSharedBrowser();
    const off = (await getBrowser()).browser.process()?.spawnargs ?? [];
    expect(off).not.toContain(FLAG);

    process.env.SORA_BROWSER_LOW_MEMORY = 'true';
    await closeSharedBrowser();
    const { browser } = await getBrowser();
    expect(browser.process()?.spawnargs ?? []).toContain(FLAG);

    // 有効でも、ページは普通に開ける（フラグで起動に失敗していない）
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setContent('<title>ok</title>');
      expect(await page.title()).toBe('ok');
    } finally {
      await context.close();
    }
  }, 60000);
});
