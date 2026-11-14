import { afterAll, describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { closeSharedBrowser, resolveChromiumPath } from './browser_engine.js';
import { assertBrowserActionInputs, handleBrowserSessionAction, runActionsOnPage } from './browser_session.js';
import { ScrapeInputError } from './errors.js';
import { STANDARD_LIMITS, STRICT_LIMITS } from './security/limits.js';
import type { BrowserActionStep } from './types.js';

/**
 * browser_action の入力と、1 回の呼び出しの全体の時間の上限（設計 6。穴 23）。
 * 以前は、actions の件数・wait の ms・delay・timeout・text の長さ・extract.maxChars に上限がなく、`wait` に 1e9 ミリ秒を指定すると、
 * ブラウザの枠を何日も持ったまま動かなくなった（枠は 1〜5 しかない）。超えた入力は、ブラウザを起動する前に、入力の誤り（REST は 400）にする。
 */

const wait = (ms: number): BrowserActionStep => ({ type: 'wait', ms });
const many = (count: number, step: BrowserActionStep): BrowserActionStep[] => Array.from({ length: count }, () => step);
const rejects = (fn: () => void): ScrapeInputError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ScrapeInputError);
    return error as ScrapeInputError;
  }
  throw new Error('入力の誤りになるはずが、通った');
};

describe('assertBrowserActionInputs', () => {
  test('ふつうの入力は通る（どちらの水準でも）', () => {
    const actions: BrowserActionStep[] = [
      { type: 'click', selector: '#login', delay: 100 },
      { type: 'fill', selector: '#user', text: 'someone@example.com' },
      { type: 'press', key: 'Enter' },
      wait(2000),
      { type: 'navigate', url: 'https://example.com/next' },
    ];
    for (const lim of [STANDARD_LIMITS, STRICT_LIMITS]) {
      expect(() => assertBrowserActionInputs({ actions, timeout: 30_000, extract: { maxChars: 30_000 } }, lim)).not.toThrow();
    }
    expect(() => assertBrowserActionInputs({}, STRICT_LIMITS)).not.toThrow();
  });

  test('actions の件数: strict は 20、standard は 100 まで', () => {
    expect(() => assertBrowserActionInputs({ actions: many(20, { type: 'press', key: 'a' }) }, STRICT_LIMITS)).not.toThrow();
    expect(rejects(() => assertBrowserActionInputs({ actions: many(21, { type: 'press', key: 'a' }) }, STRICT_LIMITS)).message).toContain('20');
    expect(() => assertBrowserActionInputs({ actions: many(100, { type: 'press', key: 'a' }) }, STANDARD_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ actions: many(101, { type: 'press', key: 'a' }) }, STANDARD_LIMITS));
  });

  test('wait の ms: strict は 15 秒、standard は 120 秒まで（以前は 1e9 ミリ秒でも通った）', () => {
    expect(() => assertBrowserActionInputs({ actions: [wait(15_000)] }, STRICT_LIMITS)).not.toThrow();
    expect(rejects(() => assertBrowserActionInputs({ actions: [wait(15_001)] }, STRICT_LIMITS)).message).toContain('15000');
    expect(() => assertBrowserActionInputs({ actions: [wait(120_000)] }, STANDARD_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ actions: [wait(120_001)] }, STANDARD_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [wait(1e9)] }, STANDARD_LIMITS));
  });

  test('セレクタを待つ wait の ms も同じ', () => {
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'wait', selector: '#x', ms: 15_001 }] }, STRICT_LIMITS));
  });

  test('delay（click の後の待ち・fill/type の 1 文字ごとの間隔）: strict は 2 秒、standard は 10 秒まで', () => {
    expect(() => assertBrowserActionInputs({ actions: [{ type: 'click', selector: '#a', delay: 2000 }] }, STRICT_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'click', selector: '#a', delay: 2001 }] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'type', selector: '#a', text: 'x', delay: 2001 }] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'fill', selector: '#a', text: 'x', delay: 10_001 }] }, STANDARD_LIMITS));
  });

  test('text・script の長さ: strict は 1 万文字、standard は 10 万文字まで', () => {
    expect(() => assertBrowserActionInputs({ actions: [{ type: 'press', key: 'a', text: 'x'.repeat(10_000) }] }, STRICT_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'press', key: 'a', text: 'x'.repeat(10_001) }] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'evaluate', script: 'x'.repeat(10_001) }] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'press', key: 'a', text: 'x'.repeat(100_001) }] }, STANDARD_LIMITS));
  });

  test('アクションのセレクタの長さは、scrape のセレクタと同じ上限（strict は 500 文字）', () => {
    expect(() => assertBrowserActionInputs({ actions: [{ type: 'click', selector: 'a'.repeat(500) }] }, STRICT_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'click', selector: 'a'.repeat(501) }] }, STRICT_LIMITS));
    expect(() => assertBrowserActionInputs({ extract: { clipSelector: 'a'.repeat(500) } }, STRICT_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ extract: { clipSelector: 'a'.repeat(501) } }, STRICT_LIMITS));
  });

  test('timeout（ページ遷移の待ち）: strict は 60 秒、standard は 180 秒まで', () => {
    expect(() => assertBrowserActionInputs({ timeout: 60_000 }, STRICT_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ timeout: 60_001 }, STRICT_LIMITS));
    expect(() => assertBrowserActionInputs({ timeout: 180_000 }, STANDARD_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ timeout: 180_001 }, STANDARD_LIMITS));
  });

  test('extract.maxChars: strict は 10 万文字、standard は 100 万文字まで', () => {
    expect(() => assertBrowserActionInputs({ extract: { maxChars: 100_000 } }, STRICT_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ extract: { maxChars: 100_001 } }, STRICT_LIMITS));
    expect(() => assertBrowserActionInputs({ extract: { maxChars: 1_000_000 } }, STANDARD_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ extract: { maxChars: 1_000_001 } }, STANDARD_LIMITS));
  });

  test('決まっている待ち時間の合計が、全体の時間（strict は 120 秒）を超えるなら、始める前に断る', () => {
    // wait 15 秒 × 8 = 120 秒は通り、9 つ（135 秒）は断る
    expect(() => assertBrowserActionInputs({ actions: many(8, wait(15_000)) }, STRICT_LIMITS)).not.toThrow();
    expect(rejects(() => assertBrowserActionInputs({ actions: many(9, wait(15_000)) }, STRICT_LIMITS)).message).toContain('120');
    // click の delay も数える（2 秒 × 20 = 40 秒は通る。wait と合わせて超えるなら断る）
    expect(() => assertBrowserActionInputs({ actions: many(20, { type: 'click', selector: '#a', delay: 2000 }) }, STRICT_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ actions: [...many(7, wait(15_000)), ...many(10, { type: 'click', selector: '#a', delay: 2000 })] }, STRICT_LIMITS));
  });

  test('fill・type は、1 文字ごとの間隔 × 文字数も数える（間隔を省いても、1 文字 40ms まで見込む）', () => {
    // 間隔 100ms × 1000 文字 = 100 秒は通り、1300 文字（130 秒）は断る
    expect(() => assertBrowserActionInputs({ actions: [{ type: 'type', selector: '#a', text: 'x'.repeat(1000), delay: 100 }] }, STRICT_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'type', selector: '#a', text: 'x'.repeat(1300), delay: 100 }] }, STRICT_LIMITS));
    // 間隔を省いた 1 万文字は、1 文字 40ms で見込んで 400 秒になるので、断る
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'fill', selector: '#a', text: 'x'.repeat(10_000) }] }, STRICT_LIMITS));
    // 間隔を省いた 2000 文字は、80 秒で通る
    expect(() => assertBrowserActionInputs({ actions: [{ type: 'fill', selector: '#a', text: 'x'.repeat(2000) }] }, STRICT_LIMITS)).not.toThrow();
  });

  test('ms が 0 の wait も 1 秒として数える（実行は、0 を「指定なし」と読んで 1 秒待つ）', () => {
    expect(() => assertBrowserActionInputs({ actions: many(120, { type: 'wait', ms: 0 }) }, { ...STRICT_LIMITS, browserActionCount: 200 })).not.toThrow();
    rejects(() => assertBrowserActionInputs({ actions: many(121, { type: 'wait', ms: 0 }) }, { ...STRICT_LIMITS, browserActionCount: 200 }));
  });

  test('間隔を省いた fill は、1 文字 40ms で数える（3000 文字 = 120 秒は通り、3001 文字は断る）', () => {
    const fill = (length: number): BrowserActionStep => ({ type: 'fill', selector: '#a', text: 'x'.repeat(length) });
    expect(() => assertBrowserActionInputs({ actions: [fill(3000)] }, STRICT_LIMITS)).not.toThrow();
    rejects(() => assertBrowserActionInputs({ actions: [fill(3001)] }, STRICT_LIMITS));
  });

  test('ms を省いた wait は 1 秒、セレクタを待つ wait の ms を省くと 10 秒として数える', () => {
    expect(() => assertBrowserActionInputs({ actions: many(120, { type: 'wait' }) }, { ...STRICT_LIMITS, browserActionCount: 200 })).not.toThrow(); // 120 秒
    rejects(() => assertBrowserActionInputs({ actions: many(121, { type: 'wait' }) }, { ...STRICT_LIMITS, browserActionCount: 200 }));
    expect(() => assertBrowserActionInputs({ actions: many(12, { type: 'wait', selector: '#a' }) }, STRICT_LIMITS)).not.toThrow(); // 120 秒
    rejects(() => assertBrowserActionInputs({ actions: many(13, { type: 'wait', selector: '#a' }) }, STRICT_LIMITS));
  });

  test('負の値・数でない値は、入力の誤り（負の ms・delay で「決まっている待ち時間の合計」を減らして、検査をすり抜けられない）', () => {
    const typing: BrowserActionStep = { type: 'type', selector: '#b', text: 'x'.repeat(10_000), delay: 2000 }; // 20000 秒。単独なら断る
    rejects(() => assertBrowserActionInputs({ actions: [typing] }, STRICT_LIMITS));
    // 前に負の待ちを足して、合計を減らす（以前は通り、1 回の type だけで枠を数時間持てた）
    for (const lim of [STRICT_LIMITS, STANDARD_LIMITS]) {
      rejects(() => assertBrowserActionInputs({ actions: [wait(-1e9), typing] }, lim));
      rejects(() => assertBrowserActionInputs({ actions: [{ type: 'click', selector: '#a', delay: -1e9 }, typing] }, lim));
    }
    // 単独でも断る（-1 でも）
    rejects(() => assertBrowserActionInputs({ actions: [wait(-1)] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'wait', selector: '#a', ms: -1 }] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'click', selector: '#a', delay: -1 }] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'type', selector: '#a', text: 'x', delay: -1 }] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'fill', selector: '#a', text: 'x', delay: -1 }] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ timeout: -1 }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ extract: { maxChars: -1 } }, STRICT_LIMITS));
    // NaN も断る（比較が常に偽になり、上限をすり抜けるため）
    rejects(() => assertBrowserActionInputs({ actions: [wait(Number.NaN)] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ actions: [{ type: 'click', selector: '#a', delay: Number.NaN }] }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ timeout: Number.NaN }, STRICT_LIMITS));
    rejects(() => assertBrowserActionInputs({ extract: { maxChars: Number.NaN } }, STRICT_LIMITS));
    // 0 は通る
    expect(() => assertBrowserActionInputs({ actions: [{ type: 'click', selector: '#a', delay: 0 }, wait(0)], timeout: 0, extract: { maxChars: 0 } }, STRICT_LIMITS)).not.toThrow();
  });
});

describe('handleBrowserSessionAction は、ブラウザを起動する前に入力を検査する', () => {
  test('strict: 21 個のアクションは、入力の誤り（ブラウザも枠も使わない）', async () => {
    const previous = process.env.SORA_ISOLATION;
    process.env.SORA_ISOLATION = 'strict';
    try {
      await expect(handleBrowserSessionAction({ url: 'https://example.com/', tenantId: 'T', actions: many(21, { type: 'press', key: 'a' }) })).rejects.toBeInstanceOf(ScrapeInputError);
    } finally {
      if (previous === undefined) delete process.env.SORA_ISOLATION;
      else process.env.SORA_ISOLATION = previous;
    }
  });

  test('セッションを閉じるだけの呼び出しは、入力の検査の対象にしない（閉じられなくなるのを避ける）', async () => {
    const previous = process.env.SORA_ISOLATION;
    process.env.SORA_ISOLATION = 'strict';
    try {
      const result = await handleBrowserSessionAction({ sessionId: 'nonexistent', closeSession: true, actions: many(500, { type: 'press', key: 'a' }) });
      expect(result.sessionClosed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SORA_ISOLATION;
      else process.env.SORA_ISOLATION = previous;
    }
  });
});

describe('runActionsOnPage の全体の時間', () => {
  const fakePage = { viewport: () => null, url: () => 'about:blank', title: async () => '' } as unknown as Page;

  test('全体の時間を超えたら、残りのアクションを実行せず、実行しなかったことをログに残す。最後の待ちは、残りの時間で切る', async () => {
    const startedAt = performance.now();
    const deadline = Date.now() + 600;
    const { actionLogs } = await runActionsOnPage(fakePage, [wait(100), wait(5000), wait(100), wait(100)], 30_000, deadline);
    const tookMs = performance.now() - startedAt;
    expect(actionLogs.map((log) => log.success)).toEqual([true, true, false, false]);
    expect(actionLogs[1].elapsedMs).toBeLessThan(1000); // 5 秒の待ちを、残りの時間（約 500ms）で切った
    expect(actionLogs[1].elapsedMs).toBeGreaterThan(100);
    expect(actionLogs[2].message).toContain('全体の制限時間');
    expect(actionLogs[3].message).toContain('全体の制限時間');
    expect(tookMs).toBeLessThan(1000);
  });

  test('時間が足りていれば、すべて実行する。締め切りを渡さなければ、制限しない（これまでどおり）', async () => {
    const { actionLogs } = await runActionsOnPage(fakePage, [wait(10), wait(10)], 30_000, Date.now() + 5000);
    expect(actionLogs.map((log) => log.success)).toEqual([true, true]);
    const unbounded = await runActionsOnPage(fakePage, [wait(10)], 30_000);
    expect(unbounded.actionLogs.map((log) => log.success)).toEqual([true]);
  });
});

describe('セレクタを待つ時間は、残りの時間で切る', () => {
  test('wait のセレクタの待ち（ms が長くても）と、click のセレクタの待ち（既定 10 秒）', async () => {
    const seen: number[] = [];
    const page = new Proxy(
      { viewport: () => null, url: () => 'about:blank', title: async () => '', waitForSelector: async (_selector: string, options: { timeout: number }) => void seen.push(options.timeout) },
      { get: (target, prop) => (prop in target ? (target as never)[prop] : prop === 'then' ? undefined : async () => '') },
    ) as unknown as Page;
    await runActionsOnPage(page, [{ type: 'wait', selector: '#a', ms: 60_000 }, { type: 'select', selector: '#b', value: 'x' }], 30_000, Date.now() + 900);
    expect(seen).toHaveLength(2);
    for (const timeout of seen) {
      expect(timeout).toBeGreaterThanOrEqual(1);
      expect(timeout).toBeLessThanOrEqual(900);
    }
  });
});

describe('遷移の待ち（navigate）は、残りの時間で切る', () => {
  test('timeout が長くても、goto に渡す待ちは、残りの時間以下', async () => {
    const previous = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true'; // DNS の検査を省く（ネットワークに出ない）
    try {
      let seenTimeout = -1;
      const page = new Proxy(
        { viewport: () => null, url: () => 'about:blank', title: async () => '', goto: async (_url: string, options: { timeout: number }) => void (seenTimeout = options.timeout) },
        { get: (target, prop) => (prop in target ? (target as never)[prop] : prop === 'then' ? undefined : async () => '') },
      ) as unknown as Page;
      await runActionsOnPage(page, [{ type: 'navigate', url: 'https://example.com/next' }], 30_000, Date.now() + 800);
      expect(seenTimeout).toBeGreaterThanOrEqual(1);
      expect(seenTimeout).toBeLessThanOrEqual(800);
    } finally {
      if (previous === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
      else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previous;
    }
  });
});

// 実際のブラウザで確かめる（ブラウザが無い環境では飛ばす）
describe.skipIf(!resolveChromiumPath())('handleBrowserSessionAction の全体の時間（本物のブラウザ）', () => {
  afterAll(closeSharedBrowser);

  test('最初の URL への遷移の待ちも、残りの時間で切る（timeout が長くても）', async () => {
    const previous = process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
    process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = 'true'; // 手元のサーバーに行く
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) }); // 応答しない
    try {
      const startedAt = performance.now();
      await expect(handleBrowserSessionAction({ url: `http://127.0.0.1:${server.port}/`, timeout: 30_000 }, { ...STRICT_LIMITS, browserActionTotalMs: 800 })).rejects.toThrow();
      expect(performance.now() - startedAt).toBeLessThan(8000); // 30 秒待たない
    } finally {
      server.stop(true);
      if (previous === undefined) delete process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK;
      else process.env.SORA_FETCH_ALLOW_PRIVATE_NETWORK = previous;
    }
  }, 30_000);

  test('ブラウザとページの用意のあと、最初の遷移の前から全体の時間を数え、過ぎたら、残りのアクションを実行しない', async () => {
    // scroll は、決まっている待ち時間に数えないが、実際には 0.5 秒かかる（5 つで約 2.5 秒）。全体を 0.6 秒にすると、途中から実行しない
    const lim = { ...STRICT_LIMITS, browserActionTotalMs: 600 };
    const scroll: BrowserActionStep = { type: 'scroll' };
    const startedAt = performance.now();
    const result = await handleBrowserSessionAction({ tenantId: 'T', actions: many(5, scroll), extract: { markdown: false } }, lim);
    const tookMs = performance.now() - startedAt;
    const successes = result.actionLogs.map((log) => log.success);
    expect(successes[0]).toBe(true);
    expect(successes[4]).toBe(false);
    expect(result.actionLogs[4].message).toContain('全体の制限時間');
    expect(tookMs).toBeLessThan(2200); // 5 つとも実行した場合（約 2.5 秒）より短い
  }, 30_000);
});

