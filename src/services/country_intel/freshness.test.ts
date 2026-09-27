import { describe, expect, test } from 'bun:test';
import { classifyFreshness } from './freshness.js';

describe('freshness', () => {
  test('unknown update time is not converted into fresh publication', () => {
    expect(classifyFreshness({ sourceId: 'feed' }, Date.now(), 60_000)).toBe('unknown');
  });

  test('future observation timestamp is explicit', () => {
    const now = Date.parse('2026-09-22T00:00:00Z');
    expect(classifyFreshness({ sourceId: 'gdelt', providerUpdatedAt: '2026-09-22T00:15:00Z' }, now, 60_000)).toBe('clock_anomaly');
  });

  test('recent success is fresh, recent check without success is stale', () => {
    const now = Date.parse('2026-09-22T00:10:00Z');
    expect(classifyFreshness({ sourceId: 'a', lastSuccessfulFetchAt: '2026-09-22T00:09:00Z' }, now, 120_000)).toBe('fresh');
    expect(classifyFreshness({ sourceId: 'b', lastCheckedAt: '2026-09-22T00:09:00Z' }, now, 120_000)).toBe('stale');
  });
});
