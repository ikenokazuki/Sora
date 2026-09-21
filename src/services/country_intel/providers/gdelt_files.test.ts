import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectGdeltWindow, createGdeltExportProvider, filterGdeltRowsForRegion, parseGdeltExport, parseGdeltLastUpdate } from './gdelt_files.js';
import type { CollectionWindow } from '../detail.js';
import type { RegionIdentity } from '../types.js';

const tsv = readFileSync(join(import.meta.dir, '..', 'fixtures', 'live-contracts', 'gdelt-export.tsv'), 'utf8');
const china: RegionIdentity = { id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [], confidence: 'high' };
const thirtyDays: CollectionWindow = { from: '2026-08-23T00:00:00Z', to: '2026-09-22T00:00:00Z', complete: false, gaps: [] };

describe('gdelt files', () => {
  test('export schema uses the real ActionGeo country column', () => {
    const rows = parseGdeltExport(tsv);
    expect(rows).toHaveLength(1);
    expect(rows[0].ActionGeo_CountryCode).toBe('CH');
    expect(rows[0].SOURCEURL).toMatch(/^https?:\/\//);
    expect(filterGdeltRowsForRegion(rows, china)).toHaveLength(1);
    expect(filterGdeltRowsForRegion(rows, { ...china, countryCode: 'US' })).toHaveLength(0);
  });

  test('last update lists https export urls', () => {
    const urls = parseGdeltLastUpdate('92766 abc http://data.gdeltproject.org/gdeltv2/20260921181500.export.CSV.zip\n');
    expect(urls).toEqual(['https://data.gdeltproject.org/gdeltv2/20260921181500.export.CSV.zip']);
  });

  test('one imported file never completes a thirty day window', async () => {
    const result = await collectGdeltWindow(thirtyDays, {
      listExportUrls: async () => ['https://data.gdeltproject.org/gdeltv2/20260921181500.export.CSV.zip'],
      fetchExport: async () => tsv,
      signal: new AbortController().signal,
    });
    expect(result.complete).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.gaps[0].reason).toMatch(/period_gap/);
  });

  test('export provider resolves the latest file for the requested region', async () => {
    const fetchFn = (async (url: string) => {
      if (url.endsWith('lastupdate.txt')) return new Response('1 a http://data.gdeltproject.org/gdeltv2/20260921181500.export.CSV.zip\n', { status: 200, headers: { 'content-type': 'text/plain' } });
      return new Response('zip-bytes', { status: 200, headers: { 'content-type': 'application/zip' } });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const provider = createGdeltExportProvider({ fetchFn, decompressZip: async () => tsv });
    const input = { request: { region: 'CN' } as never, region: china, queries: [] };
    const result = await provider.run(input, new AbortController().signal);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].evidence?.eventCountry).toBe('CN');
  });
});
