import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOfficialWebProvider } from './official_web.js';
import { parseWorldBankIndicator, WORLD_BANK_INDICATORS } from './worldbank.js';
import { parseNagerDetails } from './nager.js';
import type { ProviderInput } from '../provider_registry.js';

const input: ProviderInput = { request: { region: 'CN' } as never, region: { id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [], confidence: 'high' }, queries: [{ pass: 2, providerId: 'official_web', query: 'site:example.org update', topics: [], maxItems: 10, sourceDomain: 'example.org' }] };

describe('provider details', () => {
  test('article scraping uses the discovered article rather than its homepage', async () => {
    const calls: string[] = [];
    const provider = createOfficialWebProvider({
      searchWeb: async () => [{ url: 'https://example.org/news/update-123', title: 'Official update' }],
      scrapeUrl: async (url: string) => { calls.push(url); return { markdown: 'The opening time changed.', title: 'Official update' }; },
      verifiedDomains: ['example.org'],
    });
    const result = await provider.run(input, new AbortController().signal);
    expect(calls).toContain('https://example.org/news/update-123');
    expect(calls).not.toContain('https://example.org/');
    expect(result.items[0].detail?.contentKind).toBe('extracted_text');
    expect(result.items[0].detail?.blocks[0].text).toContain('opening time');
  });

  test('scrape failure keeps the snippet detail', async () => {
    const provider = createOfficialWebProvider({
      searchWeb: async () => [{ url: 'https://example.org/news/9', title: 'T', snippet: 'short excerpt' }],
      scrapeUrl: async () => { throw new Error('blocked'); },
    });
    const result = await provider.run({ request: { region: 'CN' } as never, region: input.region, queries: [] }, new AbortController().signal);
    expect(result.items[0].detail?.contentKind).toBe('excerpt');
  });

  test('world bank keeps the full series with units and source', () => {
    const indicator = WORLD_BANK_INDICATORS[0];
    const fixture = [null, [{ indicator: { id: indicator.id }, date: '2024', value: 19498039388042.6 }, { indicator: { id: indicator.id }, date: '2023', value: 17900000000000 }, { indicator: { id: indicator.id }, date: '2022', value: null }]] as never;
    const parsed = parseWorldBankIndicator(fixture, indicator, 'https://api.worldbank.org/v2/u', input, new Date('2026-09-22T00:00:00Z'));
    expect(parsed?.metric.key).toBe('worldbank:NY.GDP.MKTP.CD');
    expect(parsed?.metric.current).toBe(19498039388042.6);
    expect(parsed?.metric.direction).toBe('rising');
    expect(parsed?.detail.structuredData).toMatchObject({ unit: 'USD', sourceUrl: 'https://api.worldbank.org/v2/u' });
    expect((parsed?.detail.structuredData?.observations as unknown[]).length).toBe(2);
  });

  test('nager preserves scope fields in the detail', () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, '..', 'fixtures', 'nager.json'), 'utf8'));
    const [parsed] = parseNagerDetails(fixture, input, new Date('2026-09-22T00:00:00Z'));
    expect(parsed.calendar.date).toBe('2026-10-03');
    expect(parsed.detail.providerId).toBe('nager');
    expect(parsed.detail.evidenceId).toBe(parsed.calendar.id);
    expect(parsed.detail.timeBasis).toBe('provider_calendar');
  });
});
