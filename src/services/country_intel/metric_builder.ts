import { toMetricObservation } from '../intelligence/observations.js';
import type { MetricKind, MetricObservation } from '../intelligence/types.js';
import type { AcquiredItem } from './provider_registry.js';
import type { CountryEvidence, IntelEvent } from './types.js';

export interface MetricBuildContext {
  regionId: string;
  window: string;
  observedAt: string;
}

const TYPE_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  protest: 'protest_event_count',
  demonstration: 'protest_event_count',
  strike: 'protest_event_count',
  violence: 'violence_event_count',
  threat: 'violence_event_count',
  military_activity: 'military_activity_count',
  trade_restriction: 'trade_restriction_count',
  business_action: 'business_action_count',
  disaster_response: 'disaster_event_count',
});

const MEDIA_SOURCE_TYPES = new Set(['international_media', 'major_local_media', 'local_media']);

/** 取得済みイベント・証拠から分野横断で使える metric 観測値を作る。推奨・評価は含めない。 */
export function buildMetricObservations(
  events: readonly IntelEvent[],
  acquired: readonly AcquiredItem[],
  context: MetricBuildContext,
): MetricObservation[] {
  const evidenceWithProvider = acquired.flatMap((wrapped) =>
    wrapped.item.evidence ? [{ evidence: wrapped.item.evidence, providerId: wrapped.providerId }] : [],
  );
  const observations: MetricObservation[] = [];
  const observe = (
    metricKey: string,
    metricKind: MetricKind,
    currentValue: number,
    evidenceIds: string[],
  ) => {
    const providerIds = [...new Set(
      evidenceWithProvider.filter(({ evidence }) => evidenceIds.includes(evidence.id)).map(({ providerId }) => providerId),
    )];
    observations.push(toMetricObservation({
      regionId: context.regionId,
      metricKey,
      metricKind,
      window: context.window,
      observedAt: context.observedAt,
      currentValue,
      origin: 'ad_hoc',
      providerIds,
      evidenceIds,
    }));
  };

  const evidenceIdsOf = (predicate: (evidence: CountryEvidence) => boolean) =>
    evidenceWithProvider.filter(({ evidence }) => predicate(evidence)).map(({ evidence }) => evidence.id);

  observe('event_cluster_count', 'count', events.length, events.flatMap((event) => event.evidenceIds));
  const byGroup = new Map<string, IntelEvent[]>();
  for (const event of events) {
    const key = TYPE_GROUPS[event.type];
    if (!key) continue;
    const list = byGroup.get(key) ?? [];
    list.push(event);
    byGroup.set(key, list);
  }
  for (const [key, group] of byGroup) {
    observe(key, 'count', group.length, group.flatMap((event) => event.evidenceIds));
  }
  observe(
    'official_event_count', 'count',
    events.filter((event) => event.primarySourceCount > 0).length,
    events.filter((event) => event.primarySourceCount > 0).flatMap((event) => event.evidenceIds),
  );
  observe(
    'independent_source_event_count', 'count',
    events.filter((event) => event.independentSourceCount >= 2).length,
    events.filter((event) => event.independentSourceCount >= 2).flatMap((event) => event.evidenceIds),
  );
  observe('media_article_count', 'count',
    evidenceIdsOf((item) => MEDIA_SOURCE_TYPES.has(item.sourceType)).length,
    evidenceIdsOf((item) => MEDIA_SOURCE_TYPES.has(item.sourceType)));
  observe('social_observation_count', 'count',
    evidenceIdsOf((item) => item.sourceType === 'social').length,
    evidenceIdsOf((item) => item.sourceType === 'social'));
  const primary = evidenceIdsOf((item) => item.primarySource);
  const total = evidenceWithProvider.length;
  observations.push(toMetricObservation({
    regionId: context.regionId,
    metricKey: 'primary_source_ratio',
    metricKind: 'share',
    window: context.window,
    observedAt: context.observedAt,
    currentValue: total > 0 ? primary.length / total : 0,
    origin: 'ad_hoc',
    providerIds: [...new Set(evidenceWithProvider.map(({ providerId }) => providerId))],
    evidenceIds: primary,
  }));
  return observations;
}
