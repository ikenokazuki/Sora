import { describe, expect, test } from 'bun:test';
import { classifyWebItem, createOfficialWebProvider } from './official_web.js';
import { createYahooRealtimeProvider } from './yahoo_realtime_jp.js';
import type { ProviderInput } from '../provider_registry.js';

const region: ProviderInput['region'] = { id: 'KOR', name: 'South Korea', countryCode: 'KR', languages: ['ko'], aliases: [], confidence: 'high' };
const inputFor = (providerId: string, extra: ProviderInput['queries'] = [], includeSocial = false): ProviderInput => ({
  request: { region: 'South Korea', includeSocial } as never, region,
  queries: [{ pass: 1, providerId, query: 'South Korea', topics: [], maxItems: 10 }, ...extra],
});

describe('web adapters', () => {
  test('official domains become candidates until verified', () => {
    expect(classifyWebItem({ url: 'https://www.mofa.go.kr/press.html' })).toBe('official_candidate');
    expect(classifyWebItem({ url: 'https://www.mofa.go.kr/press.html' }, ['mofa.go.kr'])).toBe('official_evidence');
    expect(classifyWebItem({ url: 'https://example.com/news/1' })).toBe('media');
  });
  test('official web emits candidate for unverified official, evidence for media', async () => {
    const provider = createOfficialWebProvider({
      searchYahooWeb: async () => [
        { url: 'https://www.mofa.go.kr/press.html', title: 'Mofa press' },
        { url: 'https://example.com/news/1', title: 'News', snippet: 'excerpt' },
      ],
      scrapeUrl: async () => ({}),
    });
    const result = await provider.run(inputFor('official_web'), AbortSignal.timeout(1000));
    expect(result.items.some((i) => i.source?.domain === 'mofa.go.kr')).toBe(true);
    expect(result.items.some((i) => i.evidence?.url === 'https://example.com/news/1')).toBe(true);
  });
  test('social omitted when includeSocial false, never creates polls', async () => {
    const provider = createYahooRealtimeProvider({ searchYahooRealtime: async () => [{ url: 'https://x.com/a', text: 'post' }] });
    const off = await provider.run(inputFor('yahoo_realtime', [], false), AbortSignal.timeout(1000));
    expect(off.items).toHaveLength(0);
    const on = await provider.run(inputFor('yahoo_realtime', [], true), AbortSignal.timeout(1000));
    expect(on.items).toHaveLength(1);
    expect(on.items[0].poll).toBeUndefined();
    expect(on.items[0].evidence?.sourceType).toBe('social');
    expect(on.coverage?.join(' ')).toContain('japan_proxy');
  });
  test('yahoo errors map to provider statuses, not empty success', async () => {
    const { ProviderHttpError } = await import('../provider_registry.js');
    const { runProviders } = await import('../provider_registry.js');
    const { planCountryResearch } = await import('../query_planner.js');
    const plan = planCountryResearch({ region: 'South Korea' } as never, region, [{ id: 'yahoo_realtime', areas: [] }], []);
    const failing = createYahooRealtimeProvider({ searchYahooRealtime: async () => { throw new ProviderHttpError(429); } });
    const ok = createOfficialWebProvider({ searchYahooWeb: async () => [], scrapeUrl: async () => ({}) });
    const result = await runProviders({ ...plan, request: { region: 'South Korea', includeSocial: true } as never }, [failing, ok], { timeoutMs: 500, cache: null });
    expect(result.runs[0].status).toBe('rate_limited');
    expect(result.runs[1].status).toBe('success');
  });
});
