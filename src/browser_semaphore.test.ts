import { afterEach, describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { type Lease, type QueuePolicy, SimpleSemaphore } from './browser_semaphore.js';
import { ResourceBusyError } from './errors.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';

/**
 * ブラウザの枠（設計 6。穴 25）。tenant ごとに公平に枠を渡し、待つ数と待つ時間に上限を設け、超えたら ResourceBusyError（REST では 429）。
 * 以前は、全体で 1 本の先入れ先出しの列で、待つ数にも時間にも上限が無く、先に大量に並べた利用者の後ろで、ほかの利用者が、その全部が終わるまで待たされた
 * （main の 2e370bb で実測: 枠 1・A が 10 件のあとに並んだ B は、1567ms 待った。5 万件を待たせても断られず、枠を返さない呼び出しがあると、待つ側は永久に待った）。
 */

const policy = (over: Partial<QueuePolicy> = {}): (() => QueuePolicy) => () => ({ perTenant: 100, total: 1000, waitMs: 5000, sharePercent: 100, ...over });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** 待っている要求の全部が、枠を得て、すぐ手放すまで待つ（枠が 1 つのとき、全員が同時に持つことはないので、得た順に手放す） */
const finish = (waiting: Array<Promise<Lease>>) => Promise.all(waiting.map((promise) => promise.then((lease) => lease())));
const busyOf = async (promise: Promise<unknown>): Promise<ResourceBusyError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ResourceBusyError);
  return error as ResourceBusyError;
};

afterEach(() => resetSecurityMetrics());

describe('同時に持てる数', () => {
  test('max まで同時に持て、超えた分は、手放されるまで待つ。方針を渡さなければ、待つ数も時間も無制限', async () => {
    const sem = new SimpleSemaphore(2);
    expect(sem.max).toBe(2);
    const a = await sem.acquire('t');
    const b = await sem.acquire('t');
    expect(sem.activeCount).toBe(2);
    let thirdGot = false;
    const third = sem.acquire('t').then((lease) => {
      thirdGot = true;
      return lease;
    });
    await tick();
    expect(thirdGot).toBe(false);
    expect(sem.pendingCount).toBe(1);
    a();
    const c = await third;
    expect(sem.activeCount).toBe(2);
    expect(sem.pendingCount).toBe(0);
    b();
    c();
    expect(sem.activeCount).toBe(0);
  });

  test('tenant を渡さない呼び出しは、1 つの tenant（legacy）として数える', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy({ perTenant: 1 }) });
    const hold = await sem.acquire();
    void sem.acquire(); // 待ち 1 件（legacy の上限）
    const busy = await busyOf(sem.acquire('legacy'));
    expect(busy.reason).toBe('tenant_queue_full');
    hold();
  });

  test('手放す関数は、2 回呼んでも、1 回分だけ（もう 1 つの枠を空けない）', async () => {
    const sem = new SimpleSemaphore(1);
    const a = await sem.acquire('t');
    const waiting = sem.acquire('t');
    a();
    a();
    const b = await waiting;
    let thirdGot = false;
    const third = sem.acquire('t').then((lease) => {
      thirdGot = true;
      return lease;
    });
    await tick();
    expect(thirdGot).toBe(false);
    expect(sem.activeCount).toBe(1);
    b();
    (await third)();
  });

  test('手放した直後の同じ tick の acquire は、先に待っていた要求から枠を横取りしない（枠は、手放した時点で、待っていた要求に渡る）', async () => {
    const sem = new SimpleSemaphore(1);
    const a = await sem.acquire('a');
    const waiting = sem.acquire('b');
    a();
    expect(sem.activeCount).toBe(1); // b に、もう渡っている
    let cGot = false;
    const c = sem.acquire('c').then((lease) => {
      cGot = true;
      return lease;
    });
    await tick();
    expect(cGot).toBe(false);
    expect(sem.activeCount).toBe(1);
    (await waiting)();
    (await c)();
    expect(sem.activeCount).toBe(0);
  });
});

describe('公平さ（tenant ごとの順番）', () => {
  test('同じ tenant の中は、待った順', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy() });
    const hold = await sem.acquire('A');
    const order: string[] = [];
    const run = (label: string) =>
      sem.acquire('A').then((lease) => {
        order.push(label);
        lease();
      });
    const all = [run('1'), run('2'), run('3')];
    hold();
    await Promise.all(all);
    expect(order).toEqual(['1', '2', '3']);
  });

  test('先に大量に並べた tenant の後ろで、ほかの tenant が、その全部が終わるまで待たされない（順番に 1 つずつ）。枠の数は超えない', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy() });
    const hold = await sem.acquire('A');
    const order: string[] = [];
    let peak = 0;
    const run = (tenant: string, label: string) =>
      sem.acquire(tenant).then((lease) => {
        order.push(label);
        peak = Math.max(peak, sem.activeCount);
        lease();
      });
    const all = [run('A', 'A1'), run('A', 'A2'), run('A', 'A3'), run('B', 'B1'), run('B', 'B2')];
    hold();
    await Promise.all(all);
    // 以前（全体で 1 本の列）は A1 A2 A3 B1 B2。B1 は 4 番目だった
    expect(order).toEqual(['A1', 'B1', 'A2', 'B2', 'A3']);
    expect(peak).toBe(1); // 空きが無いのに渡さない
  });

  test('待ち始めた順に、tenant を回す（3 つの tenant）', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy() });
    const hold = await sem.acquire('X');
    const order: string[] = [];
    const run = (tenant: string, label: string) =>
      sem.acquire(tenant).then((lease) => {
        order.push(label);
        lease();
      });
    const all = [run('A', 'A1'), run('B', 'B1'), run('C', 'C1'), run('A', 'A2'), run('B', 'B2'), run('A', 'A3')];
    hold();
    await Promise.all(all);
    expect(order).toEqual(['A1', 'B1', 'C1', 'A2', 'B2', 'A3']);
  });

  test('待ちが無くなった tenant は、回す順から外れ、あとでまた待てば、最後尾から', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy() });
    const hold = await sem.acquire('X');
    const order: string[] = [];
    const run = (tenant: string, label: string) =>
      sem.acquire(tenant).then((lease) => {
        order.push(label);
        lease();
      });
    const first = [run('A', 'A1'), run('B', 'B1')];
    hold();
    await Promise.all(first);
    const hold2 = await sem.acquire('X');
    const second = [run('B', 'B2'), run('A', 'A2')];
    hold2();
    await Promise.all(second);
    expect(order).toEqual(['A1', 'B1', 'B2', 'A2']);
  });
});

describe('tenant が同時に持てる枠の割合', () => {
  test('割合を超える枠は、空きがあっても持てず、ほかの tenant はすぐ持てる。枠が戻ると、待っていた要求が得る', async () => {
    const sem = new SimpleSemaphore(4, { policy: policy({ sharePercent: 50 }) }); // 1 つの tenant は 2 枠まで
    const a1 = await sem.acquire('A');
    const a2 = await sem.acquire('A');
    let a3Got = false;
    const a3 = sem.acquire('A').then((lease) => {
      a3Got = true;
      return lease;
    });
    await tick();
    expect(a3Got).toBe(false);
    expect(sem.activeCount).toBe(2); // 空きが 2 つあっても、A は 3 つ目を持てない
    expect(sem.pendingCount).toBe(1);
    const b1 = await sem.acquire('B'); // B は、A に食われず、すぐ持てる
    const b2 = await sem.acquire('B');
    expect(sem.activeCount).toBe(4);
    a1();
    const a3Lease = await a3;
    expect(a3Got).toBe(true);
    for (const lease of [a2, b1, b2, a3Lease]) lease();
    expect(sem.activeCount).toBe(0);
  });

  test('割合から出る数は切り捨てで、最低 1 枠（枠が 1 つのときも、割合が小さくても、使える）', async () => {
    const one = new SimpleSemaphore(1, { policy: policy({ sharePercent: 10 }) });
    (await one.acquire('A'))();
    const three = new SimpleSemaphore(3, { policy: policy({ sharePercent: 50 }) }); // floor(1.5) = 1
    const a = await three.acquire('A');
    let secondGot = false;
    const second = three.acquire('A').then((lease) => {
      secondGot = true;
      return lease;
    });
    await tick();
    expect(secondGot).toBe(false);
    a();
    (await second)();
  });

  test('割合が 100 なら、1 つの tenant が全部の枠を使える（standard の振る舞い）', async () => {
    const sem = new SimpleSemaphore(3, { policy: policy({ sharePercent: 100 }) });
    const leases = await Promise.all([sem.acquire('A'), sem.acquire('A'), sem.acquire('A')]);
    expect(sem.activeCount).toBe(3);
    for (const lease of leases) lease();
  });

  test('枠に割合の上限があるせいで、待っている要求が、ほかの tenant の枠を待たせない', async () => {
    const sem = new SimpleSemaphore(2, { policy: policy({ sharePercent: 50 }) }); // 1 つの tenant は 1 枠まで
    const a1 = await sem.acquire('A');
    let a2Got = false;
    const a2 = sem.acquire('A').then((lease) => {
      a2Got = true;
      return lease;
    });
    const b = await sem.acquire('B'); // 空いている 1 枠は、上限に達した A でなく、B に渡る
    await tick();
    expect(a2Got).toBe(false);
    b();
    await tick();
    expect(a2Got).toBe(false); // B が戻っても、A は 1 枠（上限）のまま。待ちは続く
    a1();
    (await a2)();
  });
});

describe('待つ数の上限', () => {
  test('1 つの tenant が待てる数を超えたら、待たせずに断る（ResourceBusyError。tenant_queue_full）。ほかの tenant は待てる', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy({ perTenant: 2, total: 100 }) });
    const hold = await sem.acquire('A');
    const w1 = sem.acquire('A');
    const w2 = sem.acquire('A');
    const busy = await busyOf(sem.acquire('A'));
    expect(busy.reason).toBe('tenant_queue_full');
    expect(busy.retryAfterSec).toBeGreaterThan(0);
    expect(busy.message).toContain('2');
    expect(sem.pendingCount).toBe(2);
    const wb = sem.acquire('B');
    expect(sem.pendingCount).toBe(3);
    expect(getSecurityMetrics().sora_browser_busy_tenant_queue_full_total).toBe(1);
    hold();
    await finish([w1, w2, wb]);
  });

  test('全体で待てる数を超えたら、待たせずに断る（queue_full）', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy({ perTenant: 5, total: 3 }) });
    const hold = await sem.acquire('A');
    const waiting = [sem.acquire('A'), sem.acquire('A'), sem.acquire('B')];
    const busy = await busyOf(sem.acquire('C'));
    expect(busy.reason).toBe('queue_full');
    expect(busy.message).toContain('3');
    expect(sem.pendingCount).toBe(3);
    expect(getSecurityMetrics().sora_browser_busy_queue_full_total).toBe(1);
    hold();
    await finish(waiting);
  });

  test('どちらの上限にも当たるときは、その tenant 自身の上限（tenant_queue_full）を先に言う', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy({ perTenant: 1, total: 1 }) });
    const hold = await sem.acquire('A');
    const waiting = sem.acquire('A');
    expect((await busyOf(sem.acquire('A'))).reason).toBe('tenant_queue_full');
    expect((await busyOf(sem.acquire('B'))).reason).toBe('queue_full');
    hold();
    (await waiting)();
  });

  test('空きがあるときは、待つ数の上限に関わらず、すぐ得る', async () => {
    const sem = new SimpleSemaphore(2, { policy: policy({ perTenant: 0, total: 0 }) });
    const a = await sem.acquire('A');
    const b = await sem.acquire('A');
    expect(sem.activeCount).toBe(2);
    a();
    b();
  });

  test('方針は、acquire のたびに読む（水準を切り替えた運用・テストに追従する）', async () => {
    let current = policy({ perTenant: 100 })();
    const sem = new SimpleSemaphore(1, { policy: () => current });
    const hold = await sem.acquire('A');
    const first = sem.acquire('A'); // 待てる
    current = { ...current, perTenant: 1 };
    expect((await busyOf(sem.acquire('A'))).reason).toBe('tenant_queue_full');
    hold();
    (await first)();
  });
});

describe('待つ時間の上限', () => {
  test('待ち時間を超えたら断る（queue_timeout）。待ちの数は戻り、諦めた要求には枠を渡さない', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy({ waitMs: 40 }) });
    const hold = await sem.acquire('A');
    const startedAt = performance.now();
    const busy = await busyOf(sem.acquire('B'));
    const waitedMs = performance.now() - startedAt;
    expect(busy.reason).toBe('queue_timeout');
    expect(waitedMs).toBeGreaterThanOrEqual(30);
    expect(waitedMs).toBeLessThan(2000);
    expect(busy.message).toContain('秒');
    expect(sem.pendingCount).toBe(0);
    expect(getSecurityMetrics().sora_browser_busy_queue_timeout_total).toBe(1);
    hold();
    expect(sem.activeCount).toBe(0); // 諦めた B に渡っていない
    (await sem.acquire('B'))(); // 諦めた tenant も、また待てる（回す順が壊れていない）
  });

  test('時間切れになった要求の後ろで待っていた要求は、そのまま待ち続け、枠が空けば得る', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy({ waitMs: 150 }) });
    const hold = await sem.acquire('A');
    const earlyBusy = busyOf(sem.acquire('B'));
    await new Promise((resolve) => setTimeout(resolve, 70));
    const late = sem.acquire('C'); // early より遅く並ぶので、early より 70ms 遅く時間切れになる
    await earlyBusy;
    hold(); // late が時間切れになる前に枠が戻る
    (await late)();
  });

  test('時間内に枠を得た要求は、そのあと時間切れにならない（タイマーを止める）', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy({ waitMs: 30 }) });
    const hold = await sem.acquire('A');
    const waiting = sem.acquire('B');
    hold();
    const lease = await waiting;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(getSecurityMetrics().sora_browser_busy_queue_timeout_total ?? 0).toBe(0);
    expect(sem.activeCount).toBe(1);
    lease();
  });

  test('待ち時間が無限なら、時間切れにしない（方針なしの既定）', async () => {
    const sem = new SimpleSemaphore(1);
    const hold = await sem.acquire('A');
    let settled = false;
    const waiting = sem.acquire('B').then(
      (lease) => {
        settled = true;
        return lease;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    hold();
    const lease = await waiting;
    if (lease) lease();
  });
});

describe('待つのをやめる（AbortSignal）', () => {
  test('待っている間に中止されたら、列から外れ、中止の理由で失敗する。枠は渡らない', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy() });
    const hold = await sem.acquire('A');
    const controller = new AbortController();
    const waiting = sem.acquire('B', { signal: controller.signal });
    expect(sem.pendingCount).toBe(1);
    controller.abort(new Error('cancelled by client'));
    await expect(waiting).rejects.toThrow('cancelled by client');
    expect(sem.pendingCount).toBe(0);
    hold();
    expect(sem.activeCount).toBe(0);
  });

  test('すでに中止された signal では、待たずに失敗する（空きがあっても、枠を取らない）', async () => {
    const sem = new SimpleSemaphore(2, { policy: policy() });
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await expect(sem.acquire('A', { signal: controller.signal })).rejects.toThrow('already cancelled');
    expect(sem.activeCount).toBe(0);
  });

  test('枠を得たあとの中止は、何もしない', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy() });
    const controller = new AbortController();
    const lease = await sem.acquire('A', { signal: controller.signal });
    controller.abort(new Error('late'));
    expect(sem.activeCount).toBe(1);
    lease();
    expect(sem.activeCount).toBe(0);
  });

  test('枠を得た・時間切れになった・中止された、どの場合も、signal にリスナーを残さない（長く生きる signal に、待ちが溜まらない）', async () => {
    const sem = new SimpleSemaphore(1, { policy: policy({ waitMs: 30 }) });
    const listeners = (signal: AbortSignal) => getEventListeners(signal, 'abort').length;

    const granted = new AbortController();
    const hold = await sem.acquire('A');
    const waiting = sem.acquire('B', { signal: granted.signal });
    expect(listeners(granted.signal)).toBe(1); // 待っている間は、中止を聞く
    hold();
    (await waiting)();
    expect(listeners(granted.signal)).toBe(0);

    const timedOut = new AbortController();
    const hold2 = await sem.acquire('A');
    await busyOf(sem.acquire('B', { signal: timedOut.signal }));
    expect(listeners(timedOut.signal)).toBe(0);

    const aborted = new AbortController();
    const waiting2 = sem.acquire('B', { signal: aborted.signal });
    aborted.abort(new Error('stop'));
    await expect(waiting2).rejects.toThrow('stop');
    expect(listeners(aborted.signal)).toBe(0);
    hold2();
  });
});

describe('すべて空いたときの通知（onIdle。使い終わった共有ブラウザの入れ替えに使う）', () => {
  test('最後の 1 つが戻り、待ちも無いときだけ 1 回呼ぶ。ほかが持っている間や、待ちに渡す間は呼ばない', async () => {
    let idle = 0;
    const sem = new SimpleSemaphore(2, { onIdle: () => idle++ });
    const a = await sem.acquire('A');
    const b = await sem.acquire('B');
    a();
    expect(idle).toBe(0);
    b();
    expect(idle).toBe(1);

    const one = new SimpleSemaphore(1, { onIdle: () => idle++ });
    const c = await one.acquire('A');
    const waiting = one.acquire('B');
    c();
    expect(idle).toBe(1); // B に渡った。空いていない
    (await waiting)();
    expect(idle).toBe(2);
  });
});

describe('ResourceBusyError', () => {
  test('Error で、reason と retryAfterSec（秒。既定 5）を持つ', () => {
    const error = new ResourceBusyError('混んでいます', 'queue_full');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ResourceBusyError');
    expect(error.reason).toBe('queue_full');
    expect(error.retryAfterSec).toBe(5);
    expect(new ResourceBusyError('x', 'queue_timeout', 9).retryAfterSec).toBe(9);
  });
});
