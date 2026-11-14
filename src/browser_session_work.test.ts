import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import * as engine from './browser_engine.js';
import { closeAllBrowserSessions, getActiveSessionCount, handleBrowserSessionAction } from './browser_session.js';
import { ResourceBusyError } from './errors.js';
import { STANDARD_LIMITS } from './security/limits.js';
import { resetSecurityMetrics } from './security/metrics.js';
import { busyOf, fillQueue, releaseAll, saturate, within } from './test_fixtures/browser_slots.js';

/**
 * 作成済みのブラウザセッションの呼び出しが、枠の下で動くこと・使用中のセッションを閉じないこと・最長の時間があること・
 * strict で tenant の無い（legacy）セッションを使えないこと（設計 6。穴 22・23。E35）。ブラウザは起動しない（getBrowser を偽物に替える）。
 * 登録簿そのものの振る舞いは browser_session_registry.test.ts、名前の空間と数の上限は browser_session_tenant.test.ts
 */

const EVALUATE_MS = 150;
let opened = 0;
let closed = 0;
let running = 0;
let peak = 0;
const spies: Array<{ mockRestore: () => void }> = [];
const previous: Record<string, string | undefined> = {};
const realSetTimeout = globalThis.setTimeout;
/** 捕まえたセッションのタイマー（5 分の期限か、残りの寿命）。手で発火させる */
let timers: Array<{ ms: number; handler: () => void }> = [];

// then を返すと、Promise が待つ対象と取り違える。scroll アクションは evaluate を 1 回呼ぶ（EVALUATE_MS かかる）
const makePage = () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'url') return () => 'about:blank';
        if (prop === 'evaluate') {
          return async () => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((resolve) => realSetTimeout(resolve, EVALUATE_MS));
            running--;
          };
        }
        return async () => '';
      },
    },
  );
const fakeBrowser = {
  createBrowserContext: async () => {
    opened++;
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    return { newPage: async () => makePage(), close: async () => void closed++ };
  },
};

const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));
/** セッションのタイマー（5 分以下で、枠の待ちの時間切れ（standard は 10 分）ではないもの）の、いちばん新しいもの */
const latestTimer = () => timers.filter((t) => t.ms <= 300_000).at(-1);
const timerCount = () => timers.filter((t) => t.ms <= 300_000).length;

beforeEach(async () => {
  await closeAllBrowserSessions();
  previous.SORA_ISOLATION = process.env.SORA_ISOLATION;
  delete process.env.SORA_ISOLATION;
  opened = 0;
  closed = 0;
  running = 0;
  peak = 0;
  timers = [];
  spies.push(
    spyOn(engine, 'getBrowser').mockResolvedValue({ browser: fakeBrowser, isDedicated: false } as never),
    spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms >= 10_000) {
        timers.push({ ms, handler });
        return 0 as never;
      }
      return realSetTimeout(handler, ms);
    }) as never),
  );
});

afterEach(async () => {
  setSystemTime(); // 時計を戻す
  await releaseAll();
  await closeAllBrowserSessions();
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (previous.SORA_ISOLATION === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = previous.SORA_ISOLATION;
  resetSecurityMetrics();
});

/** 上限・最長の時間を小さくした値（standard の他の値はそのまま） */
const lims = (extra: Partial<typeof STANDARD_LIMITS> = {}) => ({ ...STANDARD_LIMITS, ...extra });
const act = (options: Record<string, unknown>, lim: Readonly<typeof STANDARD_LIMITS> = STANDARD_LIMITS) => within(handleBrowserSessionAction({ extract: { markdown: false }, actions: [], ...options } as never, lim));
const create = async (tenantId: string, options: Record<string, unknown> = {}, lim?: Readonly<typeof STANDARD_LIMITS>) => (await act({ createSession: true, tenantId, ...options }, lim)).sessionId as string;
const scroll = { actions: [{ type: 'scroll' }] };

/** 枠を、空きが free 個になるまで取る */
async function leaveFree(free: number): Promise<Array<() => void>> {
  const held: Array<() => void> = [];
  for (let i = 0; engine.browserSemaphore.max - held.length > free; i++) held.push(await engine.browserSemaphore.acquire(`hog-${i}`));
  return held;
}

describe('作成済みのセッションの呼び出しも、枠の下で動く', () => {
  test('枠が 1 つしか空いていないとき、3 つのセッションの同時の呼び出しは、順番に動く（同時に動くアクションは 1 つ。以前は 3 つ）', async () => {
    const ids = [await create('name:alice'), await create('name:alice'), await create('name:alice')];
    const held = await leaveFree(1);
    try {
      peak = 0;
      await Promise.all(ids.map((sessionId) => act({ sessionId, tenantId: 'name:alice', ...scroll })));
      expect(peak).toBe(1);
    } finally {
      for (const release of held) release();
    }
  });

  test('呼び出しの間、枠を 1 つ持ち、終わったら戻す', async () => {
    const id = await create('name:alice');
    const base = engine.browserSemaphore.activeCount;
    const call = act({ sessionId: id, tenantId: 'name:alice', ...scroll });
    await sleep(EVALUATE_MS / 3);
    expect(engine.browserSemaphore.activeCount).toBe(base + 1);
    await call;
    expect(engine.browserSemaphore.activeCount).toBe(base);
  });

  test('作成の呼び出しも、アクションが終わるまで枠を持つ（作成のあとの scroll の間も）', async () => {
    const base = engine.browserSemaphore.activeCount;
    const call = act({ createSession: true, tenantId: 'name:alice', ...scroll });
    await sleep(EVALUATE_MS / 3 + 20);
    expect(engine.browserSemaphore.activeCount).toBe(base + 1);
    await call;
    expect(engine.browserSemaphore.activeCount).toBe(base);
  });

  test('strict で、枠が全部埋まり、利用者の待ちが上限なら、作成済みのセッションの呼び出しも 429（待ちの上限）。断られても、セッションは閉じず、使用中の印は残らない', async () => {
    const id = await create('name:alice');
    process.env.SORA_ISOLATION = 'strict';
    await saturate();
    fillQueue('name:alice', 10);
    const busy = await busyOf(act({ sessionId: id, tenantId: 'name:alice' }, undefined));
    expect(busy.reason).toBe('tenant_queue_full');
    expect(getActiveSessionCount()).toBe(1);
    expect(closed).toBe(0);
    await releaseAll();
    delete process.env.SORA_ISOLATION;
    // 使用中の印が残っていれば、追い出せない（断られる）。残っていなければ、自分の上限（1 件）で、これを追い出して作れる
    await act({ createSession: true, sessionId: 'second', tenantId: 'name:alice' }, lims({ browserSessionsPerTenant: 1 }));
    expect(closed).toBe(1);
  });

  test('所有者トークンが違って断られた呼び出しは、セッションを使用中にしない（追い出せる）', async () => {
    await create('name:alice', { sessionId: 'locked', ownerToken: 'secret' });
    await expect(act({ sessionId: 'locked', tenantId: 'name:alice', ownerToken: 'wrong' })).rejects.toThrow('Forbidden');
    await act({ createSession: true, sessionId: 'second', tenantId: 'name:alice', ownerToken: 'other' }, lims({ browserSessionsPerTenant: 1 }));
    expect(closed).toBe(1); // locked を追い出した
  });
});

describe('使用中のセッションは、期限切れ・追い出しで閉じない', () => {
  test('アクションの途中で期限のタイマーが発火しても、閉じない。終わったあとに、期限を数え直す（新しいタイマー）。数え直した期限が来れば、閉じる', async () => {
    const id = await create('name:alice');
    const call = act({ sessionId: id, tenantId: 'name:alice', ...scroll });
    await sleep(EVALUATE_MS / 3);
    const countDuring = timerCount();
    latestTimer()?.handler(); // 使用中に、期限のタイマーが発火する
    await sleep(20);
    expect(closed).toBe(0);
    await call;
    expect(closed).toBe(0);
    expect(timerCount()).toBeGreaterThan(countDuring); // 終わりで、数え直した
    latestTimer()?.handler();
    await sleep(20);
    expect(closed).toBe(1);
    expect(getActiveSessionCount()).toBe(0);
  });

  test.skipIf(engine.browserSemaphore.max < 2)('枠が 2 つ空いていて、自分の上限（1 件）のとき: 使用中のセッションは追い出さず、新しい作成を 429 で断る。使い終われば、作れる（追い出す）', async () => {
    const lim = lims({ browserSessionsPerTenant: 1, browserSessionsTotal: 5 });
    const id = await create('name:alice', {}, lim);
    const held = await leaveFree(2);
    try {
      const using = act({ sessionId: id, tenantId: 'name:alice', ...scroll }, lim);
      await sleep(EVALUATE_MS / 3);
      const error = await act({ createSession: true, tenantId: 'name:alice' }, lim).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ResourceBusyError);
      expect((error as ResourceBusyError).reason).toBe('session_limit');
      expect(closed).toBe(0); // 使用中のセッションは、閉じていない
      await using;
      await act({ createSession: true, tenantId: 'name:alice' }, lim); // 使い終わった。追い出して作れる
      expect(closed).toBe(1);
    } finally {
      for (const release of held) release();
    }
  });

  test('枠が 1 つしか空いていないとき: 新しい作成は、使用中の呼び出しが終わるのを待ち、そのあと、使い終わったセッションを追い出して作る', async () => {
    const lim = lims({ browserSessionsPerTenant: 1, browserSessionsTotal: 5 });
    const id = await create('name:alice', {}, lim);
    const held = await leaveFree(1);
    try {
      const using = act({ sessionId: id, tenantId: 'name:alice', ...scroll }, lim);
      await sleep(EVALUATE_MS / 3);
      const creating = act({ createSession: true, tenantId: 'name:alice' }, lim);
      await sleep(20);
      expect(closed).toBe(0); // 使用中の間は、閉じない（枠を待っている）
      await Promise.all([using, creating]);
      expect(closed).toBe(1);
      expect(getActiveSessionCount()).toBe(1);
    } finally {
      for (const release of held) release();
    }
  });

  test.skipIf(engine.browserSemaphore.max < 2)('使用中に、持ち主が closeSession で閉じ、同じ ID で作り直されても、使い終わった側は、新しいセッションに触れない（タイマーも付けない）', async () => {
    const id = await create('name:alice', { sessionId: 'x' });
    const held = await leaveFree(2);
    try {
      const using = act({ sessionId: id, tenantId: 'name:alice', ...scroll });
      await sleep(EVALUATE_MS / 3);
      const oldTimer = latestTimer(); // 最初の x の期限のタイマー
      expect((await act({ sessionId: 'x', closeSession: true, tenantId: 'name:alice' })).sessionClosed).toBe(true);
      await create('name:alice', { sessionId: 'x' }); // 新しい x
      expect(getActiveSessionCount()).toBe(1);
      const countBeforeEnd = timerCount();
      await using;
      expect(timerCount()).toBe(countBeforeEnd); // 閉じられた側は、期限を数え直さない
      oldTimer?.handler(); // 閉じられた側のタイマーが、使い終わったあとに発火しても、同じ ID の新しい x を閉じない
      await sleep(20);
      expect(getActiveSessionCount()).toBe(1);
      expect(closed).toBe(1);
      expect(getActiveSessionCount()).toBe(1);
      expect(closed).toBe(1); // 閉じたのは、最初の x だけ
      const before = opened;
      await act({ sessionId: 'x', tenantId: 'name:alice' }); // 新しい x は、生きている
      expect(opened).toBe(before);
    } finally {
      for (const release of held) release();
    }
  });
});

describe('使用中の印が、どの経路でも釣り合う', () => {
  test('同じ新しい ID の作成が重なったあと（待って使った側も）、使い終われば、自分の上限の追い出しの対象になる', async () => {
    const held = await leaveFree(1);
    try {
      await Promise.all([act({ sessionId: 'dup', tenantId: 'name:alice' }), act({ sessionId: 'dup', tenantId: 'name:alice' })]);
    } finally {
      for (const release of held) release();
    }
    await act({ createSession: true, tenantId: 'name:alice' }, lims({ browserSessionsPerTenant: 1 }));
    expect(closed).toBe(1); // dup を追い出して作れた（使用中の印が残っていれば、断られる）
  });

  test('枠を待つ間に、持ち主が closeSession で閉じたら、待っていた呼び出しは、新しいセッションを作る（閉じたセッションを使わない）', async () => {
    const id = await create('name:alice', { sessionId: 'x' });
    const held = await leaveFree(1);
    try {
      const first = act({ sessionId: id, tenantId: 'name:alice', ...scroll }); // 枠を 1 つ持つ
      await sleep(EVALUATE_MS / 3);
      const waiting = act({ sessionId: id, tenantId: 'name:alice' }); // 枠を待つ
      await sleep(20);
      await act({ sessionId: id, closeSession: true, tenantId: 'name:alice' }); // 持ち主が閉じる
      expect(closed).toBe(1);
      const before = opened;
      await Promise.all([first, waiting]);
      expect(opened).toBe(before + 1); // 待っていた呼び出しは、新しい x を作った
      expect(getActiveSessionCount()).toBe(1);
    } finally {
      for (const release of held) release();
    }
  });

  test.skipIf(engine.browserSemaphore.max < 2)('作成と同時に動かしている最中の新しいセッションも、使用中（ほかの作成で追い出されない）', async () => {
    const lim = lims({ browserSessionsPerTenant: 1, browserSessionsTotal: 5 });
    const held = await leaveFree(2);
    try {
      const creating = act({ createSession: true, sessionId: 'first', tenantId: 'name:alice', ...scroll }, lim);
      await sleep(EVALUATE_MS / 3 + 20); // 作成が済み、scroll の途中
      const error = await act({ createSession: true, sessionId: 'second', tenantId: 'name:alice' }, lim).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ResourceBusyError);
      expect(closed).toBe(0);
      await creating;
    } finally {
      for (const release of held) release();
    }
  });
});

describe('最長の時間（作成から。使い続けても延びない）', () => {
  const T0 = new Date('2026-06-01T00:00:00.000Z');
  const maxMs = 600_000;
  const lim = lims({ browserSessionMaxMs: maxMs });

  test('最長の時間を過ぎた、使っていないセッションは、次の呼び出しで閉じて、同じ ID は新しいセッションになる。手前なら、同じセッション', async () => {
    setSystemTime(T0);
    await create('name:alice', { sessionId: 'x' }, lim);
    setSystemTime(new Date(T0.getTime() + maxMs - 1));
    await act({ sessionId: 'x', tenantId: 'name:alice' }, lim);
    expect(opened).toBe(1);
    expect(closed).toBe(0);
    setSystemTime(new Date(T0.getTime() + maxMs));
    await act({ sessionId: 'x', tenantId: 'name:alice' }, lim);
    expect(closed).toBe(1);
    expect(opened).toBe(2);
    expect(getActiveSessionCount()).toBe(1);
  });

  test('期限のタイマーは、5 分と、最長の時間までの残りの、短いほう', async () => {
    setSystemTime(T0);
    await create('name:alice', { sessionId: 'x' }, lim);
    expect(latestTimer()?.ms).toBe(300_000); // 残り 10 分。5 分のほうが短い
    setSystemTime(new Date(T0.getTime() + 480_000));
    await act({ sessionId: 'x', tenantId: 'name:alice' }, lim);
    const ms = latestTimer()?.ms ?? 0;
    expect(ms).toBeLessThanOrEqual(120_000); // 残り 2 分
    expect(ms).toBeGreaterThan(119_000);
  });

  test('使用中に最長の時間を過ぎたら、呼び出しが終わったときに閉じる（途中では閉じない）', async () => {
    setSystemTime(T0);
    await create('name:alice', { sessionId: 'x' }, lim);
    const call = act({ sessionId: 'x', tenantId: 'name:alice', ...scroll }, lim);
    await sleep(EVALUATE_MS / 3);
    setSystemTime(new Date(T0.getTime() + maxMs + 1000));
    await sleep(20);
    expect(closed).toBe(0);
    await call;
    await sleep(30); // 呼び出しの終わりの、閉じる処理（待たずに始める）が済むまで
    expect(closed).toBe(1);
    expect(getActiveSessionCount()).toBe(0);
  });

  test.skipIf(engine.browserSemaphore.max < 2)('最長の時間を過ぎていても、別の呼び出しが使用中のセッションは、呼び出しの始まりで閉じない（使い終わったあとに閉じる）', async () => {
    setSystemTime(T0);
    await create('name:alice', { sessionId: 'x' }, lim);
    const held = await leaveFree(2);
    try {
      const first = act({ sessionId: 'x', tenantId: 'name:alice', ...scroll }, lim);
      await sleep(EVALUATE_MS / 3);
      setSystemTime(new Date(T0.getTime() + maxMs + 1000));
      const second = act({ sessionId: 'x', tenantId: 'name:alice' }, lim); // 使用中の x に、2 つ目の呼び出し
      await sleep(20);
      expect(closed).toBe(0);
      await Promise.all([first, second]);
      await sleep(30);
      expect(closed).toBe(1);
      expect(opened).toBe(1); // 2 つ目は、新しく作らず、使用中の x を使った
    } finally {
      for (const release of held) release();
    }
  });

  test('既定は水準の値: standard は 24 時間、strict は 1 時間（1 時間と 1 ミリ秒後の呼び出しで、strict だけが新しいセッションになる）', async () => {
    setSystemTime(T0);
    await create('name:alice', { sessionId: 'x' });
    setSystemTime(new Date(T0.getTime() + 3_600_001));
    await handleBrowserSessionAction({ sessionId: 'x', tenantId: 'name:alice', actions: [], extract: { markdown: false } } as never);
    expect(closed).toBe(0); // standard: 24 時間まで
    process.env.SORA_ISOLATION = 'strict';
    await handleBrowserSessionAction({ sessionId: 'x', tenantId: 'name:alice', actions: [], extract: { markdown: false } } as never);
    expect(closed).toBe(1); // strict: 1 時間
  });
});

describe('strict では、tenant の無い（legacy）セッションを使えない', () => {
  const create1 = (options: Record<string, unknown>) => handleBrowserSessionAction({ actions: [], extract: { markdown: false }, ...options } as never);

  test('strict: tenant を渡さない・legacy を渡す作成と続きは、禁止（Forbidden。REST は 403）。ブラウザも枠も使わない', async () => {
    process.env.SORA_ISOLATION = 'strict';
    const base = engine.browserSemaphore.activeCount;
    await expect(create1({ createSession: true })).rejects.toThrow('Forbidden');
    await expect(create1({ createSession: true, tenantId: 'legacy' })).rejects.toThrow('Forbidden');
    await expect(create1({ sessionId: 'x' })).rejects.toThrow('Forbidden');
    expect(opened).toBe(0);
    expect(engine.browserSemaphore.activeCount).toBe(base);
    expect(getActiveSessionCount()).toBe(0);
  });

  test('strict でも、名前のある tenant は使える。セッションを閉じるだけの呼び出しは、legacy でも通る（閉じられなくなるのを避ける）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    await expect(create1({ createSession: true, tenantId: 'name:alice' })).resolves.toBeDefined();
    expect((await create1({ sessionId: 'nothing', closeSession: true })).sessionClosed).toBe(false);
  });

  test('standard（既定）では、これまでどおり、tenant の無いセッションを使える', async () => {
    await expect(create1({ createSession: true })).resolves.toBeDefined();
    expect(getActiveSessionCount()).toBe(1);
  });
});
