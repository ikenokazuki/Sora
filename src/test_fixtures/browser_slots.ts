import { expect } from 'bun:test';
import { browserSemaphore, type Lease } from '../browser_engine.js';
import { ResourceBusyError } from '../errors.js';

/**
 * ブラウザの枠（browserSemaphore）を、テストで使い切るための部品（設計 6。穴 22・25）。枠の数は、メモリから決まる（1〜5）ので、数に頼らない。
 * ブラウザは起動しない（枠を断られるので、起動の前に失敗する）。使ったら、afterEach で releaseAll を呼ぶ。
 */

const held: Lease[] = [];
const waiting: Array<Promise<Lease>> = [];

/** 枠を全部埋める。利用者を分けて取る（1 人が持てる枠の割合に当たらないように） */
export async function saturate(): Promise<void> {
  for (let i = 0; browserSemaphore.activeCount < browserSemaphore.max; i++) held.push(await browserSemaphore.acquire(`hog-${i}`));
}

/** 利用者の待ちを、count 件にする */
export function fillQueue(tenantId: string, count: number): void {
  for (let i = 0; i < count; i++) waiting.push(browserSemaphore.acquire(tenantId));
}

/** 持っている枠を戻し、待っていた要求にも枠を渡して、すぐ手放す */
export async function releaseAll(): Promise<void> {
  for (const lease of held.splice(0)) lease();
  await Promise.allSettled(waiting.splice(0).map((promise) => promise.then((lease) => lease())));
}

/**
 * 呼び出しが終わらないとき（枠が戻らず待ち続ける・予約が残るなど）に、テストが止まらずに失敗するようにする。
 * Bun は、終わらない Promise を expect().rejects で待つと、テストの時間切れを効かせずに止まる（CPU を使い続ける）ので、待つ前に時間切れの拒否と競わせる。
 * 呼び出しの普通の長さ（ミリ秒）より十分長く、テストの既定の時間切れ（5 秒）より短い
 */
export function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`呼び出しが ${ms} ミリ秒たっても終わりません（枠や予約が戻っていない可能性）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 失敗するはずの呼び出しが、枠を断られて（ResourceBusyError）失敗したことを確かめて、その例外を返す */
export async function busyOf(promise: Promise<unknown>): Promise<ResourceBusyError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ResourceBusyError);
  return error as ResourceBusyError;
}
