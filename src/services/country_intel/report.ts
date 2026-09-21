import { randomUUID } from 'node:crypto';
import { resolveRegion } from './region.js';
import { deduplicateEvidence } from './evidence.js';
import { extractEvent } from './event_extract.js';
import { clusterEvents } from './event_cluster.js';
import { assembleSituation, buildCoverage, buildForeignRelations, buildJapanView } from './context.js';
import { buildMetricObservations } from './metric_builder.js';
import { deriveIntelligenceSignal } from '../intelligence/signals.js';
import { buildContentView } from '../intelligence/domains/content.js';
import { buildMarketingView } from '../intelligence/domains/marketing.js';
import { buildTravelView } from '../intelligence/domains/travel.js';
import { buildFinanceView } from '../intelligence/domains/finance.js';
import type { IntelligenceSignal } from '../intelligence/types.js';
import { planCountryResearchPass1, planCountryResearchPass2 } from './query_planner.js';
import { runProviderPass, type AcquiredItem, type CountryIntelProvider, type ProviderCache } from './provider_registry.js';
import type { ProviderRun } from './types.js';
import { getCountryContext, getVerifiedCountrySources, queryBaselineObservations, saveCountryContext, saveMetricObservations } from './db.js';
import { verifyCountrySource } from './source_registry.js';
import {
  CountryContextRequestSchema,
  CountryContextReportSchema,
  type CountryContextReport,
  type CountryContextRequest,
  type CountrySource,
  type SituationSection,
} from './types.js';

export interface ResearchDependencies {
  providers?: readonly CountryIntelProvider[];
  sources?: readonly CountrySource[];
  now?: () => Date;
  cache?: ProviderCache | null;
  timeoutMs?: number;
  /** pass1 で発見した candidate の検証器。未指定時は availability check のみ。 */
  sourceVerifier?: (source: CountrySource) => Promise<CountrySource>;
}

const RUN_SEVERITY: Record<ProviderRun['status'], number> = {
  error: 5,
  rate_limited: 4,
  unavailable: 3,
  partial: 2,
  success: 1,
};

/** pass 別の run を provider 単位に集約する。件数は加算し、状態は深刻な方を残す。 */
export function mergeProviderRuns(runs: readonly ProviderRun[]): ProviderRun[] {
  const byProvider = new Map<string, ProviderRun[]>();
  for (const run of runs) {
    const list = byProvider.get(run.provider) ?? [];
    list.push(run);
    byProvider.set(run.provider, list);
  }
  return [...byProvider.values()].map((group) => {
    if (group.length === 1) return group[0];
    const worst = group.reduce((left, right) =>
      RUN_SEVERITY[right.status] > RUN_SEVERITY[left.status] ? right : left);
    return {
      provider: group[0].provider,
      startedAt: group.map((run) => run.startedAt).sort()[0],
      finishedAt: group.map((run) => run.finishedAt ?? run.startedAt).sort().at(-1),
      status: worst.status,
      itemCount: group.reduce((sum, run) => sum + run.itemCount, 0),
      coverage: [...new Set(group.flatMap((run) => run.coverage ?? []))],
      latencyMs: group.reduce((sum, run) => sum + (run.latencyMs ?? 0), 0),
      ...(worst.errorCode ? { errorCode: worst.errorCode } : {}),
    };
  });
}

export function getPersistedCountryContext(contextId: string): CountryContextReport | undefined {
  return getCountryContext(contextId);
}

/** 空文字の query / topics は未指定とみなす (空値を送るクライアントの許容)。 */
export function normalizeCountryRequest(rawRequest: CountryContextRequest): CountryContextRequest {
  const raw = rawRequest as unknown as Record<string, unknown>;
  const query = typeof raw.query === 'string' && raw.query.trim().length === 0 ? undefined : raw.query;
  let topics = raw.topics;
  if (Array.isArray(topics)) {
    const kept = topics.filter((topic) => typeof topic === 'string' && topic.trim().length > 0);
    topics = kept.length > 0 ? kept : undefined;
  }
  return { ...(raw as object), query, topics } as CountryContextRequest;
}

export async function researchCountryContext(
  rawRequest: CountryContextRequest,
  dependencies: ResearchDependencies = {},
): Promise<CountryContextReport> {
  const request = CountryContextRequestSchema.parse(normalizeCountryRequest(rawRequest));
  const nowDate = dependencies.now?.() ?? new Date();
  const region = resolveRegion(request.region);
  const providers = dependencies.providers ?? [];
  const capabilities = providers.map((provider) => ({ id: provider.id, areas: [...provider.areas] }));
  const verifySource = dependencies.sourceVerifier ?? ((source) => verifyCountrySource(source));
  const runOptions = {
    timeoutMs: dependencies.timeoutMs ?? 10_000,
    noCache: request.noCache,
    cache: dependencies.cache ?? null,
  };

  // Pass 1: 広域収集 → evidence 正規化・source candidate 発見。
  const pass1Plan = {
    request,
    region,
    pass1: planCountryResearchPass1(request, region, capabilities),
    pass2: [],
    limits: { maxPass1Queries: 12 as const, maxPass2Queries: 8 as const, maxItemsPerQuery: 100 as const },
  };
  const pass1 = await runProviderPass(pass1Plan, 1, providers, runOptions);

  // pass1 で発見した candidate を検証する。availability_only は candidate のまま。
  const discovered = pass1.items.flatMap((wrapped) => (wrapped.item.source ? [wrapped.item.source] : []));
  const newlyVerified: CountrySource[] = [];
  for (const candidate of discovered) {
    if (candidate.verificationStatus === 'verified') {
      newlyVerified.push(candidate);
      continue;
    }
    try {
      const checked = await verifySource(candidate);
      if (checked.verificationStatus === 'verified' && checked.verificationBasis !== 'availability_only') {
        newlyVerified.push(checked);
      }
    } catch {}
  }

  // Pass 2: 検証済み source (今回 + 過去の地域 source + 依存注入) のみで深掘りする。
  const storedVerified = getVerifiedCountrySources(region.id);
  const injectedVerified = (dependencies.sources ?? []).filter((source) => source.verificationStatus === 'verified');
  const pass2Queries = planCountryResearchPass2(request, region, capabilities, {
    verifiedSources: [...newlyVerified, ...storedVerified, ...injectedVerified],
  });
  const pass2Plan = { ...pass1Plan, pass1: [], pass2: pass2Queries };
  const pass2 = await runProviderPass(pass2Plan, 2, providers, runOptions);

  const mergedItems: AcquiredItem[] = [...pass1.items, ...pass2.items];
  const mergedRuns: ProviderRun[] = mergeProviderRuns([...pass1.runs, ...pass2.runs]);
  const acquisition = { items: mergedItems, runs: mergedRuns };

  const evidence = deduplicateEvidence(acquisition.items.flatMap((wrapped) => (wrapped.item.evidence ? [wrapped.item.evidence] : [])));
  const polls = acquisition.items.flatMap((wrapped) => (wrapped.item.poll ? [wrapped.item.poll] : []));
  const calendar = acquisition.items.flatMap((wrapped) => (wrapped.item.calendar ? [wrapped.item.calendar] : []));
  const temporalMetrics = acquisition.items.flatMap((wrapped) => (wrapped.item.metric ? [wrapped.item.metric] : []));
  const sources = acquisition.items.flatMap((wrapped) => (wrapped.item.source ? [wrapped.item.source] : []));

  const drafts = evidence
    .map((item) => extractEvent(item, region, nowDate))
    .filter((draft): draft is NonNullable<typeof draft> => draft !== undefined);
  const keyEvents = clusterEvents(drafts, evidence);
  const elections = keyEvents.filter((event) => event.type === 'election');
  const foreignRelations = buildForeignRelations(keyEvents, polls, temporalMetrics, evidence);
  const japan = buildJapanView(foreignRelations);

  // 各 provider が実際に取得した evidence のみ紐付ける。他者の借用は禁止。
  const evidenceByProviderArea: Record<string, readonly string[]> = {};
  for (const wrapped of acquisition.items) {
    if (!wrapped.item.evidence) continue;
    for (const area of wrapped.areas) {
      const key = `${wrapped.providerId}:${area}`;
      evidenceByProviderArea[key] = [...(evidenceByProviderArea[key] ?? []), wrapped.item.evidence.id];
    }
  }
  const coverage = buildCoverage(acquisition.runs, evidence, evidenceByProviderArea);
  const mixedOutcome =
    acquisition.runs.some((run) => run.status === 'success' || run.status === 'partial') &&
    acquisition.runs.some((run) => run.status === 'unavailable' || run.status === 'rate_limited' || run.status === 'error');
  if (coverage.overall === 'limited' && mixedOutcome && evidence.length > 0) {
    coverage.overall = 'partial';
  }

  const situation = assembleSituation(keyEvents, evidence, request.period);

  // 分野横断で使える metric 観測 → signal → domain view。推奨・評価は含めない。
  const observations = buildMetricObservations(keyEvents, acquisition.items, {
    regionId: region.id,
    window: request.period,
    observedAt: nowDate.toISOString(),
  });
  saveMetricObservations(observations.map((observation) => ({
    regionId: observation.regionId,
    metricKey: observation.metricKey,
    metricKind: observation.metricKind,
    window: observation.window,
    observedAt: observation.observedAt,
    currentValue: observation.currentValue,
    origin: observation.origin,
    providerIds: observation.providerIds,
    evidenceIds: observation.evidenceIds,
  })));
  const signals: IntelligenceSignal[] = observations.map((observation) =>
    deriveIntelligenceSignal({
      metricKey: observation.metricKey,
      regionId: observation.regionId,
      value: observation.currentValue,
      window: observation.window,
      observedAt: observation.observedAt,
      origin: observation.origin,
      evidenceIds: observation.evidenceIds,
      providerIds: observation.providerIds,
      coverage: coverage.overall,
      baselineSamples: queryBaselineObservations(
        observation.regionId,
        observation.metricKey,
        observation.window,
      ).map((stored) => stored.currentValue),
    }),
  );
  const domainInput = { regionId: region.id, signals, coverage: coverage.overall };
  const domains = {
    content: buildContentView(domainInput),
    marketing: buildMarketingView(domainInput),
    travel: buildTravelView(domainInput),
    finance: buildFinanceView(domainInput),
  };

  const report = CountryContextReportSchema.parse({
    contextId: randomUUID(),
    region,
    asOf: nowDate.toISOString(),
    situation,
    elections,
    calendar,
    foreignRelations,
    japan,
    polls,
    keyEvents,
    temporalMetrics,
    signals,
    domains,
    providerCoverage: acquisition.runs,
    coverage,
    evidence,
  } satisfies CountryContextReport);

  saveCountryContext(report, {
    providerRuns: acquisition.runs,
    evidence,
    events: keyEvents,
    polls,
    calendar,
    sources,
  });
  return report;
}
