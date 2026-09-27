import { describe, expect, test, beforeEach } from 'bun:test';
import {
  setYahooSearchCache,
  getYahooFreshCache,
  getYahooStaleCache,
  clearYahooSearchCache,
} from './yahoo_cache.js';

beforeEach(() => {
  clearYahooSearchCache();
});

describe('yahoo search stale cache', () => {
  test('fresh window serves fresh only', () => {
    setYahooSearchCache('k', { items: [1] }, 1000, 5000, 0);
    expect(getYahooFreshCache<{ items: number[] }>('k', 500)).toEqual({ items: [1] });
    expect(getYahooStaleCache<{ items: number[] }>('k', 500)).toBeNull();
  });

  test('stale window serves stale only', () => {
    setYahooSearchCache('k', { items: [1] }, 1000, 5000, 0);
    expect(getYahooFreshCache<{ items: number[] }>('k', 2000)).toBeNull();
    expect(getYahooStaleCache<{ items: number[] }>('k', 2000)).toEqual({ items: [1] });
  });

  test('entries past staleUntil are dropped', () => {
    setYahooSearchCache('k', { items: [1] }, 1000, 5000, 0);
    expect(getYahooStaleCache<{ items: number[] }>('k', 6000)).toBeNull();
    expect(getYahooFreshCache<{ items: number[] }>('k', 6000)).toBeNull();
  });

  test('missing keys miss on both windows', () => {
    expect(getYahooFreshCache<{ items: number[] }>('nope', 0)).toBeNull();
    expect(getYahooStaleCache<{ items: number[] }>('nope', 0)).toBeNull();
  });
});
