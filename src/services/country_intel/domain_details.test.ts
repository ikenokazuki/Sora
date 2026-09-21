import { describe, expect, test } from 'bun:test';
import { buildDomainContext, evidenceToFacts, type Fact, type Limitation } from './domain_details.js';
import { buildTourismView } from '../intelligence/domains/tourism.js';
import { buildMetricObservations } from './metric_builder.js';
import { buildTravelView } from '../intelligence/domains/travel.js';
import { deriveIntelligenceSignal } from '../intelligence/signals.js';

describe('domain details', () => {
  test('posting context contains an official cancellation and missing context', () => {
    const fact: Fact = { id: 'f1', topic: 'cancellations', text: 'The festival has been cancelled.', basis: 'source_excerpt', evidenceIds: ['official-cancellation'] };
    const limitation: Limitation = { code: 'posting_context_missing', area: 'content', message: 'posting text and schedule are unspecified', evidenceIds: [] };
    const view = buildDomainContext('content', [fact], [limitation]);
    expect(view.factors[0].text).toContain('cancelled');
    expect(view.factors[0].evidenceIds).toContain('official-cancellation');
    expect(view.missingInformation[0].code).toBe('posting_context_missing');
  });

  test('tourism view separates calendar and disruption without advice', () => {
    const signal = (key: string) => ({ key, regionId: 'country:CN', kind: 'count' as const, value: 2, window: '30d', observedAt: '2026-09-22T00:00:00Z', activityState: 'elevated' as const, evidenceIds: [], providerIds: [], coverage: 'good' as const });
    const view = buildTourismView({ regionId: 'country:CN', signals: [signal('calendar_event_count'), signal('disaster_event_count')], coverage: 'good' });
    expect(view.calendarSignals.map((s) => s.key)).toContain('calendar_event_count');
    expect(view.disasterSignals.map((s) => s.key)).toContain('disaster_event_count');
    expect(JSON.stringify(view).toLowerCase()).not.toContain('recommend');
  });

  test('calendar observations reach travel signals with evidence linkage', () => {
    const observations = buildMetricObservations([], [], { regionId: 'country:CN', window: '30d', observedAt: '2026-09-22T00:00:00Z' }, [{ id: 'nager:CN:2026-10-01' }]);
    const byKey = new Map(observations.map((o) => [o.metricKey, o]));
    expect(byKey.get('calendar_event_count')?.currentValue).toBe(1);
    const signals = observations.map((o) => deriveIntelligenceSignal({ metricKey: o.metricKey, regionId: o.regionId, value: o.currentValue, window: o.window, observedAt: o.observedAt, origin: o.origin, evidenceIds: o.evidenceIds, providerIds: o.providerIds, coverage: 'limited' }));
    expect(buildTravelView({ regionId: 'country:CN', signals, coverage: 'limited' }).calendarSignals.map((s) => s.key)).toContain('calendar_event_count');
  });

  test('acquired evidence becomes traceable facts', () => {
    const facts = evidenceToFacts([{ providerId: 'gdacs', areas: ['disasters'], item: { evidence: { id: 'ev-1', regionId: 'country:CN', url: 'https://example.org/1', title: 'Flood in China', sourceType: 'structured_dataset', retrievedAt: '2026-09-22T00:00:00Z', primarySource: false, latencyClass: 'near_realtime' } } }]);
    expect(facts).toHaveLength(1);
    expect(facts[0].evidenceIds).toEqual(['ev-1']);
    expect(facts[0].basis).toBe('source_excerpt');
  });
});
