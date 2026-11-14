import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as engine from './browser_engine.js';
import { closeAllBrowserSessions, closeBrowserSession, getActiveSessionCount, handleBrowserSessionAction } from './browser_session.js';
import { ResourceBusyError, ScrapeInputError } from './errors.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { STANDARD_LIMITS, STRICT_LIMITS } from './security/limits.js';

/**
 * ブラウザセッションの管理が、利用者（tenant）ごとに分かれること（設計 6。穴 22・23）:
 * 名前（ID）は tenant ごとの空間・数の上限は利用者ごとと全体・同じ ID の同時の作成で文脈が漏れない。
 * ブラウザは起動しない（getBrowser を偽物に替える）。登録簿そのものの振る舞いは browser_session_registry.test.ts
 */

let opened = 0;
let closed = 0;
let failNextContext = false;
let failSetup = false;
const spies: Array<{ mockRestore: () => void }> = [];
const previous: Record<string, string | undefined> = {};

// then を返すと、Promise が待つ対象と取り違える
const makePage = () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'url') return () => 'about:blank';
        if (prop === 'setViewport' && failSetup) {
          return async () => {
            throw new Error('ページの初期化に失敗');
          };
        }
        return async () => '';
      },
    },
  );
const fakeBrowser = {
  createBrowserContext: async () => {
    if (failNextContext) {
      failNextContext = false;
      throw new Error('文脈を作れません');
    }
    opened++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { newPage: async () => makePage(), close: async () => void closed++ };
  },
};

beforeEach(async () => {
  await closeAllBrowserSessions(); // 前のテストファイルが残したセッションがあっても、数を数え直せるように
  previous.SORA_ISOLATION = process.env.SORA_ISOLATION;
  delete process.env.SORA_ISOLATION;
  opened = 0;
  closed = 0;
  failNextContext = false;
  failSetup = false;
  spies.push(spyOn(engine, 'getBrowser').mockResolvedValue({ browser: fakeBrowser, isDedicated: false } as never));
});

afterEach(async () => {
  await closeAllBrowserSessions();
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (previous.SORA_ISOLATION === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = previous.SORA_ISOLATION;
  resetSecurityMetrics();
});

/** 上限を小さくした値（standard の他の値はそのまま） */
const caps = (perTenant: number, total: number) => ({ ...STANDARD_LIMITS, browserSessionsPerTenant: perTenant, browserSessionsTotal: total });
const act = (options: Record<string, unknown>, lim = STANDARD_LIMITS as Readonly<typeof STANDARD_LIMITS>) =>
  handleBrowserSessionAction({ extract: { markdown: false }, actions: [], ...options } as never, lim);
const create = async (tenantId: string, options: Record<string, unknown> = {}, lim?: typeof STANDARD_LIMITS) => (await act({ createSession: true, tenantId, ...options }, lim)).sessionId as string;

describe('名前の空間', () => {
  test('同じ ID を別の利用者が使える。互いのセッションは別で、禁止の応答（存在の手がかり）も出ない', async () => {
    await create('name:alice', { sessionId: 'shared' });
    const bob = await act({ sessionId: 'shared', tenantId: 'name:bob' });
    expect(bob.sessionId).toBe('shared');
    expect(opened).toBe(2); // bob は、自分の空間に新しく作った
    expect(getActiveSessionCount()).toBe(2);
    // それぞれ、自分のセッションを続けられる（新しい文脈は開かない）
    await act({ sessionId: 'shared', tenantId: 'name:alice' });
    await act({ sessionId: 'shared', tenantId: 'name:bob' });
    expect(opened).toBe(2);
    expect(closed).toBe(0);
  });

  test('ほかの利用者の ID への closeSession は、何も閉じない（閉じたかどうかも false で、存在は分からない）', async () => {
    await create('name:alice', { sessionId: 'mine' });
    const result = await act({ sessionId: 'mine', closeSession: true, tenantId: 'name:bob' });
    expect(result.sessionClosed).toBe(false);
    expect(closed).toBe(0);
    expect(getActiveSessionCount()).toBe(1);
    // 持ち主の closeSession は閉じる
    expect((await act({ sessionId: 'mine', closeSession: true, tenantId: 'name:alice' })).sessionClosed).toBe(true);
    expect(closed).toBe(1);
    expect(getActiveSessionCount()).toBe(0);
  });

  test('同じ利用者の中では、所有者トークンが合わなければ、これまでどおり禁止', async () => {
    await create('name:alice', { sessionId: 'locked', ownerToken: 'secret' });
    await expect(act({ sessionId: 'locked', tenantId: 'name:alice' })).rejects.toThrow('Forbidden');
    await expect(act({ sessionId: 'locked', tenantId: 'name:alice', ownerToken: 'wrong' })).rejects.toThrow('Forbidden');
    await expect(act({ sessionId: 'locked', tenantId: 'name:alice', ownerToken: 'secret' })).resolves.toBeDefined();
  });

  test('tenant を渡さない呼び出しは legacy の空間。closeBrowserSession(ID) の既定も legacy', async () => {
    await act({ createSession: true, sessionId: 'old-style' });
    await create('name:alice', { sessionId: 'old-style' });
    expect(getActiveSessionCount()).toBe(2);
    expect(await closeBrowserSession('old-style')).toBe(true);
    expect(getActiveSessionCount()).toBe(1);
    expect(await closeBrowserSession('old-style', 'name:alice')).toBe(true);
    expect(await closeBrowserSession('old-style', 'name:alice')).toBe(false);
  });
});

describe('数の上限', () => {
  test('全体がいっぱいなら、新しい利用者の作成を 429 相当（session_limit）で断る。ほかの利用者のセッションは、1 つも閉じない', async () => {
    const lim = caps(5, 3);
    await create('name:alice', {}, lim);
    await create('name:alice', {}, lim);
    await create('name:bob', {}, lim);
    const error = await act({ createSession: true, tenantId: 'name:carol' }, lim).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ResourceBusyError);
    expect((error as ResourceBusyError).reason).toBe('session_limit');
    expect(closed).toBe(0);
    expect(opened).toBe(3); // 断られた作成は、ブラウザの文脈を開いていない
    expect(getActiveSessionCount()).toBe(3);
    expect(getSecurityMetrics().sora_browser_busy_session_limit_total).toBe(1);
  });

  test('利用者の上限に達した利用者の作成は、その利用者の一番使われていないセッションだけを閉じる', async () => {
    const lim = caps(2, 20);
    const bob = await create('name:bob', { sessionId: 'b1' }, lim);
    const first = await create('name:alice', { sessionId: 'a1' }, lim);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await create('name:alice', { sessionId: 'a2' }, lim);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await act({ sessionId: first, tenantId: 'name:alice' }, lim); // a1 を使う → 一番使われていないのは a2
    expect(closed).toBe(0);
    await create('name:alice', { sessionId: 'a3' }, lim);
    expect(closed).toBe(1);
    expect(getActiveSessionCount()).toBe(3); // bob 1 + alice 2
    // a2 が閉じられた: a2 を指すと、新しく作り直される（文脈が 1 つ開く）。bob の b1 は残っている
    const before = opened;
    await act({ sessionId: 'a1', tenantId: 'name:alice' }, lim);
    expect(opened).toBe(before);
    await act({ sessionId: bob, tenantId: 'name:bob' }, lim);
    expect(opened).toBe(before);
  });

  test('追い出したセッションの文脈は閉じられている（漏れない）', async () => {
    const lim = caps(1, 20);
    await create('name:alice', { sessionId: 'a1' }, lim);
    await create('name:alice', { sessionId: 'a2' }, lim);
    expect(opened).toBe(2);
    expect(closed).toBe(1);
    expect(getActiveSessionCount()).toBe(1);
  });

  test('既定は水準の値: standard は 1 人で 20 件まで（21 件目は一番古いものを閉じる）、strict は 1 人で 5 件まで', async () => {
    // 水準の値は、limits() の既定（環境変数 SORA_ISOLATION）から読む。上限を渡さずに呼ぶ
    const createDefault = () => handleBrowserSessionAction({ createSession: true, tenantId: 'name:alice', actions: [], extract: { markdown: false } });
    for (let i = 0; i < 21; i++) await createDefault();
    expect(getActiveSessionCount()).toBe(STANDARD_LIMITS.browserSessionsPerTenant);
    expect(closed).toBe(1);
    await closeAllBrowserSessions();
    opened = 0;
    closed = 0;

    process.env.SORA_ISOLATION = 'strict';
    for (let i = 0; i < 6; i++) await createDefault();
    expect(getActiveSessionCount()).toBe(STRICT_LIMITS.browserSessionsPerTenant);
    expect(closed).toBe(1);
  });

  test('作成に失敗したら、予約は残らない（同じ ID で作り直せる。数にも入らない）', async () => {
    const lim = caps(1, 1);
    failNextContext = true;
    await expect(act({ createSession: true, sessionId: 'retry', tenantId: 'name:alice' }, lim)).rejects.toThrow('文脈を作れません');
    expect(getActiveSessionCount()).toBe(0);
    // 全体の上限が 1 でも、失敗した予約が残っていなければ作れる
    await expect(act({ createSession: true, sessionId: 'retry', tenantId: 'name:alice' }, lim)).resolves.toBeDefined();
    expect(getActiveSessionCount()).toBe(1);
  });
});

test('作成の途中（ページの初期化）で失敗したら、開いた文脈を閉じ、予約も戻す（漏れない。同じ ID で作り直せる）', async () => {
  failSetup = true;
  await expect(act({ createSession: true, sessionId: 'half', tenantId: 'name:alice' }, caps(1, 1))).rejects.toThrow('ページの初期化に失敗');
  expect(opened).toBe(1);
  expect(closed).toBe(1);
  expect(getActiveSessionCount()).toBe(0);
  failSetup = false;
  await expect(act({ createSession: true, sessionId: 'half', tenantId: 'name:alice' }, caps(1, 1))).resolves.toBeDefined();
  expect(getActiveSessionCount()).toBe(1);
});

describe('同じ ID の同時の作成', () => {
  /** 枠を、空きが free 個になるまで取る */
  async function leaveFree(free: number): Promise<Array<() => void>> {
    const held: Array<() => void> = [];
    for (let i = 0; engine.browserSemaphore.max - held.length > free; i++) held.push(await engine.browserSemaphore.acquire(`hog-${i}`));
    return held;
  }

  test('枠が 1 つしか空いていないとき（順番に動く）: 2 つ目は、1 つ目が作ったセッションを使う。文脈は 1 つだけ開く', async () => {
    const held = await leaveFree(1);
    try {
      const results = await Promise.all([act({ sessionId: 'dup', tenantId: 'name:alice' }), act({ sessionId: 'dup', tenantId: 'name:alice' })]);
      expect(results.map((r) => r.sessionId)).toEqual(['dup', 'dup']);
      expect(opened).toBe(1);
      expect(closed).toBe(0);
      expect(getActiveSessionCount()).toBe(1);
    } finally {
      for (const release of held) release();
    }
  });

  test.skipIf(engine.browserSemaphore.max < 2)('枠が 2 つ空いていて同時に作るとき: 2 つ目は「作成中」で断られ（入力の誤り）、文脈は漏れない', async () => {
    const held = await leaveFree(2);
    try {
      const settled = await Promise.allSettled([act({ sessionId: 'dup', tenantId: 'name:alice' }), act({ sessionId: 'dup', tenantId: 'name:alice' })]);
      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ScrapeInputError);
      expect(opened - closed).toBe(getActiveSessionCount()); // 開いた文脈は、すべて登録されている
      expect(getActiveSessionCount()).toBe(1);
    } finally {
      for (const release of held) release();
    }
  });
});

describe('セッション ID の形', () => {
  test('128 文字まで。超えたら入力の誤り（作成・続き・closeSession のどれでも）', async () => {
    const ok = 'x'.repeat(128);
    const tooLong = 'x'.repeat(129);
    await expect(act({ createSession: true, sessionId: ok, tenantId: 'name:alice' })).resolves.toBeDefined();
    for (const options of [{ createSession: true }, {}, { closeSession: true }]) {
      await expect(act({ ...options, sessionId: tooLong, tenantId: 'name:alice' })).rejects.toThrow(ScrapeInputError);
    }
    expect(opened).toBe(1);
  });

  test('制御文字（改行など）を含む ID は入力の誤り（ログの行を偽装できない）', async () => {
    for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\u001bb', 'a\u007fb']) {
      await expect(act({ createSession: true, sessionId: bad, tenantId: 'name:alice' }), JSON.stringify(bad)).rejects.toThrow(ScrapeInputError);
    }
    expect(opened).toBe(0);
    // 日本語や記号は通る
    await expect(act({ createSession: true, sessionId: 'ログイン用-1: 本番', tenantId: 'name:alice' })).resolves.toBeDefined();
  });
});
