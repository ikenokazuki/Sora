import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeSharedBrowser, getBrowser, isSharedBrowserConnected, resolveChromiumPath } from './browser_engine.js';

// 共有 Chromium の起動が並行しても、起動するのは 1 つだけ。以前は呼び出しの数だけ起動し、
// 最後に代入された 1 つ以外は参照を失って閉じられないまま残った（1 つあたり数百 MB）。

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pids: Array<number | undefined>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((p) => !isAlive(p))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pids.every((p) => !isAlive(p));
}

describe.skipIf(!resolveChromiumPath())('共有 Chromium の同時起動', () => {
  let prevIdle: string | undefined;

  beforeAll(async () => {
    prevIdle = process.env.BROWSER_IDLE_TTL_MS;
    process.env.BROWSER_IDLE_TTL_MS = '0'; // テスト中に無操作終了させない
    await closeSharedBrowser();
  });

  afterAll(async () => {
    await closeSharedBrowser();
    if (prevIdle !== undefined) process.env.BROWSER_IDLE_TTL_MS = prevIdle;
    else delete process.env.BROWSER_IDLE_TTL_MS;
  });

  test('同時に getBrowser() を呼んでも、起動は 1 つで全員が同じブラウザを受け取る', async () => {
    await closeSharedBrowser();
    const results = await Promise.all(Array.from({ length: 5 }, () => getBrowser()));
    const pids = results.map((r) => r.browser.process()?.pid);

    expect(new Set(results.map((r) => r.browser)).size).toBe(1);
    expect(new Set(pids).size).toBe(1);
    expect(results.every((r) => r.isDedicated === false)).toBe(true);
    expect(isSharedBrowserConnected()).toBe(true);

    await closeSharedBrowser();
    expect(isSharedBrowserConnected()).toBe(false);
    // 閉じたあとに、このテストで起動した Chromium が 1 つも残っていないこと
    expect(await waitUntilDead(pids)).toBe(true);
  }, 60000);

  test('起動済みなら以降の呼び出しは同じブラウザを再利用する', async () => {
    await closeSharedBrowser();
    const first = await getBrowser();
    const second = await getBrowser();
    expect(second.browser).toBe(first.browser);
    await closeSharedBrowser();
  }, 60000);

  test('起動の最中に closeSharedBrowser() を呼んでも、管理されない Chromium が残らない', async () => {
    await closeSharedBrowser();
    const spawned = new Set<number | undefined>();
    // 起動中に閉じる要求が重なる。getBrowser() 側は閉じられた後なら起動し直して新しいブラウザを返してよい
    const launching = getBrowser().then((r) => { spawned.add(r.browser.process()?.pid); return r; });
    const closing = closeSharedBrowser();
    await Promise.all([launching, closing]);

    await closeSharedBrowser();
    expect(isSharedBrowserConnected()).toBe(false);
    expect(await waitUntilDead([...spawned])).toBe(true);
  }, 60000);

  test('閉じたあとの getBrowser() は新しいブラウザを起動できる', async () => {
    await closeSharedBrowser();
    const a = await getBrowser();
    await closeSharedBrowser();
    const b = await getBrowser();
    expect(b.browser).not.toBe(a.browser);
    expect(b.browser.connected).toBe(true);
    await closeSharedBrowser();
  }, 60000);
});
