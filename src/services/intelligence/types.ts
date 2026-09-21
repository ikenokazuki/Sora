/** 非LLM分析基盤の共有型。すべて deterministic / explainable / reproducible。 */

export type MetricKind = 'count' | 'rate' | 'share' | 'level' | 'change';

export type BaselineMode = 'provider_history' | 'scheduled_local' | 'none';

export interface MetricDefinition {
  key: string;
  kind: MetricKind;
  baselineMode: BaselineMode;
  minBaselineSamples: number;
}

export type ObservationOrigin = 'provider_historical' | 'scheduled_local' | 'ad_hoc';

export interface MetricObservation {
  regionId: string;
  metricKey: string;
  metricKind: MetricKind;
  window: string;
  bucketStart?: string;
  bucketEnd?: string;
  observedAt: string;
  currentValue: number;
  origin: ObservationOrigin;
  baselineEligible: boolean;
  providerIds: string[];
  evidenceIds: string[];
}

export type ActivityState =
  | 'insufficient'
  | 'baseline'
  | 'elevated'
  | 'spike'
  | 'suppressed'
  | 'new_activity';

export interface IntelligenceSignal {
  key: string;
  regionId: string;
  kind: MetricKind;
  value: number;
  window: string;
  observedAt: string;
  baseline?: {
    median: number;
    mad?: number;
    sampleCount: number;
    origin: string;
  };
  anomalyZ?: number;
  activityState: ActivityState;
  evidenceIds: string[];
  providerIds: string[];
  coverage: 'good' | 'partial' | 'limited';
}
