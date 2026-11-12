// E11（実行: README.md。イメージの中）。Sora の起動のまま、パイプ接続・大きな応答・強制終了からの復帰
import { browserCdpMode, closeSharedBrowser, getBrowser, isSharedBrowserConnected } from '../src/browser_engine.js';
const out: Record<string, unknown> = { bun: Bun.version, cdpMode: browserCdpMode() };
const within = <T>(p: Promise<T>, ms: number, label: string) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label}: ${ms}ms で止まった`)), ms))]);
try {
  const { browser } = await getBrowser();
  const args = browser.process()?.spawnargs ?? [];
  out.pipe引数 = args.includes('--remote-debugging-pipe');
  out.port引数 = args.some((a) => a.startsWith('--remote-debugging-port'));
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  const big = await within(page.evaluate(() => `${'あ'.repeat(4_000_000)}終`), 15000, '12MB');
  await page.setContent('<body style="margin:0"><div style="height:16000px;background:linear-gradient(red,blue)"></div></body>');
  const png = await within(page.screenshot({ fullPage: true, type: 'png' }), 20000, 'screenshot');
  out.大きな応答 = { 文字数: big.length, png: png.length, pngの末尾が完全: Buffer.from(png.subarray(png.length - 12)).toString('hex') === '0000000049454e44ae426082' };
  await ctx.close();
  // 強制終了 → Sora の「共有ブラウザが繋がっているか」が false になり、次の getBrowser() が新しく起動する
  const pid = browser.process()!.pid!;
  process.kill(pid, 'SIGKILL');
  const t0 = Date.now();
  while (isSharedBrowserConnected() && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  out.強制終了の検知 = { 繋がっている: isSharedBrowserConnected(), ms: Date.now() - t0 };
  const again = await within(getBrowser(), 20000, '再起動');
  const p2 = await again.browser.newPage(); await p2.setContent('<h1>again</h1>');
  out.再起動 = { 別のブラウザ: again.browser !== browser, 描画: await p2.evaluate(() => document.body.innerText), 新しいpid: again.browser.process()?.pid !== pid };
} catch (e) { out.失敗 = (e as Error).message; }
await Promise.race([closeSharedBrowser(), new Promise((r) => setTimeout(r, 5000))]);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
