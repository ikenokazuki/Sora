// Opt-in live smoke for Country Intelligence v1. Offline parser checks are
// fatal; live provider reachability is reported best-effort and never alters
// fixture test status.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGdeltDocResponse } from './providers/gdelt.js';
import { parseGdeltEventsResponse } from './providers/gdelt_events.js';
import { parseGdacsResponse } from './providers/gdacs.js';
import { parseWorldBankResponse } from './providers/worldbank.js';
import { parseNagerResponse } from './providers/nager.js';
import { parseWikidataResponse } from './providers/wikidata.js';
import { researchCountryContext } from './report.js';
import { createGdeltProvider } from './providers/gdelt.js';
import { createGdeltEventsProvider } from './providers/gdelt_events.js';
import { createGdacsProvider } from './providers/gdacs.js';
import { createWorldBankProvider } from './providers/worldbank.js';
import { createNagerProvider } from './providers/nager.js';
import { closeDb } from '../../db.js';

const fixtureDir = join(import.meta.dir, 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
const regionFor = (name: string, countryCode: string) => ({ id: countryCode, name, countryCode, languages: [], aliases: [], confidence: 'high' as const });
const inputFor = (providerId: string, name: string, cc: string) => ({ request: { region: name } as never, region: regionFor(name, cc), queries: [{ pass: 1 as const, providerId, query: name, topics: [], maxItems: 5 }] });

let failures = 0;
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`parser ok: ${label}`); }
  catch (error) { failures++; console.error(`parser FAIL: ${label}: ${error instanceof Error ? error.message : error}`); }
};

check('gdelt publisher/event geography', () => {
  const [item] = parseGdeltDocResponse(load('gdelt.json'), inputFor('gdelt', 'South Korea', 'KR'), new Date());
  if (item.evidence?.publisherCountry !== 'US') throw new Error('publisherCountry drift');
  if (item.evidence?.eventCountry !== undefined) throw new Error('eventCountry leak');
  if (!item.evidence?.publishedAt) throw new Error('publishedAt missing');
});
check('gdelt events structured geography', () => {
  const [item] = parseGdeltEventsResponse(load('gdelt_events.json'), inputFor('gdelt_events', 'South Korea', 'KR'), new Date());
  if (item.evidence?.eventCountry !== 'KOR') throw new Error('eventCountry drift');
});
check('gdacs disaster geography', () => {
  const [item] = parseGdacsResponse(load('gdacs.json'), inputFor('gdacs', 'South Korea', 'KR'), new Date());
  if (item.evidence?.eventCountry !== 'KOR') throw new Error('eventCountry drift');
});
check('worldbank observation value', () => {
  const [item] = parseWorldBankResponse(load('worldbank.json'), inputFor('worldbank', 'South Korea', 'KR'));
  if (item.metric?.current !== 1712345678901.5) throw new Error('observation drift');
});
check('nager local date', () => {
  const [item] = parseNagerResponse(load('nager.json'), inputFor('nager', 'South Korea', 'KR'));
  if (item.calendar?.date !== '2026-10-03') throw new Error('calendar drift');
});
check('wikidata discovery-only', () => {
  const [item] = parseWikidataResponse(load('wikidata.json'), inputFor('wikidata', 'South Korea', 'KR'), new Date());
  if (item.source?.verificationStatus !== 'candidate') throw new Error('verification drift');
  if (item.evidence) throw new Error('wikidata must not emit evidence');
});

if (failures > 0) {
  console.error(`${failures} parser contract(s) failed`);
  process.exit(1);
}

if (!process.argv.includes('--live')) {
  console.log('offline parser contracts passed. Re-run with --live for provider reachability.');
  closeDb();
  process.exit(0);
}

const providers = [createGdeltProvider(), createGdeltEventsProvider(), createGdacsProvider(), createWorldBankProvider(), createNagerProvider()];
for (const name of ['South Korea', 'Taiwan', 'United States', 'France', 'Indonesia']) {
  try {
    const report = await researchCountryContext({ region: name }, { providers, timeoutMs: 15_000, cache: null });
    const statuses = report.providerCoverage.map((run) => `${run.provider}:${run.status}`).join(' ');
    console.log(`${name}: events=${report.keyEvents.length} evidence=${report.evidence.length} coverage=${report.coverage.overall} ${statuses}`);
  } catch (error) {
    console.error(`${name}: smoke error: ${error instanceof Error ? error.message : error}`);
  }
}

closeDb();
process.exit(0);
