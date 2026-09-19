import { expect, test } from 'bun:test';
import criticalFixtures from './fixtures/critical_events.json' with { type: 'json' };
import wireFixtures from './fixtures/wire_syndication.json' with { type: 'json' };
import { clusterEvents, sourceFamily } from './event_cluster.js';
import { extractEvent } from './event_extract.js';
import type { CountryEvidence, RegionIdentity } from './types.js';

const region: RegionIdentity = {
  id: 'country:KR',
  name: 'South Korea',
  countryCode: 'KR',
  languages: ['ko'],
  aliases: [],
  confidence: 'high',
};
const now = new Date('2026-09-19T00:00:00.000Z');

function evidenceFor(fixture: string): CountryEvidence {
  const item = criticalFixtures.find((entry) => entry.fixture === fixture);
  if (!item) throw new Error(`Missing critical fixture: ${fixture}`);
  return item.evidence as CountryEvidence;
}

function wireEvidenceFor(item: { id: string; publisher: string; url: string; title: string }): CountryEvidence {
  return {
    id: item.id,
    regionId: region.id,
    url: item.url,
    title: item.title,
    publisher: item.publisher,
    eventCountry: 'KR',
    sourceType: 'local_media',
    publishedAt: '2026-09-18T10:00:00.000Z',
    retrievedAt: now.toISOString(),
    primarySource: false,
    latencyClass: 'near_realtime',
  };
}

test.each([
  ['日本で大地震', 'disaster_response'],
  ['日本製品不買イベント', 'boycott'],
  ['歴史記念日の記事', 'memorial_event'],
] as const)('extracts factual action for %s', (fixture, type) => {
  expect(extractEvent(evidenceFor(fixture), region, now)?.type).toBe(type);
});

test('separates Japanese government from Japanese people', () => {
  const event = extractEvent(evidenceFor('日本政府の政策を批判'), region, now)!;

  expect(event.targets).toContainEqual(expect.objectContaining({ type: 'foreign_government' }));
  expect(event.targets).not.toContainEqual(expect.objectContaining({ type: 'people_nationality' }));
});

test('attributes a quoted statement to the politician, not the publisher', () => {
  const event = extractEvent(evidenceFor('新聞が政治家の日本批判を引用'), region, now)!;

  expect(event.actors[0]).toMatchObject({ type: 'politician' });
});

test('clusters twenty wire copies as one event and one independent family', () => {
  const wireEvidence = wireFixtures.map(wireEvidenceFor);
  const wireDrafts = wireEvidence.map((item) => extractEvent(item, region, now)!);

  const events = clusterEvents(wireDrafts, wireEvidence);

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ evidenceCount: 20, independentSourceCount: 1 });
  expect(sourceFamily(wireEvidence[0])).toBe('wire:reuters');
});

test('does not mistake a mention of a wire service for syndication metadata', () => {
  const evidence: CountryEvidence = {
    id: 'reuters-mention', regionId: region.id, url: 'https://independent.example.test/report',
    title: 'Local paper discusses Reuters reporting', publisher: 'Independent Paper',
    sourceType: 'local_media', retrievedAt: now.toISOString(), primarySource: false,
    latencyClass: 'near_realtime',
  };

  expect(sourceFamily(evidence)).toBe('domain:independent.example.test');
});

test('uses an explicit wire family as one clustering signal', () => {
  const evidence: CountryEvidence[] = [
    {
      id: 'wire-family-one', regionId: region.id, url: 'https://one.example.test/story',
      title: '(Reuters) Boycott response develops', sourceType: 'local_media',
      publishedAt: '2026-09-18T10:00:00.000Z', retrievedAt: now.toISOString(), primarySource: false,
      latencyClass: 'near_realtime',
    },
    {
      id: 'wire-family-two', regionId: region.id, url: 'https://two.example.test/story',
      title: '(Reuters) Boycott action continues', sourceType: 'local_media',
      publishedAt: '2026-09-18T12:00:00.000Z', retrievedAt: now.toISOString(), primarySource: false,
      latencyClass: 'near_realtime',
    },
  ];

  expect(clusterEvents(evidence.map((item) => extractEvent(item, region, now)!), evidence)).toHaveLength(1);
});

test('keeps same-country protests on different dates separate', () => {
  const evidence = [
    {
      id: 'protest-one', regionId: region.id, url: 'https://example.test/protest-one',
      title: 'Seoul protest calls for policy change', eventCountry: 'KR',
      sourceType: 'local_media' as const, publishedAt: '2026-09-01T12:00:00.000Z',
      retrievedAt: now.toISOString(), primarySource: false, latencyClass: 'near_realtime' as const,
    },
    {
      id: 'protest-two', regionId: region.id, url: 'https://example.test/protest-two',
      title: 'Busan protest calls for labour reform', eventCountry: 'KR',
      sourceType: 'local_media' as const, publishedAt: '2026-09-16T12:00:00.000Z',
      retrievedAt: now.toISOString(), primarySource: false, latencyClass: 'near_realtime' as const,
    },
  ];

  expect(clusterEvents(evidence.map((item) => extractEvent(item, region, now)!), evidence)).toHaveLength(2);
});
