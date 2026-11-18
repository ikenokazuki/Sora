import { afterEach, describe, expect, test } from 'bun:test';
import { ResourceBusyError } from '../errors.js';
import { type QueuePolicy, SimpleSemaphore } from './fair_queue.js';
import { getSecurityMetrics, resetSecurityMetrics } from './metrics.js';

/**
 * 公平な待ち行列は、ブラウザの枠だけでなく、共有の外部資源（地名の検索・Yahoo・国の情報の提供元・住所データの構築）にも使う（設計 6。穴 25）。
 * 断ったときの文・カウンターの名前・例外の resource が、資源ごとに分かれる。ブラウザの枠は、これまでの文と名前のまま。
 */

const policy = (over: Partial<QueuePolicy> = {}): (() => QueuePolicy) => () => ({ perTenant: 1, total: 1, waitMs: 50, sharePercent: 100, ...over });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const errorOf = async (promise: Promise<unknown>): Promise<ResourceBusyError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ResourceBusyError);
  return error as ResourceBusyError;
};

afterEach(() => resetSecurityMetrics());

describe('資源の名前', () => {
  test('既定はブラウザの枠: 文・カウンター・例外の resource が、これまでどおり', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy({ perTenant: 0 }) });
    const hold = await sem.acquire('A');
    const busy = await errorOf(sem.acquire('A'));
    expect(busy.resource).toBe('browser');
    expect(busy.reason).toBe('tenant_queue_full');
    expect(busy.message).toBe('ブラウザの枠を待つ要求が、この利用者の上限（0 件）に達しています。実行中の要求が終わってから、もう一度試してください');
    expect(getSecurityMetrics().sora_browser_busy_tenant_queue_full_total).toBe(1);
    hold();
  });

  test('地名の検索: 3 つの断り方（利用者ごとの数・全体の数・待ち時間）が、地名の検索の文・カウンター・resource になる', async () => {
    const perTenant = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 0 }) });
    const hold1 = await perTenant.acquire('A');
    const a = await errorOf(perTenant.acquire('A'));
    expect(a).toMatchObject({ resource: 'geocoding', reason: 'tenant_queue_full' });
    expect(a.message).toContain('地名の検索');
    expect(a.message).not.toContain('ブラウザ');
    hold1();

    const total = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 5, total: 0 }) });
    const hold2 = await total.acquire('A');
    const b = await errorOf(total.acquire('B'));
    expect(b).toMatchObject({ resource: 'geocoding', reason: 'queue_full' });
    expect(b.message).toContain('地名の検索');
    hold2();

    const timeout = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 5, total: 5, waitMs: 20 }) });
    const hold3 = await timeout.acquire('A');
    const c = await errorOf(timeout.acquire('B'));
    expect(c).toMatchObject({ resource: 'geocoding', reason: 'queue_timeout' });
    expect(c.message).toContain('地名の検索');
    expect(c.message).not.toContain('ブラウザ');
    hold3();

    const counters = getSecurityMetrics();
    expect(counters.sora_geocoding_busy_tenant_queue_full_total).toBe(1);
    expect(counters.sora_geocoding_busy_queue_full_total).toBe(1);
    expect(counters.sora_geocoding_busy_queue_timeout_total).toBe(1);
    expect(counters.sora_browser_busy_queue_full_total).toBeUndefined();
  });

  const WORDS = { browser: 'ブラウザ', geocoding: '地名の検索', yahoo: 'Yahoo', country_intel: '国の情報', address: '住所データ' } as const;

  test.each(Object.entries(WORDS))('%s: 3 つの断り方（利用者ごとの数・全体の数・待ち時間）の文に、その資源の名前（%s）が入り、ほかの資源の名前は入らない。カウンターもその資源のもの', async (resource, word) => {
    const r = resource as keyof typeof WORDS;
    const perTenant = new SimpleSemaphore(1, { resource: r, policy: policy({ perTenant: 0 }) });
    const hold1 = await perTenant.acquire('A');
    const a = await errorOf(perTenant.acquire('A'));
    hold1();
    const total = new SimpleSemaphore(1, { resource: r, policy: policy({ perTenant: 5, total: 0 }) });
    const hold2 = await total.acquire('A');
    const b = await errorOf(total.acquire('B'));
    hold2();
    const timeout = new SimpleSemaphore(1, { resource: r, policy: policy({ perTenant: 5, total: 5, waitMs: 20 }) });
    const hold3 = await timeout.acquire('A');
    const c = await errorOf(timeout.acquire('B'));
    hold3();
    for (const [error, reason] of [[a, 'tenant_queue_full'], [b, 'queue_full'], [c, 'queue_timeout']] as const) {
      expect(error.resource).toBe(r);
      expect(error.reason).toBe(reason);
      expect(error.message, `${resource}/${reason}`).toContain(word);
      for (const [other, otherWord] of Object.entries(WORDS)) {
        if (other !== resource) expect(error.message, `${resource}/${reason} に ${other} の名前`).not.toContain(otherWord);
      }
      expect(getSecurityMetrics()[`sora_${r}_busy_${reason}_total`], `${resource}/${reason}`).toBe(1);
    }
  });

  test('資源が違えば、数えるカウンターも別（ブラウザの数が、地名の検索の数に混ざらない）', async () => {
    const browser = new SimpleSemaphore(1, { policy: policy({ perTenant: 0 }) });
    const geo = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 0 }) });
    const hold1 = await browser.acquire('A');
    const hold2 = await geo.acquire('A');
    await errorOf(browser.acquire('A'));
    await errorOf(geo.acquire('A'));
    await errorOf(geo.acquire('A'));
    expect(getSecurityMetrics().sora_browser_busy_tenant_queue_full_total).toBe(1);
    expect(getSecurityMetrics().sora_geocoding_busy_tenant_queue_full_total).toBe(2);
    hold1();
    hold2();
    await tick();
  });
});

describe('ResourceBusyError', () => {
  test('resource の既定は browser（これまでの呼び方 new ResourceBusyError(文, 理由, 秒) が変わらない）', () => {
    const error = new ResourceBusyError('x', 'queue_full', 7);
    expect(error.resource).toBe('browser');
    expect(error.retryAfterSec).toBe(7);
  });

  test('resource を渡せる', () => {
    expect(new ResourceBusyError('x', 'tenant_budget', 3, 'yahoo')).toMatchObject({ resource: 'yahoo', reason: 'tenant_budget', retryAfterSec: 3 });
  });
});

describe('待てるかの事前の確認（assertCanWait）', () => {
  test('空きがあれば、投げない（枠は取らない）', () => {
    const sem = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 0, total: 0 }) });
    expect(() => sem.assertCanWait('A')).not.toThrow();
    expect(sem.activeCount).toBe(0);
    expect(sem.pendingCount).toBe(0);
  });

  test('待たされるときで、待てる数に余裕があれば、投げない（待ちには入らない）', async () => {
    const sem = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 1, total: 5 }) });
    const hold = await sem.acquire('A');
    expect(() => sem.assertCanWait('A')).not.toThrow();
    expect(sem.pendingCount).toBe(0);
    hold();
  });

  test('1 人の待てる数が上限なら、acquire と同じ断り（tenant_queue_full）を、待たせずに投げる。カウンターは 1 回', async () => {
    const sem = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 1, total: 5 }) });
    const hold = await sem.acquire('A');
    const waiting = sem.acquire('A');
    const error = (() => { try { sem.assertCanWait('A'); } catch (e) { return e; } })();
    expect(error).toBeInstanceOf(ResourceBusyError);
    expect(error).toMatchObject({ resource: 'geocoding', reason: 'tenant_queue_full' });
    expect(getSecurityMetrics().sora_geocoding_busy_tenant_queue_full_total).toBe(1);
    expect(sem.pendingCount).toBe(1); // 待ちは増えない
    expect(() => sem.assertCanWait('B')).not.toThrow(); // 別の利用者は待てる
    hold();
    (await waiting)();
  });

  test('全体の待てる数が上限なら、queue_full。どちらにも当たるときは、利用者の上限（tenant_queue_full）を先に言う', async () => {
    const sem = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 5, total: 1 }) });
    const hold = await sem.acquire('A');
    const waiting = sem.acquire('A');
    expect(() => sem.assertCanWait('B')).toThrow(expect.objectContaining({ reason: 'queue_full' }));
    const both = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 1, total: 1 }) });
    const hold2 = await both.acquire('A');
    const waiting2 = both.acquire('A');
    expect(() => both.assertCanWait('A')).toThrow(expect.objectContaining({ reason: 'tenant_queue_full' }));
    hold();
    hold2();
    (await waiting)();
    (await waiting2)();
  });

  test('1 人の割合の上限に達していて、空きがあっても待たされる利用者は、待てる数で見る', async () => {
    const sem = new SimpleSemaphore(2, { resource: 'geocoding', policy: policy({ perTenant: 0, total: 5, sharePercent: 50 }) });
    const a1 = await sem.acquire('A'); // 2 枠の 50% = 1 枠が上限
    expect(() => sem.assertCanWait('A')).toThrow(expect.objectContaining({ reason: 'tenant_queue_full' }));
    expect(() => sem.assertCanWait('B')).not.toThrow(); // B は、空きがあるので、すぐ取れる
    a1();
  });

  test('acquire と、答えが食い違わない（事前の確認が通れば、acquire は、断らずに、取るか待つ）', async () => {
    const sem = new SimpleSemaphore(1, { resource: 'geocoding', policy: policy({ perTenant: 2, total: 100 }) });
    const leases: Array<() => void> = [];
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      try {
        sem.assertCanWait('A');
        const pending = sem.acquire('A');
        pending.then((lease) => leases.push(lease));
        results.push('ok');
      } catch {
        results.push('busy');
      }
    }
    expect(results).toEqual(['ok', 'ok', 'ok', 'busy', 'busy', 'busy']); // 実行中 1 + 待ち 2
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    while (leases.length) leases.shift()!();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    while (leases.length) leases.shift()!();
  });
});


describe('heldBy（利用者ごとの、いま持っている枠の数）', () => {
  test('枠を取ると増え、手放すと減る。持っていない利用者は 0。省略は legacy', async () => {
    const sem = new SimpleSemaphore(4, { policy: policy({ perTenant: 10, total: 10 }) });
    expect(sem.heldBy('A')).toBe(0);
    const a1 = await sem.acquire('A');
    const a2 = await sem.acquire('A');
    const b = await sem.acquire('B');
    const legacy = await sem.acquire();
    expect(sem.heldBy('A')).toBe(2);
    expect(sem.heldBy('B')).toBe(1);
    expect(sem.heldBy()).toBe(1);
    a1();
    a1(); // 2 回手放しても、1 回だけ減る
    expect(sem.heldBy('A')).toBe(1);
    a2(); b(); legacy();
    expect([sem.heldBy('A'), sem.heldBy('B'), sem.heldBy()]).toEqual([0, 0, 0]);
  });
});
