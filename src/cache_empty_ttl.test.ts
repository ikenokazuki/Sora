import { describe, expect, test } from 'bun:test';
import { CACHE_TTL_DEFAULT, CACHE_TTL_EMPTY, isEmptySearchResult, searchCacheTtl } from './cache.js';

describe('empty search answers are kept only briefly', () => {
  test('items, results or count say the answer is empty', () => {
    expect(isEmptySearchResult({ items: [], count: 0 })).toBe(true);
    expect(isEmptySearchResult({ results: [] })).toBe(true);
    expect(isEmptySearchResult({ count: 0 })).toBe(true);
    expect(isEmptySearchResult({ items: [{ url: 'https://e/a' }], count: 1 })).toBe(false);
    expect(isEmptySearchResult({ results: [{ url: 'https://e/a' }] })).toBe(false);
  });

  test('things that are not search answers are never called empty', () => {
    expect(isEmptySearchResult(null)).toBe(false);
    expect(isEmptySearchResult(undefined)).toBe(false);
    expect(isEmptySearchResult('x')).toBe(false);
    expect(isEmptySearchResult({})).toBe(false);
    expect(isEmptySearchResult({ count: 3 })).toBe(false);
  });

  test('an empty answer gets the short TTL, any other the default', () => {
    expect(CACHE_TTL_EMPTY).toBeLessThan(CACHE_TTL_DEFAULT);
    expect(CACHE_TTL_EMPTY).toBeGreaterThan(0);
    expect(searchCacheTtl({ items: [] })).toBe(CACHE_TTL_EMPTY);
    expect(searchCacheTtl({ items: [{ url: 'https://e/a' }] })).toBe(CACHE_TTL_DEFAULT);
  });
});
