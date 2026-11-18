import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as engine from './browser_engine.js';
import { handleBrowserSessionAction } from './browser_session.js';
import { fetchWithStealthBrowser } from './browser_stealth.js';
import { decodeAudioWindows } from './services/audio_decode.js';
import { createProdMetaBrowser, createProdSessionOpener } from './services/social/transport.js';
import { renderTrackingPage } from './services/tracking/carriers/browser_track.js';

/**
 * ブラウザを起動する 7 か所（getBrowser を呼ぶ経路）が、呼んだ利用者（tenant）を getBrowser と recordBrowserUsage に渡す（設計 2。段階 6）。
 * 渡し忘れると、`strict`（tenant ごとのブラウザ）で、別の tenant のプロセスを使う（既定の legacy になる）。
 * ブラウザは起動しない（getBrowser を、その場で失敗させる）。呼び出しの最後（ブラウザ）の手前までの配線を確かめる。
 */

const saved: Record<string, string | undefined> = {};
const spies: Array<{ mockRestore: () => void }> = [];
let getBrowser: ReturnType<typeof spyOn>;
let recordUsage: ReturnType<typeof spyOn>;

beforeEach(() => {
  saved.CHROME_PATH = process.env.CHROME_PATH;
  process.env.CHROME_PATH = process.execPath; // Chromium が「ある」ことにする（起動はしない）
  getBrowser = spyOn(engine, 'getBrowser').mockRejectedValue(new Error('stop: ブラウザは起動しない'));
  recordUsage = spyOn(engine, 'recordBrowserUsage');
  spies.push(getBrowser, recordUsage);
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (saved.CHROME_PATH === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = saved.CHROME_PATH;
});

/** getBrowser の 2 つ目の引数（tenant）と、recordBrowserUsage の引数が、tenant であること */
function expectTenant(tenant: string): void {
  expect(getBrowser.mock.calls.length).toBeGreaterThan(0);
  for (const call of getBrowser.mock.calls) expect(call[1], 'getBrowser の tenant').toBe(tenant);
  expect(recordUsage.mock.calls.length).toBeGreaterThan(0);
  for (const call of recordUsage.mock.calls) expect(call[0], 'recordBrowserUsage の tenant').toBe(tenant);
}

describe('getBrowser を呼ぶ経路は、呼んだ tenant を渡す', () => {
  test('ステルスブラウザの描画（scrape のブラウザ取得）', async () => {
    await fetchWithStealthBrowser('https://example.com/', 1000, undefined, undefined, 'networkidle2', false, true, 'name:render').catch(() => undefined);
    expectTenant('name:render');
  });

  test('browser_action のワンショット（セッションなし）', async () => {
    await handleBrowserSessionAction({ tenantId: 'name:oneshot', url: 'https://example.com/', actions: [] }).catch(() => undefined);
    expectTenant('name:oneshot');
  });

  test('browser_action のセッションの作成', async () => {
    await handleBrowserSessionAction({ tenantId: 'name:session', createSession: true, url: 'https://example.com/' }).catch(() => undefined);
    expectTenant('name:session');
  });

  test('音声のデコード（recognize_song）', async () => {
    await decodeAudioWindows(new Uint8Array(64), () => [0], 'name:audio').catch(() => undefined);
    expectTenant('name:audio');
  });

  test('Weibo の匿名セッション（SNS の探索）', async () => {
    await createProdSessionOpener('name:weibo').openWeiboSession(AbortSignal.timeout(3000)).catch(() => undefined);
    expectTenant('name:weibo');
  });

  test('Meta のブラウザ描画（SNS の探索）', async () => {
    await createProdMetaBrowser('name:meta').readPage('https://example.com/', 1000, AbortSignal.timeout(3000)).catch(() => undefined);
    expectTenant('name:meta');
  });

  test('荷物追跡の公式ページの描画', async () => {
    await renderTrackingPage('https://example.com/', { tenantId: 'name:track', timeoutMs: 3000 }).catch(() => undefined);
    expectTenant('name:track');
  });
});
