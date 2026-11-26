import { describe, expect, spyOn, test } from 'bun:test';
import { BrowserDeadlineError, browserDeadlineSettings, runWithBrowserDeadline } from './browser_deadline.js';
import * as engine from './browser_engine.js';
import { fetchWithStealthBrowser } from './browser_stealth.js';
import * as db from './db.js';
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

// ブラウザは起動せず、偽のページで、残りの処理が打ち切りのあとに走る順番を作る
describe('打ち切ったあとの残りの描画', () => {
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
