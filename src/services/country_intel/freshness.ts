import type { SourceState } from './detail.js';

export type DataState = 'fresh' | 'stale' | 'unknown' | 'clock_anomaly';

const CLOCK_SKEW_MS = 60_000;

export function classifyFreshness(state: SourceState, now: number, maxAgeMs: number): DataState {
  const updatedAt = state.providerUpdatedAt ? Date.parse(state.providerUpdatedAt) : Number.NaN;
  if (Number.isFinite(updatedAt) && updatedAt > now + CLOCK_SKEW_MS) return 'clock_anomaly';
  const successAt = state.lastSuccessfulFetchAt ? Date.parse(state.lastSuccessfulFetchAt) : Number.NaN;
  if (Number.isFinite(successAt) && now - successAt <= maxAgeMs) return 'fresh';
  const checkedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : Number.NaN;
  if (Number.isFinite(checkedAt) && now - checkedAt <= maxAgeMs) return 'stale';
  return 'unknown';
}
