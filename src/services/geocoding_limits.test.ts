import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearCache } from '../cache.js';
import { ResourceBusyError } from '../errors.js';
import { runAsCaller } from '../security/caller.js';
import type { QueuePolicy } from '../security/fair_queue.js';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { TenantBudget } from '../security/tenant_budget.js';
import { createGeocoder, nominatimQueuePolicy } from './geocoding.js';

/**
 * 地名の検索（Nominatim）の順番と予算（設計 6。穴 25）。
 * 以前は、全体で 1 本の直列の列（promise の鎖）で、待つ数にも待つ時間にも上限が無く、先に大量に並べた利用者の後ろで、ほかの利用者が全部が終わるまで待った
 * （main の 91c8fa84 で実測: A が 30 件のあとに並んだ B は、仮想の時計で 33 秒待った。3000 件を並べても全部受け付けられ、55 分かかる）。
 */

const hit = [{ display_name: '東京都渋谷区神宮前 原宿', lat: '35.669968', lon: '139.709008', address: { 'ISO3166-2-lvl4': 'JP-13' } }];
const ok = () => Response.json(hit);
const noLocal = async () => null;

const policy = (over: Partial<QueuePolicy> = {}): (() => QueuePolicy) => () => ({ perTenant: 100, total: 1000, waitMs: 5000, sharePercent: 100, ...over });
const SAVED_ISOLATION = process.env.SORA_ISOLATION;

beforeEach(() => clearCache());
afterEach(() => {
  resetSecurityMetrics();
  if (SAVED_ISOLATION === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = SAVED_ISOLATION;
});

/** 仮想の時計と、手で進める sleep（間隔を空ける待ちが、すぐ終わる） */
function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

describe('公平な順番', () => {
  test('A が先に大量に並べても、B の 1 件は、A の全部の後ろにならない（利用者を順番に回す）', async () => {
    const order: string[] = [];
    const geocode = createGeocoder({
      ...clock(),
      local: noLocal,
      queuePolicy: policy(),
      fetchFn: async (url) => { order.push(new URL(url).searchParams.get('q')!); return ok(); },
    });
    const a = ['a1', 'a2', 'a3', 'a4', 'a5'].map((q) => runAsCaller('name:A', () => geocode(q, { noCache: true })));
    const b = runAsCaller('name:B', () => geocode('b1', { noCache: true }));
    await Promise.all([...a, b]);
    expect(order).toEqual(['a1', 'a2', 'b1', 'a3', 'a4', 'a5']);
  });

  test('利用者が 1 人（呼び出しの範囲の外）なら、並べた順（これまでどおり）', async () => {
    const order: string[] = [];
    const geocode = createGeocoder({
      ...clock(),
      local: noLocal,
      queuePolicy: policy(),
      fetchFn: async (url) => { order.push(new URL(url).searchParams.get('q')!); return ok(); },
    });
    await Promise.all(['x1', 'x2', 'x3'].map((q) => geocode(q, { noCache: true })));
    expect(order).toEqual(['x1', 'x2', 'x3']);
  });

  test('間隔（1.1 秒）は、これまでどおり、利用者をまたいで共有する（宛先を守るため）', async () => {
    const c = clock();
    const starts: Array<{ q: string; at: number }> = [];
    const geocode = createGeocoder({
      ...c,
      local: noLocal,
      queuePolicy: policy(),
      fetchFn: async (url) => { starts.push({ q: new URL(url).searchParams.get('q')!, at: c.now() }); return ok(); },
    });
    await Promise.all([
      runAsCaller('name:A', () => geocode('a1', { noCache: true })),
      runAsCaller('name:B', () => geocode('b1', { noCache: true })),
      runAsCaller('name:C', () => geocode('c1', { noCache: true })),
    ]);
    expect(starts).toEqual([{ q: 'a1', at: 0 }, { q: 'b1', at: 1100 }, { q: 'c1', at: 2200 }]);
  });
});

describe('同じ語を別の利用者が頼む（取得をまとめるのは、利用者ごと）', () => {
  const smallBudget = (perWindow: number) => new TenantBudget({ resource: 'geocoding', policy: () => ({ perWindow, windowMs: 60_000 }) });

  test('A の予算切れの断りが、同じ語を同時に頼んだ B に返らない。B は B の予算で動く', async () => {
    let calls = 0;
    const budget = smallBudget(1);
    const geocode = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy(), budget, fetchFn: async () => { calls++; return ok(); } });
    await runAsCaller('name:A', () => geocode('先に使う', { noCache: true })); // A の予算を使い切る
    const [a, b] = await Promise.allSettled([
      runAsCaller('name:A', () => geocode('原宿', { noCache: true })),
      runAsCaller('name:B', () => geocode('原宿', { noCache: true })),
    ]);
    expect(a.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason).toMatchObject({ reason: 'tenant_budget' });
    expect(b.status).toBe('fulfilled');
    expect(calls).toBe(2); // 先に使った 1 回と、B の 1 回
  });

  test('別の利用者が先に並べた同じ語に、B が相乗りして、A の列の末尾に並ばない（B 自身の列で、公平な順に動く）', async () => {
    const order: string[] = [];
    const geocode = createGeocoder({
      ...clock(),
      local: noLocal,
      queuePolicy: policy(),
      fetchFn: async (url) => { order.push(new URL(url).searchParams.get('q')!); return ok(); },
    });
    const run = (tenant: string, q: string) => runAsCaller(tenant, () => geocode(q, { noCache: true }));
    const a = ['a0', 'a1', 'a2', 'a3', 'a4', '人気'].map((q) => run('name:A', q));
    const b = run('name:B', '人気');
    await Promise.all([...a, b]);
    // A: a0（すぐ）→ 待ち a1 a2 a3 a4 人気。B: 人気 だけ。順番は A と B を交互に回す。B の 人気 は、A の人気の後ろではない
    expect(order.indexOf('人気')).toBe(2);
    expect(order.filter((q) => q === '人気')).toHaveLength(2); // 利用者ごとに 1 回ずつ
  });

  test('同じ利用者どうしの同じ語は、これまでどおり 1 回にまとまる', async () => {
    let calls = 0;
    const geocode = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy(), fetchFn: async () => { calls++; return ok(); } });
    await Promise.all([1, 2, 3].map(() => runAsCaller('name:A', () => geocode('原宿', { noCache: true }))));
    expect(calls).toBe(1);
  });

  test('結果のキャッシュは、利用者をまたいで共有する（A が引いた語を、あとの B は提供元へ出さずに得る）', async () => {
    let calls = 0;
    const geocode = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy(), fetchFn: async () => { calls++; return ok(); } });
    await runAsCaller('name:A', () => geocode('原宿'));
    await runAsCaller('name:B', () => geocode('原宿'));
    expect(calls).toBe(1);
  });
});

describe('待つ数と待ち時間の上限', () => {
  /** 最初の 1 件の取得を止めておく（順番を握ったままにする）。release で放す */
  function stuckGeocoder(queuePolicy: () => QueuePolicy, budget?: TenantBudget) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const geocode = createGeocoder({
      ...clock(),
      local: noLocal,
      queuePolicy,
      ...(budget ? { budget } : {}),
      fetchFn: async () => { calls++; if (calls === 1) await gate; return ok(); },
    });
    return { geocode, release, calls: () => calls };
  }

  test('1 人が待てる数を超えたら、待たせずに断る（tenant_queue_full）。別の利用者は待てる', async () => {
    const { geocode, release } = stuckGeocoder(policy({ perTenant: 2 }));
    const hold = runAsCaller('name:A', () => geocode('a0', { noCache: true }));
    await Promise.resolve();
    const w1 = runAsCaller('name:A', () => geocode('a1', { noCache: true }));
    const w2 = runAsCaller('name:A', () => geocode('a2', { noCache: true }));
    const error = await runAsCaller('name:A', () => geocode('a3', { noCache: true })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceBusyError);
    expect(error).toMatchObject({ resource: 'geocoding', reason: 'tenant_queue_full' });
    const wb = runAsCaller('name:B', () => geocode('b1', { noCache: true }));
    release();
    await Promise.all([hold, w1, w2, wb]);
    expect(getSecurityMetrics().sora_geocoding_busy_tenant_queue_full_total).toBe(1);
  });

  test('全体で待てる数を超えたら、待たせずに断る（queue_full）', async () => {
    const { geocode, release } = stuckGeocoder(policy({ perTenant: 5, total: 2 }));
    const hold = runAsCaller('name:A', () => geocode('a0', { noCache: true }));
    await Promise.resolve();
    const w1 = runAsCaller('name:A', () => geocode('a1', { noCache: true }));
    const w2 = runAsCaller('name:B', () => geocode('b1', { noCache: true }));
    const error = await runAsCaller('name:C', () => geocode('c1', { noCache: true })).catch((e: unknown) => e);
    expect(error).toMatchObject({ resource: 'geocoding', reason: 'queue_full' });
    release();
    await Promise.all([hold, w1, w2]);
  });

  test('順番が来るまでの待ちに時間の上限がある（queue_timeout）。待ちを外れた要求は、あとで取得を出さない', async () => {
    const { geocode, release, calls } = stuckGeocoder(policy({ waitMs: 20 }));
    const hold = runAsCaller('name:A', () => geocode('a0', { noCache: true }));
    await Promise.resolve();
    const error = await runAsCaller('name:B', () => geocode('b1', { noCache: true })).catch((e: unknown) => e);
    expect(error).toMatchObject({ resource: 'geocoding', reason: 'queue_timeout' });
    release();
    await hold;
    expect(calls()).toBe(1); // 待ちを外れた b1 は、提供元へ出していない
    expect(getSecurityMetrics().sora_geocoding_busy_queue_timeout_total).toBe(1);
  });

  test('取得が失敗しても順番は戻り、次の要求が進む', async () => {
    let n = 0;
    const geocode = createGeocoder({
      ...clock(),
      local: noLocal,
      queuePolicy: policy(),
      fetchFn: async () => { n++; if (n === 1) throw new Error('network'); return ok(); },
    });
    const first = geocode('f1', { noCache: true }).catch((e: unknown) => e);
    const second = geocode('f2', { noCache: true });
    expect(await first).toBeInstanceOf(Error);
    expect((await second).source).toBe('nominatim');
  });
});

describe('既定の上限は、水準（SORA_ISOLATION）から読む', () => {
  test('順番の方針は、表の値をそのまま写す（1 人・全体・待ち時間。割合は 1 つの枠なので 100）', () => {
    process.env.SORA_ISOLATION = 'strict';
    expect(nominatimQueuePolicy()).toEqual({ perTenant: 5, total: 30, waitMs: 20_000, sharePercent: 100 });
    process.env.SORA_ISOLATION = 'standard';
    expect(nominatimQueuePolicy()).toEqual({ perTenant: 100, total: 300, waitMs: 120_000, sharePercent: 100 });
  });

  test('既定の予算の窓は 1 分: 59 秒後はまだ断られ、60 秒後に通る（strict）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    const realNow = Date.now;
    let at = 1_000_000;
    Date.now = () => at;
    try {
      const geocode = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy(), fetchFn: async () => ok() });
      for (let i = 0; i < 20; i++) await runAsCaller('name:A', () => geocode(`w${i}`, { noCache: true }));
      at += 59_999;
      await expect(runAsCaller('name:A', () => geocode('w20', { noCache: true }))).rejects.toMatchObject({ reason: 'tenant_budget' });
      at += 1;
      await runAsCaller('name:A', () => geocode('w21', { noCache: true }));
    } finally {
      Date.now = realNow;
    }
  });

  test('strict: 1 人が待てるのは 5 件。6 件目を断る', async () => {
    process.env.SORA_ISOLATION = 'strict';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const geocode = createGeocoder({ ...clock(), local: noLocal, fetchFn: async () => { calls++; if (calls === 1) await gate; return ok(); } });
    const run = (q: string) => runAsCaller('name:A', () => geocode(q, { noCache: true }));
    const hold = run('s0');
    await Promise.resolve();
    const waiting = ['s1', 's2', 's3', 's4', 's5'].map(run);
    const error = await run('s6').catch((e: unknown) => e);
    expect(error).toMatchObject({ resource: 'geocoding', reason: 'tenant_queue_full' });
    release();
    await Promise.all([hold, ...waiting]);
  });

  test('standard: 1 人が 100 件並べても断られない（これまでの使い方を止めない）', async () => {
    delete process.env.SORA_ISOLATION;
    const geocode = createGeocoder({ ...clock(), local: noLocal, fetchFn: async () => ok() });
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => runAsCaller('name:A', () => geocode(`p${i}`, { noCache: true }))));
    expect(results).toHaveLength(100);
  });

  test('水準の値が不正なら、緩い側に倒さず、エラー（ほかの上限と同じ）', async () => {
    process.env.SORA_ISOLATION = 'strcit';
    const geocode = createGeocoder({ ...clock(), local: noLocal, fetchFn: async () => ok() });
    await expect(geocode('原宿', { noCache: true })).rejects.toThrow(/SORA_ISOLATION/);
  });
});

describe('利用者ごとの予算（提供元の制限に当たる前に、連打している利用者だけを止める）', () => {
  const smallBudget = (perWindow: number) =>
    new TenantBudget({ resource: 'geocoding', policy: () => ({ perWindow, windowMs: 60_000 }) });

  test('予算を使い切った利用者だけが断られ（tenant_budget）、別の利用者は通る。提供元へ出した回数は、予算の回数まで', async () => {
    let calls = 0;
    const geocode = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy(), budget: smallBudget(2), fetchFn: async () => { calls++; return ok(); } });
    const a = (q: string) => runAsCaller('name:A', () => geocode(q, { noCache: true }));
    await a('a1');
    await a('a2');
    const error = await a('a3').catch((e: unknown) => e);
    expect(error).toMatchObject({ resource: 'geocoding', reason: 'tenant_budget' });
    expect((error as ResourceBusyError).retryAfterSec).toBeGreaterThan(0);
    await runAsCaller('name:B', () => geocode('b1', { noCache: true }));
    expect(calls).toBe(3); // A が 2 回、B が 1 回。断られた a3 は提供元へ出していない
  });

  test('キャッシュの命中は、予算を使わない', async () => {
    let calls = 0;
    const geocode = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy(), budget: smallBudget(1), fetchFn: async () => { calls++; return ok(); } });
    for (let i = 0; i < 5; i++) await runAsCaller('name:A', () => geocode('原宿'));
    expect(calls).toBe(1);
  });

  test('ローカルで解決した分は、予算を使わない', async () => {
    const local = async () => ({ address: '東京都', lat: 35, lon: 139, source: 'abr' as const, needsVerification: false });
    let calls = 0;
    const geocode = createGeocoder({ ...clock(), local, queuePolicy: policy(), budget: smallBudget(1), fetchFn: async () => { calls++; return ok(); } });
    for (let i = 0; i < 5; i++) await runAsCaller('name:A', () => geocode(`丁目${i}`, { noCache: true }));
    expect(calls).toBe(0);
  });

  test('国土地理院だけで解決した住所は、予算を使わない（Nominatim へ出さない）', async () => {
    const gsi = () => Response.json([{ geometry: { coordinates: [139.7, 35.6], type: 'Point' }, properties: { title: '東京都千代田区永田町1-7-1' } }]);
    const hosts: string[] = [];
    const geocode = createGeocoder({
      ...clock(), local: noLocal, queuePolicy: policy(), budget: smallBudget(1),
      fetchFn: async (url) => { hosts.push(new URL(url).hostname); return gsi(); },
    });
    for (let i = 0; i < 3; i++) await runAsCaller('name:A', () => geocode(`東京都千代田区永田町1-7-${i + 1}`, { noCache: true }));
    expect(hosts.every((host) => host === 'msearch.gsi.go.jp')).toBe(true);
  });

  test('既定の予算は水準から読む: strict は 1 分に 20 回、standard は制限なし', async () => {
    process.env.SORA_ISOLATION = 'strict';
    const strict = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy(), fetchFn: async () => ok() });
    for (let i = 0; i < 20; i++) await runAsCaller('name:A', () => strict(`q${i}`, { noCache: true }));
    await expect(runAsCaller('name:A', () => strict('q20', { noCache: true }))).rejects.toMatchObject({ reason: 'tenant_budget' });
    delete process.env.SORA_ISOLATION;
    const standard = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy(), fetchFn: async () => ok() });
    for (let i = 0; i < 60; i++) await runAsCaller('name:A', () => standard(`r${i}`, { noCache: true }));
  });

  test('順番で断られた回（待てる数の上限・待ち時間の上限）は、予算を使わない。Retry-After どおりに再試行して、自分で締め出されない', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const budget = smallBudget(3);
    const geocode = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy({ perTenant: 1 }), budget, fetchFn: async () => { calls++; if (calls === 1) await gate; return ok(); } });
    const a = (q: string) => runAsCaller('name:A', () => geocode(q, { noCache: true }));
    const hold = a('a0'); // 予算 1 回目。順番を握る
    await Promise.resolve();
    const waiting = a('a1'); // 予算 2 回目。待つ（上限 1 件）
    // 待てる数の上限で断られる回を、何度出しても、予算は減らない（同時に出しても、予算の断りに化けない）
    for (let i = 0; i < 10; i++) {
      await expect(a(`over${i}`)).rejects.toMatchObject({ reason: 'tenant_queue_full' });
    }
    const burst = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => a(`burst${i}`)));
    expect(burst.map((r) => (r.status === 'rejected' ? (r.reason as ResourceBusyError).reason : 'ok'))).toEqual(Array(10).fill('tenant_queue_full'));
    release();
    await Promise.all([hold, waiting]);
    await a('a2'); // 予算 3 回目。まだ使える
    await expect(a('a3')).rejects.toMatchObject({ reason: 'tenant_budget' }); // 提供元へ出した 3 回で使い切った
    expect(calls).toBe(3);
  });

  test('待ちきれなかった回（queue_timeout）も、予算を使わない', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const geocode = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy({ waitMs: 20 }), budget: smallBudget(1), fetchFn: async () => { calls++; if (calls === 1) await gate; return ok(); } });
    const hold = runAsCaller('name:A', () => geocode('a0', { noCache: true }));
    await Promise.resolve();
    for (let i = 0; i < 3; i++) {
      await expect(runAsCaller('name:B', () => geocode(`b${i}`, { noCache: true }))).rejects.toMatchObject({ reason: 'queue_timeout' });
    }
    release();
    await hold;
    await runAsCaller('name:B', () => geocode('b-ok', { noCache: true })); // B の予算 1 回は、まだ残っている
  });

  test('断られた予算は、queue の断りより先（待たせずに断る）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const geocode = createGeocoder({ ...clock(), local: noLocal, queuePolicy: policy(), budget: smallBudget(1), fetchFn: async () => { calls++; if (calls === 1) await gate; return ok(); } });
    const hold = runAsCaller('name:A', () => geocode('a0', { noCache: true }));
    await Promise.resolve();
    const t0 = Date.now();
    await expect(runAsCaller('name:A', () => geocode('a1', { noCache: true }))).rejects.toMatchObject({ reason: 'tenant_budget' });
    expect(Date.now() - t0).toBeLessThan(500); // 順番を待たずに断る
    release();
    await hold;
  });
});
