import { expect, test } from 'bun:test';
import { assembleSituation } from './context.js';
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

test('does not place every event into politics', () => {
  const situation = assembleSituation([
    event('e1', 'trade_restriction'),
    event('e2', 'disaster_response'),
    event('e3', 'election'),
    event('e4', 'protest'),
    event('e5', 'military_activity'),
  ], [], '30d');
  expect(situation.economy.eventIds).toEqual(['e1']);
  expect(situation.disasters.eventIds).toEqual(['e2']);
  expect(situation.politics.eventIds).toEqual(['e3']);
  expect(situation.social.eventIds).toEqual(['e4']);
  expect(situation.security.eventIds).toEqual(['e5']);
});

test('leaves unclassifiable events out of sections but keeps their ids available', () => {
  const situation = assembleSituation([event('s1', 'statement'), event('m1', 'meeting')], [], '30d');
  const sectioned = [
    ...situation.politics.eventIds, ...situation.economy.eventIds, ...situation.security.eventIds,
    ...situation.disasters.eventIds, ...situation.health.eventIds, ...situation.humanitarian.eventIds,
    ...situation.social.eventIds,
  ];
  expect(sectioned).toEqual([]);
  expect(situation.politics.summaryFacts).toEqual([]);
});

test('summarizes section counts without evaluative language', () => {
  const situation = assembleSituation(
    [event('p1', 'protest'), event('p2', 'protest'), event('p3', 'protest')],
    [], '7d',
  );
  expect(situation.social.summaryFacts).toEqual([
    '3 protest event clusters were observed in the requested period.',
  ]);
  const joined = JSON.stringify(situation);
  for (const banned of ['dangerous', 'hostile', 'favorable', 'negative', 'safe', 'risk']) {
    expect(joined.toLowerCase()).not.toContain(banned);
  }
});

import { promoteSingleObservations } from './context.js';
import type { CountryEvidence, Fact } from './types.js';
import type { RegionLink } from './region_link.js';

function singleEvidence(id: string, overrides: Partial<CountryEvidence> = {}): CountryEvidence {
  return {
    id, regionId: 'country:CN', url: 'https://example.org/' + id, title: 'Title ' + id,
    publisher: 'Pub', sourceType: 'international_media', retrievedAt: '2026-09-22T00:00:00Z',
    primarySource: false, latencyClass: 'near_realtime', ...overrides,
  };
}
function singleFact(id: string, topic: string, evidenceId: string): Fact {
  return { id: 'fact-' + id, topic, text: 'text ' + id, basis: 'source_excerpt', evidenceIds: [evidenceId] };
}
function promote(facts: Fact[], entries: Array<[CountryEvidence, RegionLink]>, clustered: string[] = []) {
  const situation = assembleSituation([], [], '30d');
  const evidenceById = new Map(entries.map(([e]) => [e.id, e]));
  const links = new Map(entries.map(([e, link]) => [e.id, link]));
  promoteSingleObservations(situation, facts, evidenceById, links, new Set(clustered));
  return situation;
}

test('promotes direct singles into empty sections without inventing events', () => {
  const e1 = singleEvidence('e1', { publishedAt: '2026-09-20T00:00:00Z' });
  const situation = promote(
    [singleFact('f1', 'economy', 'e1')],
    [[e1, 'direct']],
  );
  expect(situation.economy.eventIds).toEqual([]);
  expect(situation.economy.evidenceIds).toEqual(['e1']);
  expect(situation.economy.summaryFacts[0]).toMatch(/single observation/);
  expect(situation.economy.summaryFacts.join(' ')).toContain('Title e1');
});

test('never promotes candidate, unrelated or unknown evidence', () => {
  const mk = (id: string) => singleEvidence(id);
  const situation = promote(
    [singleFact('f1', 'economy', 'c1'), singleFact('f2', 'economy', 'u1'), singleFact('f3', 'economy', 'x1')],
    [[mk('c1'), 'candidate'], [mk('u1'), 'unrelated'], [mk('x1'), 'unknown']],
  );
  expect(situation.economy.evidenceIds).toEqual([]);
  expect(situation.economy.summaryFacts).toEqual([]);
});

test('excludes clustered evidence and leaves clustered areas untouched', () => {
  const e1 = singleEvidence('e1');
  const e2 = singleEvidence('e2');
  const situation = promote(
    [singleFact('f1', 'disasters', 'e1'), singleFact('f2', 'economy', 'e2')],
    [[e1, 'direct'], [e2, 'direct']],
    ['e1'],
  );
  expect(situation.disasters.evidenceIds).toEqual([]);
  expect(situation.economy.evidenceIds).toEqual(['e2']);
});

test('caps at five with official primary sources first', () => {
  const entries = Array.from({ length: 7 }, (_, i) => {
    const id = 'e' + String(i);
    return [singleEvidence(id, { primarySource: i === 6, publishedAt: '2026-09-2' + String(i % 9) + 'T00:00:00Z' }), 'direct' as RegionLink] as [CountryEvidence, RegionLink];
  });
  const situation = promote(
    entries.map(([e]) => singleFact('f-' + e.id, 'economy', e.id)),
    entries,
  );
  expect(situation.economy.evidenceIds).toHaveLength(5);
  expect(situation.economy.evidenceIds[0]).toBe('e6');
});

test('promotion adds no evaluative language', () => {
  const e1 = singleEvidence('e1');
  const situation = promote([singleFact('f1', 'economy', 'e1')], [[e1, 'related']]);
  const joined = JSON.stringify(situation).toLowerCase();
  for (const banned of ['dangerous', 'hostile', 'favorable', 'negative', 'safe', 'risk']) {
    expect(joined).not.toContain(banned);
  }
});

test('promotes pattern-typed singles from untagged topics', () => {
  const e1 = singleEvidence('e1', { title: '選挙結果が確定' });
  const situation = promote(
    [singleFact('f1', 'media_activity', 'e1')],
    [[e1, 'direct']],
  );
  expect(situation.politics.eventIds).toEqual([]);
  expect(situation.politics.evidenceIds).toEqual(['e1']);
});

test('pattern path reads titles only, not bodies', () => {
  const e1 = singleEvidence('e1', { title: '今日の出来事' });
  const situation = promote(
    [singleFact('f1', 'media_activity', 'e1')],
    [[e1, 'direct']],
  );
  expect(situation.politics.evidenceIds).toEqual([]);
  expect(situation.economy.evidenceIds).toEqual([]);
});

test('econ titles promote to economy once', () => {
  const e1 = singleEvidence('e1', { title: '中国经济形势分析' });
  const situation = promote(
    [singleFact('f1', 'economy', 'e1')],
    [[e1, 'direct']],
  );
  expect(situation.economy.evidenceIds).toEqual(['e1']);
  expect(situation.politics.evidenceIds).toEqual([]);
});
