import { beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getCacheMetrics, getFromCache, setToCache } from '../cache.js';
import { getSecurityMetrics, resetSecurityMetrics } from './metrics.js';
import { getFromTenantCache, setToTenantCache } from './tenant_cache.js';
import { markTenantStateUsed, tenantCacheKey, trackTenantState } from './tenant_state.js';

/**
 * tenant の保存済みの状態で得た結果の、キャッシュの読み書き（設計 5。穴 16・17）。
 * scrapeUrl・integratedSearch・mapSiteUrl・searchWebForRest が、同じ規則で使う。
 */

const key = () => `tenant-cache:${randomUUID()}`;

beforeEach(() => resetSecurityMetrics());

describe('setToTenantCache: 取得が、tenant の保存済みの状態を使ったかで、置く先が決まる', () => {
  test('状態を使わなかった結果は、共有のキーに置く（tenant のキーには置かない）', async () => {
    const k = key();
    await trackTenantState(async () => setToTenantCache('name:alice', k, { v: 'public' }));
    expect(getFromCache(k)).toMatchObject({ v: 'public' });
    expect(getFromCache(tenantCacheKey('name:alice', k))).toBeNull();
    expect(getSecurityMetrics().sora_tenant_cache_write_total ?? 0).toBe(0); // 数えるのは、tenant のキーに置いたときだけ（増えるまで、項目が無い）
  });

  test('状態を使った結果は、その tenant のキーにだけ置く（共有のキーには置かない）。数える', async () => {
    const k = key();
    await trackTenantState(async () => {
      markTenantStateUsed();
      setToTenantCache('name:alice', k, { v: 'private' });
    });
    expect(getFromCache(tenantCacheKey('name:alice', k))).toMatchObject({ v: 'private' });
    expect(getFromCache(k)).toBeNull();
    expect(getFromCache(tenantCacheKey('name:bob', k))).toBeNull();
    expect(getSecurityMetrics().sora_tenant_cache_write_total).toBe(1);
  });

  test('印を集める範囲の外では、状態を使っていない扱い（共有のキー）', () => {
    const k = key();
    setToTenantCache('name:alice', k, { v: 'outside' });
    expect(getFromCache(k)).toMatchObject({ v: 'outside' });
  });

  test('有効期間（ミリ秒）を、そのまま渡す。省くと、既定', async () => {
    const [short, long] = [key(), key()];
    await trackTenantState(async () => {
      setToTenantCache('name:alice', short, { v: 1 }, 5);
      setToTenantCache('name:alice', long, { v: 2 });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(getFromCache(short)).toBeNull();
    expect(getFromCache(long)).toMatchObject({ v: 2 });
  });
});

describe('getFromTenantCache: その tenant のキー、共有のキーの順に読む', () => {
  test('tenant のキーがあれば、そちらを返す（共有のキーより先）', () => {
    const k = key();
    setToCache(tenantCacheKey('name:alice', k), { v: 'own' });
    setToCache(k, { v: 'shared' });
    expect(getFromTenantCache('name:alice', k)).toMatchObject({ v: 'own', cached: true });
  });

  test('tenant のキーが無ければ、共有のキーを返す。別の tenant のキーは読まない', () => {
    const k = key();
    setToCache(tenantCacheKey('name:bob', k), { v: 'bob' });
    expect(getFromTenantCache('name:alice', k)).toBeNull();
    setToCache(k, { v: 'shared' });
    expect(getFromTenantCache('name:alice', k)).toMatchObject({ v: 'shared', cached: true });
  });

  test('外れは 1 回の読みにつき 1 回だけ数える（tenant のキーと共有のキーで 2 回にしない）。当たりは数える', () => {
    const k = key();
    const before = getCacheMetrics();
    expect(getFromTenantCache('name:alice', k)).toBeNull();
    expect(getCacheMetrics().misses).toBe(before.misses + 1);
    setToCache(k, { v: 1 });
    expect(getFromTenantCache('name:alice', k)).not.toBeNull();
    expect(getCacheMetrics().hits).toBe(before.hits + 1);
    expect(getCacheMetrics().misses).toBe(before.misses + 1);
  });
});
