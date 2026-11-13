import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getCacheMetrics, getFromCache, setToCache } from './cache.js';

describe('getFromCache の countMiss（tenant のキーを先に読み、外れたら共有のキーを読むとき、1 回の読みを 2 回の外れにしない）', () => {
  const key = () => `count-miss:${randomUUID()}`;

  test('既定では、外れを数える', () => {
    const before = getCacheMetrics().misses;
    expect(getFromCache(key())).toBeNull();
    expect(getCacheMetrics().misses).toBe(before + 1);
  });

  test('countMiss: false では、無いキーの外れを数えない', () => {
    const before = getCacheMetrics().misses;
    expect(getFromCache(key(), { countMiss: false })).toBeNull();
    expect(getCacheMetrics().misses).toBe(before);
  });

  test('countMiss: false では、期限が切れたキーの外れも数えない。既定では数える', async () => {
    const [a, b] = [key(), key()];
    setToCache(a, { v: 1 }, 5);
    setToCache(b, { v: 2 }, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = getCacheMetrics().misses;
    expect(getFromCache(a, { countMiss: false })).toBeNull();
    expect(getCacheMetrics().misses).toBe(before);
    expect(getFromCache(b)).toBeNull();
    expect(getCacheMetrics().misses).toBe(before + 1);
  });

  test('当たりは、どちらでも数える', () => {
    const k = key();
    setToCache(k, { v: 1 });
    const before = getCacheMetrics().hits;
    expect(getFromCache(k, { countMiss: false })).toMatchObject({ v: 1, cached: true });
    expect(getCacheMetrics().hits).toBe(before + 1);
  });
});
