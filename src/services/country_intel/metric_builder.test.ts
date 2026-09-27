import { expect, test } from 'bun:test';
import { buildMetricObservations } from './metric_builder.js';
import type { AcquiredItem } from './provider_registry.js';
import type { IntelEvent } from './types.js';

function event(id: string, type: IntelEvent['type']): IntelEvent {
  return {
    id, regionId: 'country:KR', type, title: `${type} title`,
    actors: [], targets: [], evidenceIds: [`ev-${id}`], evidenceCount: 1,
    independentSourceCount: 1, primarySourceCount: 0,
    firstSeenAt: '2026-09-19T00:00:00Z', lastSeenAt: '2026-09-19T00:00:00Z',
    confidence: 'medium',
  };
}

function wrapped(providerId: string, evidence: any): AcquiredItem {
  return { providerId, areas: ['media_activity'], item: { evidence } };
}

test('counts events and evidence into metric observations', () => {
  const observations = buildMetricObservations(
    [event('p1', 'protest'), event('p2', 'protest'), event('v1', 'violence')],
    [
      wrapped('gdelt', { id: 'ev-p1', sourceType: 'international_media' }),
      wrapped('gdelt', { id: 'ev-p2', sourceType: 'social' }),
    ],
    { regionId: 'country:KR', window: '30d', observedAt: '2026-09-19T00:00:00Z' },
  );
  const byKey = new Map(observations.map((o) => [o.metricKey, o]));
  expect(byKey.get('protest_event_count')?.currentValue).toBe(2);
  expect(byKey.get('violence_event_count')?.currentValue).toBe(1);
  expect(byKey.get('event_cluster_count')?.currentValue).toBe(3);
  expect(byKey.get('media_article_count')?.currentValue).toBe(1);
  expect(byKey.get('social_observation_count')?.currentValue).toBe(1);
  expect(byKey.get('protest_event_count')?.origin).toBe('ad_hoc');
  expect(byKey.get('protest_event_count')?.evidenceIds).toContain('ev-p1');
});
