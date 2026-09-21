import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { feedEntriesToAcquisition, parseFeed } from './feeds.js';
import { parseUsgsResponse } from './usgs.js';
import { parseEonetResponse } from './eonet.js';
import { GLOBAL_FEED_CATALOG } from '../source_catalog.js';
import type { ProviderInput } from '../provider_registry.js';

const fixtureDir = join(import.meta.dir, '..', 'fixtures');
const input: ProviderInput = { request: { region: 'CN' } as never, region: { id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [], confidence: 'high' }, queries: [] };
const now = new Date('2026-09-22T00:00:00Z');

describe('global feeds', () => {
  test('unclassified non-English evidence remains retrievable', () => {
    const xml = readFileSync(join(fixtureDir, 'feed-arabic.xml'), 'utf8');
    const details = parseFeed(xml, 'regional-source');
    expect(details).toHaveLength(1);
    expect(details[0].language).toBe('ar');
    const [item] = feedEntriesToAcquisition(details, { id: 'regional-source', url: 'https://example.org/notice', publisher: 'Regional source', languages: ['ar'], areas: [], sourceType: 'international_media', verificationBasis: 'fixture', pollIntervalMs: 300000, contentPolicy: 'excerpt_only' }, input, now);
    expect(item.detail?.blocks.length).toBeGreaterThan(0);
    expect(item.detail?.geographyBasis).toBe('unknown');
    expect(item.evidence?.eventCountry).toBeUndefined();
  });

  test('atom links resolve from href attributes', () => {
    const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Rate decision</title><link href="https://example.org/atom/1"/><summary>Held steady.</summary><published>2026-09-21T10:00:00Z</published></entry></feed>';
    const [entry] = parseFeed(xml, 'atom-source');
    expect(entry.link).toBe('https://example.org/atom/1');
    expect(entry.publishedAt).toBe('2026-09-21T10:00:00Z');
  });

  test('usgs keeps magnitude and depth without asserting a country', () => {
    const fixture = JSON.parse(readFileSync(join(fixtureDir, 'usgs.json'), 'utf8'));
    const items = parseUsgsResponse(fixture, input, now);
    expect(items).toHaveLength(2);
    expect(items[0].evidence?.eventCountry).toBeUndefined();
    expect(items[0].detail?.structuredData).toMatchObject({ mag: 5.2, depthKm: 10 });
    expect(items[0].detail?.providerItemId).toBe('us7000ab12');
  });

  test('eonet keeps geometry dates as its own provider records', () => {
    const fixture = JSON.parse(readFileSync(join(fixtureDir, 'eonet.json'), 'utf8'));
    const items = parseEonetResponse(fixture, input, now);
    expect(items).toHaveLength(2);
    expect(items[0].detail?.providerId).toBe('eonet');
    expect(items[0].detail?.structuredData).toMatchObject({ geometryDates: ['2026-09-21T12:00:00Z'] });
  });

  test('catalog has no realtime search dependency', () => {
    const urls = GLOBAL_FEED_CATALOG.map((entry) => entry.url).join(' ');
    expect(urls).not.toMatch(/yahoo|realtime/i);
    expect(GLOBAL_FEED_CATALOG.map((entry) => entry.id)).toEqual(expect.arrayContaining(['bbc-world', 'un-news', 'ecb-press']));
  });
});
