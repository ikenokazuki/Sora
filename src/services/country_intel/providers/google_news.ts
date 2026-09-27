import { feedEntriesToAcquisition, parseFeed } from './feeds.js';
import type { SourceCatalogEntry } from '../source_catalog.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import { isRecentPublication, newsLanguage, planNewsQueries } from './news_queries.js';

export const GOOGLE_NEWS_RSS_BASE = 'https://news.google.com/rss/search';
export const GOOGLE_NEWS_MAX_ITEMS = 12;

/** 既存の呼び出し元との互換名。計画はニュース検索共通。 */
export const planGoogleNewsQueries = (input: ProviderInput) => planNewsQueries(input, 'google_news');

/** gl/hl/ceid は地域から派生。 */
export function buildGoogleNewsSearchUrl(region: ProviderInput['region'], queryText?: string, language = newsLanguage(region)): string | undefined {
  const query = queryText?.trim() ? queryText.trim() : region.name?.trim();
  if (!query) return undefined;
  const params = new URLSearchParams({ q: query, hl: language });
  if (region.countryCode) {
    params.set('gl', region.countryCode);
    params.set('ceid', region.countryCode + ':' + language);
  }
  return GOOGLE_NEWS_RSS_BASE + '?' + params.toString();
}

const CATALOG_ENTRY: SourceCatalogEntry = {
  id: 'google-news',
  url: GOOGLE_NEWS_RSS_BASE,
  publisher: 'Google News',
  languages: [],
  areas: ['media_activity', 'economy', 'politics', 'tourism', 'health', 'disasters'],
  sourceType: 'international_media',
  verificationBasis: 'unverified_collection',
  pollIntervalMs: 300_000,
  contentPolicy: 'excerpt_only',
};

export function createGoogleNewsProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'google_news', areas: ['media_activity', 'economy', 'politics', 'tourism', 'health', 'disasters'], latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    collectionWindowDays: 7,
    async run(input: ProviderInput, signal: AbortSignal) {
      const queries = planGoogleNewsQueries(input);
      const outcomes = await Promise.allSettled(queries.map(async (planned) => {
        const url = buildGoogleNewsSearchUrl(input.region, planned.query, planned.language);
        if (!url) return [] as AcquisitionItem[];
        const res = await fetchProviderResponse(url, { sourceId: 'google_news', timeoutMs: 8000, format: 'xml', signal, fetchFn: runFetch });
        const now = new Date();
        const entries = parseFeed(await res.text(), 'google-news')
          .filter((entry) => isRecentPublication(entry.publishedAt, now))
          .slice(0, GOOGLE_NEWS_MAX_ITEMS)
          // Google News RSS の description は記事本文でなくリンク見出しの再掲。
          .map((entry) => /<a\s/iu.test(entry.description ?? '') ? { ...entry, description: undefined } : entry);
        return feedEntriesToAcquisition(entries, CATALOG_ENTRY, input, now).map((item) => ({
          ...item,
          areas: [planned.area],
          evidence: item.evidence ? { ...item.evidence, acquisition: { providerId: 'google_news', query: planned.query } } : undefined,
          detail: item.detail ? { ...item.detail, structuredData: { ...item.detail.structuredData, searchFacet: planned.facet, searchQuery: planned.query } } : undefined,
        }));
      }));
      if (signal.aborted) throw signal.reason;
      const succeeded = outcomes.filter((outcome): outcome is PromiseFulfilledResult<AcquisitionItem[]> => outcome.status === 'fulfilled');
      if (succeeded.length === 0) {
        const error = (outcomes[0] as PromiseRejectedResult | undefined)?.reason;
        if (error instanceof ProviderHttpError) throw error;
        throw new ProviderNetworkError(String(error));
      }
      const seen = new Set<string>();
      const items = succeeded.flatMap((outcome) => outcome.value).filter((item) => {
        const url = item.evidence?.url;
        if (!url || seen.has(url)) return false;
        seen.add(url);
        return true;
      });
      const gaps = outcomes.flatMap((outcome, index) => {
        const reason = outcome.status === 'rejected' ? 'fetch_failed'
          : outcome.value.length === 0 ? 'no_recent_items' : undefined;
        return reason ? [{ area: queries[index].area, reason: `${queries[index].facet} ${reason}` }] : [];
      });
      return {
        items,
        coverage: [...new Set(items.flatMap((item) => item.areas ?? []))],
        ...(gaps.length ? { gaps } : {}),
        ...(succeeded.length < outcomes.length ? { status: 'partial' as const } : {}),
      };
    },
  };
}
