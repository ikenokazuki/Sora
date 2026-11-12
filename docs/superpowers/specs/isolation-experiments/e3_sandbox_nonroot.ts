// E3b: 非 root・サンドボックス有効（--no-sandbox なし）・パイプ接続。chrome://sandbox でサンドボックスの状態を読む（実行: README.md）
import puppeteer from 'puppeteer-core';
const out: Record<string, unknown> = { uid: process.getuid?.() };
try {
  const browser = await puppeteer.launch({ executablePath: '/usr/lib/chromium/chromium', headless: true, pipe: true, args: ['--disable-dev-shm-usage', '--user-data-dir=/tmp/ud-sb'] });
  const page = await browser.newPage();
  await page.setContent('<h1>sandboxed ok</h1>');
  out.page = await page.evaluate(() => document.body.innerText);
  const sb = await browser.newPage();
  await sb.goto('chrome://sandbox', { timeout: 10000 }).catch((e) => { out.sandboxPageError = String(e).slice(0, 100); });
  out.chromeSandboxPage = (await sb.evaluate(() => document.body.innerText).catch(() => '')).split('\n').filter((l) => /sandbox|namespace|seccomp|SUID|Layer/i.test(l)).slice(0, 14);
  await browser.close();
} catch (e) { out.error = String(e).slice(0, 300); }
console.log(JSON.stringify(out, null, 2));
process.exit(0);
