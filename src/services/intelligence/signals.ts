import { computeBaselineDeviation } from './baseline.js';
import { getMetricDefinition } from './metric_registry.js';
import type { ActivityState, IntelligenceSignal, ObservationOrigin } from './types.js';

export interface SignalInput {
  metricKey: string;
  regionId: string;
  value: number;
  window: string;
  observedAt: string;
  origin: ObservationOrigin;
  evidenceIds: string[];
  providerIds: string[];
  coverage: IntelligenceSignal['coverage'];
  baselineSamples?: readonly number[];
  baselineOrigin?: string;
}

function stateForZ(anomalyZ: number): ActivityState {
  const magnitude = Math.abs(anomalyZ);
  if (magnitude < 1) return 'baseline';
  if (magnitude < 3) return 'elevated';
  return anomalyZ > 0 ? 'spike' : 'suppressed';
}

/** 観測値と履歴から evidence-backed な activity signal を導出する。推奨・評価は返さない。 */
export function deriveIntelligenceSignal(input: SignalInput): IntelligenceSignal {
  const definition = getMetricDefinition(input.metricKey);
  const base: IntelligenceSignal = {
    key: input.metricKey,
    regionId: input.regionId,
    kind: definition.kind,
    value: input.value,
    window: input.window,
    observedAt: input.observedAt,
    evidenceIds: [...input.evidenceIds],
    providerIds: [...input.providerIds],
    coverage: input.coverage,
    activityState: 'insufficient',
  };
  // level metric は定義済み transform なしに異常スコア化しない。
  if (definition.kind === 'level') return base;
  // ad-hoc な問い合わせ回数は現実の活動量ではない。baseline から除外する。
  const samples = input.origin === 'ad_hoc' ? [] : [...(input.baselineSamples ?? [])];
  const deviation = computeBaselineDeviation(input.value, samples, {
    minSamples: definition.minBaselineSamples,
    origin: input.origin,
  });
  base.baseline = {
    median: deviation.median ?? input.value,
    ...(deviation.mad !== undefined ? { mad: deviation.mad } : {}),
    sampleCount: deviation.sampleCount,
    origin: input.baselineOrigin ?? input.origin,
  };
  if (deviation.insufficient) return base;
  if (deviation.zeroBaseline) {
    base.activityState = input.value === 0 ? 'baseline' : 'new_activity';
    return base;
  }
  base.anomalyZ = deviation.anomalyZ;
  base.activityState = stateForZ(deviation.anomalyZ ?? 0);
  return base;
}
