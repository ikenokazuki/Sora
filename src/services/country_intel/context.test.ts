import { expect, test } from 'bun:test';
import {
  buildCoverage,
  buildForeignRelations,
  buildJapanView,
  computeTemporalMetric,
  normalizeCalendarDate,
  pollsComparable,
} from './context.js';
import type { CountryEvidence, IntelEvent, PollObservation, ProviderRun, TemporalMetric } from './types.js';

const basePoll: PollObservation = {
  id: 'poll-1', regionId: 'country:KR', pollster: 'Example Polling',
  population: 'adults', mode: 'phone', question: 'What is your view of Japan?',
  responses: [{ label: 'positive', value: 40 }], sourceUrl: 'https://poll.example.test/1', evidenceId: 'evidence-1',
};

function event(id: string, type: IntelEvent['type'], countryCode?: string, evidenceIds: string[] = []): IntelEvent {
  return {
    id, regionId: 'country:KR', type, title: id,
    actors: [], targets: countryCode ? [{ name: countryCode, type: 'country', countryCode }] : [], evidenceIds,
    evidenceCount: 0, independentSourceCount: 0, primarySourceCount: 0,
    firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', confidence: 'low',
  };
}

const evidence: CountryEvidence = {
  id: 'evidence-1', regionId: 'country:KR', url: 'https://news.example.test/1',
  sourceType: 'major_local_media', retrievedAt: '2026-01-01T00:00:00.000Z',
  primarySource: false, latencyClass: 'near_realtime',
};

test('compares polls only when wording population and mode align', () => {
  expect(pollsComparable(basePoll, { ...basePoll, pollster: 'Other' })).toBe(true);
  expect(pollsComparable(basePoll, { ...basePoll, mode: 'online' })).toBe(false);
});

test('normalizes calendar date in the region timezone', () => {
  expect(normalizeCalendarDate('2026-01-01T00:30:00+09:00', 'Asia/Tokyo')).toBe('2026-01-01');
  expect(normalizeCalendarDate('2026-01-01T00:30:00+09:00', 'America/Los_Angeles')).toBe('2025-12-31');
});

test('computes clipped MAD anomaly without semantic labels', () => {
  expect(computeTemporalMetric('protest_event_count', 12, '7d', [1, 1, 2, 2, 3], 'external_historical'))
    .toMatchObject({ anomalyZ: 6, direction: 'rising' });
});

test('cold start records insufficient baseline', () => {
  expect(computeTemporalMetric('media_cluster_count', 2, '24h', [], 'insufficient').baseline)
    .toEqual({ sampleCount: 0, origin: 'insufficient' });
});

test('requires three usable samples before calculating an anomaly', () => {
  for (const [samples, sampleCount] of [[[1], 1], [[1, 2], 2], [[1, Number.NaN, 2], 2]] as const) {
    const metric = computeTemporalMetric('media_cluster_count', 3, '24h', samples, 'external_historical');
    expect(metric).toMatchObject({
      baseline: { sampleCount, origin: 'insufficient' },
      direction: 'unknown',
    });
    expect(metric.anomalyZ).toBeUndefined();
  }
});

test('groups relation events by every explicit counterpart without Japan special cases', () => {
  const metrics: TemporalMetric[] = [{ key: 'media_cluster_count', current: 3, window: '7d', direction: 'rising' }];
  const relations = buildForeignRelations(
    [event('jp-protest', 'protest', 'JP'), event('jp-boycott', 'boycott', 'JP'), event('us-trade', 'trade_restriction', 'US')],
    [basePoll], metrics, [{ ...evidence, mentionedCountries: ['JP', 'US'] }],
  );

  expect(relations).toEqual(expect.arrayContaining([
    expect.objectContaining({ counterpartCountryCode: 'JP', recentEventIds: ['jp-protest', 'jp-boycott'], relevantPolls: [basePoll], mediaMetrics: metrics }),
    expect.objectContaining({ counterpartCountryCode: 'US', recentEventIds: ['us-trade'], relevantPolls: [basePoll], mediaMetrics: metrics }),
  ]));
});

test('builds a counterpart relation from event evidence mentions alone', () => {
  const relations = buildForeignRelations(
    [event('mentioned-event', 'statement', undefined, ['mentioned-evidence'])], [], [],
    [{ ...evidence, id: 'mentioned-evidence', mentionedCountries: ['CA'] }],
  );

  expect(relations).toEqual([expect.objectContaining({
    counterpartCountryCode: 'CA',
    officialEvents: [expect.objectContaining({ id: 'mentioned-event' })],
  })]);
});

test('attaches a poll only to counterparts mentioned by its evidence', () => {
  const jpPoll = { ...basePoll, evidenceId: 'poll-jp' };
  const relations = buildForeignRelations(
    [event('jp-event', 'statement', 'JP'), event('us-event', 'statement', 'US')], [jpPoll], [],
    [{ ...evidence, id: 'poll-jp', mentionedCountries: ['JP'] }],
  );

  expect(relations.find(({ counterpartCountryCode }) => counterpartCountryCode === 'JP')?.relevantPolls).toEqual([jpPoll]);
  expect(relations.find(({ counterpartCountryCode }) => counterpartCountryCode === 'US')?.relevantPolls).toEqual([]);
});

test('projects Japan fields only from the JP relation', () => {
  const relations = buildForeignRelations(
    [event('jp-protest', 'protest', 'JP'), event('jp-boycott', 'boycott', 'JP'), event('jp-trade', 'trade_restriction', 'JP'), event('us-protest', 'protest', 'US')],
    [basePoll], [],
  );

  expect(buildJapanView(relations)).toMatchObject({
    countryCode: 'JP', protests: [expect.objectContaining({ id: 'jp-protest' })],
    boycotts: [expect.objectContaining({ id: 'jp-boycott' })],
    tradeRestrictions: [expect.objectContaining({ id: 'jp-trade' })],
  });
  expect(buildJapanView(relations)?.protests).not.toContainEqual(expect.objectContaining({ id: 'us-protest' }));
  expect(buildJapanView([])).toBeUndefined();
});

test('reports collection gaps when covered providers yield no evidence', () => {
  const runs: ProviderRun[] = [
    { provider: 'news', startedAt: '2026-01-01T00:00:00.000Z', status: 'success', itemCount: 0, coverage: ['politics'] },
    { provider: 'polls', startedAt: '2026-01-01T00:00:00.000Z', status: 'unavailable', itemCount: 0, coverage: ['polls'] },
  ];

  const coverage = buildCoverage(runs, []);

  expect(coverage.byArea.politics).toBe('limited');
  expect(coverage.byArea.polls).toBe('limited');
  expect(coverage.overall).toBe('limited');
  expect(coverage.missingEvidence).toEqual(expect.arrayContaining(['politics', 'polls']));
  expect(coverage.unavailableProviders).toEqual(['polls']);
});

test('keeps successful covered collection distinct from unavailable areas', () => {
  const coverage = buildCoverage([
    { provider: 'news', startedAt: '2026-01-01T00:00:00.000Z', status: 'success', itemCount: 1, coverage: ['politics'] },
    { provider: 'social', startedAt: '2026-01-01T00:00:00.000Z', status: 'partial', itemCount: 1, coverage: ['social'] },
  ], [evidence], { 'news:politics': ['evidence-1'], 'social:social': ['evidence-1'] });

  expect(coverage.byArea.politics).toBe('good');
  expect(coverage.byArea.social).toBe('partial');
  expect(coverage.byArea.health).toBe('limited');
  expect(coverage.missingEvidence).toContain('health');
  expect(coverage.unavailableProviders).toEqual([]);
});

test('keeps an uncovered provider area limited when another area has evidence', () => {
  const coverage = buildCoverage([
    { provider: 'news', startedAt: '2026-01-01T00:00:00.000Z', status: 'success', itemCount: 1, coverage: ['politics', 'economy'] },
  ], [evidence], { 'news:politics': ['evidence-1'] });

  expect(coverage.byArea.politics).toBe('good');
  expect(coverage.byArea.economy).toBe('limited');
  expect(coverage.missingEvidence).toContain('economy');
});
