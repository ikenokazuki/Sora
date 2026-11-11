/**
 * ブラウザ（Sora が起動する Chromium）と静的取得（wreq-js のプロファイル）の、TLS の ClientHello を取って比べる。
 * 使い方: bun scripts/tls-fingerprint/run.ts [--json]
 *   CHROME_PATH で Chromium を選ぶ。プロファイルは Sora の静的取得と同じ選び方（pickBrowserProfile）。
 * 終了コード: 差が無ければ 0、あれば 1。
 *
 * Chromium が wreq のプロファイルより新しいと、差が出る。差が出たら、(1) ブラウザの起動引数で止められる機能なら止める
 * （browser_engine.ts の WREQ_ALIGN_DISABLED_FEATURES）、(2) 止められないなら、wreq-js の emulation の上書き
 * （tlsOptions）で、実際の Chromium の値に寄せる。差の中身は、この道具の出力にそのまま出る。
 */
import { createSession } from 'wreq-js';
import { closeSharedBrowser, getBrowser, getChromiumMajorVersion } from '../../src/browser_engine.js';
import { EMULATION_OS, pickBrowserProfile } from '../../src/http_fetcher.js';
import { startCaptureServer } from './capture.js';
import { type ClientHello, comparable, diffHellos } from './client_hello.js';

export async function captureBrowserHello(): Promise<ClientHello> {
  const server = await startCaptureServer();
  try {
    const { browser } = await getBrowser();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      // 接続は切られて失敗する。それが想定どおり
      void page.goto(`https://localhost:${server.port}/`, { timeout: 15_000 }).catch(() => {});
      return await server.next();
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await server.close();
  }
}

export async function captureWreqHello(profile = pickBrowserProfile()): Promise<ClientHello> {
  const server = await startCaptureServer();
  try {
    const session = await createSession({ browser: profile, os: EMULATION_OS });
    try {
      void session.fetch(`https://localhost:${server.port}/`, { timeout: 15_000 }).catch(() => {});
      return await server.next();
    } finally {
      await session.close().catch(() => {});
    }
  } finally {
    await server.close();
  }
}

if (import.meta.main) {
  const json = process.argv.includes('--json');
  const profile = pickBrowserProfile();
  const engine = getChromiumMajorVersion();
  const browser = await captureBrowserHello();
  const wreq = await captureWreqHello(profile);
  const differences = diffHellos(browser, wreq);
  await closeSharedBrowser();
  if (json) {
    console.log(JSON.stringify({ engine, profile, differences, browser: comparable(browser), wreq: comparable(wreq) }, null, 2));
  } else {
    console.log(`Chromium ${engine ?? '(版を取れず)'} と wreq の ${profile} の ClientHello を比べた`);
    if (differences.length === 0) console.log('差なし');
    for (const d of differences) {
      console.log(`- ${d.field}\n    browser: ${JSON.stringify(d.browser)}\n    wreq   : ${JSON.stringify(d.wreq)}`);
    }
  }
  process.exit(differences.length === 0 ? 0 : 1);
}
