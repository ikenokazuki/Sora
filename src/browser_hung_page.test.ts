import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { browserDeadlineSettings } from './browser_deadline.js';
import { browserSemaphore, closeSharedBrowser, getBrowser, resolveChromiumPath } from './browser_engine.js';
import { closeAllBrowserSessions, getActiveSessionCount, handleBrowserSessionAction } from './browser_session.js';
import * as cache from './cache.js';
import { scrapeUrl } from './scraper.js';
import { limits } from './security/limits.js';
import { failureOf, waitFor, within } from './test_fixtures/wait.js';

// 読み込みのあとに JavaScript が回り続けるページでは、ページを読む呼び出しと page.close() が返らない。
// 時間の上限を超えたら、文脈ごと閉じて（renderer も終わる）、ブラウザの枠を返すことを、本物の Chromium で確かめる（手元のサーバーだけ）
const chromePath = resolveChromiumPath();
const text = '回り続けるページの本文です。'.repeat(20);
const BUSY = `<!doctype html><html><head><title>busy</title></head><body><p>${text}</p><script>addEventListener("load",()=>setTimeout(()=>{for(;;){}},50))</script></body></html>`;
// 全体の画像を撮ると resize が届く（Chromium 148 で実測）。そこで回り始めると、撮影が返らない。撮影が残ったページは、page.close() も返らない
const RESIZE = `<!doctype html><html><head><title>resize</title></head><body><p>${text}</p><div style="height:3000px"></div><script>addEventListener("resize",()=>{for(;;){}})</script></body></html>`;

describe.skipIf(!chromePath)('回り続けるページでも、ブラウザの枠は時間の上限で返る（本物の Chromium）', () => {
  let server: ReturnType<typeof Bun.serve>;
  const prevAllow = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
  const prevGrace = browserDeadlineSettings.graceMs;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}?n=${Date.now()}-${Math.random()}`;
  /** 開いたままの文脈の数（既定の文脈を除く） */
  const openContexts = async (tenantId: string) => (await getBrowser(undefined, tenantId)).browser.browserContexts().length - 1;
  const released = async () => {
    await waitFor(() => browserSemaphore.activeCount === 0);
    expect(await openContexts('name:mallory')).toBe(0);
  };

  beforeAll(() => {
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    browserDeadlineSettings.graceMs = 2000;
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => new Response(new URL(req.url).pathname === '/resize' ? RESIZE : BUSY, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
  });
  beforeEach(() => cache.clearCache());
  afterAll(async () => {
    browserDeadlineSettings.graceMs = prevGrace;
    if (prevAllow === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = prevAllow;
    await within(5000, closeAllBrowserSessions()).catch(() => {});
    await within(10_000, closeSharedBrowser()).catch(() => {});
    server.stop(true);
  });

  test('scrape のブラウザの描画は、timeoutMs に猶予を足した時間で失敗し、枠と文脈を手放す', async () => {
    const error = await within(20_000, failureOf(scrapeUrl({ tenantId: 'name:mallory', url: url('/busy'), mode: 'browser', timeoutMs: 3000, noCache: true })));
    expect(error?.message).toContain('タイムアウト');
    await released();
  }, 40_000);

  test('browser_action（1 回きり）は、全体の時間に猶予を足した時間で失敗し、枠と文脈を手放す', async () => {
    const lim = { ...limits(), browserActionTotalMs: 3000 };
    const error = await within(20_000, failureOf(handleBrowserSessionAction({ tenantId: 'name:mallory', url: url('/busy'), timeout: 3000 }, lim)));
    expect(error?.message).toContain('タイムアウト');
    await released();
  }, 40_000);

  test('browser_action のセッションは、時間を超えたら閉じて、枠を手放す', async () => {
    const lim = { ...limits(), browserActionTotalMs: 3000 };
    const error = await within(20_000, failureOf(handleBrowserSessionAction({ tenantId: 'name:mallory', sessionId: 'sess_busy', createSession: true, url: url('/busy'), timeout: 3000 }, lim)));
    expect(error?.message).toContain('タイムアウト');
    expect(error?.message).toContain('セッションは閉じました');
    expect(getActiveSessionCount()).toBe(0);
    await released();
  }, 40_000);

  test('画像を撮っている途中で時間を超えても、セッションを閉じて、枠を手放す', async () => {
    // 最初のページの確認画面の待ち（5 秒）のあと、撮影の途中で時間の上限が来るようにする
    const lim = { ...limits(), browserActionTotalMs: 8000 };
    const error = await within(30_000, failureOf(handleBrowserSessionAction({ tenantId: 'name:mallory', sessionId: 'sess_shot', createSession: true, url: url('/resize'), extract: { markdown: false, screenshot: true } }, lim)));
    expect(error?.message).toContain('タイムアウト');
    expect(getActiveSessionCount()).toBe(0);
    await released();
  }, 60_000);
});
