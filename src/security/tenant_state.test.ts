import { describe, expect, test } from 'bun:test';
import { markTenantStateUsed, tenantCacheKey, tenantStateUsed, trackTenantState } from './tenant_state.js';

describe('trackTenantState: 取得が tenant の保存済みの状態を使ったかを集める', () => {
  test('印が立たなければ used は false。値はそのまま返す', async () => {
    expect(await trackTenantState(async () => 42)).toEqual({ value: 42, used: false });
  });

  test('範囲の外で印を立てても、例外にならず、何も起きない', () => {
    expect(() => markTenantStateUsed()).not.toThrow();
    expect(tenantStateUsed()).toBe(false);
  });

  test('範囲の中では、tenantStateUsed が、いまの印を返す', async () => {
    const seen: boolean[] = [];
    const result = await trackTenantState(async () => {
      seen.push(tenantStateUsed());
      markTenantStateUsed();
      seen.push(tenantStateUsed());
    });
    expect(seen).toEqual([false, true]);
    expect(result.used).toBe(true);
    expect(tenantStateUsed()).toBe(false); // 範囲を出たら、外の印は無い
  });

  test('await をまたいでも、Promise.all の枝の中でも、setTimeout のあとでも、印は範囲に届く', async () => {
    const result = await trackTenantState(async () => {
      await Promise.all([
        Promise.resolve(),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          markTenantStateUsed();
        })(),
      ]);
      return 'done';
    });
    expect(result).toEqual({ value: 'done', used: true });
  });

  test('内側の範囲の印は、外側にも伝わる。外側の印は、終わった内側には影響しない', async () => {
    let inner: { used: boolean } | undefined;
    let innerQuiet: { used: boolean } | undefined;
    const outer = await trackTenantState(async () => {
      innerQuiet = await trackTenantState(async () => undefined);
      inner = await trackTenantState(async () => markTenantStateUsed());
      markTenantStateUsed();
    });
    expect(innerQuiet?.used).toBe(false); // 印が立つ前に終わった内側
    expect(inner?.used).toBe(true);
    expect(outer.used).toBe(true);

    const onlyInner = await trackTenantState(async () => {
      await trackTenantState(async () => markTenantStateUsed());
    });
    expect(onlyInner.used).toBe(true); // 内側だけが立てても、外側に届く

    const onlyOuter = await trackTenantState(async () => {
      const quiet = await trackTenantState(async () => undefined);
      markTenantStateUsed();
      return quiet.used;
    });
    expect(onlyOuter).toEqual({ value: false, used: true });
  });

  test('並行する範囲は、互いに影響しない', async () => {
    const [a, b] = await Promise.all([
      trackTenantState(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        markTenantStateUsed();
      }),
      trackTenantState(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }),
    ]);
    expect(a.used).toBe(true);
    expect(b.used).toBe(false);
  });

  test('例外が出ても範囲は閉じ、あとの範囲に影響しない', async () => {
    await expect(trackTenantState(async () => {
      markTenantStateUsed();
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(tenantStateUsed()).toBe(false);
    expect((await trackTenantState(async () => 1)).used).toBe(false);
  });
});

describe('tenantCacheKey: tenant の状態で得た結果のキャッシュのキー', () => {
  test('tenant ごとに別で、共有のキーと混ざらない。前置きから、tenant の分を探せる', () => {
    const shared = 'scrape:v11:https://example.com/:abc';
    expect(tenantCacheKey('name:alice', shared)).toBe(`tenant:name:alice:${shared}`);
    expect(tenantCacheKey('name:alice', shared)).not.toBe(tenantCacheKey('name:bob', shared));
    expect(tenantCacheKey('name:alice', shared)).not.toBe(shared);
    expect(tenantCacheKey('name:alice', shared).startsWith('tenant:name:alice:')).toBe(true);
  });
});
