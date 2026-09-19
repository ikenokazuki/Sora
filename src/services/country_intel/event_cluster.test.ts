import { expect, test } from 'bun:test';
import criticalFixtures from './fixtures/critical_events.json' with { type: 'json' };
import wireFixtures from './fixtures/wire_syndication.json' with { type: 'json' };
import { clusterEvents, sourceFamily } from './event_cluster.js';
import { extractEvent } from './event_extract.js';
import { deduplicateEvidence, normalizeEvidence, type EvidenceInput } from './evidence.js';
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

function wireEvidenceFor(item: { publisher: string; url: string; title: string }): EvidenceInput {
  return {
    url: item.url,
    title: item.title,
    excerpt: 'SEOUL, Sept 18 (Reuters) - Japanese product boycott event held in Seoul.',
    publisher: item.publisher,
    eventCountry: 'KR',
    sourceType: 'local_media',
    publishedAt: '2026-09-18T10:00:00.000Z',
    primarySource: false,
    latencyClass: 'near_realtime',
  };
}

test('extracts the Japan earthquake as a factual disaster event at its explicit location', () => {
  const event = extractEvent(evidenceFor('日本で大地震'), region, now)!;

  expect(event).toMatchObject({ type: 'disaster_response', location: { countryCode: 'JP' } });
  expect(event.targets).toContainEqual({ name: 'Japan', type: 'country', countryCode: 'JP' });
});

test('extracts a boycott target from a factual excerpt when the title is generic', () => {
  const event = extractEvent(evidenceFor('日本製品不買イベント'), region, now)!;

  expect(event).toMatchObject({ type: 'boycott' });
  expect(event.targets).toContainEqual({ name: 'Japanese products', type: 'product', countryCode: 'JP' });
});

test('extracts the memorial event case', () => {
  expect(extractEvent(evidenceFor('歴史記念日の記事'), region, now)?.type).toBe('memorial_event');
});

test('separates Japanese government from Japanese people', () => {
  const event = extractEvent(evidenceFor('日本政府の政策を批判'), region, now)!;

  expect(event.targets).toContainEqual({ name: 'Japanese government', type: 'foreign_government', countryCode: 'JP' });
  expect(event.targets).not.toContainEqual(expect.objectContaining({ type: 'people_nationality' }));
});

test('extracts Japanese people as a standalone nationality target', () => {
  const evidence = { ...evidenceFor('日本政府の政策を批判'), id: 'people-target', title: '日本人への声明', excerpt: undefined };

  expect(extractEvent(evidence, region, now)!.targets)
    .toEqual([{ name: 'Japanese people', type: 'people_nationality', countryCode: 'JP' }]);
});

test('attributes a quoted statement to the politician, not the publisher', () => {
  const event = extractEvent(evidenceFor('新聞が政治家の日本批判を引用'), region, now)!;

  expect(event.actors[0]).toMatchObject({ type: 'politician' });
  expect(event.actors).not.toContainEqual(expect.objectContaining({ type: 'media' }));
});

test('collects every explicit actor from title and excerpt', () => {
  const evidence = { ...evidenceFor('新聞が政治家の日本批判を引用'), id: 'several-actors', title: '政治家が発言', excerpt: '政府と政治家が日本について発言した。' };

  expect(extractEvent(evidence, region, now)!.actors).toEqual(expect.arrayContaining([
    { name: 'politician', type: 'politician' },
    { name: 'government', type: 'government' },
  ]));
});

test('keeps every explicit Japanese target in one event', () => {
  const event = extractEvent(evidenceFor('複数の日本対象'), region, now)!;

  expect(event.targets).toEqual(expect.arrayContaining([
    { name: 'Japanese government', type: 'foreign_government', countryCode: 'JP' },
    { name: 'Japanese people', type: 'people_nationality', countryCode: 'JP' },
    { name: 'Japanese products', type: 'product', countryCode: 'JP' },
    { name: 'Japan', type: 'country', countryCode: 'JP' },
  ]));
});

test('clusters twenty wire copies as one event and one independent family', () => {
  const wireEvidence = wireFixtures.map((item) => normalizeEvidence(wireEvidenceFor(item), region, now));
  const retainedEvidence = deduplicateEvidence(wireEvidence);
  const wireDrafts = retainedEvidence.map((item) => extractEvent(item, region, now)!);

  const events = clusterEvents(wireDrafts, retainedEvidence);

  expect(retainedEvidence).toHaveLength(20);
  expect(new Set(retainedEvidence.map((item) => item.id))).toHaveLength(20);
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

  expect(sourceFamily(evidence)).toBe('domain:example.test');
});

test('recognizes bounded wire datelines and canonical publisher domains', () => {
  const dateline = (title: string, url: string): CountryEvidence => ({
    id: title, regionId: region.id, url, title, sourceType: 'local_media',
    retrievedAt: now.toISOString(), primarySource: false, latencyClass: 'near_realtime',
  });

  expect(sourceFamily(dateline('SEOUL, Sept 19 (Reuters) - report', 'https://asia.news.example.co.uk/a'))).toBe('wire:reuters');
  expect(sourceFamily(dateline('WASHINGTON (AP) - report', 'https://api.example.com/a'))).toBe('wire:ap');
  expect(sourceFamily(dateline('PARIS (AFP) - report', 'https://www.example.com/a'))).toBe('wire:afp');
  expect(sourceFamily({ ...dateline('(Reuters) - report', 'https://www.example.com/a'), publisher: 'Associated Press' })).toBe('wire:ap');
  expect(sourceFamily(dateline('Independent report', 'https://asia.news.example.co.uk/a'))).toBe('domain:example.co.uk');
});

test('uses deterministic fallbacks for invalid or missing timestamps', () => {
  const evidence: CountryEvidence = {
    id: 'invalid-time', regionId: region.id, url: 'https://example.test/time', title: 'Japan protest',
    sourceType: 'local_media', publishedAt: 'not-a-timestamp', retrievedAt: 'not-a-timestamp',
    primarySource: false, latencyClass: 'near_realtime',
  };

  expect(extractEvent(evidence, region, now)).toMatchObject({
    occurredAt: undefined,
    firstSeenAt: '2026-09-19T00:00:00.000Z',
    lastSeenAt: '2026-09-19T00:00:00.000Z',
  });
});

test('does not merge same-day unrelated stories merely because they share a wire family', () => {
  const evidence: CountryEvidence[] = [
    {
      id: 'wire-family-one', regionId: region.id, url: 'https://one.example.test/story',
      title: '(Reuters) protest over tax policy', eventCountry: 'KR', sourceType: 'local_media',
      publishedAt: '2026-09-18T10:00:00.000Z', retrievedAt: now.toISOString(), primarySource: false,
      latencyClass: 'near_realtime',
    },
    {
      id: 'wire-family-two', regionId: region.id, url: 'https://two.example.test/story',
      title: '(Reuters) protest over labour policy', eventCountry: 'KR', sourceType: 'local_media',
      publishedAt: '2026-09-18T12:00:00.000Z', retrievedAt: now.toISOString(), primarySource: false,
      latencyClass: 'near_realtime',
    },
  ];

  expect(clusterEvents(evidence.map((item) => extractEvent(item, region, now)!), evidence)).toHaveLength(2);
});

test('does not merge drafts across regions or conflicting known event countries', () => {
  const crossRegion = [
    { id: 'kr', regionId: 'country:KR', url: 'https://a.test/one', title: 'Japan protest', eventCountry: 'JP', sourceType: 'local_media' as const, publishedAt: '2026-09-18T10:00:00Z', retrievedAt: now.toISOString(), primarySource: false, latencyClass: 'near_realtime' as const },
    { id: 'jp', regionId: 'country:JP', url: 'https://b.test/two', title: 'Japan protest', eventCountry: 'JP', sourceType: 'local_media' as const, publishedAt: '2026-09-18T11:00:00Z', retrievedAt: now.toISOString(), primarySource: false, latencyClass: 'near_realtime' as const },
  ];
  const conflictingLocations = [
    { ...crossRegion[0], id: 'location-jp', regionId: region.id },
    { ...crossRegion[0], id: 'location-kr', regionId: region.id, url: 'https://c.test/three', eventCountry: 'KR' },
  ];

  expect(clusterEvents(crossRegion.map((item) => extractEvent(item, region, now)!), crossRegion)).toHaveLength(2);
  expect(clusterEvents(conflictingLocations.map((item) => extractEvent(item, region, now)!), conflictingLocations)).toHaveLength(2);
});

test('normalizes mixed-offset timestamps and chooses chronological bounds', () => {
  const evidence: CountryEvidence[] = [
    { id: 'late', regionId: region.id, url: 'https://a.test/late', title: 'Japan protest', eventCountry: 'KR', sourceType: 'local_media', publishedAt: '2026-09-19T00:30:00+09:00', retrievedAt: '2026-09-19T00:30:00+09:00', primarySource: false, latencyClass: 'near_realtime' },
    { id: 'early', regionId: region.id, url: 'https://b.test/early', title: 'Japan protest', eventCountry: 'KR', sourceType: 'local_media', publishedAt: '2026-09-18T18:00:00Z', retrievedAt: '2026-09-18T18:00:00Z', primarySource: false, latencyClass: 'near_realtime' },
  ];
  const event = clusterEvents(evidence.map((item) => extractEvent(item, region, now)!), evidence)[0];

  expect(event).toMatchObject({
    occurredAt: '2026-09-18T15:30:00.000Z',
    firstSeenAt: '2026-09-18T15:30:00.000Z',
    lastSeenAt: '2026-09-18T18:00:00.000Z',
  });
});

test('clusters transitive matching pairs independent of input order', () => {
  const evidence: CountryEvidence[] = [
    { id: 'a', regionId: region.id, url: 'https://a.test/story', title: 'protest over tax law', sourceType: 'local_media', publishedAt: '2026-09-18T10:00:00Z', retrievedAt: now.toISOString(), primarySource: false, latencyClass: 'near_realtime' },
    { id: 'b', regionId: region.id, url: 'https://b.test/story', title: 'protest over tax law changes', sourceType: 'local_media', publishedAt: '2026-09-18T11:00:00Z', retrievedAt: now.toISOString(), primarySource: false, latencyClass: 'near_realtime' },
    { id: 'c', regionId: region.id, url: 'https://c.test/story', title: 'protest over tax law changes today', sourceType: 'local_media', publishedAt: '2026-09-18T12:00:00Z', retrievedAt: now.toISOString(), primarySource: false, latencyClass: 'near_realtime' },
  ];
  const drafts = evidence.map((item) => extractEvent(item, region, now)!);

  expect(clusterEvents(drafts, evidence)).toHaveLength(1);
  expect(clusterEvents([...drafts].reverse(), [...evidence].reverse())).toHaveLength(1);
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
