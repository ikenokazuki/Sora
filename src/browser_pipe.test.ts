import { afterAll, describe, expect, test } from 'bun:test';
import { browserCdpMode, closeSharedBrowser, getBrowser, resolveChromiumPath } from './browser_engine.js';

// Bun 1.3.x ではポートのまま（browserCdpMode）。パイプの試験は、パイプを使う版（Bun 1.4.4 以上）だけで行う
describe.skipIf(!resolveChromiumPath() || browserCdpMode() !== 'pipe')('ブラウザの CDP は、TCP のデバッグポートでなくパイプで繋ぐ', () => {
  afterAll(async () => {
    await closeSharedBrowser();
  });

  test('Chromium は --remote-debugging-pipe で起動し、--remote-debugging-port を持たない', async () => {
    const { browser } = await getBrowser();
    const args = browser.process()?.spawnargs ?? [];
    expect(args).toContain('--remote-debugging-pipe');
    expect(args.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(false);
  });

  test('大きな応答が、欠けも壊れもなく届く（約 12MB の文字列と、縦に長いページの全体のスクリーンショット）', async () => {
    const { browser } = await getBrowser();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const big = await page.evaluate(() => `${'あ'.repeat(4_000_000)}終`);
      expect(big.length).toBe(4_000_001);
      expect(big.endsWith('ああ終')).toBe(true);

      await page.setContent('<body style="margin:0"><div style="height:16000px;background:linear-gradient(red,blue)"></div></body>');
      const png = await page.screenshot({ fullPage: true, type: 'png' });
      expect(Buffer.from(png.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a'); // PNG の署名
      expect(Buffer.from(png.subarray(png.length - 12)).toString('hex')).toBe('0000000049454e44ae426082'); // 末尾の IEND チャンク（欠けていない）
      expect(png.length).toBeGreaterThan(50_000);
    } finally {
      await context.close();
    }
  }, 60_000);
});
