/**
 * イメージの中で動かす確認（scripts/verify-image.sh から）: --cap-drop=ALL のコンテナ（uid を落とすのに要る capability が無い）でも、
 * ブラウザが起動して描画でき、落とせないことを警告で知らせ、従来どおり（Sora と同じ uid）で動くこと。
 * 既定（auto）の挙動が、--cap-drop=ALL で運用している環境を壊さないことの確認。
 * 使い方: docker run --rm --cap-drop=ALL -e NODE_ENV=test -e SORA_DB_PATH=:memory: -v "$PWD/src:/app/src:ro" -v "$PWD/scripts:/app/scripts:ro" \
 *           --entrypoint /usr/local/bin/bun <イメージ> /app/scripts/browser-capdrop-check.ts
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 2）
 */
import { readFileSync } from 'node:fs';
import { browserSandboxStatus, closeSharedBrowser, getBrowser } from '../src/browser_engine.js';

// テストの既定（サンドボックスなし）を、本番と同じ auto にする
process.env.SORA_BROWSER_SANDBOX ??= 'auto';
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
  originalWarn(...args);
};
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const field = (path: string, name: string) => readFileSync(path, 'utf8').match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'))?.[1].trim();
check(process.getuid?.() === 0, `この確認は root（Sora 本体と同じ）で動かす（uid=${process.getuid?.()}）`);
check(/^0+$/.test(field('/proc/self/status', 'CapEff') ?? '?'), `この確認は capability なし（--cap-drop=ALL）で動かす: CapEff=${field('/proc/self/status', 'CapEff')}`);

const { browser } = await getBrowser();
const pid = browser.process()?.pid;
check(pid !== undefined, 'Chromium の pid を取れない');
// 落とせないので、Sora と同じ uid（従来どおり）
const uid = field(`/proc/${pid}/status`, 'Uid')?.split(/\s+/)[0];
check(uid === '0', `落とせないはずが、Chromium の uid が 0 でない: ${uid}`);
check(
  warnings.some((message) => message.includes('CAP_CHOWN') && message.includes('CAP_SETUID') && message.includes('--cap-add=SETUID')),
  `落とせないことを、足りない capability と足し方つきの警告で知らせていない: ${JSON.stringify(warnings)}`,
);
check(browserSandboxStatus() === 'off', `root のままなので、サンドボックスは使えないはず: ${browserSandboxStatus()}`);

const context = await browser.createBrowserContext();
const page = await context.newPage();
await page.setContent('<html><body><h1>描画</h1></body></html>');
check((await page.evaluate(() => document.body.innerText)) === '描画', '描画できない');
await context.close();
await closeSharedBrowser();

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: --cap-drop=ALL でも、ブラウザは起動して描画でき、落とせないことを警告で知らせ、従来どおり（uid 0）で動く');
