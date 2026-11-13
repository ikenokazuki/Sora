import { describe, expect, test } from 'bun:test';
import { getCacheMetrics, getFromCache, setToCache } from './cache.js';
import { clearTenantCache } from './cache.js';
import { CLEAR_CACHE_BY_PREFIX_SQL, dbClearCacheByPrefix, dbGetCache, dbSetCache, getDb } from './db.js';
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

describe('dbClearCacheByPrefix: 主キーの索引で範囲を引く（管理者でない利用者が何度呼んでも、表の全体を走査しない）', () => {
  test('文は索引で引く（SEARCH）。全体の走査（SCAN）ではない', () => {
    const plan = getDb().query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${CLEAR_CACHE_BY_PREFIX_SQL}`).all('a', 'b').map((row) => row.detail).join('\n');
    expect(plan).toMatch(/SEARCH/);
    expect(plan).not.toMatch(/SCAN/);
  });

  test('範囲の端: 前置きと同じキー・前置きの直後の文字のキー・前置きより小さいキーは、正しく扱う', () => {
    const prefix = tenantCacheKey('name:clear-edge', '');
    const inside = [prefix, `${prefix}x`, `${prefix}\u3042\u{1F600}`];
    // 前置きの最後の ':' の次の文字（';'）で始まるキーと、前置きの手前のキーは、範囲の外
    const outside = [`${prefix.slice(0, -1)};x`, `${prefix.slice(0, -1)}`, `${prefix.slice(0, -2)}x:x`];
    for (const key of [...inside, ...outside]) dbSetCache(key, { v: key }, 600);
    dbClearCacheByPrefix(prefix);
    for (const key of inside) expect(dbGetCache(key), key).toBeUndefined();
    for (const key of outside) expect(dbGetCache(key), key).toBeDefined();
    for (const key of outside) dbClearCacheByPrefix(key);
  });

  test('空の前置きでは、何も消さない（全消去にしない）', () => {
    dbSetCache('clear:empty-prefix', { v: 1 }, 600);
    expect(dbClearCacheByPrefix('')).toBe(0);
    expect(dbGetCache('clear:empty-prefix')).toBeDefined();
    dbClearCacheByPrefix('clear:empty-prefix');
  });
});

