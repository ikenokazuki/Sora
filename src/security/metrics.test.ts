import { describe, expect, test } from 'bun:test';
import { incrementSecurityCounter, getSecurityMetrics, resetSecurityMetrics } from './metrics.js';

describe('security metrics', () => {
  test('counters accumulate and reset in isolation', () => {
    resetSecurityMetrics();
    incrementSecurityCounter('sora_search_queries_total');
    incrementSecurityCounter('sora_search_queries_total', 2);
    incrementSecurityCounter('sora_x_wave_total');
    const m = getSecurityMetrics();
    expect(m['sora_search_queries_total']).toBe(3);
    expect(m['sora_x_wave_total']).toBe(1);
    resetSecurityMetrics();
    expect(getSecurityMetrics()).toEqual({});
  });
});
