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

// 既定 runtime の実スクレイパを止め、fixture のみで完結させる。
process.env.SORA_INTEL_SCRAPE = 'off';

const realFetch = globalThis.fetch;

function stubFetch(failHost?: string) {
  const byHost: Record<string, unknown> = {
    'api.gdeltproject.org': load('gdelt.json'),
    'www.gdacs.org': load('gdacs.json'),
    'api.worldbank.org': load('worldbank.json'),
    'date.nager.at': load('nager.json'),
    'www.wikidata.org': load('wikidata.json'),
    'earthquake.usgs.gov': load('usgs.json'),
    'eonet.gsfc.nasa.gov': load('eonet.json'),
  };
  const xmlFeed = readFileSync(join(fixtureDir, 'feed-generic.xml'), 'utf8');
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (failHost && url.hostname.includes(failHost)) throw new Error('provider down');
    if (url.hostname === 'data.gdeltproject.org') {
      if (url.pathname.endsWith('lastupdate.txt')) return new Response('1 a http://data.gdeltproject.org/gdeltv2/20260921181500.export.CSV.zip\n', { status: 200, headers: { 'content-type': 'text/plain' } });
      return new Response('not found', { status: 404 });
    }
    if (url.hostname === 'feeds.bbci.co.uk' || url.hostname === 'news.un.org' || url.hostname === 'www.ecb.europa.eu') {
      return new Response(xmlFeed, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    }
    const payload = byHost[url.hostname];
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
    .toEqual([...defaultCountryIntelProviderIds]);
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

test("default runtime wires the built-in article fetcher unless disabled", async () => {
  const { createDefaultCountryIntelDependencies } = await import("./runtime.js");
  const scraper = await import("../../scraper.js");
  expect(typeof scraper.scrapeUrl).toBe("function");
  const previous = process.env.SORA_INTEL_SCRAPE;
  try {
    delete process.env.SORA_INTEL_SCRAPE;
    expect(typeof createDefaultCountryIntelDependencies().scrapeArticle).toBe("function");
    process.env.SORA_INTEL_SCRAPE = "off";
    expect(createDefaultCountryIntelDependencies().scrapeArticle).toBeUndefined();
    const custom = async () => ({});
    expect(createDefaultCountryIntelDependencies({ scrapeArticle: custom }).scrapeArticle).toBe(custom);
  } finally {
    if (previous === undefined) delete process.env.SORA_INTEL_SCRAPE;
    else process.env.SORA_INTEL_SCRAPE = previous;
  }
});
