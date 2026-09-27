import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { getCountryIntelDbMetrics, pruneCountryIntel, saveCountryContext } from './db.js';
import { ephemeralDbWarning } from './maintenance.js';
import type { CountryContextReport } from './types.js';

let directory: string;
let previousPath: string | undefined;

function minimalReport(contextId: string): CountryContextReport {
  const section = { summaryFacts: [], eventIds: [], metrics: [], evidenceIds: [] };
  const domains = {
    content: { regionId: 'KOR', attention: [], disaster: [], socialActivity: [], calendar: [], coverage: 'limited' as const },
    marketing: { regionId: 'KOR', attention: [], businessActivity: [], calendar: [], socialActivity: [], disruption: [], coverage: 'limited' as const },
    travel: { regionId: 'KOR', disruptionSignals: [], disasterSignals: [], healthSignals: [], calendarSignals: [], coverage: 'limited' as const },
    finance: { regionId: 'KOR', economy: [], trade: [], businessAction: [], policyActivity: [], coverage: 'limited' as const },
  };
  return {
    contextId, region: { id: 'KOR', name: 'South Korea', countryCode: 'KR', languages: ['ko'], aliases: [], confidence: 'high' },
    asOf: new Date('2026-09-19T00:00:00Z').toISOString(),
    situation: { politics: section, economy: section, security: section, disasters: section, health: section, humanitarian: section, social: section },
    elections: [], calendar: [], foreignRelations: [], polls: [], keyEvents: [], temporalMetrics: [], providerCoverage: [],
    signals: [],
    domains,
    coverage: { overall: 'limited', byArea: { politics: 'limited', economy: 'limited', security: 'limited', disaster: 'limited', health: 'limited', polls: 'limited', media: 'limited', social: 'limited', calendar: 'limited', foreignRelations: 'limited' }, missingEvidence: [], unavailableProviders: [] },
    evidence: [],
  };
}

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-maint-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

describe('intel maintenance', () => {
  test('warns for ephemeral container paths, not the persistent volume', () => {
    expect(ephemeralDbWarning('/app/data/sora.db')).toMatch(/\/data/);
    expect(ephemeralDbWarning('./data/sora.db')).toBeDefined();
    expect(ephemeralDbWarning('/data/sora.db')).toBeUndefined();
  });
  test('prune keeps fresh reports and metrics report storage bytes', () => {
    saveCountryContext(minimalReport('ctx-fresh'));
    const pruned = pruneCountryIntel(Date.parse('2026-09-19T01:00:00Z'));
    expect(pruned.reports).toBe(0);
    const metrics = getCountryIntelDbMetrics();
    expect(metrics.mainBytes).toBeGreaterThan(0);
    expect(metrics.totalBytes).toBeGreaterThanOrEqual(metrics.mainBytes);
  });
  test('smoke script is opt-in and excluded from the default test run', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:intel:live']).toBe('bun run src/services/country_intel/live_smoke.ts');
    expect(pkg.scripts.test ?? 'bun test').not.toContain('live_smoke');
  });
});
