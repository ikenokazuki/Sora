import { describe, expect, test } from 'bun:test';
import {
  ProviderPressureController,
  getYahooQueryBudget,
  type ProviderPressureOptions,
} from './provider_pressure.js';

const opts = (): ProviderPressureOptions => ({
  minSpacingMs: 150,
  initialSpacingMs: 400,
  maxSpacingMs: 5000,
  increaseStepMs: 50,
  decreaseMultiplier: 2,
  circuitThreshold: 3,
  circuitCooldownMs: 15_000,
  windowMs: 30_000,
});

describe('provider pressure controller', () => {
  test('success slowly decreases spacing toward the floor', () => {
    const c = new ProviderPressureController(opts());
    expect(c.snapshot(0).spacingMs).toBe(400);
    c.onSuccess(10);
    expect(c.snapshot(10).spacingMs).toBe(350);
    for (let t = 20; t < 200; t += 10) c.onSuccess(t);
    expect(c.snapshot(200).spacingMs).toBe(150);
  });

  test('429 increases spacing geometrically up to the ceiling', () => {
    const c = new ProviderPressureController(opts());
    c.onRateLimit(undefined, 0);
    expect(c.snapshot(0).spacingMs).toBe(800);
    c.onRateLimit(undefined, 10);
    expect(c.snapshot(10).spacingMs).toBe(1600);
    for (let t = 20; t < 200; t += 10) c.onRateLimit(undefined, t);
    expect(c.snapshot(200).spacingMs).toBe(5000);
  });

  test('Retry-After updates cooldownUntil', () => {
    const c = new ProviderPressureController(opts());
    c.onRateLimit(2000, 1000);
    expect(c.snapshot(1000).cooldownUntil).toBe(3000);
    expect(c.canRequest(2000)).toBe(false);
    expect(c.canRequest(3000)).toBe(true);
  });

  test('old 429s leave the sliding window', () => {
    const c = new ProviderPressureController({ ...opts(), circuitThreshold: 99 });
    c.onRateLimit(undefined, 0);
    c.onRateLimit(undefined, 1000);
    expect(c.snapshot(2000).recentRateLimits).toBe(2);
    expect(c.snapshot(2000).level).toBe('high');
    // Window expiry drops the 429 count, but spacing only recovers via successes.
    expect(c.snapshot(40_000).recentRateLimits).toBe(0);
    expect(c.snapshot(40_000).level).toBe('high');
    for (let t = 40_010; t < 41_000; t += 10) c.onSuccess(t);
    expect(c.snapshot(41_000).level).toBe('low');
  });

  test('circuit opens at threshold and half-opens after cooldown', () => {
    const c = new ProviderPressureController(opts());
    c.onRateLimit(undefined, 0);
    c.onRateLimit(undefined, 100);
    expect(c.snapshot(100).circuit).toBe('closed');
    c.onRateLimit(undefined, 200);
    const opened = c.snapshot(200);
    expect(opened.circuit).toBe('open');
    expect(c.canRequest(300)).toBe(false);
    // Cooldown expiry admits exactly one probe.
    expect(c.canRequest(200 + 15_000)).toBe(true);
    expect(c.snapshot(200 + 15_000).circuit).toBe('half-open');
  });

  test('half-open success closes, half-open 429 reopens', () => {
    const c = new ProviderPressureController(opts());
    c.onRateLimit(undefined, 0);
    c.onRateLimit(undefined, 100);
    c.onRateLimit(undefined, 200);
    expect(c.canRequest(200 + 15_000)).toBe(true);
    c.onSuccess(200 + 15_000);
    expect(c.snapshot(200 + 15_000).circuit).toBe('closed');
    c.onRateLimit(undefined, 300 + 15_000);
    c.onRateLimit(undefined, 400 + 15_000);
    c.onRateLimit(undefined, 500 + 15_000);
    expect(c.canRequest(600 + 15_000)).toBe(false);
  });

  test('query budget follows pressure level', () => {
    expect(getYahooQueryBudget('low')).toBe(3);
    expect(getYahooQueryBudget('medium')).toBe(2);
    expect(getYahooQueryBudget('high')).toBe(1);
  });

  test('level thresholds combine recent 429s and spacing', () => {
    const c = new ProviderPressureController(opts());
    expect(c.getLevel(0)).toBe('low');
    c.onRateLimit(undefined, 0);
    expect(c.getLevel(0)).toBe('medium');
    c.onRateLimit(undefined, 10);
    expect(c.getLevel(10)).toBe('high');
  });
});
