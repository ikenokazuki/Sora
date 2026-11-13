import { describe, expect, test } from 'bun:test';
import { getCacheMetrics, getFromCache, setToCache } from './cache.js';
import { clearTenantCache } from './cache.js';
import { dbGetCache, dbSetCache } from './db.js';
import { tenantCacheKey } from './security/tenant_state.js';

/**
 * その tenant のキャッシュだけを消す（設計 5。穴 19）。tenant の保存済みの状態で得た結果は、`tenant:<ID>:…` のキーに置かれる。
 * 共有のキー（状態を使わずに得た結果）と、ほかの tenant のキーは、残す。
 */

const alice = 'name:clear-alice';
const bob = 'name:clear-bob';

describe('clearTenantCache', () => {
  test('メモリから、その tenant のキーだけを消し、消した数を返す。共有のキーと、ほかの tenant のキーは残る', () => {
    setToCache(tenantCacheKey(alice, 'clear:k1'), { v: 'a1' });
    setToCache(tenantCacheKey(alice, 'clear:k2'), { v: 'a2' });
    setToCache(tenantCacheKey(bob, 'clear:k1'), { v: 'b1' });
    setToCache('clear:shared', { v: 'shared' });
    expect(clearTenantCache(alice)).toBe(2);
    expect(getFromCache(tenantCacheKey(alice, 'clear:k1'))).toBeNull();
    expect(getFromCache(tenantCacheKey(alice, 'clear:k2'))).toBeNull();
    expect(getFromCache(tenantCacheKey(bob, 'clear:k1'))).toMatchObject({ v: 'b1' });
    expect(getFromCache('clear:shared')).toMatchObject({ v: 'shared' });
    expect(clearTenantCache(alice)).toBe(0);
    clearTenantCache(bob);
  });

  test('DB（L2）からも消す。メモリに無く DB にだけある行も', () => {
    const own = tenantCacheKey(alice, 'clear:db-own');
    const other = tenantCacheKey(bob, 'clear:db-other');
    dbSetCache(own, { v: 'own' }, 600);
    dbSetCache(other, { v: 'other' }, 600);
    dbSetCache('clear:db-shared', { v: 'shared' }, 600);
    clearTenantCache(alice);
    expect(dbGetCache(own)).toBeUndefined();
    expect(dbGetCache(other)).toBeDefined();
    expect(dbGetCache('clear:db-shared')).toBeDefined();
    clearTenantCache(bob);
    expect(dbGetCache(other)).toBeUndefined();
  });

  test('名前の先頭が同じ別の tenant（name:a と name:ab）や、_ と % を含む名前（ワイルドカードにしない）を巻き込まない', () => {
    const [a, ab, under, other] = ['name:clear-a', 'name:clear-ab', 'name:clear_x', 'name:clearzx'];
    for (const id of [a, ab, under, other]) {
      setToCache(tenantCacheKey(id, 'clear:k'), { v: id });
      dbSetCache(tenantCacheKey(id, 'clear:db'), { v: id }, 600);
    }
    clearTenantCache(a);
    expect(getFromCache(tenantCacheKey(a, 'clear:k'))).toBeNull();
    expect(getFromCache(tenantCacheKey(ab, 'clear:k'))).not.toBeNull();
    expect(dbGetCache(tenantCacheKey(a, 'clear:db'))).toBeUndefined();
    expect(dbGetCache(tenantCacheKey(ab, 'clear:db'))).toBeDefined();
    clearTenantCache(under);
    expect(getFromCache(tenantCacheKey(under, 'clear:k'))).toBeNull();
    expect(getFromCache(tenantCacheKey(other, 'clear:k'))).not.toBeNull(); // _ は、任意の 1 文字ではない
    expect(dbGetCache(tenantCacheKey(other, 'clear:db'))).toBeDefined();
    for (const id of [ab, other]) clearTenantCache(id);
  });

  test('全体の統計（hits・misses）は、消さない', () => {
    setToCache(tenantCacheKey(alice, 'clear:stat'), { v: 1 });
    getFromCache(tenantCacheKey(alice, 'clear:stat'));
    getFromCache('clear:stat-miss');
    const before = getCacheMetrics();
    expect(before.hits + before.misses).toBeGreaterThan(0);
    clearTenantCache(alice);
    const after = getCacheMetrics();
    expect(after.hits).toBe(before.hits);
    expect(after.misses).toBe(before.misses);
  });
});
