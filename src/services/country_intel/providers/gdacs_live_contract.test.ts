import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchGdacsRegion, parseGdacsApi, parseGdacsFeed, parseGdacsResponse, resolveGdacsUrl } from './gdacs.js';
import type { ProviderInput } from '../provider_registry.js';

const fixtureDir = join(import.meta.dir, '..', 'fixtures', 'live-contracts');
const load = (name: string): unknown => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
const china: ProviderInput = { request: { region: 'CN' } as never, region: { id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [], confidence: 'high' }, queries: [] };
const now = new Date('2026-09-22T00:00:00Z');

describe('gdacs live contract', () => {
  test('legacy string-url fixtures keep parsing', () => {
    const korea: ProviderInput = { request: { region: 'KR' } as never, region: { id: 'KOR', name: 'South Korea', countryCode: 'KR', languages: [], aliases: [], confidence: 'high' }, queries: [] };
    const legacy = JSON.parse(readFileSync(join(import.meta.dir, '..', 'fixtures', 'gdacs.json'), 'utf8'));
    const [item] = parseGdacsResponse(legacy, korea, now);
    expect(item.evidence?.eventCountry).toBe('KR');
    expect(item.detail?.providerItemId).toContain('TC');
  });

  test('an affected country is retained even when it is not the first country', () => {
    const fixture = load('gdacs-api-multicountry.json') as Parameters<typeof parseGdacsApi>[0];
    const raw = fixture.features?.[0]?.properties;
    expect(resolveGdacsUrl(raw!)).toBe('https://www.gdacs.org/report.aspx?eventid=1104081&episodeid=19&eventtype=FL');
    expect(matchGdacsRegion(raw!, china)).toEqual(['CN']);
    const [item] = parseGdacsApi(fixture, china, now);
    expect(item.evidence?.url).toBe('https://www.gdacs.org/report.aspx?episodeid=19&eventid=1104081&eventtype=FL');
    expect(item.evidence?.eventCountry).toBe('CN');
    expect(item.detail?.providerItemId).toBe('FL:1104081:19');
    expect(item.detail?.structuredData).toMatchObject({ alertLevel: 'Orange', affectedCountryCodes: ['CN'] });
  });

  test('rss items resolve the same record key', () => {
    const xml = readFileSync(join(fixtureDir, 'gdacs-rss-sample.xml'), 'utf8');
    const [item] = parseGdacsFeed(xml, china, now);
    expect(item.evidence?.eventCountry).toBe('CN');
    expect(item.detail?.providerItemId).toBe('FL:1104081:19');
  });

  test('unknown geography and missing urls are excluded with a reason to count', () => {
    const fixture = { features: [{ properties: { eventtype: 'EQ', eventid: 1, country: 'Atlantis', url: 'https://www.gdacs.org/report.aspx?eventid=1' } }, { properties: { eventtype: 'EQ', eventid: 2, country: 'China' } }] };
    expect(parseGdacsApi(fixture, china, now)).toEqual([]);
  });
});
