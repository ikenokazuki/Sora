import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';

export interface RealtimePost { url: string; text?: string; postedAt?: string; user?: string; }
export interface YahooRealtimeDeps {
  searchYahooRealtime: (query: string, signal: AbortSignal) => Promise<RealtimePost[]>;
}
export function realtimePostsToAcquisition(posts: RealtimePost[], input: ProviderInput, now = new Date()): AcquisitionItem[] {
  return posts.filter((p) => p.url).slice(0, 30).map((post) => ({
    evidence: normalizeEvidence({ url: post.url, title: post.text?.slice(0, 120), excerpt: post.text?.slice(0, 1000), publisher: post.user ?? 'yahoo_realtime', sourceType: 'social', publishedAt: post.postedAt, primarySource: false, latencyClass: 'realtime' }, input.region, now),
  }));
}
export function createYahooRealtimeProvider(deps: YahooRealtimeDeps): CountryIntelProvider {
  return {
    id: 'yahoo_realtime', areas: ['social_observations'], regions: ['JP'], latencyClass: 'realtime', defaultTtlSeconds: 600,
    async run(input: ProviderInput, signal: AbortSignal) {
      if (!input.request.includeSocial) return { items: [], coverage: ['social_observations:excluded'] };
      const query = input.request.query?.trim()
        ?? (input.region.countryCode === 'JP' ? '日本' : input.queries.find((q) => q.providerId === 'yahoo_realtime')?.query ?? input.region.name);
      let posts: RealtimePost[];
      try { posts = await deps.searchYahooRealtime(query, signal); }
      catch (e) {
        if (e instanceof ProviderHttpError || e instanceof ProviderNetworkError) throw e;
        if (signal.aborted) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const items = realtimePostsToAcquisition(posts, input, new Date()).map((item) => ({
        ...item,
        evidence: item.evidence ? { ...item.evidence, acquisition: { providerId: 'yahoo_realtime', query } } : undefined,
      }));
      return { items, coverage: ['social_observations:ja', 'social_observations:japan_proxy'] };
    },
  };
}
