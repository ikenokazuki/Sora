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
