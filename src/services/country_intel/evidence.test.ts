import { expect, test } from 'bun:test';
import {
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

test('hashes NFKC text with collapsed whitespace', () => {
  expect(hashEvidenceContent('  Japan\u3000 earthquake\n')).toBe(hashEvidenceContent('Japan earthquake'));
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
    url: 'https://another.example.com/story',
    excerpt: 'Japan\u3000 earthquake',
    sourceType: 'international_media',
    primarySource: false,
    latencyClass: 'near_realtime',
  }, japan, now);

  expect(deduplicateEvidence([trackingUrlCopy, canonical, exactContentCopy])).toHaveLength(1);
});
