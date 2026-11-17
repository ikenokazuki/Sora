import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ResourceBusyError } from '../../errors.js';
import { runAsCaller } from '../../security/caller.js';
import type { QueuePolicy } from '../../security/fair_queue.js';
import { getSecurityMetrics, resetSecurityMetrics } from '../../security/metrics.js';
import { TenantBudget } from '../../security/tenant_budget.js';
import { createProviderHttpGate, fetchProviderResponse, providerHttpGate, providerHttpQueuePolicy, resetProviderHttpState } from './provider_http.js';
import { ProviderHttpError } from './provider_registry.js';

/**
 * 国の情報の提供元への取得の順番・予算（設計 6。穴 25）。
 * 以前は、同時 4 件の順番が全体で 1 本の先入れ先出しで、待つ数にも待ち時間にも上限が無く（A が 80 件を並べたあとの B の 1 件が 2037 ms 待った）、
 * 待っている間に取得を中止しても（signal）順番から外れず、利用者ごとの予算も無かった。
 */

const SAVED_ISOLATION = process.env.SORA_ISOLATION;
beforeEach(() => {
  delete process.env.SORA_ISOLATION;
  resetProviderHttpState();
  resetSecurityMetrics();
});
afterEach(() => {
  if (SAVED_ISOLATION === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = SAVED_ISOLATION;
  resetProviderHttpState();
});

const policy = (over: Partial<QueuePolicy> = {}): (() => QueuePolicy) => () => ({ perTenant: 100, total: 1000, waitMs: 5000, sharePercent: 100, ...over });
const smallBudget = (perWindow: number) => new TenantBudget({ resource: 'country_intel', policy: () => ({ perWindow, windowMs: 60_000 }) });
const ok = (): Response => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 手で終わらせるまで止まる fetch。started は、実際に提供元へ出した順 */
function controlled() {
  const started: string[] = [];
  const pending: Array<{ url: string; finish: () => void }> = [];
  const fetchFn = (url: string): Promise<Response> => {
    started.push(url);
    return new Promise<Response>((resolve) => { pending.push({ url, finish: () => resolve(ok()) }); });
  };
  return {
    fetchFn,
    started,
    /** 出ている取得のうち、url のものを終わらせる */
    async finish(url: string) {
      const index = pending.findIndex((entry) => entry.url === url);
      if (index < 0) throw new Error('not pending: ' + url);
      pending.splice(index, 1)[0].finish();
      await tick();
    },
  };
}

type Gate = ReturnType<typeof createProviderHttpGate>;
const caller = (gate: Gate, fetchFn: (url: string) => Promise<Response>) =>
  (tenant: string, url: string, over: Partial<Parameters<typeof fetchProviderResponse>[1]> = {}) => {
    const promise = runAsCaller(tenant, () => fetchProviderResponse(url, { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn, gate, ...over }));
    // 順番に残ったまま時間切れ（queue_timeout）になる呼び出しが、あとで走る別のテストに、未処理の拒否として付かないように
    promise.catch(() => undefined);
    return promise;
  };
/** 終わらない Promise で、テストが固まらないように（expect().rejects は、終わらない Promise の時間切れが効かない）。固まったら、失敗にする */
const within = <T>(promise: Promise<T>, ms = 1000): Promise<T> =>
  Promise.race([promise, Bun.sleep(ms).then((): never => { throw new Error('終わらなかった（' + ms + ' ms）'); })]);
const busyOf = async (promise: Promise<unknown>): Promise<ResourceBusyError> => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ResourceBusyError);
  return error as ResourceBusyError;
};

describe('順番は利用者ごとに公平', () => {
  test('A が 10 件を並べたあとの B の 1 件は、A の 1 件の次に動く（先入れ先出しなら、A の 10 件が先）', async () => {
    const c = controlled();
    const gate = createProviderHttpGate({ concurrency: 2, queuePolicy: policy() });
    const call = caller(gate, c.fetchFn);
    const a = Array.from({ length: 10 }, (_, i) => call('name:A', `https://a.example/${i}`));
    await tick();
    const b = call('name:B', 'https://b.example/0');
    await tick();
    expect(c.started).toEqual(['https://a.example/0', 'https://a.example/1']);
    await c.finish('https://a.example/0');
    await c.finish('https://a.example/1');
    expect(c.started.slice(0, 4)).toEqual(['https://a.example/0', 'https://a.example/1', 'https://a.example/2', 'https://b.example/0']);
    for (const url of [...c.started]) await c.finish(url).catch(() => undefined);
    void a; void b;
  });

  test('同時に提供元へ出すのは、gate の同時数まで（既定は 4）', async () => {
    const c = controlled();
    const call = caller(createProviderHttpGate({ queuePolicy: policy() }), c.fetchFn);
    for (let i = 0; i < 10; i++) void call('name:A', `https://a.example/${i}`);
    await tick();
    expect(c.started).toHaveLength(4);
  });
});

describe('待つ数・待ち時間の上限', () => {
  test('1 人が待てる数を超えたら、待たせず tenant_queue_full（国の情報の資源）。ほかの利用者は待てる。提供元には出ない', async () => {
    const c = controlled();
    const gate = createProviderHttpGate({ concurrency: 1, queuePolicy: policy({ perTenant: 2 }) });
    const call = caller(gate, c.fetchFn);
    void call('name:A', 'https://a.example/0');
    void call('name:A', 'https://a.example/1');
    void call('name:A', 'https://a.example/2');
    await tick();
    const error = await busyOf(call('name:A', 'https://a.example/3'));
    expect(error).toMatchObject({ reason: 'tenant_queue_full', resource: 'country_intel' });
    expect(error.message).toContain('国の情報の取得の順番');
    void call('name:B', 'https://b.example/0');
    await tick();
    expect(gate.queue.pendingCount).toBe(3);
    expect(c.started).toEqual(['https://a.example/0']);
    expect(getSecurityMetrics()['sora_country_intel_busy_tenant_queue_full_total']).toBe(1);
  });

  test('全体で待てる数を超えたら、queue_full', async () => {
    const c = controlled();
    const gate = createProviderHttpGate({ concurrency: 1, queuePolicy: policy({ total: 2 }) });
    const call = caller(gate, c.fetchFn);
    void call('name:A', 'https://a.example/0');
    void call('name:A', 'https://a.example/1');
    void call('name:B', 'https://b.example/0');
    await tick();
    const error = await busyOf(call('name:C', 'https://c.example/0'));
    expect(error.reason).toBe('queue_full');
    expect(getSecurityMetrics()['sora_country_intel_busy_queue_full_total']).toBe(1);
  });

  test('待ち時間を超えたら、queue_timeout で断る。そのあと枠が空いても、その取得は出ない', async () => {
    const c = controlled();
    const gate = createProviderHttpGate({ concurrency: 1, queuePolicy: policy({ waitMs: 30 }) });
    const call = caller(gate, c.fetchFn);
    void call('name:A', 'https://a.example/0');
    await tick();
    const error = await busyOf(call('name:B', 'https://b.example/0'));
    expect(error.reason).toBe('queue_timeout');
    await c.finish('https://a.example/0');
    expect(c.started).toEqual(['https://a.example/0']);
  });

  test('待っている間に取得を中止（signal）したら、順番から外れ、その理由で失敗する。枠が空いても出ない', async () => {
    const c = controlled();
    const gate = createProviderHttpGate({ concurrency: 1, queuePolicy: policy(), budget: smallBudget(10) });
    const call = caller(gate, c.fetchFn);
    void call('name:A', 'https://a.example/0');
    await tick();
    const controller = new AbortController();
    const waiting = runAsCaller('name:B', () => fetchProviderResponse('https://b.example/0', { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn: c.fetchFn, gate, signal: controller.signal }));
    await tick();
    expect(gate.queue.pendingCount).toBe(1);
    controller.abort(new Error('provider timed out'));
    await expect(within(waiting)).rejects.toThrow('provider timed out');
    expect(gate.queue.pendingCount).toBe(0);
    await c.finish('https://a.example/0');
    expect(c.started).toEqual(['https://a.example/0']);
    expect(gate.budget.usedBy('name:B')).toBe(0);
  });

  test('始めから中止されている取得は、提供元にも順番にも予算にも入らない', async () => {
    const c = controlled();
    const gate = createProviderHttpGate({ queuePolicy: policy(), budget: smallBudget(10) });
    const call = caller(gate, c.fetchFn);
    const controller = new AbortController();
    controller.abort(new Error('already'));
    await expect(within(call('name:A', 'https://a.example/0', { signal: controller.signal }))).rejects.toThrow('already');
    expect(c.started).toEqual([]);
    expect(gate.budget.usedBy('name:A')).toBe(0);
  });
});

describe('1 人の予算', () => {
  test('予算を使い切ったら、待たせず tenant_budget で断る。提供元には出ない。ほかの利用者の予算は減らない', async () => {
    const started: string[] = [];
    const fetchFn = async (url: string) => { started.push(url); return ok(); };
    const gate = createProviderHttpGate({ queuePolicy: policy(), budget: smallBudget(2) });
    const call = caller(gate, fetchFn);
    await call('name:A', 'https://a.example/0');
    await call('name:A', 'https://a.example/1');
    const error = await busyOf(call('name:A', 'https://a.example/2'));
    expect(error).toMatchObject({ reason: 'tenant_budget', resource: 'country_intel' });
    expect(error.message).toContain('国の情報の取得');
    await call('name:B', 'https://b.example/0');
    expect(started).toEqual(['https://a.example/0', 'https://a.example/1', 'https://b.example/0']);
    expect(getSecurityMetrics()['sora_country_intel_busy_tenant_budget_total']).toBe(1);
  });

  test('呼び出しの外（利用者を決めない経路）は legacy として数える', async () => {
    const gate = createProviderHttpGate({ queuePolicy: policy(), budget: smallBudget(1) });
    const fetchFn = async () => ok();
    await fetchProviderResponse('https://x.example/0', { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn, gate });
    expect(gate.budget.usedBy('legacy')).toBe(1);
    const error = await busyOf(fetchProviderResponse('https://x.example/1', { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn, gate }));
    expect(error.reason).toBe('tenant_budget');
  });

  test('待てる数で断った回は、予算を使わない。予算がちょうど尽きていても、断りの理由は待てる数（順番の上限の確認が、予算を使う前）', async () => {
    const c = controlled();
    const gate = createProviderHttpGate({ concurrency: 1, queuePolicy: policy({ perTenant: 1 }), budget: smallBudget(2) });
    const call = caller(gate, c.fetchFn);
    void call('name:A', 'https://a.example/0');
    void call('name:A', 'https://a.example/1');
    await tick();
    const error = await busyOf(call('name:A', 'https://a.example/2'));
    expect(error.reason).toBe('tenant_queue_full');
    expect(gate.budget.usedBy('name:A')).toBe(2);
  });

  test('待ちきれなかった回（待ち時間・中止）は、予算を返す', async () => {
    const c = controlled();
    const gate = createProviderHttpGate({ concurrency: 1, queuePolicy: policy({ waitMs: 20 }), budget: smallBudget(10) });
    const call = caller(gate, c.fetchFn);
    void call('name:A', 'https://a.example/0');
    await tick();
    await busyOf(call('name:B', 'https://b.example/0'));
    expect(gate.budget.usedBy('name:B')).toBe(0);
    expect(gate.budget.usedBy('name:A')).toBe(1);
  });

  test('提供元に出した回は、失敗（HTTP 500・429・通信の失敗）でも、予算を使ったまま', async () => {
    const gate = createProviderHttpGate({ queuePolicy: policy(), budget: smallBudget(10) });
    const statuses = [500, 429, 404];
    for (const [i, status] of statuses.entries()) {
      const fetchFn = async () => new Response('x', { status });
      const error = await fetchProviderResponse(`https://x.example/${i}`, { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn, gate }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderHttpError);
    }
    const network = async () => { throw new TypeError('fetch failed'); };
    await fetchProviderResponse('https://x.example/n', { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn: network, gate }).catch(() => undefined);
    expect(gate.budget.usedBy('legacy')).toBe(4);
  });
});

describe('水準（SORA_ISOLATION）の既定の値', () => {
  test('standard: 待てる数は 1 人 100・全体 300、待ち時間は 30 秒。予算は制限なし', async () => {
    expect(providerHttpQueuePolicy()).toEqual({ perTenant: 100, total: 300, waitMs: 30_000, sharePercent: 100 });
    const fetchFn = async () => ok();
    for (let i = 0; i < 200; i++) await runAsCaller('name:A', () => fetchProviderResponse(`https://x.example/${i}`, { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn }));
  });

  test('strict: 待てる数は 1 人 30・全体 120、待ち時間は 10 秒。予算は 1 分に 120 回（121 回目で断る）', async () => {
    process.env.SORA_ISOLATION = 'strict';
    expect(providerHttpQueuePolicy()).toEqual({ perTenant: 30, total: 120, waitMs: 10_000, sharePercent: 100 });
    const fetchFn = async () => ok();
    for (let i = 0; i < 120; i++) await runAsCaller('name:A', () => fetchProviderResponse(`https://x.example/${i}`, { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn }));
    const error = await busyOf(runAsCaller('name:A', () => fetchProviderResponse('https://x.example/over', { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn })));
    expect(error.reason).toBe('tenant_budget');
    await runAsCaller('name:B', () => fetchProviderResponse('https://x.example/b', { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn }));
  });

  test('strict の予算の窓は 1 分: 45 秒では使い切ったまま（あと 15 秒）、61 秒たつと通る', async () => {
    process.env.SORA_ISOLATION = 'strict';
    let time = 1_000_000;
    const gate = createProviderHttpGate({ now: () => time });
    const fetchFn = async () => ok();
    const one = (name: string) => runAsCaller('name:A', () => fetchProviderResponse(`https://x.example/${name}`, { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn, gate }));
    for (let i = 0; i < 120; i++) await one(String(i));
    time += 45_000;
    const error = await busyOf(one('over'));
    expect(error.reason).toBe('tenant_budget');
    expect(error.retryAfterSec).toBe(15);
    time += 16_000;
    await one('later');
  });

  test('resetProviderHttpState は、予算・順番・ホストごとの間隔を最初に戻す', async () => {
    process.env.SORA_ISOLATION = 'strict';
    const fetchFn = async () => ok();
    for (let i = 0; i < 120; i++) await fetchProviderResponse(`https://x.example/${i}`, { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn });
    expect(providerHttpGate.budget.usedBy('legacy')).toBe(120);
    // 順番: 同時数（4）を握ったまま、止まった取得を残す
    const stuck = () => new Promise<Response>(() => undefined);
    for (let i = 0; i < 4; i++) runAsCaller('name:S', () => fetchProviderResponse(`https://stuck.example/${i}`, { sourceId: 's', timeoutMs: 60_000, format: 'json', fetchFn: stuck })).catch(() => undefined);
    await tick();
    expect(providerHttpGate.queue.activeCount).toBe(4);
    // 間隔: 同じホストへ 1000ms 空ける印をつける
    let t = 0;
    const slept: number[] = [];
    const clock = { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, minIntervalMs: 1000 };
    await fetchProviderResponse('https://spaced.example/0', { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn, gate: createProviderHttpGate(), ...clock });
    resetProviderHttpState();
    expect(providerHttpGate.budget.usedBy('legacy')).toBe(0);
    expect(providerHttpGate.queue.activeCount).toBe(0);
    await fetchProviderResponse('https://spaced.example/1', { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn, gate: createProviderHttpGate(), ...clock });
    expect(slept).toEqual([]);
    await fetchProviderResponse('https://x.example/again', { sourceId: 's', timeoutMs: 5000, format: 'json', fetchFn });
  });
});
