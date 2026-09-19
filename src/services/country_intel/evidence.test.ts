import { expect, test } from 'bun:test';
import {
  canonicalPublisherDomain,
  canonicalizeEvidenceUrl,
  deduplicateEvidence,
  hashEvidenceContent,
  normalizeEvidence,
} from './evidence.js';
import type { RegionIdentity } from './types.js';

const japan: RegionIdentity = {
  id: 'country:JP',
  name: 'Japan',
  countryCode: 'JP',
  languages: ['ja'],
  aliases: [],
  timezone: 'Asia/Tokyo',
  confidence: 'high',
};
const now = new Date('2026-09-19T00:00:00Z');

test('keeps publisher and event geography independent', () => {
  const evidence = normalizeEvidence({
    url: 'https://reuters.com/a?utm_source=x',
    title: 'Japan earthquake',
    publisherCountry: 'GB',
    mentionedCountries: ['JP'],
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);

  expect(evidence.publisherCountry).toBe('GB');
  expect(evidence.eventCountry).toBeUndefined();
  expect(evidence.url).toBe('https://reuters.com/a');
  expect(evidence.regionId).toBe('country:JP');
  expect(evidence.retrievedAt).toBe('2026-09-19T00:00:00.000Z');
});

test('canonicalizes only tracking URL parameters while preserving sorted meaningful parameters', () => {
  expect(canonicalizeEvidenceUrl('https://example.com/a?z=2&utm_source=x&a=1&gclid=ad#section'))
    .toBe('https://example.com/a?a=1&z=2');
});

test('derives conservative registrable publisher domains', () => {
  expect(canonicalPublisherDomain('https://alpha.org.uk/a')).toBe('alpha.org.uk');
  expect(canonicalPublisherDomain('https://beta.org.uk/a')).toBe('beta.org.uk');
  expect(canonicalPublisherDomain('https://news.alpha.org.uk/a')).toBe('alpha.org.uk');
  expect(canonicalPublisherDomain('https://www.alpha.org.uk/a')).toBe('alpha.org.uk');
  expect(canonicalPublisherDomain('https://news.alpha.com.au/a')).toBe('alpha.com.au');
  expect(canonicalPublisherDomain('https://news.alpha.co.jp/a')).toBe('alpha.co.jp');
  expect(canonicalPublisherDomain('https://news.alpha.unknown/a')).toBe('news.alpha.unknown');
});

test('hashes NFKC text with collapsed whitespace', () => {
  expect(hashEvidenceContent('  Japan\u3000 earthquake\n')).toBe(hashEvidenceContent('Japan earthquake'));
});

test('hashes distinct normalized content separately', () => {
  expect(hashEvidenceContent('Japan earthquake')).not.toBe(hashEvidenceContent('Japan earthquake response'));
});

test('uses a nonblank excerpt when content is blank', () => {
  const withExcerpt = normalizeEvidence({
    url: 'https://example.com/with-excerpt',
    content: ' \u3000\n ',
    excerpt: 'Japan earthquake',
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);
  const withoutExcerpt = normalizeEvidence({
    url: 'https://example.com/without-excerpt',
    content: ' \u3000\n ',
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);

  expect(withExcerpt.contentHash).toBe(hashEvidenceContent('Japan earthquake'));
  expect(withoutExcerpt.contentHash).toBeUndefined();
});

test('keeps evidence IDs stable across retrieval clocks and changes them for ID material', () => {
  const input = {
    url: 'https://example.com/a?utm_source=x',
    excerpt: 'Japan earthquake',
    publishedAt: '2026-09-18T00:00:00.000Z',
    sourceType: 'international_media' as const,
    primarySource: false,
    latencyClass: 'near_realtime' as const,
  };
  const first = normalizeEvidence(input, japan, now);
  const retrievedLater = normalizeEvidence(input, japan, new Date('2026-09-20T00:00:00Z'));
  const changedPublication = normalizeEvidence({ ...input, publishedAt: '2026-09-17T00:00:00.000Z' }, japan, now);
  const changedRegion = normalizeEvidence(input, { ...japan, id: 'country:KR' }, now);

  expect(retrievedLater.id).toBe(first.id);
  expect(changedPublication.id).not.toBe(first.id);
  expect(changedRegion.id).not.toBe(first.id);
});

test('deduplicates canonical URLs and exact normalized content', () => {
  const trackingUrlCopy = normalizeEvidence({
    url: 'https://example.com/a?utm_source=newsletter',
    excerpt: 'Japan earthquake',
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);
  const canonical = normalizeEvidence({
    url: 'https://example.com/a',
    excerpt: 'Different copy of the same source',
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);
  const exactContentCopy = normalizeEvidence({
    url: 'https://another-publisher.test/story',
    excerpt: 'Japan\u3000 earthquake',
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);

  expect(deduplicateEvidence([trackingUrlCopy, canonical, exactContentCopy]))
    .toEqual([trackingUrlCopy, exactContentCopy]);
});

test('deduplicates identical content only within the same canonical publisher domain', () => {
  const first = normalizeEvidence({
    url: 'https://news.example.co.uk/a',
    excerpt: 'wire content',
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);
  const samePublisher = normalizeEvidence({
    url: 'https://archive.example.co.uk/b',
    excerpt: 'wire content',
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);
  const syndicationCopy = normalizeEvidence({
    url: 'https://another-publisher.example.com/story',
    excerpt: 'wire content',
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);

  expect(deduplicateEvidence([first, samePublisher, syndicationCopy]))
    .toEqual([first, syndicationCopy]);
});
