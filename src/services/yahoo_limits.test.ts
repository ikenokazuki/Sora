import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { ResourceBusyError } from '../errors.js';
import * as httpFetcher from '../http_fetcher.js';
import { currentCaller, runAsCaller } from '../security/caller.js';
import type { QueuePolicy } from '../security/fair_queue.js';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { TenantBudget } from '../security/tenant_budget.js';
import { clearCache } from '../cache.js';
import { clearYahooSearchCache } from '../retrieval/yahoo_cache.js';
import { searchRealtimeCached } from '../yahoo_search_cache.js';
import {
  callYahooMcp,
  createWebAnchorHints,
  createYahooGate,
  fetchYahooWebDirect,
  isYahooRateLimitedError,
  recordYahooWebResult,
  resetYahooBreaker,
  resetYahooCallGate,
  resetYahooWebPressure,
  searchYahooRealtime,
  searchYahooVideo,
  searchYahooWeb,
  tripYahooBreaker,
  yahooGate,
  yahooQueuePolicy,
  yahooWebPressure,
} from './yahoo.js';

/**
 * Yahoo の順番・予算・ブレーカー（設計 6。穴 25）。
 * 以前は、同梱バイナリ・動画の直取得の順番が、全体で 1 本の直列の鎖で、待つ数にも待ち時間にも上限が無く（A が 40 件のあとの B の 1 件が 2049 ms 待った。
 * 2000 件を並べても全部受け付けられた）、ブレーカーが開いている間も、順番を待ってから断っていた。1 人の連打が提供元の 429 に当たると、ブレーカーが 120 秒、全員を止める。
 */

const SAVED = {
  SORA_ISOLATION: process.env.SORA_ISOLATION,
  SORA_YAHOO_MIN_INTERVAL_MS: process.env.SORA_YAHOO_MIN_INTERVAL_MS,
  SORA_YAHOO_BREAKER_COOLDOWN_MS: process.env.SORA_YAHOO_BREAKER_COOLDOWN_MS,
};
const spies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  resetYahooBreaker();
  resetYahooCallGate();
  resetYahooWebPressure();
  resetSecurityMetrics();
  clearYahooSearchCache();
  delete process.env.SORA_ISOLATION;
  delete process.env.SORA_YAHOO_BREAKER_COOLDOWN_MS;
  process.env.SORA_YAHOO_MIN_INTERVAL_MS = '0';
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetYahooBreaker();
  resetYahooCallGate();
});

const policy = (over: Partial<QueuePolicy> = {}): (() => QueuePolicy) => () => ({ perTenant: 100, total: 1000, waitMs: 5000, sharePercent: 100, ...over });
const smallBudget = (perWindow: number) => new TenantBudget({ resource: 'yahoo', policy: () => ({ perWindow, windowMs: 60_000 }) });

/** 仮想の時計。sleep はすぐ終わる（時計を進める） */
function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

/** 間隔を空ける待ちを、手で放すまで止める時計（順番を握ったままにする） */
function blockedClock(start = 1_000_000) {
  let time = start;
  const waiting: Array<() => void> = [];
  return {
    now: () => time,
    sleep: (ms: number) => new Promise<void>((resolve) => { waiting.push(() => { time += ms; resolve(); }); }),
    releaseAll: async () => {
      // 放すと、次の待ちが握って、また止まるので、空になるまで繰り返す
      for (let i = 0; i < 200 && waiting.length > 0; i++) {
        for (const fn of waiting.splice(0)) fn();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    },
    pending: () => waiting.length,
  };
}

const busyOf = async (promise: Promise<unknown>): Promise<ResourceBusyError> => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ResourceBusyError);
  return error as ResourceBusyError;
};

describe('順番: 公平・間隔・上限', () => {
  test('A が先に並べても、B の 1 件は、A の全部の後ろにならない（利用者を順番に回す）。間隔（500ms）は利用者をまたいで共有', async () => {
    const c = clock();
    const gate = createYahooGate({ ...c, minIntervalMs: () => 500, queuePolicy: policy(), budget: smallBudget(0) });
    const order: Array<{ who: string; at: number }> = [];
    // 通った時刻 = 間隔を待ち終えた時刻。admit が戻った時点の仮想の時計は、あとの要求の待ちで進んでいるので、戻る前の位置（sleep の後）は取れない。
    // そこで、通った順に、時計が 500ms ずつ進むことを見る（最初の 1 件は待たないので、時計が進まない）
    const run = (tenant: string, who: string) => runAsCaller(tenant, () => gate.admit().then(() => { order.push({ who, at: c.now() }); }));
    await Promise.all([
      ...['a0', 'a1', 'a2', 'a3', 'a4'].map((who) => run('name:A', who)),
      run('name:B', 'b0'),
    ]);
    expect(order.map((o) => o.who)).toEqual(['a0', 'a1', 'b0', 'a2', 'a3', 'a4']);
    // 500ms 間隔（最初の 1 件は待たない）
    // 全体で 6 件が、500ms 間隔で 1 つずつ: 最後に時計が進んだ合計は 5 回分（2500ms）
    expect(c.now() - 1_000_000).toBe(2500);
    // 通った順に、時計は戻らない（先に通った方が、早い時刻）
    const times = order.map((o) => o.at);
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  test('間隔が 0 なら、順番を使わない（同時に出しても、待つ数の上限が効かない）。予算は、それでも数える', async () => {
    const gate = createYahooGate({ ...clock(), minIntervalMs: () => 0, queuePolicy: policy({ perTenant: 0, total: 0 }), budget: smallBudget(4) });
    // 同時に 3 件: 順番を使うと、先の 1 件が枠を握っている間に、待てる数 0 で断られる
    await Promise.all([gate.admit(), gate.admit(), gate.admit()]);
    await gate.admit();
    const busy = await busyOf(gate.admit());
    expect(busy.reason).toBe('tenant_budget');
  });

  test('間隔がちょうど 1 なら、順番を使う（待つ数の上限が効く）', async () => {
    const gate = createYahooGate({ ...blockedClock(), minIntervalMs: () => 1, queuePolicy: policy({ perTenant: 0, total: 0 }), budget: smallBudget(0) });
    const results = await Promise.allSettled([gate.admit(), gate.admit()]);
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
  });

  test('1 人が待てる数を超えたら、待たせず、予算も使わずに断る（tenant_queue_full）。別の利用者は待てる', async () => {
    const c = blockedClock();
    const budget = smallBudget(100);
    const gate = createYahooGate({ ...c, minIntervalMs: () => 500, queuePolicy: policy({ perTenant: 2 }), budget });
    const a = (n: number) => runAsCaller('name:A', () => gate.admit().then(() => n));
    const first = a(0); // すぐ通る
    const holder = a(1); // 順番を握って、間隔の待ちで止まる
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const w1 = a(2);
    const w2 = a(3); // 待ち 2 件（上限）
    const busy = await busyOf(a(4));
    expect(busy).toMatchObject({ resource: 'yahoo', reason: 'tenant_queue_full' });
    expect(budget.usedBy('name:A')).toBe(4); // first・holder・w1・w2。断られた a(4) は使わない
    const b = runAsCaller('name:B', () => gate.admit());
    await c.releaseAll();
    await Promise.all([first, holder, w1, w2, b]);
    expect(getSecurityMetrics().sora_yahoo_busy_tenant_queue_full_total).toBe(1);
  });

  test('待てる数の上限で、同時に出した要求は、予算を使う前に断られる（予算の断りに化けない）', async () => {
    const c = blockedClock();
    const budget = smallBudget(3);
    const gate = createYahooGate({ ...c, minIntervalMs: () => 500, queuePolicy: policy({ perTenant: 1 }), budget });
    const a = (n: number) => runAsCaller('name:A', () => gate.admit().then(() => n));
    const pending = [a(0), a(1)]; // すぐ通る 1 件と、握る 1 件
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    pending.push(a(2)); // 待ち 1 件（上限）。予算は 3 回使った
    const burst = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => a(10 + i)));
    expect(burst.map((r) => (r.status === 'rejected' ? (r.reason as ResourceBusyError).reason : 'ok'))).toEqual(Array(10).fill('tenant_queue_full'));
    expect(budget.usedBy('name:A')).toBe(3);
    await c.releaseAll();
    await Promise.all(pending);
  });

  test('全体で待てる数を超えたら、queue_full', async () => {
    const c = blockedClock();
    const gate = createYahooGate({ ...c, minIntervalMs: () => 500, queuePolicy: policy({ perTenant: 5, total: 2 }), budget: smallBudget(0) });
    const run = (tenant: string) => runAsCaller(tenant, () => gate.admit());
    const pending = [run('name:A'), run('name:A')]; // すぐ通る 1 件と、握る 1 件
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    pending.push(run('name:B'), run('name:C'));
    const busy = await busyOf(run('name:D'));
    expect(busy.reason).toBe('queue_full');
    await c.releaseAll();
    await Promise.all(pending);
  });

  test('順番が来るまでの待ちに時間の上限がある（queue_timeout）。待ちきれなかった回は、予算を返す', async () => {
    const c = blockedClock();
    const budget = smallBudget(3);
    const gate = createYahooGate({ ...c, minIntervalMs: () => 500, queuePolicy: policy({ waitMs: 20 }), budget });
    const a = [runAsCaller('name:A', () => gate.admit()), runAsCaller('name:A', () => gate.admit())];
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 3; i++) {
      const busy = await busyOf(runAsCaller('name:B', () => gate.admit()));
      expect(busy.reason).toBe('queue_timeout');
    }
    expect(budget.usedBy('name:B')).toBe(0); // 3 回待ちきれなくても、予算は減らない
    await c.releaseAll();
    await Promise.all(a);
  });

  test('予算を使い切った利用者は、順番に並べず、すぐ断る（tenant_budget）。ほかの利用者は通る', async () => {
    const c = blockedClock();
    const gate = createYahooGate({ ...c, minIntervalMs: () => 500, queuePolicy: policy(), budget: smallBudget(2) });
    const a = [runAsCaller('name:A', () => gate.admit()), runAsCaller('name:A', () => gate.admit())];
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const t0 = Date.now();
    const busy = await busyOf(runAsCaller('name:A', () => gate.admit()));
    expect(busy).toMatchObject({ resource: 'yahoo', reason: 'tenant_budget' });
    expect(Date.now() - t0).toBeLessThan(300); // 順番を待たずに断る
    const b = runAsCaller('name:B', () => gate.admit());
    await c.releaseAll();
    await Promise.all([...a, b]);
  });

  test('admit が返す関数で、予算を返せる（提供元へ出さなかった回）', async () => {
    const budget = smallBudget(1);
    const gate = createYahooGate({ ...clock(), minIntervalMs: () => 0, queuePolicy: policy(), budget });
    const refund = await runAsCaller('name:A', () => gate.admit());
    expect(budget.usedBy('name:A')).toBe(1);
    refund();
    expect(budget.usedBy('name:A')).toBe(0);
    await runAsCaller('name:A', () => gate.admit()); // また使える
  });

  test('spend（順番を使わない提供元への問い合わせ）: 予算だけを使う。返す関数を返す', () => {
    const budget = smallBudget(1);
    const gate = createYahooGate({ ...clock(), minIntervalMs: () => 500, queuePolicy: policy({ perTenant: 0, total: 0 }), budget });
    const refund = runAsCaller('name:A', () => gate.spend());
    expect(budget.usedBy('name:A')).toBe(1);
    expect(() => runAsCaller('name:A', () => gate.spend())).toThrow(expect.objectContaining({ reason: 'tenant_budget' }));
    refund();
    runAsCaller('name:A', () => gate.spend());
  });

  test('reset で、予算を元に戻す', async () => {
    const budget = smallBudget(1);
    const gate = createYahooGate({ ...clock(), minIntervalMs: () => 0, queuePolicy: policy(), budget });
    await gate.admit();
    gate.reset();
    await gate.admit(); // 予算も戻っている
  });

  test('reset で、前の間隔を忘れる（直後の 1 件は、間隔を待たない）', async () => {
    const c = clock();
    const gate = createYahooGate({ ...c, minIntervalMs: () => 500, queuePolicy: policy(), budget: smallBudget(0) });
    await gate.admit();
    gate.reset();
    const before = c.now();
    await gate.admit();
    expect(c.now()).toBe(before); // 間隔の待ち（仮想の sleep）をしていない
  });

  test('reset で、握られた順番・待ちを手放す（直後の 1 件は、前の握りを待たない）', async () => {
    const c = blockedClock();
    const gate = createYahooGate({ ...c, minIntervalMs: () => 500, queuePolicy: policy(), budget: smallBudget(0) });
    const first = gate.admit();
    const holder = gate.admit(); // 順番を握って、間隔の待ちで止まる
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(c.pending()).toBe(1);
    gate.reset();
    const fresh = await Promise.race([gate.admit().then(() => 'passed'), new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 200))]);
    expect(fresh).toBe('passed');
    await c.releaseAll();
    await Promise.all([first, holder]);
  });
});

describe('既定の上限は、水準（SORA_ISOLATION）から読む', () => {
  test('順番の方針は、表の値をそのまま写す', () => {
    process.env.SORA_ISOLATION = 'strict';
    expect(yahooQueuePolicy()).toEqual({ perTenant: 5, total: 30, waitMs: 20_000, sharePercent: 100 });
    process.env.SORA_ISOLATION = 'standard';
    expect(yahooQueuePolicy()).toEqual({ perTenant: 100, total: 300, waitMs: 120_000, sharePercent: 100 });
  });

  test('既定の予算の窓は 1 分で、予算は strict が 60 回・standard は制限なし', async () => {
    const realNow = Date.now;
    let at = 1_000_000;
    Date.now = () => at;
    try {
      process.env.SORA_ISOLATION = 'strict';
      const strict = createYahooGate({ ...clock(), minIntervalMs: () => 0 });
      for (let i = 0; i < 60; i++) await runAsCaller('name:A', () => strict.admit());
      await expect(runAsCaller('name:A', () => strict.admit())).rejects.toMatchObject({ reason: 'tenant_budget' });
      at += 59_999;
      await expect(runAsCaller('name:A', () => strict.admit())).rejects.toMatchObject({ reason: 'tenant_budget' });
      at += 1;
      await runAsCaller('name:A', () => strict.admit());
      delete process.env.SORA_ISOLATION;
      const standard = createYahooGate({ ...clock(), minIntervalMs: () => 0 });
      for (let i = 0; i < 200; i++) await runAsCaller('name:A', () => standard.admit());
    } finally {
      Date.now = realNow;
    }
  });

  test('水準の値が不正なら、緩い側に倒さず、エラー', async () => {
    process.env.SORA_ISOLATION = 'strcit';
    const gate = createYahooGate({ ...clock(), minIntervalMs: () => 500 });
    await expect(gate.admit()).rejects.toThrow(/SORA_ISOLATION/);
  });
});

/** spawn を、すぐ終わる偽の子プロセスに替える。呼ばれた回数が、提供元へ出した回数 */
function fakeSpawn(text = '{"items":[{"title":"a"}]}') {
  const calls: unknown[] = [];
  const spy = spyOn(childProcess, 'spawn').mockImplementation((() => {
    calls.push(1);
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    child.stdin = {
      write: () => undefined,
      end: () => {
        queueMicrotask(() => {
          child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }) + '\n');
          child.emit('close', 0);
        });
      },
    };
    return child;
  }) as never);
  spies.push(spy);
  return calls;
}

describe('callYahooMcp（同梱バイナリ）', () => {
  test('提供元へ出す 1 回が、予算を 1 回使う（strict）。standard は、何も覚えない', async () => {
    const calls = fakeSpawn();
    process.env.SORA_ISOLATION = 'strict';
    await runAsCaller('name:A', () => callYahooMcp('yahoo_web_search', { query: 'x' }));
    await runAsCaller('name:A', () => callYahooMcp('yahoo_news_search', { query: 'y' }));
    await runAsCaller('name:B', () => callYahooMcp('yahoo_news_search', { query: 'y' }));
    expect(calls).toHaveLength(3);
    expect(yahooGate.budget.usedBy('name:A')).toBe(2);
    expect(yahooGate.budget.usedBy('name:B')).toBe(1);
    resetYahooCallGate();
    delete process.env.SORA_ISOLATION;
    await runAsCaller('name:A', () => callYahooMcp('yahoo_web_search', { query: 'x' }));
    expect(yahooGate.budget.usedBy('name:A')).toBe(0);
  });

  test('予算を使い切ったら、提供元へ出さずに断る（429 相当）。ほかの利用者の予算は減らない', async () => {
    const calls = fakeSpawn();
    process.env.SORA_ISOLATION = 'strict';
    for (let i = 0; i < 60; i++) await runAsCaller('name:A', () => callYahooMcp('yahoo_news_search', { query: `q${i}` }));
    const busy = await busyOf(runAsCaller('name:A', () => callYahooMcp('yahoo_news_search', { query: 'over' })));
    expect(busy).toMatchObject({ resource: 'yahoo', reason: 'tenant_budget' });
    expect(calls).toHaveLength(60);
    await runAsCaller('name:B', () => callYahooMcp('yahoo_news_search', { query: 'b' }));
    expect(calls).toHaveLength(61);
  });

  test('ブレーカーが開いている間は、順番にも予算にも入らず、すぐ断る（YAHOO_RATE_LIMITED）。提供元へ出さない', async () => {
    const calls = fakeSpawn();
    process.env.SORA_ISOLATION = 'strict';
    process.env.SORA_YAHOO_MIN_INTERVAL_MS = '500';
    tripYahooBreaker();
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => runAsCaller('name:A', () => callYahooMcp('yahoo_news_search', { query: `q${i}` })).catch((e: unknown) => e)));
    expect(Date.now() - t0).toBeLessThan(300); // 以前は、順番を待ってから、1 件ずつ（500ms 間隔で）断っていた
    expect(results.every((r) => isYahooRateLimitedError(r))).toBe(true);
    expect(calls).toHaveLength(0);
    expect(yahooGate.budget.usedBy('name:A')).toBe(0);
    expect(getSecurityMetrics().sora_throttled_total).toBe(20);
  });

  test('順番を待つ間にブレーカーが開いたら、提供元へ出さずに断り、予算を返す', async () => {
    const calls = fakeSpawn();
    process.env.SORA_ISOLATION = 'strict';
    process.env.SORA_YAHOO_MIN_INTERVAL_MS = '80';
    const first = runAsCaller('name:A', () => callYahooMcp('yahoo_news_search', { query: 'first' }));
    const second = runAsCaller('name:A', () => callYahooMcp('yahoo_news_search', { query: 'second' })).catch((e: unknown) => e);
    await first; // 1 件目は、間隔を待たずに通る
    expect(calls).toHaveLength(1);
    tripYahooBreaker(); // 2 件目は、まだ間隔（80ms）を待っている
    const error = await second;
    expect(isYahooRateLimitedError(error)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(yahooGate.budget.usedBy('name:A')).toBe(1); // 2 件目の予算は、返した
  });
});

describe('fetchYahooWebDirect（Web 検索の直取得。順番は通らず、予算だけ）', () => {
  const html = '<html><body><div class="sw-Card"></div></body></html>';
  test('予算を 1 回使う（strict）。使い切ったら、提供元へ出さずに断る', async () => {
    let fetched = 0;
    spies.push(spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async () => { fetched++; return { response: new Response(html) }; }) as never));
    process.env.SORA_ISOLATION = 'strict';
    for (let i = 0; i < 60; i++) await runAsCaller('name:A', () => fetchYahooWebDirect(`q${i}`));
    expect(fetched).toBe(60);
    const busy = await busyOf(runAsCaller('name:A', () => fetchYahooWebDirect('over')));
    expect(busy).toMatchObject({ resource: 'yahoo', reason: 'tenant_budget' });
    expect(fetched).toBe(60);
    await runAsCaller('name:B', () => fetchYahooWebDirect('b'));
    expect(fetched).toBe(61);
  });
});

describe('動画の直取得: ブレーカー', () => {
  const videoPage = '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"initialState":{"domainState":{"videoAlgo":{"items":[]}}}}}</script></body></html>';
  const video = (q: string) => runAsCaller('name:A', () => searchYahooVideo({ query: q, platform: 'youtube', updated: 'week' } as never));

  test('ブレーカーが開いている間は、順番にも予算にも入らず、すぐ断る', async () => {
    let fetched = 0;
    spies.push(spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async () => { fetched++; return { response: new Response(videoPage) }; }) as never));
    process.env.SORA_ISOLATION = 'strict';
    process.env.SORA_YAHOO_MIN_INTERVAL_MS = '500';
    tripYahooBreaker();
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => video(`v${i}`).catch((e: unknown) => e)));
    expect(Date.now() - t0).toBeLessThan(300); // 順番を待ってから、1 件ずつ（500ms 間隔で）断らない
    expect(results.every((r) => isYahooRateLimitedError(r))).toBe(true);
    expect(fetched).toBe(0);
    expect(yahooGate.budget.usedBy('name:A')).toBe(0);
  });

  test('順番を待つ間にブレーカーが開いたら、提供元へ出さずに断り、予算を返す', async () => {
    let fetched = 0;
    spies.push(spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async () => { fetched++; return { response: new Response(videoPage) }; }) as never));
    process.env.SORA_ISOLATION = 'strict';
    process.env.SORA_YAHOO_MIN_INTERVAL_MS = '80';
    const first = video('first');
    const second = video('second').catch((e: unknown) => e);
    await first;
    expect(fetched).toBe(1);
    tripYahooBreaker(); // 2 件目は、まだ間隔（80ms）を待っている
    expect(isYahooRateLimitedError(await second)).toBe(true);
    expect(fetched).toBe(1);
    expect(yahooGate.budget.usedBy('name:A')).toBe(1); // 2 件目の予算は返した
  });
});

describe('動画の直取得（期間・動画サイトの指定）', () => {
  test('予算を 1 回使い、ブレーカーが開いていれば、予算を使わずに断る', async () => {
    let fetched = 0;
    const videoPage = '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"initialState":{"domainState":{"videoAlgo":{"items":[]}}}}}</script></body></html>';
    spies.push(spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async () => { fetched++; return { response: new Response(videoPage) }; }) as never));
    process.env.SORA_ISOLATION = 'strict';
    await runAsCaller('name:A', () => searchYahooVideo({ query: '動画', platform: 'youtube', updated: 'week' } as never));
    expect(fetched).toBe(1);
    expect(yahooGate.budget.usedBy('name:A')).toBe(1);
    tripYahooBreaker();
    const error = await runAsCaller('name:A', () => searchYahooVideo({ query: '動画2', platform: 'youtube', updated: 'week' } as never)).then(() => undefined, (e: unknown) => e);
    expect(isYahooRateLimitedError(error)).toBe(true);
    expect(fetched).toBe(1);
    expect(yahooGate.budget.usedBy('name:A')).toBe(1);
  });
});

describe('Web 検索: 取得をまとめるのは、利用者ごと。順番・予算の断りは、その利用者にだけ返る', () => {
  const item = { title: 'a', url: 'https://example.com/a', snippet: 's' };
  const stubs = (over: { direct?: () => Promise<unknown>; mcp?: () => Promise<unknown> } = {}) => {
    const counts = { direct: 0, mcp: 0 };
    return {
      counts,
      deps: {
        fetchYahooWebDirect: async () => { counts.direct++; return over.direct ? over.direct() : [item]; },
        callYahooMcp: async () => { counts.mcp++; return over.mcp ? over.mcp() : { content: [{ type: 'text', text: JSON.stringify({ items: [item] }) }] }; },
      } as never,
    };
  };
  const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2)}`;

  test('同じ利用者どうしの同じ語は、これまでどおり 1 回にまとまる', async () => {
    const { counts, deps } = stubs({ direct: async () => { await new Promise<void>((r) => setTimeout(r, 20)); return [item]; } });
    const query = unique('same');
    await Promise.all([1, 2, 3].map(() => runAsCaller('name:A', () => searchYahooWeb({ query, disableFallback: true, noCache: true }, deps))));
    expect(counts.direct).toBe(1);
  });

  test('別の利用者の同じ語は、まとめない（利用者ごとに 1 回）', async () => {
    const { counts, deps } = stubs({ direct: async () => { await new Promise<void>((r) => setTimeout(r, 20)); return [item]; } });
    const query = unique('cross');
    await Promise.all(['name:A', 'name:B', 'name:C'].map((tenant) => runAsCaller(tenant, () => searchYahooWeb({ query, disableFallback: true, noCache: true }, deps))));
    expect(counts.direct).toBe(3);
  });

  test('A の取得が順番・予算で断られても、同じ語を同時に頼んだ B には返らない', async () => {
    const query = unique('spill');
    const busy = () => new ResourceBusyError('Yahoo への問い合わせの、この利用者の予算を使い切りました', 'tenant_budget', 30, 'yahoo');
    let calls = 0;
    const deps = {
      fetchYahooWebDirect: async () => {
        calls++;
        await new Promise<void>((r) => setTimeout(r, 20));
        if (currentTenantIsA()) throw busy();
        return [item];
      },
      callYahooMcp: async () => { throw new Error('unused'); },
    } as never;
    const currentTenantIsA = () => currentCaller() === 'name:A';
    const [a, b] = await Promise.allSettled([
      runAsCaller('name:A', () => searchYahooWeb({ query, disableFallback: true, noCache: true }, deps)),
      runAsCaller('name:B', () => searchYahooWeb({ query, disableFallback: true, noCache: true }, deps)),
    ]);
    expect(a.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason).toBeInstanceOf(ResourceBusyError);
    expect(b.status).toBe('fulfilled');
    expect((b as PromiseFulfilledResult<any>).value.items.length).toBeGreaterThan(0);
    expect(calls).toBe(2);
  });

  test('直取得の断り（予算）は、ただの失敗にも throttled の結果にもせず、そのまま投げる。MCP の代替へも進まない。提供元の圧力にも数えない', async () => {
    const busy = new ResourceBusyError('x', 'tenant_budget', 30, 'yahoo');
    const { counts, deps } = stubs({ direct: async () => { throw busy; } });
    await expect(runAsCaller('name:A', () => searchYahooWeb({ query: unique('direct-busy'), disableFallback: true, noCache: true }, deps))).rejects.toBe(busy);
    expect(counts.mcp).toBe(0);
    expect(yahooWebPressure.snapshot().recentRateLimits).toBe(0);
    expect(yahooWebPressure.canRequest()).toBe(true);
    expect(getSecurityMetrics().yahoo_429_total).toBeUndefined();
  });

  test('MCP の代替の断り（順番）も、そのまま投げる', async () => {
    const busy = new ResourceBusyError('x', 'tenant_queue_full', 5, 'yahoo');
    const { deps } = stubs({ direct: async () => [], mcp: async () => { throw busy; } });
    await expect(runAsCaller('name:A', () => searchYahooWeb({ query: unique('mcp-busy'), disableFallback: true, noCache: true }, deps))).rejects.toBe(busy);
    expect(yahooWebPressure.snapshot().recentRateLimits).toBe(0);
  });

  test('混み合い以外の失敗は、これまでどおり（throttled の結果・providerErrors）', async () => {
    const { deps } = stubs({ direct: async () => { throw new Error('boom'); }, mcp: async () => { throw new Error('boom2'); } });
    const res = await runAsCaller('name:A', () => searchYahooWeb({ query: unique('plain'), disableFallback: true, noCache: true }, deps));
    expect(res.items).toEqual([]);
  });
});

describe('recordYahooWebResult: 混み合いの断りは、提供元の失敗に数えない', () => {
  test('ResourceBusyError は false を返し、カウンターも、圧力も動かさない', () => {
    const before = yahooWebPressure.snapshot();
    expect(recordYahooWebResult(new ResourceBusyError('429 too many requests rate limit', 'tenant_budget', 5, 'yahoo'))).toBe(false);
    expect(getSecurityMetrics().yahoo_request_total).toBeUndefined();
    expect(getSecurityMetrics().yahoo_429_total).toBeUndefined();
    expect(yahooWebPressure.snapshot()).toEqual(before);
  });

  test('提供元の 429 は、これまでどおり数える', () => {
    expect(recordYahooWebResult(Object.assign(new Error('Yahoo provider rate limited'), { code: 'YAHOO_RATE_LIMITED' }))).toBe(true);
    expect(getSecurityMetrics().yahoo_429_total).toBe(1);
  });
});

describe('順番・予算で断られても、劣化した結果を作らない（共有キャッシュに入って、ほかの利用者に返らないように）', () => {
  const exhaust = (tenant: string) => { for (let i = 0; i < 60; i++) runAsCaller(tenant, () => yahooGate.spend()); };

  test('Web 検索の追加の検索（rescue）が予算で断られたら、初回の弱い結果を返さず、そのまま投げる。キャッシュにも入らない', async () => {
    process.env.SORA_ISOLATION = 'strict';
    clearYahooSearchCache();
    const query = '東京 ライブ 予定 2026年11月20日';
    const weak = [{ title: 'weak', url: 'https://example.com/w', snippet: 'x' }];
    const deps = { fetchYahooWebDirect: async () => weak } as never; // 直取得は偽物（予算を使わない）。追加の検索は、本物の入口（予算）を通る
    exhaust('name:A');
    await expect(runAsCaller('name:A', () => searchYahooWeb({ query }, deps))).rejects.toMatchObject({ resource: 'yahoo', reason: 'tenant_budget' });
    // 予算に余裕のある B は、A の弱い結果を受け取らない（キャッシュに入っていない）
    const calls = fakeSpawn('{"items":[{"title":"rescue hit","url":"https://example.org/r","description":"東京 ライブ 予定"}]}');
    const b: any = await runAsCaller('name:B', () => searchYahooWeb({ query }, deps));
    expect(b.cached).toBeUndefined();
    expect(b.adaptiveUnion).toBe(true);
    expect(calls).toHaveLength(1);
  });

  const LOVE_TITLES = ['=LOVE（イコールラブ）オフィシャルサイト', 'SCHEDULE | =LOVE（イコールラブ）公式サイト', '=LOVE 全国ツアー2026 ライブ日程 - チケットぴあ'];
  const webHtml = '<div id="web"><ul>' + LOVE_TITLES.map((t, i) => `<li><a href="https://example.com/${i}">${t}</a><div>s</div></li>`).join('') + '</ul></div>';
  const post = (id: string, text: string, handle = 'fan') => ({ id, author_handle: handle, author_name: handle, text, url: `https://x.com/${handle}/status/${id}`, created_at: 1758000000 });
  const loveNoise = Array.from({ length: 8 }, (_, i) => post(`9${i}`, `LOVE ライブ 予定 ${i}`));
  const loveProvider = (q: string) => (q.includes('イコラブ') ? [post('101', 'イコラブ ライブ 予定発表！')] : q.includes('=LOVE') ? [...loveNoise, post('100', '=LOVE 最高')] : loveNoise);
  const TOTALS: Record<string, number> = { '=LOVE': 5000, 'ライブ': 900000 };
  const realtime = () => ({
    query: '=LOVE ライブ 予定',
    detailEnrichment: false,
    _callMcp: async (_tool: string, args: { query: string }) => ({ content: [{ text: JSON.stringify({ items: loveProvider(args.query) }) }] }),
    _termTotals: async (terms: string[]) => Object.fromEntries(terms.filter((t) => TOTALS[t]).map((t) => [t, TOTALS[t]])),
  }) as never;
  const ids = (r: any) => (r.items ?? r.data?.items ?? []).map((i: any) => i.id);

  test('search_realtime のアンカー判定（Web 検索）が予算で断られたら、ノイズの混ざった劣化した結果を返さず、そのまま投げる。共有キャッシュにも入らない', async () => {
    spies.push(spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async () => ({ response: new Response(webHtml) })) as never));
    process.env.SORA_ISOLATION = 'strict';
    clearCache();
    clearYahooSearchCache();
    exhaust('name:A');
    await expect(runAsCaller('name:A', () => searchRealtimeCached({ ...(realtime() as object), query: '=LOVE ライブ 予定' } as never))).rejects.toMatchObject({ resource: 'yahoo', reason: 'tenant_budget' });
    // 予算に余裕のある B は、アンカーが判定された正しい結果を得る（A のノイズ入りの結果がキャッシュに無い）
    const b: any = await runAsCaller('name:B', () => searchRealtimeCached({ ...(realtime() as object), query: '=LOVE ライブ 予定' } as never));
    expect(b.cached).toBe(false);
    expect(ids(b)).toEqual(['100']);
  });

  test('公式投稿の判定（officialPosts）の断りも、握らない（アンカーが壊れていて、別名を探すとき）', async () => {
    const busy = new ResourceBusyError('x', 'tenant_budget', 30, 'yahoo');
    const hints = { webTitles: async () => LOVE_TITLES, officialPosts: async () => { throw busy; } };
    await expect(searchYahooRealtime({ ...(realtime() as object), anchorHints: hints } as never)).rejects.toBe(busy);
    const plain = { webTitles: async () => LOVE_TITLES, officialPosts: async () => { throw new Error('boom'); } };
    const res = await searchYahooRealtime({ ...(realtime() as object), anchorHints: plain } as never);
    expect(res.items.length).toBeGreaterThan(0);
  });

  test('searchYahooRealtime 本体も、アンカー判定の断りを握らない（判定の失敗は握るが、順番・予算の断りは投げる）', async () => {
    const busy = new ResourceBusyError('x', 'tenant_budget', 30, 'yahoo');
    const hints = { webTitles: async () => { throw busy; }, officialPosts: async () => [] };
    await expect(searchYahooRealtime({ ...(realtime() as object), anchorHints: hints } as never)).rejects.toBe(busy);
    // 混み合い以外の失敗は、これまでどおり握る（アンカーなしで続ける）
    const plain = { webTitles: async () => { throw new Error('boom'); }, officialPosts: async () => [] };
    const res = await searchYahooRealtime({ ...(realtime() as object), anchorHints: plain } as never);
    expect(res.items.length).toBeGreaterThan(0);
  });

  test('createWebAnchorHints: Web 検索の断りは握らず、webTitles の失敗として投げる。混み合い以外は空', async () => {
    process.env.SORA_ISOLATION = 'strict';
    clearYahooSearchCache(); // 前のテストの検索結果（新しいキャッシュ）に当たると、提供元へ出ず、予算の断りまで進まない
    spies.push(spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async () => ({ response: new Response(webHtml) })) as never));
    exhaust('name:A');
    await expect(runAsCaller('name:A', () => createWebAnchorHints('=LOVE ライブ 予定').webTitles())).rejects.toMatchObject({ reason: 'tenant_budget' });
    spies.pop()?.mockRestore();
    spies.push(spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async () => { throw new Error('network'); }) as never));
    resetYahooCallGate();
    clearYahooSearchCache();
    expect(await createWebAnchorHints('=LOVE ライブ 予定 別').webTitles()).toEqual([]);
  });
});

describe('ブレーカー・時計: 順番に並んだ要求', () => {
  test('ブレーカーが開いたら、順番に並んでいた要求は、間隔を待たずに、順番が来たところで断られる（admit の guard）', async () => {
    const c = blockedClock();
    const budget = smallBudget(100);
    const gate = createYahooGate({ ...c, minIntervalMs: () => 500, queuePolicy: policy(), budget });
    let open = false;
    const guard = () => { if (open) throw new Error('breaker open'); };
    const run = (n: number) => runAsCaller('name:A', () => gate.admit(guard).then(() => n, (e: unknown) => (e as Error).message));
    const results = [run(0), run(1)]; // すぐ通る 1 件と、間隔を待つ 1 件
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let i = 2; i < 6; i++) results.push(run(i)); // 順番に並ぶ 4 件
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    open = true; // 順番に並んだまま、ブレーカーが開く
    await c.releaseAll();
    expect(await Promise.all(results)).toEqual([0, 1, 'breaker open', 'breaker open', 'breaker open', 'breaker open']);
    expect(c.pending()).toBe(0); // 断られた要求は、間隔の待ち（sleep）をしていない
    expect(budget.usedBy('name:A')).toBe(2); // 断られた分の予算は返した
  });

  test('guard が投げたら、順番も手放す（次の要求が進める）', async () => {
    const gate = createYahooGate({ ...clock(), minIntervalMs: () => 500, queuePolicy: policy({ perTenant: 0, total: 0 }), budget: smallBudget(0) });
    await expect(gate.admit(() => { throw new Error('no'); })).rejects.toThrow('no');
    await gate.admit(); // 順番が手放されていれば、待たずに通る
  });

  test('動画の直取得: 順番に並んだ要求は、ブレーカーが開いたあと、間隔 × 件数も待たずに断られる', async () => {
    const videoPage = '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"initialState":{"domainState":{"videoAlgo":{"items":[]}}}}}</script></body></html>';
    spies.push(spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation((async () => ({ response: new Response(videoPage) })) as never));
    process.env.SORA_YAHOO_MIN_INTERVAL_MS = '100';
    const t0 = Date.now();
    const calls = Array.from({ length: 8 }, (_, i) => runAsCaller('name:A', () => searchYahooVideo({ query: `v${i}`, platform: 'youtube', updated: 'week' } as never)).catch((e: unknown) => e));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    tripYahooBreaker();
    const results = await Promise.all(calls);
    expect(Date.now() - t0).toBeLessThan(350);
    expect(results.filter((r) => isYahooRateLimitedError(r)).length).toBeGreaterThanOrEqual(6);
  });

  test('callYahooMcp: 順番に並んだ要求は、ブレーカーが開いたあと、間隔 × 件数も待たずに断られる', async () => {
    fakeSpawn();
    process.env.SORA_YAHOO_MIN_INTERVAL_MS = '100';
    const t0 = Date.now();
    const calls = Array.from({ length: 8 }, (_, i) => runAsCaller('name:A', () => callYahooMcp('yahoo_news_search', { query: `q${i}` })).catch((e: unknown) => e));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    tripYahooBreaker();
    const results = await Promise.all(calls);
    expect(Date.now() - t0).toBeLessThan(350); // 以前は、1 件ずつ 100ms 空けて断られ、700ms かかった
    expect(results.filter((r) => isYahooRateLimitedError(r)).length).toBeGreaterThanOrEqual(6);
  });

  test('時計が戻っても、間隔の待ちは、間隔（500ms）を超えない（順番を握ったまま長く眠って、全員が断られない）', async () => {
    let time = 10_000_000;
    const slept: number[] = [];
    const gate = createYahooGate({ now: () => time, sleep: async (ms) => { slept.push(ms); time += ms; }, minIntervalMs: () => 500, queuePolicy: policy(), budget: smallBudget(0) });
    await gate.admit(); // lastStart = 10,000,000
    time -= 3_600_000; // 時計が 1 時間戻る
    await gate.admit();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeLessThanOrEqual(500);
  });
});
