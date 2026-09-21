/** 非LLM分析基盤の共有型。すべて deterministic / explainable / reproducible。 */
import { z } from 'zod';

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

const SignalCoverageSchema = z.enum(['good', 'partial', 'limited']);

export const IntelligenceSignalSchema = z.object({
  key: z.string(),
  regionId: z.string(),
  kind: z.enum(['count', 'rate', 'share', 'level', 'change']),
  value: z.number(),
  window: z.string(),
  observedAt: z.string(),
  baseline: z.object({
    median: z.number(),
    mad: z.number().optional(),
    sampleCount: z.number(),
    origin: z.string(),
  }).optional(),
  anomalyZ: z.number().optional(),
  activityState: z.enum(['insufficient', 'baseline', 'elevated', 'spike', 'suppressed', 'new_activity']),
  evidenceIds: z.array(z.string()),
  providerIds: z.array(z.string()),
  coverage: SignalCoverageSchema,
});

const domainBucket = z.array(IntelligenceSignalSchema);

export const DomainViewsSchema = z.object({
  content: z.object({
    regionId: z.string(),
    attention: domainBucket,
    disaster: domainBucket,
    socialActivity: domainBucket,
    calendar: domainBucket,
    coverage: SignalCoverageSchema,
  }),
  marketing: z.object({
    regionId: z.string(),
    attention: domainBucket,
    businessActivity: domainBucket,
    calendar: domainBucket,
    socialActivity: domainBucket,
    disruption: domainBucket,
    coverage: SignalCoverageSchema,
  }),
  travel: z.object({
    regionId: z.string(),
    disruptionSignals: domainBucket,
    disasterSignals: domainBucket,
    healthSignals: domainBucket,
    calendarSignals: domainBucket,
    coverage: SignalCoverageSchema,
  }),
  finance: z.object({
    regionId: z.string(),
    economy: domainBucket,
    trade: domainBucket,
    businessAction: domainBucket,
    policyActivity: domainBucket,
    coverage: SignalCoverageSchema,
  }),
});
