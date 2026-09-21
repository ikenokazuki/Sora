import { randomUUID } from 'node:crypto';
import { resolveRegion } from './region.js';
import { deduplicateEvidence } from './evidence.js';
import { extractEvent } from './event_extract.js';
import { clusterEvents } from './event_cluster.js';
import { buildCoverage, buildForeignRelations, buildJapanView } from './context.js';
import { planCountryResearchPass1, planCountryResearchPass2 } from './query_planner.js';
import { runProviderPass, type AcquiredItem, type CountryIntelProvider, type ProviderCache } from './provider_registry.js';
import type { ProviderRun } from './types.js';
import { getCountryContext, getVerifiedCountrySources, saveCountryContext } from './db.js';
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

export function getPersistedCountryContext(contextId: string): CountryContextReport | undefined {
  return getCountryContext(contextId);
}

function emptySection(): SituationSection {
  return { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] };
}

export async function researchCountryContext(
  rawRequest: CountryContextRequest,
  dependencies: ResearchDependencies = {},
): Promise<CountryContextReport> {
  const request = CountryContextRequestSchema.parse(rawRequest);
  const nowDate = dependencies.now?.() ?? new Date();
  const region = resolveRegion(request.region);
  const providers = dependencies.providers ?? [];
  const capabilities = providers.map((provider) => ({ id: provider.id, areas: [...provider.areas] }));
  const verifySource = dependencies.sourceVerifier ?? ((source) => verifyCountrySource(source));
  const runOptions = {
    timeoutMs: dependencies.timeoutMs ?? 10_000,
    noCache: request.noCache,
    cache: dependencies.cache ?? null,
    now: () => nowDate.getTime(),
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
  const mergedRuns: ProviderRun[] = [...pass1.runs, ...pass2.runs];
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

  const keyEventIds = keyEvents.map((event) => event.id);
  const evidenceIds = evidence.map((item) => item.id);
  const situation: CountryContextReport['situation'] = {
    politics: { ...emptySection(), eventIds: keyEventIds, evidenceIds },
    economy: emptySection(),
    security: emptySection(),
    disasters: emptySection(),
    health: emptySection(),
    humanitarian: emptySection(),
    social: emptySection(),
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
