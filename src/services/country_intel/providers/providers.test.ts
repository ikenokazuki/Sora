import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGdeltDocUrl, parseGdeltDocResponse, parseGdeltSeendate } from './gdelt.js';
import { buildGdeltEventsUrl, parseGdeltEventsResponse } from './gdelt_events.js';
import { buildGdacsUrl, parseGdacsResponse } from './gdacs.js';
import { buildWorldBankUrl, parseWorldBankResponse } from './worldbank.js';
import { buildNagerUrl, parseNagerResponse } from './nager.js';
import { buildWikidataUrl, parseWikidataResponse } from './wikidata.js';
import type { ProviderInput } from '../provider_registry.js';

const fixtureDir = join(import.meta.dir, '..', 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
const region: ProviderInput['region'] = { id: 'KOR', name: 'South Korea', countryCode: 'KR', languages: ['ko'], aliases: [], confidence: 'high' };
const baseInput = (providerId = 'gdelt'): ProviderInput => ({ request: { region: 'South Korea' } as never, region, queries: [{ pass: 1, providerId, query: 'South Korea', topics: [], maxItems: 10 }] });
const now = new Date('2026-09-19T00:00:00Z');

describe('structured providers', () => {
  test('gdelt keeps publisher geography, never event geography', () => {
    expect(buildGdeltDocUrl('South Korea', 25)).toBe('https://api.gdeltproject.org/api/v2/doc/doc?query=South+Korea&mode=ArtList&format=json&maxrecords=25&sort=DateDesc');
    expect(parseGdeltSeendate('20260910T083000Z')).toBe('2026-09-10T08:30:00Z');
    const [item] = parseGdeltDocResponse(load('gdelt.json'), baseInput('gdelt'), now);
    expect(item.evidence?.publisherCountry).toBe('US');
    expect(item.evidence?.eventCountry).toBeUndefined();
    expect(item.evidence?.sourceType).toBe('international_media');
    expect(item.evidence?.latencyClass).toBe('near_realtime');
    expect(item.evidence?.publishedAt).toBe('2026-09-10T08:30:00Z');
    expect(item.evidence?.url).toBe('https://www.nytimes.com/2026/09/10/world/asia/korea-policy.html');
  });
  test('gdelt events keeps structured event geography', () => {
    expect(buildGdeltEventsUrl('Korea', 50)).toContain('https://api.gdeltproject.org/api/v2/events/events?');
    const [item] = parseGdeltEventsResponse(load('gdelt_events.json'), baseInput('gdelt_events'), now);
    expect(item.evidence?.eventCountry).toBe('KOR');
    expect(item.evidence?.sourceType).toBe('structured_dataset');
    expect(item.evidence?.latencyClass).toBe('delayed');
    expect(item.evidence?.publishedAt).toBe('2026-09-10T00:00:00Z');
  });
  test('gdacs parses disaster alert with event country', () => {
    expect(buildGdacsUrl()).toContain('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH');
    const [item] = parseGdacsResponse(load('gdacs.json'), baseInput('gdacs'), now);
    expect(item.evidence?.eventCountry).toBe('KOR');
    expect(item.evidence?.sourceType).toBe('structured_dataset');
    expect(item.evidence?.latencyClass).toBe('near_realtime');
  });
  test('world bank emits temporal observation, not event', () => {
    expect(buildWorldBankUrl('KOR')).toContain('https://api.worldbank.org/v2/country/KOR/indicator/NY.GDP.MKTP.CD');
    const [item] = parseWorldBankResponse(load('worldbank.json'), baseInput('worldbank'));
    expect(item.metric?.current).toBe(1712345678901.5);
    expect(item.metric?.key).toBe('worldbank:NY.GDP.MKTP.CD');
    expect(item.evidence).toBeUndefined();
  });
  test('nager preserves calendar local date', () => {
    expect(buildNagerUrl(2026, 'KR')).toBe('https://date.nager.at/api/v3/publicholidays/2026/KR');
    const [item] = parseNagerResponse(load('nager.json'), baseInput('nager'));
    expect(item.calendar?.date).toBe('2026-10-03');
    expect(item.calendar?.type).toBe('public_holiday');
    expect(item.calendar?.official).toBe(true);
  });
  test('wikidata emits discovery-only source candidates', () => {
    expect(buildWikidataUrl('Korea')).toContain('https://www.wikidata.org/w/api.php?');
    const [item] = parseWikidataResponse(load('wikidata.json'), baseInput('wikidata'), now);
    expect(item.source?.verificationStatus).toBe('candidate');
    expect(item.source?.domain).toBe('mofa.go.kr');
    expect(item.evidence).toBeUndefined();
  });
});
