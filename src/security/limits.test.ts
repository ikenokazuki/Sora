import { describe, expect, test } from 'bun:test';
import { checkEnv } from '../config.js';
import { isolationLevel, limits, STANDARD_LIMITS, STRICT_LIMITS } from './limits.js';

/**
 * 増幅の上限（設計 6。穴 11・21・23・24・26）の値。水準（SORA_ISOLATION）で 2 組の組み込みの値を切り替える。
 * standard（既定）: ユーザーが 1 人か、互いに信頼できる少数。今までの使い方を止めない緩い値（異常な入力だけを止める）。
 * strict: 互いに信頼できない利用者に公開する共有のサービス。設計書の値。
 */

describe('isolationLevel', () => {
  test('未設定は standard。strict を設定すると strict（大文字小文字は問わない）', () => {
    expect(isolationLevel({})).toBe('standard');
    expect(isolationLevel({ SORA_ISOLATION: 'strict' })).toBe('strict');
    expect(isolationLevel({ SORA_ISOLATION: 'STRICT' })).toBe('strict');
    expect(isolationLevel({ SORA_ISOLATION: 'standard' })).toBe('standard');
  });

  test('空・空白だけは、未設定と同じ standard。前後の空白は取り除く（strict の前後の空白は strict）', () => {
    expect(isolationLevel({ SORA_ISOLATION: '' })).toBe('standard');
    expect(isolationLevel({ SORA_ISOLATION: '   ' })).toBe('standard');
    expect(isolationLevel({ SORA_ISOLATION: ' strict ' })).toBe('strict');
  });

  test('書き方の誤り（strcit などの打ち間違い）は、緩い側の standard にせず、エラーにする（起動の検査を通らない経路でも）', () => {
    for (const typo of ['strcit', 'paranoid', 'stricter', 'on', '1']) {
      expect(() => isolationLevel({ SORA_ISOLATION: typo }), typo).toThrow(/SORA_ISOLATION の値/);
      expect(() => limits({ SORA_ISOLATION: typo }), typo).toThrow(/正しい形: standard・strict/);
    }
  });

  test('起動の検査（checkEnv）も、同じ文で errors にする（起動を止める）。正しい値・未設定では出さない', () => {
    const { errors } = checkEnv({ SORA_ISOLATION: 'strcit' });
    expect(errors).toContain('SORA_ISOLATION の値（"strcit"）は不正です。正しい形: standard・strict のどれか');
    expect(checkEnv({ SORA_ISOLATION: 'strict' }).errors.filter((e) => e.includes('SORA_ISOLATION'))).toEqual([]);
    expect(checkEnv({}).errors.filter((e) => e.includes('SORA_ISOLATION'))).toEqual([]);
  });
});

describe('limits', () => {
  test('水準に応じた値の組を返す', () => {
    expect(limits({})).toBe(STANDARD_LIMITS);
    expect(limits({ SORA_ISOLATION: 'strict' })).toBe(STRICT_LIMITS);
  });

  test('strict の値は、設計書の値（未決 7）', () => {
    expect(STRICT_LIMITS).toMatchObject({
      sitemapRobotsLines: 5,
      sitemapChildren: 20,
      sitemapBytes: 10 * 1024 * 1024,
      mapDeadlineMs: 30_000,
      patternCount: 20,
      selectorCount: 20,
    });
  });

  test('ブラウザの枠の値（待つ数・待ち時間・tenant の割合）: strict は設計の値、standard は緩い値。割合は 1〜100 のパーセント', () => {
    expect(STRICT_LIMITS).toMatchObject({ browserQueuePerTenant: 10, browserQueueTotal: 100, browserQueueWaitMs: 60_000, browserTenantSharePercent: 50 });
    expect(STANDARD_LIMITS).toMatchObject({ browserQueuePerTenant: 100, browserQueueTotal: 500, browserQueueWaitMs: 600_000, browserTenantSharePercent: 100 });
    for (const table of [STANDARD_LIMITS, STRICT_LIMITS]) {
      expect(table.browserTenantSharePercent).toBeGreaterThanOrEqual(1);
      expect(table.browserTenantSharePercent).toBeLessThanOrEqual(100);
      // 1 人の待ちが、全体の待ちを超える値にはしない（超えても全体の上限が先に効くだけで、意味がない）
      expect(table.browserQueuePerTenant).toBeLessThanOrEqual(table.browserQueueTotal);
    }
  });

  test('browser_action の値（件数・待ち・間隔・文字数・遷移の待ち・全体の時間・抽出の文字数）: strict は設計の値、standard は緩い値', () => {
    expect(STRICT_LIMITS).toMatchObject({
      browserActionCount: 20,
      browserActionWaitMs: 15_000,
      browserActionDelayMs: 2_000,
      browserActionTextLength: 10_000,
      browserActionTimeoutMs: 60_000,
      browserActionTotalMs: 120_000,
      browserExtractChars: 100_000,
    });
    expect(STANDARD_LIMITS).toMatchObject({
      browserActionCount: 100,
      browserActionWaitMs: 120_000,
      browserActionDelayMs: 10_000,
      browserActionTextLength: 100_000,
      browserActionTimeoutMs: 180_000,
      browserActionTotalMs: 600_000,
      browserExtractChars: 1_000_000,
    });
    for (const table of [STANDARD_LIMITS, STRICT_LIMITS]) {
      // 1 回の待ちや遷移の待ちが、全体の時間を超える値にはしない（超えても、全体の時間が先に効くだけで、意味がない）
      expect(table.browserActionWaitMs).toBeLessThanOrEqual(table.browserActionTotalMs);
      expect(table.browserActionTimeoutMs).toBeLessThanOrEqual(table.browserActionTotalMs);
    }
  });

  test('ブラウザセッションの数の値（利用者ごと・全体）: strict は利用者ごとに 5・全体 20、standard は利用者ごとも全体と同じ 20（利用者が 1 人なら、今までと同じ）', () => {
    expect(STRICT_LIMITS).toMatchObject({ browserSessionsPerTenant: 5, browserSessionsTotal: 20 });
    expect(STANDARD_LIMITS).toMatchObject({ browserSessionsPerTenant: 20, browserSessionsTotal: 20 });
    for (const table of [STANDARD_LIMITS, STRICT_LIMITS]) {
      // 1 人の上限が、全体を超える値にはしない（超えても、全体の上限が先に効くだけで、意味がない）
      expect(table.browserSessionsPerTenant).toBeLessThanOrEqual(table.browserSessionsTotal);
    }
  });

  test('すべての値は正の整数。standard は strict より緩い（同じか大きい）', () => {
    const keys = Object.keys(STRICT_LIMITS) as Array<keyof typeof STRICT_LIMITS>;
    expect(keys.toSorted()).toEqual((Object.keys(STANDARD_LIMITS) as Array<keyof typeof STANDARD_LIMITS>).toSorted());
    for (const key of keys) {
      expect(Number.isInteger(STRICT_LIMITS[key]) && STRICT_LIMITS[key] > 0, `strict.${key}`).toBe(true);
      expect(Number.isInteger(STANDARD_LIMITS[key]) && STANDARD_LIMITS[key] > 0, `standard.${key}`).toBe(true);
      expect(STANDARD_LIMITS[key], key).toBeGreaterThanOrEqual(STRICT_LIMITS[key]);
    }
  });

  test('値の組は書き換えられない（呼び出し側が、共有の値を壊さない）', () => {
    expect(Object.isFrozen(STANDARD_LIMITS)).toBe(true);
    expect(Object.isFrozen(STRICT_LIMITS)).toBe(true);
  });
});
