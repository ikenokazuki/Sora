import { expect, test } from 'bun:test';
import { deriveIntelligenceSignal, type SignalInput } from './signals.js';

function input(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    metricKey: 'protest_event_count',
    regionId: 'country:KR',
    value: 4,
    window: '7d',
    observedAt: '2026-09-19T00:00:00Z',
    origin: 'provider_historical',
    evidenceIds: ['ev-1'],
    providerIds: ['gdelt'],
    coverage: 'good',
    baselineSamples: [1, 2, 2, 3, 4, 2, 3, 2, 1, 3, 2, 4, 3, 2],
    ...overrides,
  };
}

test('insufficient baseline never becomes elevated', () => {
  const signal = deriveIntelligenceSignal(input({ baselineSamples: [3, 4] }));
  expect(signal.activityState).toBe('insufficient');
  expect(signal.anomalyZ).toBeUndefined();
});

test('zero baseline may produce new_activity without fake z-score', () => {
  const signal = deriveIntelligenceSignal(input({ baselineSamples: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
  expect(signal.activityState).toBe('new_activity');
  expect(signal.anomalyZ).toBeUndefined();
});

test('ad-hoc observations are excluded from baseline', () => {
  const signal = deriveIntelligenceSignal(input({ origin: 'ad_hoc' }));
  expect(signal.activityState).toBe('insufficient');
  expect(signal.baseline?.sampleCount).toBe(0);
});

test('provider provenance is preserved in signal', () => {
  const signal = deriveIntelligenceSignal(input());
  expect(signal.providerIds).toEqual(['gdelt']);
  expect(signal.evidenceIds).toEqual(['ev-1']);
});

test('limited coverage is preserved in signal', () => {
  const signal = deriveIntelligenceSignal(input({ coverage: 'limited' }));
  expect(signal.coverage).toBe('limited');
});

test('level metric is not anomaly-scored without a defined transform', () => {
  const signal = deriveIntelligenceSignal(input({
    metricKey: 'gdp_nominal',
    value: 1712345678901.5,
    baselineSamples: [1500000000000, 1600000000000, 1650000000000, 1680000000000, 1700000000000],
  }));
  expect(signal.anomalyZ).toBeUndefined();
  expect(['baseline', 'insufficient']).toContain(signal.activityState);
});
