import type { MetricObservation, ObservationOrigin } from './types.js';

/** baseline への適合性は origin で決まる。ad-hoc な問い合わせは除外する。 */
export function isBaselineEligible(origin: ObservationOrigin): boolean {
  return origin === 'provider_historical' || origin === 'scheduled_local';
}

export function toMetricObservation(input: {
  regionId: string;
  metricKey: string;
  metricKind: MetricObservation['metricKind'];
  window: string;
  bucketStart?: string;
  bucketEnd?: string;
  observedAt: string;
  currentValue: number;
  origin: ObservationOrigin;
  providerIds: string[];
  evidenceIds: string[];
}): MetricObservation {
  return { ...input, baselineEligible: isBaselineEligible(input.origin) };
}

/** baseline 用の系列を作る。ad-hoc 観測は値として混ぜない。 */
export function toBaselineSamples(observations: readonly MetricObservation[]): number[] {
  return observations
    .filter((observation) => observation.baselineEligible && Number.isFinite(observation.currentValue))
    .map((observation) => observation.currentValue);
}
