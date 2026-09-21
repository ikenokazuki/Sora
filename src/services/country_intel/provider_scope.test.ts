import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGdeltDocUrl } from './providers/gdelt.js';
import { parseGdacsResponse } from './providers/gdacs.js';
import { parseWikidataResponse } from './providers/wikidata.js';
import { createWorldBankProvider } from './providers/worldbank.js';
import { createNagerProvider } from './providers/nager.js';
import type { ProviderInput } from './provider_registry.js';

const fixtureDir = join(import.meta.dir, 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
const korea: ProviderInput['region'] = {
  id: 'country:KR', name: 'South Korea', countryCode: 'KR',
  languages: ['ko'], aliases: [], confidence: 'high',
};
const koreaInput = (providerId: string): ProviderInput => ({
  request: { region: 'South Korea' } as never, region: korea,
  queries: [{ pass: 1, providerId, query: 'South Korea', topics: [], maxItems: 10 }],
});
const now = new Date('2026-09-19T00:00:00Z');
const unresolvedInput: ProviderInput = {
  request: { region: 'Unknown Example Region' } as never,
  region: { id: 'unresolved:unknown example region', name: 'Unknown Example Region', languages: [], aliases: [], confidence: 'low' },
  queries: [],
};

describe('provider scope and period correctness', () => {
  test('maps requested period into GDELT timespan', () => {
    expect(buildGdeltDocUrl('Japan', 25, '7d')).toContain('timespan=7d');
    expect(buildGdeltDocUrl('Japan', 25, '30d')).toContain('timespan=30d');
    expect(buildGdeltDocUrl('Japan', 25, '90d')).toContain('timespan=90d');
  });

  test('keeps only events belonging to requested region', () => {
    const items = parseGdacsResponse(load('gdacs_mixed_regions.json'), koreaInput('gdacs'), now);
    expect(items).toHaveLength(1);
    expect(items[0].evidence?.eventCountry).toBe('KR');
  });

  test('does not treat Wikidata entity page as an official source', () => {
    const items = parseWikidataResponse({
      search: [{ id: 'Q17', label: 'Japan', url: 'https://www.wikidata.org/wiki/Q17' }],
    }, koreaInput('wikidata'), now);
    expect(items.some((x) => x.source?.sourceType === 'official')).toBe(false);
  });

  test('worldbank is unavailable without a resolved country, never KR fallback', async () => {
    const result = await createWorldBankProvider(async () => {
      throw new Error('must not fetch without a resolved country');
    }).run(unresolvedInput, AbortSignal.timeout(1000));
    expect(result.status).toBe('unavailable');
    expect(result.errorCode).toBe('PROVIDER_REGION_UNSUPPORTED');
    expect(result.items).toEqual([]);
  });

  test('nager is unavailable without a resolved country, never KR fallback', async () => {
    const result = await createNagerProvider(async () => {
      throw new Error('must not fetch without a resolved country');
    }).run(unresolvedInput, AbortSignal.timeout(1000));
    expect(result.status).toBe('unavailable');
    expect(result.errorCode).toBe('PROVIDER_REGION_UNSUPPORTED');
    expect(result.items).toEqual([]);
  });
});
