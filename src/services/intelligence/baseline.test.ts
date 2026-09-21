import { expect, test } from 'bun:test';
import { computeBaselineDeviation } from './baseline.js';

test('uses modified MAD z-score', () => {
  const result = computeBaselineDeviation(4, [1, 2, 2, 3, 4]);
  expect(result.anomalyZ).toBeCloseTo(1.349, 3);
});

test('does not turn one event after a zero baseline into max z-score', () => {
  const result = computeBaselineDeviation(1, [0, 0, 0, 0, 0, 0, 0]);
  expect(result.anomalyZ).toBeUndefined();
  expect(result.zeroBaseline).toBe(true);
});

test('marks sample shortage as insufficient instead of a normal state', () => {
  const result = computeBaselineDeviation(5, [4, 6], { minSamples: 14 });
  expect(result.insufficient).toBe(true);
  expect(result.anomalyZ).toBeUndefined();
});
