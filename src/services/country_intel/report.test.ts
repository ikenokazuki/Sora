import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { normalizeEvidence } from './evidence.js';
import { ProviderHttpError, type CountryIntelProvider } from './provider_registry.js';
import { getPersistedCountryContext, researchCountryContext } from './report.js';

let directory: string;
let previousPath: string | undefined;
const now = () => new Date('2026-09-19T00:00:00Z');

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-report-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

function evidenceProvider(id: string, title: string, extra: Record<string, unknown> = {}): CountryIntelProvider {
  return {
    id, areas: ['media_activity', 'current_events'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
    async run(input) {
      return {
        items: [{
          evidence: normalizeEvidence({
            url: `https://news.example/${id}/1`, title, publisher: 'Example News',
            publisherCountry: 'US', eventCountry: 'KR', mentionedCountries: ['JP'],
            sourceType: 'international_media', publishedAt: '2026-09-18T00:00:00Z',
            excerpt: 'Japanese government statement quoted in Seoul', primarySource: false,
            latencyClass: 'near_realtime', ...extra,
          }, input.region, now()),
        }],
        coverage: ['media_activity'],
      };
    },
  };
}

describe('country report', () => {
  test('assembles and persists a comprehensive evidence-backed report', async () => {
    const report = await researchCountryContext(
      { region: 'South Korea' },
      { providers: [evidenceProvider('gdelt', 'Meeting on trade agreement in Seoul')], now, cache: null },
    );
    expect(report.region.countryCode).toBe('KR');
    expect(report.keyEvents.length).toBeGreaterThan(0);
    expect(report.evidence.length).toBeGreaterThan(0);
    expect(getPersistedCountryContext(report.contextId)).toEqual(report);
  });
  test('returns partial report when a provider returns 429', async () => {
    const failing: CountryIntelProvider = {
      id: 'limited', areas: ['media_activity'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
      async run() { throw new ProviderHttpError(429); },
    };
    const report = await researchCountryContext(
      { region: 'KR' },
      { providers: [evidenceProvider('gdelt', 'Election rally in Seoul'), failing], now, cache: null },
    );
    expect(report.coverage.overall).toBe('partial');
    expect(report.providerCoverage).toContainEqual(expect.objectContaining({ status: 'rate_limited' }));
  });
  test('creates Japan projection without semantic scores', async () => {
    const report = await researchCountryContext(
      { region: 'KR' },
      { providers: [evidenceProvider('gdelt', 'Japanese government statement on trade quoted in Seoul')], now, cache: null },
    );
    expect(report.japan?.countryCode).toBe('JP');
    expect(JSON.stringify(report)).not.toMatch(/antiJapan|hostility|riskScore/i);
  });
});
