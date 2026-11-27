import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ResourceBusyError } from '../errors.js';
import { runAsCaller } from '../security/caller.js';
import { getSecurityMetrics, resetSecurityMetrics } from '../security/metrics.js';
import { BodyBudget, bodyBudgetTotalBytes } from './body_budget.js';
import { readBodyWithLimit } from './safe_transport.js';

/**
 * 読み込み中の本文の合計の上限（監査 8）。止まる大きな本文を同時に何本も取ると、1 本ごとに本文の大きさだけメモリを使い続け、
 * 利用者ごとの上限が無かった（29MB の本文を 20 本で +720MB）。全体は機械のメモリから決め、strict は 1 人分の上限も置く。
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;
const servers: Array<{ stop: (force?: boolean) => void }> = [];

// カウンタは、ほかのファイルの試験が数えた分も残るので、前に戻す
beforeEach(() => resetSecurityMetrics());
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
  resetSecurityMetrics();
});

/** 宛先が、相手の接続が切れたと気づいた要求の数（読む側が読み込みをやめると、接続を閉じる） */
let clientGone = 0;

/** 1 KB ずつ n 回送る本文を返す宛先。close でなければ、そこで止まる（本文を終えない） */
function serveChunks(chunks: number, close = false) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 60,
    fetch: (request) => {
      request.signal.addEventListener('abort', () => clientGone++);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array(1024).fill(0x61));
            if (close) controller.close();
          },
        }),
      );
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/`;
}

/** 本文が全部届いてから読み始める（宛先が送る量と、読む側の予約の量をそろえる） */
async function fetchReady(url: string): Promise<Response> {
  const response = await fetch(url);
  await Bun.sleep(50);
  return response;
}

const busy = (error: unknown) => error instanceof ResourceBusyError && error.resource === 'body' && error.reason === 'memory_limit';

describe('BodyBudget: 読み込み中の本文の量の予約', () => {
  test('全体の上限と、1 人分の上限の中なら予約できる。超える予約は、予約せずに ResourceBusyError（body・memory_limit）。返せば、また予約できる', () => {
    const budget = new BodyBudget(() => 1000, () => 600);
    budget.reserve('name:alice', 500);
    expect(() => budget.reserve('name:alice', 200)).toThrow(ResourceBusyError); // 1 人分を超える
    expect(budget.usedBy('name:alice')).toBe(500);
    budget.reserve('name:bob', 500);
    let error: unknown;
    try {
      budget.reserve('name:carol', 100); // 全体を超える
    } catch (caught) {
      error = caught;
    }
    expect(busy(error)).toBe(true);
    expect(getSecurityMetrics().sora_body_busy_memory_limit_total).toBe(2);

    budget.release('name:alice', 500);
    expect(budget.usedBy('name:alice')).toBe(0);
    budget.reserve('name:carol', 100);
    expect(budget.used()).toBe(600);
  });

  test('上限ちょうどまでは予約できる（1 人分も全体も）。一部を返せば、その分だけ減る', () => {
    const budget = new BodyBudget(() => 1000, () => 600);
    budget.reserve('name:alice', 300);
    budget.reserve('name:alice', 300);
    budget.reserve('name:bob', 400);
    expect(budget.used()).toBe(1000);
    budget.release('name:alice', 200);
    expect(budget.usedBy('name:alice')).toBe(400);
    expect(budget.used()).toBe(800);
  });

  test('1 人分の上限が 0 のときは、利用者ごとの上限を置かない（全体だけ）', () => {
    const budget = new BodyBudget(() => 1000, () => 0);
    budget.reserve('name:alice', 1000);
    expect(() => budget.reserve('name:alice', 1)).toThrow(ResourceBusyError);
  });

  test('全体の上限は、機械のメモリの 25%（256MB〜1GB）。分からなければ 1GB', () => {
    expect(bodyBudgetTotalBytes(1 * GB)).toBe(256 * MB);
    expect(bodyBudgetTotalBytes(2 * GB)).toBe(512 * MB);
    expect(bodyBudgetTotalBytes(512 * MB)).toBe(256 * MB);
    expect(bodyBudgetTotalBytes(16 * GB)).toBe(1 * GB);
    expect(bodyBudgetTotalBytes(undefined)).toBe(1 * GB);
  });
});

describe('readBodyWithLimit と読み込み中の本文の量', () => {
  test('いま呼んでいる利用者の分に、読んだ量を予約し、読み終えたら返す', async () => {
    const budget = new BodyBudget(() => 100 * 1024, () => 50 * 1024);
    const body = await runAsCaller('name:alice', async () => readBodyWithLimit(await fetchReady(serveChunks(10, true)), MB, { timeoutMs: 5000, budget }));
    expect(body.byteLength).toBe(10 * 1024);
    expect(budget.used()).toBe(0);
  });

  test('1 人分の上限を超えたら、その読み込みだけを止めて ResourceBusyError。予約した分は返し、ほかの利用者は読める', async () => {
    const budget = new BodyBudget(() => 100 * 1024, () => 20 * 1024);
    const error = await runAsCaller('name:alice', async () => readBodyWithLimit(await fetchReady(serveChunks(30)), MB, { timeoutMs: 5000, budget })).catch((caught: unknown) => caught);
    expect(busy(error)).toBe(true);
    expect(budget.usedBy('name:alice')).toBe(0);

    const bob = await runAsCaller('name:bob', async () => readBodyWithLimit(await fetchReady(serveChunks(10, true)), MB, { timeoutMs: 5000, budget }));
    expect(bob.byteLength).toBe(10 * 1024);
  });

  test('別の利用者の読み込みは、互いの分に入らない（1 人分の上限は、利用者ごと）', async () => {
    const budget = new BodyBudget(() => 1 * MB, () => 20 * 1024);
    // alice が 15 KB を持ったまま止まっている間に、bob が 10 KB を読む（合わせると 1 人分の 20 KB を超える）
    const alice = runAsCaller('name:alice', async () => readBodyWithLimit(await fetchReady(serveChunks(15)), MB, { timeoutMs: 500, budget }).catch((error: unknown) => error));
    await Bun.sleep(200);
    expect(budget.usedBy('name:alice')).toBe(15 * 1024);
    const bob = await runAsCaller('name:bob', async () => readBodyWithLimit(await fetchReady(serveChunks(10, true)), MB, { timeoutMs: 5000, budget }));
    expect(bob.byteLength).toBe(10 * 1024);
    await alice;
  });

  test('上限を超えて止めた読み込みは、宛先との接続も閉じる（受け取り続けない）', async () => {
    const budget = new BodyBudget(() => 1 * MB, () => 5 * 1024);
    clientGone = 0;
    const error = await runAsCaller('name:alice', async () => readBodyWithLimit(await fetchReady(serveChunks(10)), MB, { timeoutMs: 5000, budget })).catch((caught: unknown) => caught);
    expect(busy(error)).toBe(true);
    const deadline = Date.now() + 2000;
    while (clientGone === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(clientGone).toBe(1);
  });

  test('1 人が止まる本文を同時に何本も読んでも、その人の分で止まる（以前は本数だけメモリを使い続けた）', async () => {
    const budget = new BodyBudget(() => 1 * MB, () => 25 * 1024);
    // 10 KB ずつ送って止まる本文を 4 本。読み込みの時間の上限まで待つ間、2 本分（20 KB）だけが予約を持ち、残りは断られる
    const results = await runAsCaller('name:alice', () =>
      Promise.all(Array.from({ length: 4 }, async () => readBodyWithLimit(await fetchReady(serveChunks(10)), MB, { timeoutMs: 300, budget }).then(() => 'read', (error: unknown) => (busy(error) ? 'busy' : 'timeout')))),
    );
    expect(results.filter((result) => result === 'busy')).toHaveLength(2);
    expect(budget.used()).toBe(0);
  });
});
