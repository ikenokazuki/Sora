import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAsCaller } from '../security/caller.js';
import type { QueuePolicy } from '../security/fair_queue.js';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { TenantBudget } from '../security/tenant_budget.js';
import { createTestAddressData, settleAddressData, tick } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG } from '../test_fixtures/address/harness.js';
import { ADDRESS_SYSTEM_TENANT, addressQueuePolicy, type AddressBuilder } from './address_data.js';
import { AddressBusyError, AddressPendingError } from './address_errors.js';
import { jobArtifactId, type BuildJob } from './address_store.js';

/**
 * 住所データの構築の順番・予算（設計 6。穴 25）。
 * 以前は、構築の待ち行列が全員で 1 本で（頼んだ順。優先度は種類ごと）、待つ数に上限が無く（2000 件頼んでも全部入った）、
 * A が 60 市区町村を頼んだあとの B の 1 件が、その全部が終わるまで 1878 ms 待った。同じ ID は全員で 1 つにまとめるので、
 * B が頼んだ ID が A の列の後ろにあると、B はそこまで待った。
 */

const SAVED_ISOLATION = process.env.SORA_ISOLATION;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-limits-'));
  delete process.env.SORA_ISOLATION;
  resetSecurityMetrics();
});
afterEach(async () => {
  // 放さずに終わったテストの構築役も放す（放さないと、後始末の settleAddressData が、止まったままの構築を待ち続ける）
  for (const release of stopped.splice(0)) release();
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
  if (SAVED_ISOLATION === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = SAVED_ISOLATION;
});

const policy = (over: Partial<QueuePolicy> = {}): (() => QueuePolicy) => () => ({ perTenant: 100, total: 1000, waitMs: Infinity, sharePercent: 100, ...over });
const smallBudget = (perWindow: number) => new TenantBudget({ resource: 'address', policy: () => ({ perWindow, windowMs: 60_000 }) });
const city = (n: number): BuildJob => ({ kind: 'city', lgCode: String(100000 + n) });
const id = (n: number): string => `city:${100000 + n}`;

/** 後始末で放す、止めたままの構築役の release */
const stopped: Array<() => void> = [];

/** 手で放すまで止まる構築役。started は、実際に始めた順 */
function stoppedBuilder() {
  const started: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const builder: AddressBuilder = { async run(job) { started.push(jobArtifactId(job)); await gate; } };
  stopped.push(() => open());
  return { builder, started, release: () => open() };
}

/** すぐ終わる構築役 */
function quickBuilder() {
  const started: string[] = [];
  const builder: AddressBuilder = { async run(job) { started.push(jobArtifactId(job)); } };
  return { builder, started };
}

type Built = ReturnType<typeof createTestAddressData>;
/** 利用者 tenant として構築を頼む（待たない）。断られても、未処理の拒否にしない */
const ask = (data: Built['data'], tenant: string, job: BuildJob): Promise<void> => {
  const promise = runAsCaller(tenant, () => data.request(job));
  promise.catch(() => undefined);
  return promise;
};
const busyOf = async (promise: Promise<unknown>): Promise<AddressBusyError> => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(AddressBusyError);
  return error as AddressBusyError;
};

describe('順番は利用者ごとに公平（種類ごとの優先度は保つ）', () => {
  test('A が 5 件を頼んだあとの B の 1 件は、A の 1 件の次に動く（頼んだ順なら、A の 5 件が先）', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy() });
    for (let i = 1; i <= 5; i++) void ask(data, 'name:A', city(i));
    void ask(data, 'name:B', city(99));
    await tick();
    expect(fb.started).toEqual([id(1)]);
    fb.release();
    await data.idle();
    expect(fb.started).toEqual([id(1), id(99), id(2), id(3), id(4), id(5)]);
  });

  test('全国マスター・索引は、頼んだ利用者の順番が何度来ていても、市区町村より先（全国の小さな構築は、利用者の公平より先）', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy() });
    void ask(data, 'name:A', city(1)); // 実行中（A の順番が 1 回来た）
    void ask(data, 'name:A', city(2));
    void ask(data, 'name:A', city(3));
    void ask(data, 'name:A', { kind: 'master' });
    void ask(data, 'name:A', { kind: 'index' });
    void ask(data, 'name:B', city(9)); // B はまだ順番が来ていない
    await tick();
    fb.release();
    await data.idle();
    expect(fb.started).toEqual([id(1), 'master', 'index', id(9), id(2), id(3)]);
  });

  test('全国の小さな構築（マスター・郵便番号・索引）は、利用者の順番より先。市区町村の中の種類（町字・番地・街区）は、利用者の公平のあとで、同じ利用者の中だけで順を決める', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy() });
    void ask(data, 'name:A', city(1)); // 実行中
    for (let i = 2; i <= 4; i++) void ask(data, 'name:A', city(i));
    void ask(data, 'name:B', { kind: 'mlit', lgCode: String(100077) }); // 種類の優先度は低いが、B はまだ順番が来ていない
    void ask(data, 'name:A', { kind: 'num', lgCode: String(100090) });
    void ask(data, 'name:C', { kind: 'index' });
    await tick();
    fb.release();
    await data.idle();
    // 全国の索引（C）が先。次に、順番が来ていない B の街区。そのあと A の中で、町字（city）→ 番地（num）の順
    expect(fb.started).toEqual([id(1), 'index', 'mlit:100077', id(2), id(3), id(4), 'num:100090']);
  });

  test('別の利用者がすでに待ち行列に入れた ID を頼んだら、その利用者の順番でも動く（相手の列の末尾に並ばない）。構築は 1 回', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy() });
    for (let i = 1; i <= 4; i++) void ask(data, 'name:A', city(i));
    const shared = ask(data, 'name:B', city(4));
    await tick();
    fb.release();
    await shared;
    await data.idle();
    expect(fb.started).toEqual([id(1), id(4), id(2), id(3)]);
  });

  test('相乗りで動いた構築は、相乗りした利用者の順番として数える（その利用者の自分の構築は、そのあとに回る）', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy() });
    for (let i = 1; i <= 4; i++) void ask(data, 'name:A', city(i));
    void ask(data, 'name:B', city(9));
    void ask(data, 'name:B', city(4));
    await tick();
    fb.release();
    await data.idle();
    expect(fb.started).toEqual([id(1), id(4), id(2), id(9), id(3)]);
  });

  test('3 人が並べたときは、1 人ずつ順番に回る（順番の記録は、2 人分より多く覚える）', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy() });
    void ask(data, 'name:A', city(1));
    void ask(data, 'name:A', city(2));
    void ask(data, 'name:A', city(3));
    void ask(data, 'name:B', city(11));
    void ask(data, 'name:B', city(12));
    void ask(data, 'name:C', city(21));
    void ask(data, 'name:C', city(22));
    await tick();
    fb.release();
    await data.idle();
    expect(fb.started).toEqual([id(1), id(11), id(21), id(2), id(12), id(22), id(3)]);
  });

  test('すでに動いている ID を頼んでも、新しい構築を始めない', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy() });
    void ask(data, 'name:A', city(1));
    await tick();
    const again = ask(data, 'name:B', city(1));
    await tick();
    fb.release();
    await again;
    expect(fb.started).toEqual([id(1)]);
  });
});

describe('待つ数の上限', () => {
  test('1 人が待てる構築の数を超えたら、待たせず tenant_queue_full（住所の資源・断った ID つき）。ほかの利用者は待てる。始めない', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy({ perTenant: 2 }) });
    void ask(data, 'name:A', city(1)); // 実行中（待ちに数えない）
    void ask(data, 'name:A', city(2));
    void ask(data, 'name:A', city(3));
    const error = await busyOf(ask(data, 'name:A', city(4)));
    expect(error).toMatchObject({ reason: 'tenant_queue_full', resource: 'address', artifact: id(4) });
    expect(error.message).toContain('住所データの構築の順番');
    void ask(data, 'name:B', city(5));
    await tick();
    fb.release();
    await data.idle();
    expect(fb.started).toEqual([id(1), id(5), id(2), id(3)]);
    expect(getSecurityMetrics()['sora_address_busy_tenant_queue_full_total']).toBe(1);
  });

  test('全体で待てる数を超えたら、queue_full', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy({ total: 2 }) });
    void ask(data, 'name:A', city(1));
    void ask(data, 'name:A', city(2));
    void ask(data, 'name:B', city(3));
    const error = await busyOf(ask(data, 'name:C', city(4)));
    expect(error.reason).toBe('queue_full');
    expect(getSecurityMetrics()['sora_address_busy_queue_full_total']).toBe(1);
  });

  test('すでに待ち行列にある ID を頼むのは、上限に達していても断らない（新しい構築ではない）', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy({ perTenant: 1, total: 3 }) });
    void ask(data, 'name:A', city(1));
    void ask(data, 'name:A', city(2));
    void ask(data, 'name:B', city(3));
    const joined = ask(data, 'name:B', city(2));
    await tick();
    fb.release();
    await joined;
    expect(fb.started.filter((started) => started === id(2))).toHaveLength(1);
  });

  test('相乗りしただけの構築は、その利用者の待つ数に入らない（頼んだ人の分だけ数える）', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy({ perTenant: 1 }) });
    void ask(data, 'name:A', city(1)); // 実行中
    void ask(data, 'name:A', city(2)); // A の待ち 1 件（A の上限）
    void ask(data, 'name:B', city(2)); // B が相乗り
    const own = ask(data, 'name:B', city(3)); // B 自身の新しい構築は、B の待ち 0 件なので通る
    await tick();
    const refused = await busyOf(ask(data, 'name:B', city(4))); // これで B の待ちは 1 件（city 3）
    expect(refused.reason).toBe('tenant_queue_full');
    fb.release();
    await own;
  });

  test('システムの事前取得（ADDRESS_SYSTEM_TENANT）は、上限にも予算にも数えない。利用者の順番は取る', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy({ perTenant: 1, total: 2 }), budget: smallBudget(1) });
    for (let i = 1; i <= 6; i++) void ask(data, ADDRESS_SYSTEM_TENANT, city(i));
    void ask(data, 'name:A', city(50));
    await tick();
    fb.release();
    await data.idle();
    expect(fb.started).toHaveLength(7);
    expect(fb.started[1]).toBe(id(50));
  });
});

describe('1 人の予算（新しい構築だけを数える）', () => {
  test('予算を使い切ったら、待たせず tenant_budget で断る。始めない。ほかの利用者の予算は減らない', async () => {
    const q = quickBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => q.builder, queuePolicy: policy(), budget: smallBudget(2) });
    await ask(data, 'name:A', city(1));
    await ask(data, 'name:A', city(2));
    const error = await busyOf(ask(data, 'name:A', city(3)));
    expect(error).toMatchObject({ reason: 'tenant_budget', resource: 'address', artifact: id(3) });
    await ask(data, 'name:B', city(4));
    expect(q.started).toEqual([id(1), id(2), id(4)]);
    expect(getSecurityMetrics()['sora_address_busy_tenant_budget_total']).toBe(1);
  });

  test('待ち行列の上限で断った回は、予算を使わない（上限の確認が、予算を使う前）。予算がちょうど尽きていても、理由は待てる数', async () => {
    const fb = stoppedBuilder();
    const budget = smallBudget(2);
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy({ perTenant: 1 }), budget });
    void ask(data, 'name:A', city(1));
    void ask(data, 'name:A', city(2));
    const error = await busyOf(ask(data, 'name:A', city(3)));
    expect(error.reason).toBe('tenant_queue_full');
    expect(budget.usedBy('name:A')).toBe(2);
  });

  test('すでにある ID を頼むのは、予算を使わない（同じ ID の 2 回目・ほかの利用者が頼んだ ID）', async () => {
    const fb = stoppedBuilder();
    const budget = smallBudget(5);
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy(), budget });
    void ask(data, 'name:A', city(1));
    void ask(data, 'name:A', city(1));
    void ask(data, 'name:B', city(1));
    await tick();
    expect(budget.usedBy('name:A')).toBe(1);
    expect(budget.usedBy('name:B')).toBe(0);
  });

  test('できあがっている成果物の ensure は、予算も順番も使わない', async () => {
    const budget = smallBudget(1);
    const { data } = createTestAddressData(dir, { concurrency: 1, queuePolicy: policy(), budget });
    await runAsCaller('name:A', () => data.ensure({ kind: 'city', lgCode: CHIYODA_LG }));
    expect(budget.usedBy('name:A')).toBe(1);
    await runAsCaller('name:A', () => data.ensure({ kind: 'city', lgCode: CHIYODA_LG }));
    await runAsCaller('name:B', () => data.ensure({ kind: 'city', lgCode: CHIYODA_LG }));
    expect(budget.usedBy('name:A')).toBe(1);
    expect(budget.usedBy('name:B')).toBe(0);
  });
});

describe('待たない呼び出しと裏の再確認は、断られても失敗しない', () => {
  test('ensure は断られたら AddressBusyError。待たない呼び出し（background）も、頼んで断られたときは AddressBusyError（「取得中」ではない）。頼まない呼び出し（never）は AddressPendingError', async () => {
    const fb = stoppedBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => fb.builder, queuePolicy: policy({ perTenant: 1 }) });
    void ask(data, 'name:A', city(1)); // 実行中（待ちに数えない）
    void ask(data, 'name:A', city(2)); // 待ち 1 件（上限に達する）
    await tick();
    const waiting = await busyOf(runAsCaller('name:A', () => data.ensure(city(3), 50)));
    expect(waiting.reason).toBe('tenant_queue_full');
    const background = await busyOf(runAsCaller('name:A', () => data.withoutWaiting('background', () => data.ensure(city(4)))));
    expect(background).toMatchObject({ reason: 'tenant_queue_full', artifact: id(4) });
    const never = await runAsCaller('name:A', () => data.withoutWaiting('never', () => data.ensure(city(5)))).then(() => undefined, (e: unknown) => e);
    expect(never).toBeInstanceOf(AddressPendingError);
    // 断られたあと、頼めるようになれば（B）、同じ ID を頼める
    const accepted = await runAsCaller('name:B', () => data.withoutWaiting('background', () => data.ensure(city(4)))).then(() => undefined, (e: unknown) => e);
    expect(accepted).toBeInstanceOf(AddressPendingError);
    fb.release();
    await data.idle();
    // B の構築は、B の順番（まだ来ていない）で、A の待ち（2）より先に動く
    expect(fb.started).toEqual([id(1), id(4), id(2)]);
  });

  test('返り値を無視する request（待たない）が断られても、未処理の拒否にならない', async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => { seen.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => quickBuilder().builder, queuePolicy: policy({ perTenant: 0 }) });
      void runAsCaller('name:A', () => data.request(city(1)));
      await tick(30);
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('できあがった成果物の期限切れの再確認が断られても、読む呼び出しは古い成果物を返す（再確認の失敗を未処理にしない）', async () => {
    let time = 1_000_000;
    const budget = smallBudget(1);
    const { data, inner } = createTestAddressData(dir, { concurrency: 1, now: () => time, queuePolicy: policy(), budget });
    const first = await runAsCaller('name:A', () => data.ensure({ kind: 'city', lgCode: CHIYODA_LG }));
    time += 40 * 86_400_000;
    const again = await runAsCaller('name:A', () => data.ensure({ kind: 'city', lgCode: CHIYODA_LG }));
    expect(again.ver).toBe(first.ver);
    await tick(30);
    // 断られた再確認は、始まっていない（構築は最初の 1 回だけ）。予算も、最初の 1 回分のまま
    expect(inner.runs).toHaveLength(1);
    expect(budget.usedBy('name:A')).toBe(1);
  });
});

describe('水準（SORA_ISOLATION）の既定の値', () => {
  test('standard: 待てる構築は 1 人 100・全体 300。待ち時間は無し。strict: 1 人 30・全体 120', () => {
    expect(addressQueuePolicy()).toEqual({ perTenant: 100, total: 300, waitMs: Infinity, sharePercent: 100 });
    process.env.SORA_ISOLATION = 'strict';
    expect(addressQueuePolicy()).toEqual({ perTenant: 30, total: 120, waitMs: Infinity, sharePercent: 100 });
  });

  test('strict の予算の窓は 1 分（60 回）: 断った回は、住所データの構築の文とカウンター。45 秒では使い切ったまま（あと 15 秒）、61 秒たつと通る', async () => {
    process.env.SORA_ISOLATION = 'strict';
    let time = 1_000_000;
    const q = quickBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => q.builder, now: () => time });
    for (let i = 1; i <= 60; i++) await ask(data, 'name:A', city(i));
    time += 45_000;
    const error = await busyOf(ask(data, 'name:A', city(61)));
    expect(error.reason).toBe('tenant_budget');
    expect(error.retryAfterSec).toBe(15);
    expect(error.message).toContain('住所データの構築');
    expect(getSecurityMetrics()['sora_address_busy_tenant_budget_total']).toBe(1);
    time += 16_000;
    await ask(data, 'name:A', city(61));
  });

  test('strict の予算は 1 分に 60 回（61 回目の新しい構築で断る）。standard は制限なし', async () => {
    const q = quickBuilder();
    const { data } = createTestAddressData(dir, { concurrency: 1, wrap: () => q.builder });
    for (let i = 1; i <= 40; i++) await ask(data, 'name:A', city(i));
    expect(q.started).toHaveLength(40);

    process.env.SORA_ISOLATION = 'strict';
    const strict = quickBuilder();
    const built = createTestAddressData(dir, { concurrency: 1, wrap: () => strict.builder });
    for (let i = 1; i <= 60; i++) await ask(built.data, 'name:A', city(i));
    const error = await busyOf(ask(built.data, 'name:A', city(61)));
    expect(error.reason).toBe('tenant_budget');
    await ask(built.data, 'name:B', city(61));
  });
});
