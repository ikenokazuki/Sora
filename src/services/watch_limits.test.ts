import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, dbClaimWatchCheck, dbCountWatchTargets, dbGetWatchTarget, dbReleaseWatchCheck, getDb } from '../db.js';
import * as enrichment from '../enrichment.js';
import { ResourceBusyError, WatchLimitError } from '../errors.js';
import { STANDARD_LIMITS, STRICT_LIMITS } from '../security/limits.js';
import { checkAllWatchTargets, checkWatchTarget, deleteWatchTarget, registerWatchTarget } from './watch.js';

/**
 * ウォッチの上限（設計 6。穴 18・24）: 1 人の登録数と、同じウォッチの確認の最小の間隔。
 * これまで、登録数に上限がなく、同じウォッチを続けて確認すると、そのたびに上流を取りに行った（一括の確認は、全件を毎回取りに行った）。
 */

const ALICE = 'name:alice';
const BOB = 'name:bob';

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'watch-limits-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

/** 取得を差し替える。呼ばれた数を calls に数える */
function counter() {
  const calls = { n: 0 };
  const scrape = async (_opts?: unknown) => {
    calls.n++;
    return { content: 'ページの本文', extracted: { content: 'ページの本文' } };
  };
  return { calls, scrape: scrape as never };
}

const lim = (extra: Partial<typeof STANDARD_LIMITS> = {}) => ({ ...STANDARD_LIMITS, ...extra });
const register = (tenantId: string, n: number, limits = lim(), scrape: never = counter().scrape, id?: string) =>
  registerWatchTarget({ tenantId, id, url: `https://example.com/${tenantId}/${n}`, initialFetch: false, limits }, scrape);

/** 最後に確認した時刻を、いま − ms にする（時計を進めずに、間隔が過ぎた状態を作る） */
const checkedAgo = (id: string, ms: number) => getDb().query('UPDATE watch_targets SET last_checked_at = ? WHERE id = ?').run(Date.now() - ms, id);

describe('登録数の上限（1 人あたり）', () => {
  test('上限まで登録でき、上限を超える登録は何も保存せずに WATCH_LIMIT_EXCEEDED（上限・いまの数つき）', async () => {
    const limits = lim({ watchTargetsPerTenant: 3 });
    for (let i = 0; i < 3; i++) await register(ALICE, i, limits);
    let error: unknown;
    try {
      await register(ALICE, 3, limits);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WatchLimitError);
    expect(error).toMatchObject({ code: 'WATCH_LIMIT_EXCEEDED', limit: 3, current: 3 });
    expect(dbCountWatchTargets(ALICE)).toBe(3);
    expect((error as Error).message).toContain('3 件');
  });

  test('同時に 10 件の登録を送っても、上限（3 件）を超えない（数えてから保存するまでに、待ちが入らない）', async () => {
    const limits = lim({ watchTargetsPerTenant: 3 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => register(ALICE, i, limits)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof WatchLimitError)).toHaveLength(7);
    expect(dbCountWatchTargets(ALICE)).toBe(3);
  });

  test('数えるのは利用者ごと。別の利用者の登録は、数に入らない', async () => {
    const limits = lim({ watchTargetsPerTenant: 2 });
    await register(ALICE, 0, limits);
    await register(ALICE, 1, limits);
    await register(BOB, 0, limits); // alice がいっぱいでも、bob は登録できる
    expect(dbCountWatchTargets(ALICE)).toBe(2);
    expect(dbCountWatchTargets(BOB)).toBe(1);
    await expect(register(ALICE, 2, limits)).rejects.toBeInstanceOf(WatchLimitError);
  });

  test('削除すれば、また登録できる', async () => {
    const limits = lim({ watchTargetsPerTenant: 1 });
    const first = await register(ALICE, 0, limits);
    await expect(register(ALICE, 1, limits)).rejects.toBeInstanceOf(WatchLimitError);
    expect(deleteWatchTarget(first.target.id, ALICE)).toBe(true);
    await register(ALICE, 1, limits);
    expect(dbCountWatchTargets(ALICE)).toBe(1);
  });

  test('いっぱいのときの、自分の既存のウォッチの更新（同じ id）は、断らない', async () => {
    const limits = lim({ watchTargetsPerTenant: 1 });
    const first = await register(ALICE, 0, limits);
    const again = await registerWatchTarget({ tenantId: ALICE, id: first.target.id, url: 'https://example.com/changed', initialFetch: false, limits }, counter().scrape);
    expect(again.target.url).toBe('https://example.com/changed');
    expect(dbCountWatchTargets(ALICE)).toBe(1);
  });

  test('別の利用者の id で登録しようとしても、数には入らず、これまでどおり断られる', async () => {
    const limits = lim({ watchTargetsPerTenant: 5 });
    const bobs = await register(BOB, 0, limits);
    await expect(registerWatchTarget({ tenantId: ALICE, id: bobs.target.id, url: 'https://example.com/x', initialFetch: false, limits }, counter().scrape)).rejects.toThrow('not available');
    expect(dbCountWatchTargets(ALICE)).toBe(0);
  });

  test('既定は水準の値: strict は 50 件、standard は 1000 件（limits を渡さないとき、SORA_ISOLATION で決まる）', async () => {
    const previous = process.env.SORA_ISOLATION;
    process.env.SORA_ISOLATION = 'strict';
    try {
      for (let i = 0; i < STRICT_LIMITS.watchTargetsPerTenant; i++) {
        await registerWatchTarget({ tenantId: ALICE, url: `https://example.com/${i}`, initialFetch: false }, counter().scrape);
      }
      await expect(registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/over', initialFetch: false }, counter().scrape)).rejects.toBeInstanceOf(WatchLimitError);
    } finally {
      if (previous === undefined) delete process.env.SORA_ISOLATION;
      else process.env.SORA_ISOLATION = previous;
    }
  });
});

describe('同じウォッチの確認の最小の間隔', () => {
  const strictInterval = lim({ watchMinIntervalMs: 900_000 });

  test('間隔の中の 2 回目は、取得せずに WATCH_TOO_FREQUENT（あと何秒かつき）。間隔が過ぎれば通る', async () => {
    const { calls, scrape } = counter();
    const target = (await register(ALICE, 0, strictInterval, scrape)).target;
    await checkWatchTarget(target.id, ALICE, scrape, strictInterval);
    expect(calls.n).toBe(1);
    let error: unknown;
    try {
      await checkWatchTarget(target.id, ALICE, scrape, strictInterval);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WatchLimitError);
    expect(error).toMatchObject({ code: 'WATCH_TOO_FREQUENT' });
    const retryAfter = (error as WatchLimitError).retryAfterSec;
    expect(retryAfter).toBeGreaterThan(890);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect(calls.n).toBe(1); // 2 回目は取りに行っていない
    // 14 分前の確認 → まだ（あと 1 分ほど）。16 分前 → 通る
    checkedAgo(target.id, 14 * 60_000);
    await expect(checkWatchTarget(target.id, ALICE, scrape, strictInterval)).rejects.toMatchObject({ code: 'WATCH_TOO_FREQUENT' });
    checkedAgo(target.id, 16 * 60_000);
    await checkWatchTarget(target.id, ALICE, scrape, strictInterval);
    expect(calls.n).toBe(2);
  });

  test('あと何秒かは切り上げる（残り 0.5 秒なら 1 秒。0 秒と言わない）', async () => {
    const { scrape } = counter();
    const target = (await register(ALICE, 0, strictInterval, scrape)).target;
    checkedAgo(target.id, 899_500);
    const error = await checkWatchTarget(target.id, ALICE, scrape, strictInterval).catch((e) => e);
    expect(error).toBeInstanceOf(WatchLimitError);
    expect(error.retryAfterSec).toBe(1);
  });

  test('自分の既存のウォッチを登録し直すとき（同じ id）の初回の確認も、間隔の中なら断られ、initialError で知らせる（登録は保存される）', async () => {
    const { calls, scrape } = counter();
    const first = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a', limits: strictInterval }, scrape);
    expect(calls.n).toBe(1);
    const again = await registerWatchTarget({ tenantId: ALICE, id: first.target.id, url: 'https://example.com/b', limits: strictInterval }, scrape);
    expect(again.target.url).toBe('https://example.com/b'); // 更新は保存された
    expect(again.initialError?.code).toBe('WATCH_TOO_FREQUENT'); // 初回の確認は、間隔の中なので取得していない
    expect(calls.n).toBe(1);
  });

  test('間隔は、前の確認の「始め」から数える（取得に時間がかかっても、間隔が延びない）', async () => {
    const slow = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { content: 'ページの本文', extracted: { content: 'ページの本文' } };
    }) as never;
    const target = (await register(ALICE, 0, strictInterval, slow)).target;
    const before = Date.now();
    await checkWatchTarget(target.id, ALICE, slow, strictInterval);
    const recorded = dbGetWatchTarget(target.id, ALICE)?.last_checked_at ?? 0;
    expect(recorded).toBeLessThan(before + 100); // 取得の終わり（before + 150 以降）ではなく、確認の始め
    expect(recorded).toBeGreaterThanOrEqual(before);
  });

  test('始めから数えるのは、内容が変わった確認も、変わらない確認も同じ（保存する時刻は、権利を取った時刻）', async () => {
    const pages = { body: 'はじめの本文' };
    const slow = (async () => {
      const body = pages.body;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { content: body, extracted: { content: body } };
    }) as never;
    const target = (await register(ALICE, 0, strictInterval, slow)).target;
    await checkWatchTarget(target.id, ALICE, slow, strictInterval); // 基準を作る（初回）
    for (const [label, body] of [
      ['内容が変わった', 'かわった本文'],
      ['内容が変わらない', 'かわった本文'],
    ] as const) {
      pages.body = body;
      checkedAgo(target.id, 20 * 60_000); // 間隔が過ぎた状態
      const before = Date.now();
      const result = await checkWatchTarget(target.id, ALICE, slow, strictInterval);
      expect(result.changed, label).toBe(label === '内容が変わった');
      const recorded = dbGetWatchTarget(target.id, ALICE)?.last_checked_at ?? 0;
      expect(recorded, label).toBeGreaterThanOrEqual(before);
      expect(recorded, label).toBeLessThan(before + 100); // 取得の終わり（before + 150 以降）ではなく、確認の始め
    }
  });

  test('ブラウザの枠が混み合って断られた確認（上流に届く前の失敗）は、間隔に数えない。前の記録に戻し、すぐ確認し直せる', async () => {
    const { calls, scrape } = counter();
    const target = (await register(ALICE, 0, strictInterval, scrape)).target;
    await checkWatchTarget(target.id, ALICE, scrape, strictInterval); // 記録あり
    checkedAgo(target.id, 20 * 60_000); // 間隔が過ぎた状態
    const previous = dbGetWatchTarget(target.id, ALICE)?.last_checked_at;
    const busy = (async () => {
      throw new ResourceBusyError('枠が混み合っています', 'queue_full', 5);
    }) as never;
    await expect(checkWatchTarget(target.id, ALICE, busy, strictInterval)).rejects.toBeInstanceOf(ResourceBusyError);
    expect(dbGetWatchTarget(target.id, ALICE)?.last_checked_at).toBe(previous); // 権利を戻した
    await checkWatchTarget(target.id, ALICE, scrape, strictInterval); // 5 秒後の再試行が、15 分待ちにならない
    expect(calls.n).toBe(2);
  });

  test('DB に書けないとき、strict の間隔は止まらずに断る（取得せず、失敗にする）。standard は、確認の記録に頼らないので、取得する', async () => {
    const { calls, scrape } = counter();
    const target = (await register(ALICE, 0, strictInterval, scrape)).target;
    getDb().run('PRAGMA query_only = ON');
    try {
      await expect(checkWatchTarget(target.id, ALICE, scrape, strictInterval)).rejects.toThrow();
      expect(calls.n).toBe(0);
      await checkWatchTarget(target.id, ALICE, scrape, lim()); // standard（間隔 0）
      expect(calls.n).toBe(1);
    } finally {
      getDb().run('PRAGMA query_only = OFF');
    }
  });

  test('間隔 0（standard）では、確認の権利を取らない。失敗した確認は、確認の時刻に触れない（これまでどおり）', async () => {
    const target = (await register(ALICE, 0)).target;
    expect(dbGetWatchTarget(target.id, ALICE)?.last_checked_at ?? null).toBeNull();
    const failing = (async () => {
      throw new Error('接続できません');
    }) as never;
    await expect(checkWatchTarget(target.id, ALICE, failing, lim())).rejects.toThrow('接続できません');
    expect(dbGetWatchTarget(target.id, ALICE)?.last_checked_at ?? null).toBeNull();
  });

  test('最小の間隔が 0（standard の既定）なら、何度でも続けて確認できる', async () => {
    const { calls, scrape } = counter();
    const target = (await register(ALICE, 0, lim(), scrape)).target;
    for (let i = 0; i < 5; i++) await checkWatchTarget(target.id, ALICE, scrape, lim());
    expect(calls.n).toBe(5);
  });

  test('登録の初回の確認も、間隔に数える（登録の直後の確認は、間隔の中）', async () => {
    const { calls, scrape } = counter();
    const registered = await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/a', limits: strictInterval }, scrape);
    expect(calls.n).toBe(1);
    await expect(checkWatchTarget(registered.target.id, ALICE, scrape, strictInterval)).rejects.toMatchObject({ code: 'WATCH_TOO_FREQUENT' });
    expect(calls.n).toBe(1);
  });

  test('取得に失敗した確認も、間隔に数える（上流には届いた。失敗を連打して取りに行かせない）', async () => {
    const target = (await register(ALICE, 0, strictInterval)).target;
    const failing = (async () => {
      throw new Error('接続できません');
    }) as never;
    await expect(checkWatchTarget(target.id, ALICE, failing, strictInterval)).rejects.toThrow('接続できません');
    await expect(checkWatchTarget(target.id, ALICE, failing, strictInterval)).rejects.toMatchObject({ code: 'WATCH_TOO_FREQUENT' });
  });

  test('同時の 2 回の確認でも、取得するのは 1 回（確認の権利を、取得の前に、同期で取る）', async () => {
    const { calls, scrape } = counter();
    const target = (await register(ALICE, 0, strictInterval, scrape)).target;
    const results = await Promise.allSettled([checkWatchTarget(target.id, ALICE, scrape, strictInterval), checkWatchTarget(target.id, ALICE, scrape, strictInterval)]);
    expect(results.map((r) => r.status).toSorted()).toEqual(['fulfilled', 'rejected']);
    expect(calls.n).toBe(1);
  });

  test('別の利用者のウォッチの id は、これまでどおり「見つからない」（間隔の記録にも触れない）', async () => {
    const { scrape } = counter();
    const target = (await register(BOB, 0, strictInterval, scrape)).target;
    await expect(checkWatchTarget(target.id, ALICE, scrape, strictInterval)).rejects.toThrow('not found');
    expect(dbGetWatchTarget(target.id, BOB)?.last_checked_at ?? null).toBeNull(); // 確認の記録は付いていない
  });
});

describe('確認の権利（dbClaimWatchCheck）', () => {
  test('ちょうど間隔だけたっていれば取れる。1 ミリ秒足りなければ取れず、あと 1 ミリ秒', async () => {
    const target = (await register(ALICE, 0)).target;
    const now = 10_000_000;
    getDb().query('UPDATE watch_targets SET last_checked_at = ? WHERE id = ?').run(now - 900_000, target.id);
    expect(dbClaimWatchCheck(target.id, ALICE, 900_000, now)).toEqual({ claimed: true, at: now, previous: now - 900_000 }); // 取った時刻と、前の時刻
    expect(dbGetWatchTarget(target.id, ALICE)?.last_checked_at).toBe(now); // 権利を取ったら、確認の時刻が now になる
    getDb().query('UPDATE watch_targets SET last_checked_at = ? WHERE id = ?').run(now - 899_999, target.id);
    expect(dbClaimWatchCheck(target.id, ALICE, 900_000, now)).toEqual({ claimed: false, waitMs: 1 });
    expect(dbGetWatchTarget(target.id, ALICE)?.last_checked_at).toBe(now - 899_999); // 取れなかったら、時刻は変えない
  });

  test('一度も確認していない（last_checked_at なし）なら取れる。あと何ミリ秒かは、前の確認 + 間隔 − 今', async () => {
    const target = (await register(ALICE, 0)).target;
    expect(dbClaimWatchCheck(target.id, ALICE, 900_000, 5_000_000)).toEqual({ claimed: true, at: 5_000_000, previous: null });
    expect(dbClaimWatchCheck(target.id, ALICE, 900_000, 5_300_000)).toEqual({ claimed: false, waitMs: 600_000 });
  });

  test('権利を戻すと、前の時刻に戻る。ほかが取り直したあと（時刻が違う）なら、触らない', async () => {
    const target = (await register(ALICE, 0)).target;
    const first = dbClaimWatchCheck(target.id, ALICE, 1000, 5_000_000);
    expect(first).toMatchObject({ claimed: true, previous: null });
    dbReleaseWatchCheck(target.id, ALICE, 5_000_000, null);
    expect(dbGetWatchTarget(target.id, ALICE)?.last_checked_at ?? null).toBeNull();
    // 取り直した人（時刻 6,000,000）がいるとき、先の人の戻しは効かない
    dbClaimWatchCheck(target.id, ALICE, 1000, 5_000_000);
    dbClaimWatchCheck(target.id, ALICE, 1000, 6_000_000);
    dbReleaseWatchCheck(target.id, ALICE, 5_000_000, null);
    expect(dbGetWatchTarget(target.id, ALICE)?.last_checked_at).toBe(6_000_000);
  });

  test('別の利用者の id と、存在しない id は、権利を取れず、残りも無い（waitMs 0）。確認の記録も変えない', async () => {
    const target = (await register(BOB, 0)).target;
    expect(dbClaimWatchCheck(target.id, ALICE, 0, 1)).toEqual({ claimed: false, waitMs: 0 });
    expect(dbClaimWatchCheck('wt_none', ALICE, 0, 1)).toEqual({ claimed: false, waitMs: 0 });
    expect(dbGetWatchTarget(target.id, BOB)?.last_checked_at ?? null).toBeNull();
  });
});

describe('一括の確認（id なし）', () => {
  const strictInterval = lim({ watchMinIntervalMs: 900_000 });

  test('間隔の中のウォッチは、取得せずに「見送り」（skipped・retryAfterSec）として結果に載せ、間隔が過ぎたものだけ取得する', async () => {
    const { calls, scrape } = counter();
    const a = (await register(ALICE, 0, strictInterval, scrape)).target;
    const b = (await register(ALICE, 1, strictInterval, scrape)).target;
    const c = (await register(ALICE, 2, strictInterval, scrape)).target;
    checkedAgo(a.id, 20 * 60_000); // 過ぎた
    checkedAgo(b.id, 5 * 60_000); // 間隔の中
    // c は、一度も確認していない（last_checked_at なし）→ 取得する
    const results = await checkAllWatchTargets(ALICE, scrape, strictInterval);
    expect(calls.n).toBe(2); // a と c
    const byId = new Map(results.map((r) => [r.targetId, r]));
    expect(byId.get(a.id)?.skipped).toBeUndefined();
    expect(byId.get(c.id)?.skipped).toBeUndefined();
    const skipped = byId.get(b.id);
    expect(skipped).toMatchObject({ skipped: true, changed: false });
    expect(skipped?.retryAfterSec).toBeGreaterThan(590);
    expect(skipped?.retryAfterSec).toBeLessThanOrEqual(600);
    expect(skipped?.diffSummary).toContain('見送');
    // 続けてもう一度 → 全件が間隔の中
    const again = await checkAllWatchTargets(ALICE, scrape, strictInterval);
    expect(calls.n).toBe(2);
    expect(again.every((r) => r.skipped === true)).toBe(true);
  });

  test('見送ったウォッチには、取得も Webhook もしない（本文が変わっていても、間隔の中では見に行かない）', async () => {
    const deliver = spyOn(enrichment, 'deliverWebhook').mockResolvedValue(true);
    try {
      let body = '最初の本文';
      let fetched = 0;
      const scrape = (async () => {
        fetched++;
        return { content: body, extracted: { content: body } };
      }) as never;
      const target = (await registerWatchTarget({ tenantId: ALICE, url: 'https://example.com/w', webhookUrl: 'https://hooks.example.com/x', initialFetch: false, limits: strictInterval }, scrape)).target;
      await checkAllWatchTargets(ALICE, scrape, strictInterval); // 初回（ベースライン）
      expect(fetched).toBe(1);
      body = '変わった本文'; // 取りに行けば、差分と Webhook になる
      deliver.mockClear();
      const results = await checkAllWatchTargets(ALICE, scrape, strictInterval); // 間隔の中 → 見送り
      expect(results.map((r) => r.skipped)).toEqual([true]);
      expect(fetched).toBe(1);
      expect(deliver).not.toHaveBeenCalled();
      // 間隔が過ぎれば、差分を見つけて、Webhook を送る（見送りが、差分を失わせない）
      checkedAgo(target.id, 20 * 60_000);
      const later = await checkAllWatchTargets(ALICE, scrape, strictInterval);
      expect(later[0]).toMatchObject({ changed: true });
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      deliver.mockRestore();
    }
  });

  test('見送った結果の checkedAt は、実際に確認した時刻（いまではない）', async () => {
    const { scrape } = counter();
    const target = (await register(ALICE, 0, strictInterval, scrape)).target;
    const at = Date.now() - 5 * 60_000;
    checkedAgo(target.id, 5 * 60_000);
    const [skipped] = await checkAllWatchTargets(ALICE, scrape, strictInterval);
    expect(skipped.skipped).toBe(true);
    expect(Math.abs(new Date(skipped.checkedAt).getTime() - at)).toBeLessThan(1000);
  });
});
