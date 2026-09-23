import { z } from 'zod';

import { DomainViewsSchema, IntelligenceSignalSchema, type IntelligenceSignal } from '../intelligence/types.js';
import { EvidenceDetailSchema } from './detail.js';

export const COUNTRY_INTEL_TOPICS = [
  'politics', 'elections', 'diplomacy', 'security', 'military', 'protests',
  'political_violence', 'economy', 'trade', 'business', 'disasters', 'health',
  'humanitarian', 'social_issues', 'public_opinion', 'calendar', 'holidays',
  'commemorations', 'foreign_relations', 'japan_related_events', 'media_activity',
  'social_observations',
] as const;

export type CountryIntelTopic = (typeof COUNTRY_INTEL_TOPICS)[number];

export interface CountryContextRequest {
  region: string;
  query?: string;
  topics?: CountryIntelTopic[];
  period?: '7d' | '30d' | '90d';
  includeSocial?: boolean;
  noCache?: boolean;
  verbose?: boolean;
}

export const CountryContextRequestSchema = z.object({
  region: z.string().trim().min(1),
  query: z.string().min(1).optional(),
  topics: z.array(z.enum(COUNTRY_INTEL_TOPICS)).optional(),
  period: z.enum(['7d', '30d', '90d']).default('30d'),
  includeSocial: z.boolean().default(false),
  noCache: z.boolean().default(false),
  verbose: z.boolean().default(false),
});

export interface RegionIdentity {
  id: string;
  name: string;
  nativeName?: string;
  countryCode?: string;
  subdivisionCode?: string;
  parentCountryCode?: string;
  languages: string[];
  aliases: string[];
  timezone?: string;
  confidence: 'low' | 'medium' | 'high';
}

export const RegionIdentitySchema = z.object({
  id: z.string(),
  name: z.string(),
  nativeName: z.string().optional(),
  countryCode: z.string().optional(),
  subdivisionCode: z.string().optional(),
  parentCountryCode: z.string().optional(),
  languages: z.array(z.string()),
  aliases: z.array(z.string()),
  timezone: z.string().optional(),
  confidence: z.enum(['low', 'medium', 'high']),
});

export type EvidenceSourceType =
  | 'official'
  | 'structured_dataset'
  | 'representative_poll'
  | 'research'
  | 'major_local_media'
  | 'local_media'
  | 'international_media'
  | 'social'
  | 'calendar'
  | 'other';

export type EvidenceLatencyClass = 'realtime' | 'near_realtime' | 'delayed' | 'historical';

export type RegionLink = 'direct' | 'related' | 'candidate' | 'unrelated' | 'unknown';
export const RegionLinkSchema = z.enum(['direct', 'related', 'candidate', 'unrelated', 'unknown']);

export interface CountryEvidence {
  id: string;
  regionId: string;
  url: string;
  title?: string;
  publisher?: string;
  publisherCountry?: string;
  eventCountry?: string;
  mentionedCountries?: string[];
  sourceType: EvidenceSourceType;
  language?: string;
  publishedAt?: string;
  retrievedAt: string;
  excerpt?: string;
  contentHash?: string;
  primarySource: boolean;
  latencyClass: EvidenceLatencyClass;
  eventClusterId?: string;
  /** 取得経路。重複排除で失わない。 */
  acquisition?: {
    providerId: string;
    providerItemId?: string;
    query?: string;
    queryTargetedRegion?: boolean;
    collectionScope?: string;
  };
  /** 対象地域との関係。 */
  regionLink?: RegionLink;
  regionLinkReasons?: string[];
}

export const CountryEvidenceSchema = z.object({
  id: z.string(),
  regionId: z.string(),
  url: z.string(),
  title: z.string().optional(),
  publisher: z.string().optional(),
  publisherCountry: z.string().optional(),
  eventCountry: z.string().optional(),
  mentionedCountries: z.array(z.string()).optional(),
  sourceType: z.enum(['official', 'structured_dataset', 'representative_poll', 'research', 'major_local_media', 'local_media', 'international_media', 'social', 'calendar', 'other']),
  language: z.string().optional(),
  publishedAt: z.string().optional(),
  retrievedAt: z.string(),
  excerpt: z.string().optional(),
  contentHash: z.string().optional(),
  primarySource: z.boolean(),
  latencyClass: z.enum(['realtime', 'near_realtime', 'delayed', 'historical']),
  eventClusterId: z.string().optional(),
  acquisition: z.object({
    providerId: z.string(),
    providerItemId: z.string().optional(),
    query: z.string().optional(),
    queryTargetedRegion: z.boolean().optional(),
    collectionScope: z.string().optional(),
  }).optional(),
  regionLink: RegionLinkSchema.optional(),
  regionLinkReasons: z.array(z.string()).optional(),
});

export type ActorType =
  | 'government'
  | 'head_of_state'
  | 'head_of_government'
  | 'foreign_ministry'
  | 'politician'
  | 'political_party'
  | 'parliament'
  | 'military'
  | 'police'
  | 'court'
  | 'company'
  | 'industry_group'
  | 'media'
  | 'journalist'
  | 'ngo'
  | 'protester'
  | 'activist'
  | 'general_public'
  | 'survey_respondent'
  | 'unknown';

export const ACTOR_TYPES = [
  'government', 'head_of_state', 'head_of_government', 'foreign_ministry',
  'politician', 'political_party', 'parliament', 'military', 'police', 'court',
  'company', 'industry_group', 'media', 'journalist', 'ngo', 'protester',
  'activist', 'general_public', 'survey_respondent', 'unknown',
] as const satisfies readonly ActorType[];

export interface IntelEntity {
  name: string;
  type?: ActorType;
  countryCode?: string;
  canonicalId?: string;
}

export const IntelEntitySchema = z.object({
  name: z.string(),
  type: z.enum(ACTOR_TYPES).optional(),
  countryCode: z.string().optional(),
  canonicalId: z.string().optional(),
});

export type TargetType =
  | 'country'
  | 'foreign_government'
  | 'domestic_government'
  | 'people_nationality'
  | 'company'
  | 'product'
  | 'culture'
  | 'historical_entity'
  | 'territory'
  | 'politician'
  | 'political_party'
  | 'policy'
  | 'institution'
  | 'other'
  | 'none'
  | 'unknown';

export const TARGET_TYPES = [
  'country', 'foreign_government', 'domestic_government', 'people_nationality',
  'company', 'product', 'culture', 'historical_entity', 'territory', 'politician',
  'political_party', 'policy', 'institution', 'other', 'none', 'unknown',
] as const satisfies readonly TargetType[];

export interface IntelTarget {
  name: string;
  type: TargetType;
  countryCode?: string;
  canonicalId?: string;
}

export const IntelTargetSchema = z.object({
  name: z.string(),
  type: z.enum(TARGET_TYPES),
  countryCode: z.string().optional(),
  canonicalId: z.string().optional(),
});

export type ActionType =
  | 'statement'
  | 'meeting'
  | 'agreement'
  | 'sanction'
  | 'boycott'
  | 'protest'
  | 'demonstration'
  | 'strike'
  | 'violence'
  | 'threat'
  | 'arrest'
  | 'election'
  | 'legislation'
  | 'military_activity'
  | 'trade_restriction'
  | 'business_action'
  | 'cultural_event'
  | 'memorial_event'
  | 'celebration'
  | 'disaster_response'
  | 'other';

export const ACTION_TYPES = [
  'statement', 'meeting', 'agreement', 'sanction', 'boycott', 'protest',
  'demonstration', 'strike', 'violence', 'threat', 'arrest', 'election',
  'legislation', 'military_activity', 'trade_restriction', 'business_action',
  'cultural_event', 'memorial_event', 'celebration', 'disaster_response', 'other',
] as const satisfies readonly ActionType[];

export interface IntelEvent {
  id: string;
  regionId: string;
  type: ActionType;
  title: string;
  excerpt?: string;
  excerptTruncated?: boolean;
  indicators?: { label: string; value: string }[];
  occurredAt?: string;
  location?: { name?: string; countryCode?: string };
  actors: IntelEntity[];
  targets: IntelTarget[];
  evidenceIds: string[];
  evidenceCount: number;
  independentSourceCount: number;
  primarySourceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  confidence: 'low' | 'medium' | 'high';
}

export const IntelEventSchema = z.object({
  id: z.string(),
  regionId: z.string(),
  type: z.enum(ACTION_TYPES),
  title: z.string(),
  excerpt: z.string().optional(),
  excerptTruncated: z.boolean().optional(),
  indicators: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  occurredAt: z.string().optional(),
  location: z.object({ name: z.string().optional(), countryCode: z.string().optional() }).optional(),
  actors: z.array(IntelEntitySchema),
  targets: z.array(IntelTargetSchema),
  evidenceIds: z.array(z.string()),
  evidenceCount: z.number(),
  independentSourceCount: z.number(),
  primarySourceCount: z.number(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
});

export interface CountrySource {
  id: string;
  regionId: string;
  domain: string;
  sourceType: string;
  discoveredAt: string;
  verifiedAt?: string;
  verificationStatus: 'verified' | 'candidate' | 'rejected' | 'stale';
  discoveryMethod: 'manual_seed' | 'search' | 'rss' | 'sitemap' | 'official_link' | 'wikidata' | 'other';
  verificationBasis?: CountrySourceVerificationBasis;
}

export const CountrySourceVerificationBasisSchema = z.enum([
  'manual_seed', 'official_crosslink', 'trusted_registry', 'availability_only',
]);

export type CountrySourceVerificationBasis = z.infer<typeof CountrySourceVerificationBasisSchema>;

export const CountrySourceSchema = z.object({
  id: z.string(),
  regionId: z.string(),
  domain: z.string(),
  sourceType: z.string(),
  discoveredAt: z.string(),
  verifiedAt: z.string().optional(),
  verificationStatus: z.enum(['verified', 'candidate', 'rejected', 'stale']),
  discoveryMethod: z.enum(['manual_seed', 'search', 'rss', 'sitemap', 'official_link', 'wikidata', 'other']),
  verificationBasis: CountrySourceVerificationBasisSchema.optional(),
});

export type ProviderRunStatus = 'success' | 'partial' | 'unavailable' | 'rate_limited' | 'error';

export interface ProviderRun {
  provider: string;
  startedAt: string;
  finishedAt?: string;
  status: ProviderRunStatus;
  itemCount: number;
  coverage?: string[];
  latencyMs?: number;
  errorCode?: string;
}

export const ProviderRunSchema = z.object({
  provider: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(['success', 'partial', 'unavailable', 'rate_limited', 'error']),
  itemCount: z.number(),
  coverage: z.array(z.string()).optional(),
  latencyMs: z.number().optional(),
  errorCode: z.string().optional(),
});

export interface PollObservation {
  id: string;
  regionId: string;
  pollster: string;
  fieldStart?: string;
  fieldEnd?: string;
  sampleSize?: number;
  population?: string;
  mode?: string;
  question: string;
  responses: { label: string; value: number }[];
  sourceUrl: string;
  evidenceId: string;
}

export const PollObservationSchema = z.object({
  id: z.string(),
  regionId: z.string(),
  pollster: z.string(),
  fieldStart: z.string().optional(),
  fieldEnd: z.string().optional(),
  sampleSize: z.number().optional(),
  population: z.string().optional(),
  mode: z.string().optional(),
  question: z.string(),
  responses: z.array(z.object({ label: z.string(), value: z.number() })),
  sourceUrl: z.string(),
  evidenceId: z.string(),
});

export type CalendarEventType =
  | 'public_holiday'
  | 'official_observance'
  | 'memorial'
  | 'anniversary'
  | 'religious'
  | 'international_observance'
  | 'other';

export interface CalendarEvent {
  id: string;
  date: string;
  title: string;
  type: CalendarEventType;
  official: boolean;
  relatedCountries?: string[];
  sourceUrl: string;
  evidenceId?: string;
}

export const CalendarEventSchema = z.object({
  id: z.string(),
  date: z.string(),
  title: z.string(),
  type: z.enum(['public_holiday', 'official_observance', 'memorial', 'anniversary', 'religious', 'international_observance', 'other']),
  official: z.boolean(),
  relatedCountries: z.array(z.string()).optional(),
  sourceUrl: z.string(),
  evidenceId: z.string().optional(),
});

export type BaselineOrigin = 'external_historical' | 'local_observed' | 'mixed' | 'insufficient';

export interface TemporalMetric {
  key: string;
  current: number;
  window: string;
  baseline?: { median?: number; mad?: number; sampleCount: number; origin: BaselineOrigin };
  anomalyZ?: number;
  direction: 'rising' | 'stable' | 'falling' | 'unknown';
}

export const TemporalMetricSchema = z.object({
  key: z.string(),
  current: z.number(),
  window: z.string(),
  baseline: z.object({
    median: z.number().optional(),
    mad: z.number().optional(),
    sampleCount: z.number(),
    origin: z.enum(['external_historical', 'local_observed', 'mixed', 'insufficient']),
  }).optional(),
  anomalyZ: z.number().optional(),
  direction: z.enum(['rising', 'stable', 'falling', 'unknown']),
});

export interface ForeignRelationContext {
  counterpartCountryCode: string;
  officialEvents: IntelEvent[];
  protestEvents: IntelEvent[];
  tradeEvents: IntelEvent[];
  businessEvents: IntelEvent[];
  culturalEvents: IntelEvent[];
  violenceEvents: IntelEvent[];
  relevantPolls: PollObservation[];
  mediaMetrics: TemporalMetric[];
  recentEventIds: string[];
}

export const ForeignRelationContextSchema = z.object({
  counterpartCountryCode: z.string(),
  officialEvents: z.array(IntelEventSchema),
  protestEvents: z.array(IntelEventSchema),
  tradeEvents: z.array(IntelEventSchema),
  businessEvents: z.array(IntelEventSchema),
  culturalEvents: z.array(IntelEventSchema),
  violenceEvents: z.array(IntelEventSchema),
  relevantPolls: z.array(PollObservationSchema),
  mediaMetrics: z.array(TemporalMetricSchema),
  recentEventIds: z.array(z.string()),
});

export interface JapanContextView {
  countryCode: 'JP';
  officialEvents: IntelEvent[];
  protests: IntelEvent[];
  boycotts: IntelEvent[];
  tradeRestrictions: IntelEvent[];
  culturalEvents: IntelEvent[];
  violenceEvents: IntelEvent[];
  polls: PollObservation[];
  mediaMetrics: TemporalMetric[];
}

export const JapanContextViewSchema = z.object({
  countryCode: z.literal('JP'),
  officialEvents: z.array(IntelEventSchema),
  protests: z.array(IntelEventSchema),
  boycotts: z.array(IntelEventSchema),
  tradeRestrictions: z.array(IntelEventSchema),
  culturalEvents: z.array(IntelEventSchema),
  violenceEvents: z.array(IntelEventSchema),
  polls: z.array(PollObservationSchema),
  mediaMetrics: z.array(TemporalMetricSchema),
});

export type CoverageState = 'good' | 'partial' | 'limited';

export interface CoverageReport {
  overall: CoverageState;
  byArea: {
    politics: CoverageState;
    economy: CoverageState;
    security: CoverageState;
    disaster: CoverageState;
    health: CoverageState;
    polls: CoverageState;
    media: CoverageState;
    social: CoverageState;
    calendar: CoverageState;
    foreignRelations: CoverageState;
  };
  missingEvidence: string[];
  unavailableProviders: string[];
}

const CoverageStateSchema = z.enum(['good', 'partial', 'limited']);

export const CoverageReportSchema = z.object({
  overall: CoverageStateSchema,
  byArea: z.object({
    politics: CoverageStateSchema,
    economy: CoverageStateSchema,
    security: CoverageStateSchema,
    disaster: CoverageStateSchema,
    health: CoverageStateSchema,
    polls: CoverageStateSchema,
    media: CoverageStateSchema,
    social: CoverageStateSchema,
    calendar: CoverageStateSchema,
    foreignRelations: CoverageStateSchema,
  }),
  missingEvidence: z.array(z.string()),
  unavailableProviders: z.array(z.string()),
});

export interface SituationSection {
  summaryFacts: string[];
  eventIds: string[];
  metrics: TemporalMetric[];
  evidenceIds: string[];
}

export const SituationSectionSchema = z.object({
  summaryFacts: z.array(z.string()),
  eventIds: z.array(z.string()),
  metrics: z.array(TemporalMetricSchema),
  evidenceIds: z.array(z.string()),
});

export type EvidenceStrength = 'PRIMARY' | 'CORROBORATED' | 'SECONDARY' | 'WEAK' | 'UNVERIFIED';

export type FactBasis = 'provider_field' | 'source_excerpt' | 'rule_derived';
export const FactBasisSchema = z.enum(['provider_field', 'source_excerpt', 'rule_derived']);

export type Domain = 'general' | 'content' | 'marketing' | 'finance' | 'tourism' | 'travel';
export const DomainSchema = z.enum(['general', 'content', 'marketing', 'finance', 'tourism', 'travel']);

export interface Fact {
  id: string;
  topic: string;
  text: string;
  basis: FactBasis;
  evidenceIds: string[];
  truncated?: boolean;
}

export const FactSchema = z.object({
  id: z.string(),
  topic: z.string(),
  text: z.string(),
  basis: FactBasisSchema,
  evidenceIds: z.array(z.string()),
  truncated: z.boolean().optional(),
});

export interface Limitation {
  code: string;
  area: string;
  providerId?: string;
  message: string;
  evidenceIds: string[];
}

export const LimitationSchema = z.object({
  code: z.string(),
  area: z.string(),
  providerId: z.string().optional(),
  message: z.string(),
  evidenceIds: z.array(z.string()),
});

export interface DomainContext {
  domain: Domain;
  factors: Fact[];
  /** 地域指定検索由来の未確認候補。確認済み factors とは分けて返す。 */
  candidateFactors?: Fact[];
  missingInformation: Limitation[];
}

export const DomainContextSchema = z.object({
  domain: DomainSchema,
  factors: z.array(FactSchema),
  candidateFactors: z.array(FactSchema).optional(),
  missingInformation: z.array(LimitationSchema),
});

export interface CollectionGap {
  from: string;
  to: string;
  reason: string;
}

export const CollectionGapSchema = z.object({
  from: z.string(),
  to: z.string(),
  reason: z.string(),
});

export interface ActualWindow {
  from: string;
  to: string;
  complete: boolean;
  gaps: CollectionGap[];
}

export const ActualWindowSchema = z.object({
  from: z.string(),
  to: z.string(),
  complete: z.boolean(),
  gaps: z.array(CollectionGapSchema),
});

export interface RefreshState {
  state: 'complete' | 'partial' | 'pending';
  refreshId: string;
}

export const RefreshStateSchema = z.object({
  state: z.enum(['complete', 'partial', 'pending']),
  refreshId: z.string(),
});
export interface RecentTopic {
  topicId: string;
  title: string;
  providers: string[];
  rank?: number;
  hot?: string;
  pinned?: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  evidenceIds: string[];
  previousRank?: number;
  rankChange?: 'up' | 'down' | 'steady';
}
export const RecentTopicSchema = z.object({
  topicId: z.string(),
  title: z.string(),
  providers: z.array(z.string()),
  rank: z.number().optional(),
  hot: z.string().optional(),
  pinned: z.boolean().optional(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  evidenceIds: z.array(z.string()),
  previousRank: z.number().optional(),
  rankChange: z.enum(['up', 'down', 'steady']).optional(),
});
export interface RecentReport {
  evidenceId: string;
  title: string;
  publisher?: string;
  url: string;
  publishedAt?: string;
  ageClass: 'flash' | 'recent' | 'background' | 'unknown';
}
export const RecentReportSchema = z.object({
  evidenceId: z.string(),
  title: z.string(),
  publisher: z.string().optional(),
  url: z.string(),
  publishedAt: z.string().optional(),
  ageClass: z.enum(['flash', 'recent', 'background', 'unknown']),
});
export interface RecentSourceState {
  provider: string;
  status: ProviderRun['status'];
  finishedAt?: string;
  itemCount: number;
  errorCode?: string;
  upstreamUpdatedAt?: string;
  stale: boolean;
}
export const RecentSourceStateSchema = z.object({
  provider: z.string(),
  status: z.enum(['success', 'partial', 'unavailable', 'rate_limited', 'error']),
  finishedAt: z.string().optional(),
  itemCount: z.number(),
  errorCode: z.string().optional(),
  upstreamUpdatedAt: z.string().optional(),
  stale: z.boolean(),
});
export interface RecentContext {
  generatedAt: string;
  windowHours: 24;
  topics: RecentTopic[];
  reports: RecentReport[];
  sources: RecentSourceState[];
  limitations: Limitation[];
}
export const RecentContextSchema = z.object({
  generatedAt: z.string(),
  windowHours: z.literal(24),
  topics: z.array(RecentTopicSchema),
  reports: z.array(RecentReportSchema),
  sources: z.array(RecentSourceStateSchema),
  limitations: z.array(LimitationSchema),
});
export interface CountryContextReport {
  contextId: string;
  region: RegionIdentity;
  asOf: string;
  situation: {
    politics: SituationSection;
    economy: SituationSection;
    security: SituationSection;
    disasters: SituationSection;
    health: SituationSection;
    humanitarian: SituationSection;
    social: SituationSection;
  };
  elections: IntelEvent[];
  calendar: CalendarEvent[];
  foreignRelations: ForeignRelationContext[];
  japan?: JapanContextView;
  polls: PollObservation[];
  keyEvents: IntelEvent[];
  temporalMetrics: TemporalMetric[];
  signals: IntelligenceSignal[];
  domains: {
    content: { regionId: string; attention: IntelligenceSignal[]; disaster: IntelligenceSignal[]; socialActivity: IntelligenceSignal[]; calendar: IntelligenceSignal[]; coverage: IntelligenceSignal['coverage'] };
    marketing: { regionId: string; attention: IntelligenceSignal[]; businessActivity: IntelligenceSignal[]; calendar: IntelligenceSignal[]; socialActivity: IntelligenceSignal[]; disruption: IntelligenceSignal[]; coverage: IntelligenceSignal['coverage'] };
    travel: { regionId: string; disruptionSignals: IntelligenceSignal[]; disasterSignals: IntelligenceSignal[]; healthSignals: IntelligenceSignal[]; calendarSignals: IntelligenceSignal[]; coverage: IntelligenceSignal['coverage'] };
    finance: { regionId: string; economy: IntelligenceSignal[]; trade: IntelligenceSignal[]; businessAction: IntelligenceSignal[]; policyActivity: IntelligenceSignal[]; coverage: IntelligenceSignal['coverage'] };
  };
  providerCoverage: ProviderRun[];
  coverage: CoverageReport;
  evidence: CountryEvidence[];
  /** 初回応答に同梱する詳細。keyEvents・factors・metrics・calendar の参照先を含む。 */
  evidenceDetails?: EvidenceDetail[];
  /** 本文補完の結果。 */
  enrichment?: {
    attempted: number;
    upgraded: number;
    failed: number;
    skippedBudget: number;
    unavailable: boolean;
    truncatedDetails: number;
    omittedDetails: number;
  };
  schemaVersion?: string;
  domainContext?: Partial<Record<Domain, DomainContext>>;
  limitations?: Limitation[];
  refreshState?: RefreshState;
  actualWindows?: ActualWindow[];
  /** 直近24時間の話題・記事の要約。任意。 */
  recentContext?: RecentContext;
}

export const CountryContextReportSchema = z.object({
  contextId: z.string(),
  region: RegionIdentitySchema,
  asOf: z.string(),
  situation: z.object({
    politics: SituationSectionSchema,
    economy: SituationSectionSchema,
    security: SituationSectionSchema,
    disasters: SituationSectionSchema,
    health: SituationSectionSchema,
    humanitarian: SituationSectionSchema,
    social: SituationSectionSchema,
  }),
  elections: z.array(IntelEventSchema),
  calendar: z.array(CalendarEventSchema),
  foreignRelations: z.array(ForeignRelationContextSchema),
  japan: JapanContextViewSchema.optional(),
  polls: z.array(PollObservationSchema),
  keyEvents: z.array(IntelEventSchema),
  temporalMetrics: z.array(TemporalMetricSchema),
  signals: z.array(IntelligenceSignalSchema),
  domains: DomainViewsSchema,
  providerCoverage: z.array(ProviderRunSchema),
  coverage: CoverageReportSchema,
  evidence: z.array(CountryEvidenceSchema),
  evidenceDetails: z.array(EvidenceDetailSchema).optional(),
  enrichment: z.object({
    attempted: z.number(),
    upgraded: z.number(),
    failed: z.number(),
    skippedBudget: z.number(),
    unavailable: z.boolean(),
    truncatedDetails: z.number(),
    omittedDetails: z.number(),
  }).optional(),
  schemaVersion: z.string().optional(),
  domainContext: z.record(DomainSchema, DomainContextSchema).optional(),
  limitations: z.array(LimitationSchema).optional(),
  refreshState: RefreshStateSchema.optional(),
  actualWindows: z.array(ActualWindowSchema).optional(),
  recentContext: RecentContextSchema.optional(),
});
