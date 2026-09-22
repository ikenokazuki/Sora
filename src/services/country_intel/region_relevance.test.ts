import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../db.js';
import { normalizeEvidence } from './evidence.js';
import type { CountryIntelProvider } from './provider_registry.js';
import { researchCountryContext } from './report.js';

let directory: string;
let previousPath: string | undefined;
const now = () => new Date('2026-09-22T00:00:00Z');

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'intel-region-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

interface SyntheticItem {
  title: string;
  excerpt?: string;
  eventCountry?: string;
  mentionedCountries?: string[];
  sourceType?: 'structured_dataset' | 'international_media';
}

function syntheticProvider(id: string, items: SyntheticItem[]): CountryIntelProvider {
  return {
    id, areas: ['disasters', 'media_activity'], latencyClass: 'near_realtime', defaultTtlSeconds: 60,
    async run(input) {
      return {
        items: items.map((entry, index) => ({
          evidence: normalizeEvidence({
            url: 'https://example.org/' + id + '/' + String(index),
            title: entry.title,
            excerpt: entry.excerpt,
            publisher: 'Example',
            ...(entry.eventCountry ? { eventCountry: entry.eventCountry } : {}),
            ...(entry.mentionedCountries ? { mentionedCountries: entry.mentionedCountries } : {}),
            sourceType: entry.sourceType ?? 'international_media',
            publishedAt: '2026-09-21T00:00:00Z',
            primarySource: false,
            latencyClass: 'near_realtime',
          }, input.region, now()),
        })),
        coverage: ['disasters'],
      };
    },
  };
}

describe('region relevance', () => {
  test('China report keeps domestic quake, drops foreign, unattributed, unclassified', async () => {
    const report = await researchCountryContext(
      { region: 'China' },
      {
        providers: [syntheticProvider('mixed', [
          { title: 'M5.2 earthquake - 120 km SE of Nanjing, China', excerpt: 'earthquake magnitude 5.2 depth 10km Nanjing, China', eventCountry: 'CN', sourceType: 'structured_dataset' },
          { title: 'M0.84 - 10 km ENE of Ridgecrest, CA', excerpt: 'earthquake magnitude 0.84 depth 5km Ridgecrest, CA', eventCountry: 'US', sourceType: 'structured_dataset' },
          { title: 'M1.1 - 5 km S of Pahala, Hawaii', excerpt: 'earthquake magnitude 1.1 depth 3km Pahala, Hawaii', sourceType: 'structured_dataset' },
          { title: 'Local column: morning market notes', excerpt: 'Unclassified commentary without an event type', sourceType: 'international_media' },
        ])],
        now,
        cache: null,
      },
    );
    expect(report.region.countryCode).toBe('CN');
    expect(report.evidence).toHaveLength(4);
    const titles = report.keyEvents.map((event) => event.title);
    expect(titles).toContain('M5.2 earthquake - 120 km SE of Nanjing, China');
    expect(titles.join('\n')).not.toContain('Ridgecrest');
    expect(titles.join('\n')).not.toContain('Pahala');
    expect(titles.join('\n')).not.toContain('market notes');
    const quake = report.keyEvents.find((event) => event.title.includes('Nanjing'))!;
    expect(quake.type).toBe('disaster_response');
    expect(quake.excerpt).toContain('magnitude 5.2');
  });

  test('foreign occurrence with explicit region link stays', async () => {
    const report = await researchCountryContext(
      { region: 'China' },
      {
        providers: [syntheticProvider('sanction', [
          {
            title: 'US announces new export restrictions',
            excerpt: 'Washington announces export restrictions affecting Chinese technology firms',
            eventCountry: 'US',
            mentionedCountries: ['US', 'CN'],
            sourceType: 'international_media',
          },
        ])],
        now,
        cache: null,
      },
    );
    expect(report.keyEvents.map((event) => event.title)).toContain('US announces new export restrictions');
  });

  test('facts keep excerpts for downstream judges', async () => {
    const report = await researchCountryContext(
      { region: 'China' },
      {
        providers: [syntheticProvider('quake', [
          { title: 'M5.2 earthquake - 120 km SE of Nanjing, China', excerpt: 'earthquake magnitude 5.2 depth 10km Nanjing, China', eventCountry: 'CN', sourceType: 'structured_dataset' },
        ])],
        now,
        cache: null,
      },
    );
    const texts = (report.domainContext?.general?.factors ?? []).map((fact) => fact.text).join('\n');
    expect(texts).toContain('magnitude 5.2');
  });
});
