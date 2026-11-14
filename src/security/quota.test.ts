import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createAuthMiddleware, hashApiKey } from '../auth.js';
import { dbAddApiUsage, dbGetApiUsage } from '../db.js';
import { QuotaExceededError, secondsUntilNextUtcDay } from '../errors.js';
import { withEnv } from '../test_fixtures/env.js';
import { chargeQuota, checkQuota, refundQuota, setQuotaEnabled, usageKeyForTenant } from './quota.js';
import { tenantIdForApiKey } from './tenant_context.js';

/**
 * 日次クォータの重み（設計 6。穴 26）: 一括・crawl が、件数分を数える。
 * 数える先は、認証のミドルウェアと同じ表（api_usage）の同じ行（単一の鍵は鍵のハッシュ、鍵ファイルは tenant の ID、匿名は 'anonymous'）。
 */
const today = () => new Date().toISOString().slice(0, 10);
const withLimit = <T>(limit: string | undefined, fn: () => T | Promise<T>) => withEnv({ SORA_AUTH_DAILY_LIMIT: limit }, fn);

describe('数える先の鍵（usageKeyForTenant）', () => {
  test('鍵の tenant は鍵のハッシュ、匿名（legacy）は anonymous、名前つきの鍵は tenant の ID のまま。Sora 自身の取得（public）は数えない', () => {
    const key = `quota-key-${randomUUID()}`;
    expect(usageKeyForTenant(tenantIdForApiKey(key))).toBe(hashApiKey(key));
    expect(usageKeyForTenant('legacy')).toBe('anonymous');
    expect(usageKeyForTenant('name:alice')).toBe('name:alice');
    expect(usageKeyForTenant('public')).toBeUndefined();
  });
});

describe('chargeQuota', () => {
  test('上限の中なら、件数分を足す。足したあとの回数は、認証のミドルウェアが数える行と同じ', async () => {
    await withLimit('10', () => {
      const tenant = `name:charge-${randomUUID()}`;
      chargeQuota(tenant, 4);
      expect(dbGetApiUsage(tenant, today())).toBe(4);
      chargeQuota(tenant, 6);
      expect(dbGetApiUsage(tenant, today())).toBe(10);
    });
  });

  test('上限を超える件数は、何も足さずに QuotaExceededError（上限・いまの回数・求めた件数を持つ）', async () => {
    await withLimit('10', () => {
      const tenant = `name:over-${randomUUID()}`;
      chargeQuota(tenant, 8);
      let error: unknown;
      try {
        chargeQuota(tenant, 3);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(QuotaExceededError);
      expect(error).toMatchObject({ limit: 10, current: 8, requested: 3 });
      expect(dbGetApiUsage(tenant, today())).toBe(8);
      // ちょうど残りの分は通る
      chargeQuota(tenant, 2);
      expect(dbGetApiUsage(tenant, today())).toBe(10);
    });
  });

  test('上限を決めていなければ、数えるだけで断らない（既定は無制限）', async () => {
    await withLimit(undefined, () => {
      const tenant = `name:free-${randomUUID()}`;
      chargeQuota(tenant, 5000);
      expect(dbGetApiUsage(tenant, today())).toBe(5000);
    });
  });

  test('0 件・負の件数・数でない件数は、何もしない（足し算を逆に使わせない）', async () => {
    await withLimit('10', () => {
      const tenant = `name:zero-${randomUUID()}`;
      chargeQuota(tenant, 3);
      for (const units of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
        chargeQuota(tenant, units);
        expect(dbGetApiUsage(tenant, today()), String(units)).toBe(3);
      }
    });
  });

  test('足す件数が 0 のとき（1 件の一括・1 ページの crawl）は、すでに上限を超えていても、断らない（要求の 1 回は認証が通した）', async () => {
    await withLimit('10', () => {
      const tenant = `name:zero-over-${randomUUID()}`;
      dbAddApiUsage(tenant, today(), 12); // 上限を超えた状態（認証のミドルウェアが数えた分）
      expect(() => chargeQuota(tenant, 0)).not.toThrow();
      expect(() => checkQuota(tenant, 0)).not.toThrow();
      expect(dbGetApiUsage(tenant, today())).toBe(12);
      // 1 件でも足すなら、断る
      expect(() => chargeQuota(tenant, 1)).toThrow(QuotaExceededError);
    });
  });

  test('Sora 自身の取得（public）は数えない', async () => {
    await withLimit('1', () => {
      chargeQuota('public', 1000);
      expect(dbGetApiUsage('public', today())).toBe(0);
    });
  });

  test('認証のミドルウェアが数えた回数と合算される（同じ鍵の同じ日の行）', async () => {
    const key = `quota-mw-${randomUUID()}`;
    await withLimit('5', async () => {
      const app = new Hono();
      app.use('*', createAuthMiddleware(key));
      app.get('/p', (c) => c.text('ok'));
      for (let i = 0; i < 2; i++) expect((await app.request('/p', { headers: { 'X-API-Key': key } })).status).toBe(200);
      const tenant = tenantIdForApiKey(key);
      chargeQuota(tenant, 3); // 2 + 3 = 5（ちょうど上限）
      expect(() => chargeQuota(tenant, 1)).toThrow(QuotaExceededError);
      // 上限を使い切ったので、次の要求も 429
      expect((await app.request('/p', { headers: { 'X-API-Key': key } })).status).toBe(429);
    });
  });
});

describe('checkQuota と refundQuota', () => {
  test('checkQuota は、足さずに、足せるかだけを見る', async () => {
    await withLimit('10', () => {
      const tenant = `name:check-${randomUUID()}`;
      chargeQuota(tenant, 9);
      checkQuota(tenant, 1);
      expect(() => checkQuota(tenant, 2)).toThrow(QuotaExceededError);
      expect(dbGetApiUsage(tenant, today())).toBe(9);
    });
  });

  test('refundQuota は、足した分を戻す。0 より下にはしない', async () => {
    await withLimit('10', () => {
      const tenant = `name:refund-${randomUUID()}`;
      chargeQuota(tenant, 6);
      refundQuota(tenant, 4);
      expect(dbGetApiUsage(tenant, today())).toBe(2);
      refundQuota(tenant, 100);
      expect(dbGetApiUsage(tenant, today())).toBe(0);
      for (const units of [0, -3, Number.NaN]) {
        refundQuota(tenant, units);
        expect(dbGetApiUsage(tenant, today()), String(units)).toBe(0);
      }
    });
  });
});

describe('日をまたぐ呼び出し（crawl が UTC の日の変わり目をまたいだとき）', () => {
  test('足した日を指定して戻すと、その日の行だけが減る（戻した時点の日の行は触らない）', async () => {
    await withLimit('100', () => {
      const tenant = `name:cross-${randomUUID()}`;
      chargeQuota(tenant, 40, '2031-03-10');
      dbAddApiUsage(tenant, '2031-03-11', 60); // 翌日の行（その日の要求が数えた回数）
      refundQuota(tenant, 30, '2031-03-10');
      expect(dbGetApiUsage(tenant, '2031-03-10')).toBe(10);
      expect(dbGetApiUsage(tenant, '2031-03-11')).toBe(60);
    });
  });

  test('足す日を指定すると、その日の回数で上限を見る', async () => {
    await withLimit('50', () => {
      const tenant = `name:cross-limit-${randomUUID()}`;
      dbAddApiUsage(tenant, '2031-03-10', 45);
      expect(() => chargeQuota(tenant, 10, '2031-03-10')).toThrow(QuotaExceededError);
      chargeQuota(tenant, 10, '2031-03-11'); // 別の日の行は空
      expect(dbGetApiUsage(tenant, '2031-03-11')).toBe(10);
    });
  });
});

describe('stdio では数えない（setQuotaEnabled）', () => {
  test('無効にすると、足さず・断らず・戻さない。有効に戻すと、また数える', async () => {
    await withLimit('5', () => {
      const tenant = `name:stdio-${randomUUID()}`;
      chargeQuota(tenant, 3); // 有効なうちに足した分
      setQuotaEnabled(false);
      try {
        chargeQuota(tenant, 100);
        checkQuota(tenant, 100);
        refundQuota(tenant, 2);
        expect(dbGetApiUsage(tenant, today())).toBe(3); // 足さず、戻さない
      } finally {
        setQuotaEnabled(true);
      }
      expect(() => chargeQuota(tenant, 100)).toThrow(QuotaExceededError);
    });
  });
});

describe('次の UTC の日の始まりまでの秒（Retry-After）', () => {
  test('日の終わりに近いほど短く、日の始まりちょうどは 24 時間。月・年をまたいでも合う', () => {
    expect(secondsUntilNextUtcDay(new Date(Date.UTC(2026, 10, 14, 23, 59, 0)))).toBe(60);
    expect(secondsUntilNextUtcDay(new Date(Date.UTC(2026, 10, 14, 0, 0, 0)))).toBe(86400);
    expect(secondsUntilNextUtcDay(new Date(Date.UTC(2026, 10, 30, 12, 0, 0)))).toBe(12 * 3600); // 11 月 30 日 → 12 月 1 日
    expect(secondsUntilNextUtcDay(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe(1); // 年末
    expect(secondsUntilNextUtcDay(new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 500)))).toBe(1); // 端数は切り上げ、1 以上
  });

  test('QuotaExceededError の retryAfterSec は、この秒数', () => {
    expect(Math.abs(new QuotaExceededError(5, 5, 3).retryAfterSec - secondsUntilNextUtcDay())).toBeLessThanOrEqual(2);
  });
});

describe('dbAddApiUsage', () => {
  test('回数を足して、足したあとの回数を返す。負の数は戻す（0 で止まる）', () => {
    const key = `add-${randomUUID()}`;
    expect(dbAddApiUsage(key, today(), 3)).toBe(3);
    expect(dbAddApiUsage(key, today(), 4)).toBe(7);
    expect(dbAddApiUsage(key, today(), -2)).toBe(5);
    expect(dbAddApiUsage(key, today(), -50)).toBe(0);
    expect(dbGetApiUsage(key, today())).toBe(0);
    expect(dbGetApiUsage(`none-${randomUUID()}`, today())).toBe(0);
  });

  test('行がまだ無いところへ負の数を足しても、0 から下がらない', () => {
    const key = `add-neg-${randomUUID()}`;
    expect(dbAddApiUsage(key, today(), -5)).toBe(0);
    expect(dbGetApiUsage(key, today())).toBe(0);
  });
});
