import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { normalizeEvidence } from './evidence.js';
import { ProviderHttpError, type CountryIntelProvider } from './provider_registry.js';
import { getEvidencePage } from './db.js';
import { researchCountryContext } from './report.js';

let directory: string;
let previousPath: string | undefined;
const now = () => new Date('2026-09-19T00:00:00Z');

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-v2-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

function evidenceProvider(id: string): CountryIntelProvider {
  return {
    id, areas: ['media_activity'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
    async run(input) {
      const evidence = normalizeEvidence({ url: 'https://news.example/' + id + '/1', title: 'Trade agreement signed', excerpt: 'Ministers signed a trade agreement.', publisher: 'Example News', sourceType: 'international_media', primarySource: false, latencyClass: 'near_realtime' }, input.region, now());
      return { items: [{ evidence, detail: { evidenceId: evidence.id, providerId: id, providerItemId: '1', sourceRecordUrl: 'https://news.example/' + id + '/1', contentKind: 'excerpt', blocks: [{ index: 0, text: 'Ministers signed a trade agreement.' }], retrievedAt: now().toISOString(), timeBasis: 'retrieved', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: false } }], coverage: ['media_activity'] };
    },
  };
}

describe('report v2', () => {
  test('report carries versioned domain context and persisted details', async () => {
    const report = await researchCountryContext({ region: 'South Korea' }, { providers: [evidenceProvider('gdelt')], now, cache: null });
    expect(report.schemaVersion).toBe('2');
    expect(Object.keys(report.domainContext ?? {}).sort()).toEqual(['content', 'finance', 'general', 'marketing', 'tourism', 'travel']);
    expect(report.domainContext?.content?.factors.length).toBeGreaterThan(0);
    expect(report.refreshState?.state).toBe('complete');
    expect(report.actualWindows?.[0]?.complete).toBe(true);
    expect(report.limitations).toEqual([]);
    const page = getEvidencePage(report.contextId, { limit: 40 });
    expect(page.totalStored).toBe(1);
    expect(page.items[0].blocks[0].text).toContain('trade agreement');
  });

  test('failed providers surface as limitations with window gaps', async () => {
    const failing: CountryIntelProvider = {
      id: 'limited', areas: ['media_activity'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
      async run() { throw new ProviderHttpError(429); },
    };
    const report = await researchCountryContext({ region: 'South Korea' }, { providers: [evidenceProvider('gdelt'), failing], now, cache: null });
    expect(report.refreshState?.state).toBe('partial');
    expect(report.limitations?.some((l) => l.providerId === 'limited' && l.code === 'rate_limited')).toBe(true);
    expect(report.actualWindows?.[0]?.complete).toBe(false);
    expect(report.actualWindows?.[0]?.gaps.some((g) => g.reason.includes('limited'))).toBe(true);
    expect(report.domainContext?.travel?.missingInformation.length).toBeGreaterThan(0);
  });
});
