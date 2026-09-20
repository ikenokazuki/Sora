import { randomUUID } from 'node:crypto';
import { resolveRegion } from './region.js';
import { deduplicateEvidence } from './evidence.js';
import { extractEvent } from './event_extract.js';
import { clusterEvents } from './event_cluster.js';
import { buildCoverage, buildForeignRelations, buildJapanView } from './context.js';
import { planCountryResearch } from './query_planner.js';
import { runProviders, type CountryIntelProvider, type ProviderCache } from './provider_registry.js';
import { getCountryContext, saveCountryContext } from './db.js';
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
  const plan = planCountryResearch(request, region, capabilities, dependencies.sources ?? []);
  const acquisition = await runProviders(plan, providers, {
    timeoutMs: dependencies.timeoutMs ?? 10_000,
    noCache: request.noCache,
    cache: dependencies.cache ?? null,
    now: () => nowDate.getTime(),
  });

  const evidence = deduplicateEvidence(acquisition.items.flatMap((item) => (item.evidence ? [item.evidence] : [])));
  const polls = acquisition.items.flatMap((item) => (item.poll ? [item.poll] : []));
  const calendar = acquisition.items.flatMap((item) => (item.calendar ? [item.calendar] : []));
  const temporalMetrics = acquisition.items.flatMap((item) => (item.metric ? [item.metric] : []));
  const sources = acquisition.items.flatMap((item) => (item.source ? [item.source] : []));

  const drafts = evidence
    .map((item) => extractEvent(item, region, nowDate))
    .filter((draft): draft is NonNullable<typeof draft> => draft !== undefined);
  const keyEvents = clusterEvents(drafts, evidence);
  const elections = keyEvents.filter((event) => event.type === 'election');
  const foreignRelations = buildForeignRelations(keyEvents, polls, temporalMetrics, evidence);
  const japan = buildJapanView(foreignRelations);

  const evidenceIds = evidence.map((item) => item.id);
  const evidenceByProviderArea: Record<string, readonly string[]> = {};
  for (const run of acquisition.runs) {
    if (run.itemCount <= 0) continue;
    for (const area of run.coverage ?? []) {
      evidenceByProviderArea[`${run.provider}:${area}`] = evidenceIds;
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
