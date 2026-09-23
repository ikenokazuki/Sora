import { describe, expect, test } from 'bun:test';
import {
  ProviderHttpError,
  providerCacheKey,
  runProviders,
  type CountryIntelProvider,
  type ProviderCache,
  type ResearchPlan,
} from './provider_registry.js';
import { planCountryResearch } from './query_planner.js';
import { verifyCountrySource } from './source_registry.js';
import type { CountryEvidence, CountrySource, RegionIdentity } from './types.js';

const region: RegionIdentity = {
  id: 'country:KR',
  name: 'South Korea',
  countryCode: 'KR',
  languages: ['ko'],
  aliases: ['Republic of Korea'],
  confidence: 'high',
};

const evidence: CountryEvidence = {
  id: 'ev-1',
  regionId: region.id,
  url: 'https://example.kr/news/1',
  sourceType: 'official',
  retrievedAt: '2026-09-21T00:00:00.000Z',
  primarySource: true,
  latencyClass: 'near_realtime',
};

const plan: ResearchPlan = {
  request: { region: 'KR', topics: ['politics'], period: '30d', query: 'election' },
  region,
  pass1: [{ pass: 1, providerId: 'test', query: 'South Korea election politics', topics: ['politics'], maxItems: 20 }],
  pass2: [],
  limits: { maxPass1Queries: 12, maxPass2Queries: 8, maxItemsPerQuery: 100 },
};

function provider(
  id: string,
  run: CountryIntelProvider['run'],
  areas: string[] = ['politics'],
): CountryIntelProvider {
  return { id, areas, latencyClass: 'near_realtime', defaultTtlSeconds: 60, run };
}

describe('provider isolation', () => {
  test('keeps successful evidence when another provider is rate limited', async () => {
    const successfulProvider = provider('good', async () => ({ items: [{ evidence }] }));
    const rateLimitedProvider = provider('limited', async () => {
      throw new ProviderHttpError(429, '60');
    });

    const result = await runProviders(plan, [successfulProvider, rateLimitedProvider], {
      timeoutMs: 50,
      maxRetryAfterMs: 10,
      cache: null,
    });

    expect(result.items).toHaveLength(1);
    expect(result.runs.map((run) => run.status)).toEqual(['success', 'rate_limited']);
    expect(result.runs[1]).toMatchObject({
      itemCount: 0,
      coverage: ['politics'],
      errorCode: 'PROVIDER_RATE_LIMITED',
    });
    expect(result.runs.every((run) => run.finishedAt !== undefined && run.latencyMs !== undefined)).toBe(true);
  });

  test('times out one provider without rejecting the acquisition', async () => {
    const neverResolvingProvider = provider('hung', () => new Promise(() => {}));

    const result = await runProviders(plan, [neverResolvingProvider], {
      timeoutMs: 10,
      cache: null,
    });

    expect(result.items).toEqual([]);
    expect(result.runs[0]).toMatchObject({
      status: 'unavailable',
      errorCode: 'PROVIDER_TIMEOUT',
      itemCount: 0,
      coverage: ['politics'],
    });
  });

  test('retries transient failures once, but never retries ordinary 4xx', async () => {
    let transientAttempts = 0;
    let clientAttempts = 0;
    const transient = provider('transient', async () => {
      transientAttempts++;
      if (transientAttempts === 1) throw new ProviderHttpError(503);
      return { items: [{ evidence }] };
    });
    const clientError = provider('client', async () => {
      clientAttempts++;
      throw new ProviderHttpError(404);
    });

    const result = await runProviders(plan, [transient, clientError], { timeoutMs: 50, cache: null });

    expect(transientAttempts).toBe(2);
    expect(clientAttempts).toBe(1);
    expect(result.runs.map((run) => run.status)).toEqual(['success', 'error']);
    expect(result.runs[1].errorCode).toBe('PROVIDER_HTTP_4XX');
  });

  test('retries a network failure only once', async () => {
    let attempts = 0;
    const flaky = provider('network', async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      return { items: [{ evidence }] };
    });

    const result = await runProviders(plan, [flaky], { timeoutMs: 50, cache: null });

    expect(attempts).toBe(2);
    expect(result.items).toEqual([{ providerId: 'network', areas: ['politics'], item: { evidence } }]);
    expect(result.runs[0].status).toBe('success');
  });

  test('honors one bounded Retry-After retry for 429', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const limited = provider('limited', async () => {
      attempts++;
      if (attempts === 1) throw new ProviderHttpError(429, '2');
      return { items: [{ evidence }] };
    });

    const result = await runProviders(plan, [limited], {
      timeoutMs: 50,
      cache: null,
      maxRetryAfterMs: 2_000,
      sleep: async (ms) => { delays.push(ms); },
    });

    expect(attempts).toBe(2);
    expect(delays).toEqual([2_000]);
    expect(result.runs[0].status).toBe('success');
  });

  test('maps a provider-returned failure status to a stable error code', async () => {
    const limited = provider('limited-result', async () => ({
      items: [],
      status: 'rate_limited',
    }));

    const result = await runProviders(plan, [limited], { timeoutMs: 50, cache: null });

    expect(result.runs[0]).toMatchObject({
      status: 'rate_limited',
      errorCode: 'PROVIDER_RATE_LIMITED',
    });
  });
});

describe('provider cache', () => {
  test('partitions keys by provider, region, topics, period, and query', () => {
    const base = providerCacheKey('gdelt', plan);

    expect(base).not.toBe(providerCacheKey('gdacs', plan));
    expect(base).not.toBe(providerCacheKey('gdelt', { ...plan, region: { ...region, id: 'country:JP' } }));
    expect(base).not.toBe(providerCacheKey('gdelt', { ...plan, request: { ...plan.request, topics: ['economy'] } }));
    expect(base).not.toBe(providerCacheKey('gdelt', { ...plan, request: { ...plan.request, period: '7d' } }));
    expect(base).not.toBe(providerCacheKey('gdelt', { ...plan, request: { ...plan.request, query: 'trade' } }));
  });

  test('noCache skips reads while keeping fresh results available and writable', async () => {
    let reads = 0;
    const writes: Array<{ key: string; ttl: number }> = [];
    const cache: ProviderCache = {
      get() {
        reads++;
        return { value: { items: [] }, expiresAt: Date.now() + 10_000 };
      },
      set(key, _value, ttl) { writes.push({ key, ttl }); },
    };
    const fresh = provider('fresh', async () => ({ items: [{ evidence }] }));

    const result = await runProviders(plan, [fresh], { timeoutMs: 50, noCache: true, cache });

    expect(reads).toBe(0);
    expect(result.items).toEqual([{ providerId: 'fresh', areas: ['politics'], item: { evidence } }]);
    expect(writes).toEqual([{ key: providerCacheKey('fresh', plan), ttl: 60 }]);
  });
});

describe('bounded planning', () => {
  test('caps both passes and excludes unverified source candidates', () => {
    const capabilities = Array.from({ length: 20 }, (_, index) => ({
      id: `provider-${index}`,
      areas: ['politics'],
    }));
    const verifiedSources: CountrySource[] = Array.from({ length: 12 }, (_, index) => ({
      id: `source-${index}`,
      regionId: region.id,
      domain: `verified-${index}.gov.kr`,
      sourceType: 'official',
      discoveredAt: '2026-09-20T00:00:00.000Z',
      verifiedAt: '2026-09-21T00:00:00.000Z',
      verificationStatus: 'verified',
      discoveryMethod: 'official_link',
    }));
    verifiedSources.push({
      ...verifiedSources[0],
      id: 'candidate',
      domain: 'candidate.example',
      verifiedAt: undefined,
      verificationStatus: 'candidate',
    });

    const result = planCountryResearch(
      { region: 'KR', period: '30d' },
      region,
      capabilities,
      verifiedSources,
    );

    expect(result.pass1.length).toBeLessThanOrEqual(24);
    expect(result.pass2.length).toBeLessThanOrEqual(8);
    expect(result.limits).toEqual({ maxPass1Queries: 24, maxPass2Queries: 8, maxItemsPerQuery: 100 });
    expect(result.pass2.some((query) => query.sourceDomain === 'candidate.example')).toBe(false);
  });
});

describe('source verification', () => {
  const candidate: CountrySource = {
    id: 'source-1',
    regionId: region.id,
    domain: 'agency.gov.kr',
    sourceType: 'official',
    discoveredAt: '2026-09-20T00:00:00.000Z',
    verificationStatus: 'candidate',
    discoveryMethod: 'search',
  };

  test('does not trust an unverified discovered source', async () => {
    const source = await verifyCountrySource(candidate, {
      fetch: async () => new Response('', { status: 503 }),
      now: () => Date.parse('2026-09-21T00:00:00.000Z'),
    });

    expect(source.verificationStatus).toBe('candidate');
    expect(source.verifiedAt).toBeUndefined();
  });

  test('times out an availability check even when injected fetch ignores abort', async () => {
    const source = await verifyCountrySource(candidate, {
      fetch: async () => new Promise(() => {}),
      timeoutMs: 5,
    });

    expect(source.verificationStatus).toBe('candidate');
    expect(source.verifiedAt).toBeUndefined();
  });

  test('requires HTTPS-safe redirects and an official cross-link when supplied', async () => {
    const unsafe = await verifyCountrySource(candidate, {
      fetch: async () => new Response('', { status: 302, headers: { location: 'http://agency.gov.kr/home' } }),
      officialLinks: ['https://agency.gov.kr'],
    });
    const uncrosslinked = await verifyCountrySource(candidate, {
      fetch: async () => new Response('', { status: 200 }),
      officialLinks: ['https://different.gov.kr'],
    });

    expect(unsafe.verificationStatus).toBe('candidate');
    expect(uncrosslinked.verificationStatus).toBe('candidate');
  });

  test('rejects credentials embedded in an HTTPS redirect', async () => {
    let requests = 0;
    const source = await verifyCountrySource(candidate, {
      fetch: async () => requests++ === 0
        ? new Response('', {
            status: 302,
            headers: { location: 'https://user:secret@agency.gov.kr/home' },
          })
        : new Response('', { status: 200 }),
    });

    expect(source.verificationStatus).toBe('candidate');
    expect(source.verifiedAt).toBeUndefined();
  });

  test('verifies a recently available consistent HTTPS source', async () => {
    const requested: string[] = [];
    const source = await verifyCountrySource(candidate, {
      fetch: async (input) => {
        requested.push(String(input));
        return new Response('', { status: 200 });
      },
      officialLinks: ['https://www.agency.gov.kr/about'],
      now: () => Date.parse('2026-09-21T12:00:00.000Z'),
    });

    expect(requested).toEqual(['https://agency.gov.kr/']);
    expect(source).toMatchObject({
      verificationStatus: 'verified',
      verifiedAt: '2026-09-21T12:00:00.000Z',
    });
  });
});
