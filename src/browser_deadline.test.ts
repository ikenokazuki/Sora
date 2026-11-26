import { describe, expect, spyOn, test } from 'bun:test';
import { BrowserDeadlineError, browserDeadlineSettings, runWithBrowserDeadline } from './browser_deadline.js';
import * as engine from './browser_engine.js';
import { closeAllBrowserSessions, handleBrowserSessionAction } from './browser_session.js';
import { fetchWithStealthBrowser } from './browser_stealth.js';
import * as db from './db.js';
import { STANDARD_LIMITS } from './security/limits.js';
import { failureOf, within } from './test_fixtures/wait.js';

describe('runWithBrowserDeadline', () => {
  test('超えたら、閉じてから、処理の返りを待たずに「タイムアウト」で失敗し、信号を中止する', async () => {
    let closed = 0;
    let signal: AbortSignal | undefined;
    const error = await within(3000, failureOf(runWithBrowserDeadline(100, async () => { closed++; }, (s) => {
      signal = s;
      return new Promise<never>(() => {});
    })));
    expect(error).toBeInstanceOf(BrowserDeadlineError);
    expect(error?.message).toContain('タイムアウト');
    expect(closed).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(error);
  });

  test('閉じるのに失敗しても、時間切れの失敗はそのまま返す', async () => {
    const error = await within(3000, failureOf(runWithBrowserDeadline(50, async () => { throw new Error('close failed'); }, () => new Promise<never>(() => {}))));
    expect(error).toBeInstanceOf(BrowserDeadlineError);
  });

  test('閉じ終わるのを待ってから失敗にする（呼び出し元が、ページが閉じる前に枠を返さない）', async () => {
    let done = false;
    const error = await within(3000, failureOf(runWithBrowserDeadline(50, async () => { await Bun.sleep(300); done = true; }, () => new Promise<never>(() => {}))));
    expect(error).toBeInstanceOf(BrowserDeadlineError);
    expect(done).toBe(true);
  });

  test('閉じるのが返らなくても、少し待ったら失敗を返す', async () => {
    const prev = browserDeadlineSettings.closeWaitMs;
    browserDeadlineSettings.closeWaitMs = 200;
    try {
      const error = await within(2000, failureOf(runWithBrowserDeadline(50, () => new Promise<never>(() => {}), () => new Promise<never>(() => {}))));
      expect(error).toBeInstanceOf(BrowserDeadlineError);
    } finally {
      browserDeadlineSettings.closeWaitMs = prev;
    }
  });

  test('閉じた拍子に残りの処理が失敗しても、時間切れの失敗を返す', async () => {
    let stuck: ((reason: Error) => void) | undefined;
    const error = await within(3000, failureOf(runWithBrowserDeadline(50, async () => stuck?.(new Error('Target closed')), () => new Promise<never>((_resolve, reject) => { stuck = reject; }))));
    expect(error).toBeInstanceOf(BrowserDeadlineError);
  });

  test('時間内に終われば、結果を返し、閉じない', async () => {
    let closed = 0;
    const result = await runWithBrowserDeadline(1000, async () => { closed++; }, async () => 'done');
    expect(result).toBe('done');
    await Bun.sleep(1100);
    expect(closed).toBe(0);
  });

  test('処理の失敗は、そのまま返す', async () => {
    const error = await failureOf(runWithBrowserDeadline(1000, async () => {}, async () => { throw new Error('page failed'); }));
    expect(error?.message).toBe('page failed');
  });
});

// ブラウザは起動せず、偽のページで、打ち切りのあとの順番を作る
describe('打ち切ったあと', () => {
  test('browser_action のセッションは、閉じ終わってから、ブラウザの枠を返す', async () => {
    let heldWhenClosed: number | undefined;
    const page = new Proxy({}, { get: (_target, prop) => (prop === 'then' ? undefined : prop === 'url' ? () => 'about:blank' : prop === 'evaluate' ? () => new Promise<never>(() => {}) : async () => '') });
    const context = { newPage: async () => page, close: async () => { await Bun.sleep(300); heldWhenClosed = engine.browserSemaphore.activeCount; } };
    const spies = [spyOn(engine, 'getBrowser').mockResolvedValue({ browser: { createBrowserContext: async () => context }, isDedicated: false } as never)];
    const prevGrace = browserDeadlineSettings.graceMs;
    browserDeadlineSettings.graceMs = 100;
    try {
      const error = await within(5000, failureOf(handleBrowserSessionAction(
        { tenantId: 'name:order', sessionId: 'sess_order', createSession: true, extract: { markdown: false }, actions: [{ type: 'scroll' }] },
        { ...STANDARD_LIMITS, browserActionTotalMs: 1000 },
      )));
      expect(error?.message).toContain('タイムアウト');
      expect(heldWhenClosed).toBe(1);
      expect(engine.browserSemaphore.activeCount).toBe(0);
    } finally {
      browserDeadlineSettings.graceMs = prevGrace;
      for (const spy of spies) spy.mockRestore();
      await closeAllBrowserSessions();
    }
  });

  test('あとから返った題名のあとで、Cookie を保存しない', async () => {
    // 指定の無いメソッドは、空の値を返すページ。then を返すと、Promise が待つ対象と取り違える
    const methods: Record<string, (...args: unknown[]) => unknown> = {
      // 題名の返事が、打ち切りのあとに届く
      title: async () => { await Bun.sleep(500); return 'late'; },
      cookies: async () => [{ name: 'late', value: '1', domain: 'late.example.invalid' }],
    };
    const page = new Proxy({}, { get: (_target, prop) => (prop === 'then' ? undefined : prop === 'url' ? () => 'about:blank' : methods[prop as string] ?? (async () => '')) });
    const spies = [
      spyOn(engine, 'resolveChromiumPath').mockReturnValue('/test/chromium'),
      spyOn(engine, 'getBrowser').mockResolvedValue({ browser: { createBrowserContext: async () => ({ newPage: async () => page, close: async () => {} }) }, isDedicated: false } as never),
      spyOn(db, 'dbSaveTenantCookies'),
    ];
    const prevGrace = browserDeadlineSettings.graceMs;
    browserDeadlineSettings.graceMs = 100;
    try {
      const error = await within(5000, failureOf(fetchWithStealthBrowser('http://late.example.invalid/', 100, undefined, undefined, 'networkidle2', false, true, 'name:late')));
      expect(error?.message).toContain('タイムアウト');
      await Bun.sleep(600);
      expect(spies[2]).not.toHaveBeenCalled();
    } finally {
      browserDeadlineSettings.graceMs = prevGrace;
      for (const spy of spies) spy.mockRestore();
    }
  });
});
