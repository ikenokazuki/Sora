import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { intelligenceRoutes } from '../../routes/intelligence.js';
import {
  createDefaultCountryIntelDependencies,
  defaultCountryIntelProviderIds,
  researchCountryWithDefaults,
} from './runtime.js';

const fixtureDir = join(import.meta.dir, 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));

const realFetch = globalThis.fetch;

function stubFetch(failHost?: string) {
  const byHost: Record<string, unknown> = {
    'api.gdeltproject.org': load('gdelt.json'),
    'www.gdacs.org': load('gdacs.json'),
    'api.worldbank.org': load('worldbank.json'),
    'date.nager.at': load('nager.json'),
    'www.wikidata.org': load('wikidata.json'),
  };
  globalThis.fetch = (async (input: any) => {
    const host = new URL(String(input)).hostname;
    if (failHost && host.includes(failHost)) throw new Error('provider down');
    const payload = byHost[host];
    if (payload === undefined) return new Response('not found', { status: 404 });
    return Response.json(payload);
  }) as typeof fetch;
}

test('REST and MCP use the same default country-intelligence runtime', async () => {
  stubFetch();
  try {
    const res = await intelligenceRoutes.request('/intelligence/country', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ region: 'South Korea', noCache: true }),
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as any;
    const viaRoute = report.providerCoverage.map((run: any) => run.provider).sort();
    const direct = await researchCountryWithDefaults(
      { region: 'South Korea', noCache: true },
      { cache: null, now: () => new Date('2026-09-19T00:00:00Z') },
    );
    const viaDirect = direct.providerCoverage.map((run) => run.provider).sort();
    expect(viaRoute).toEqual(defaultCountryIntelProviderIds.slice().sort());
    expect(viaDirect).toEqual(viaRoute);
    expect(report.evidence.length).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('default runtime never substitutes a fallback country', async () => {
  expect(createDefaultCountryIntelDependencies().providers?.map((p) => p.id))
    .toEqual(defaultCountryIntelProviderIds);
  stubFetch();
  try {
    const report = await researchCountryWithDefaults(
      { region: 'Unknown Example Region', noCache: true },
      { cache: null, now: () => new Date('2026-09-19T00:00:00Z') },
    );
    const runs = new Map(report.providerCoverage.map((run) => [run.provider, run]));
    expect(runs.get('worldbank')).toMatchObject({ status: 'unavailable', errorCode: 'PROVIDER_REGION_UNSUPPORTED' });
    expect(runs.get('nager')).toMatchObject({ status: 'unavailable', errorCode: 'PROVIDER_REGION_UNSUPPORTED' });
    expect(JSON.stringify(report.evidence)).not.toContain('KR');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('one unavailable provider does not fail the complete report', async () => {
  stubFetch('api.worldbank.org');
  try {
    const report = await researchCountryWithDefaults(
      { region: 'South Korea', noCache: true },
      { cache: null, now: () => new Date('2026-09-19T00:00:00Z') },
    );
    expect(report.providerCoverage.find((run) => run.provider === 'worldbank')?.status).toBe('unavailable');
    expect(report.evidence.length).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
