import type { SourceCatalogEntry } from '../source_catalog.js';
import type { AcquisitionItem, CountryIntelProvider, ProviderInput } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import { feedEntriesToAcquisition, parseFeed } from './feeds.js';
import { isRecentPublication, planNewsQueries } from './news_queries.js';
import type { GdeltFetch } from './gdelt.js';

export const BING_NEWS_RSS_BASE = 'https://www.bing.com/news/search';
const MAX_ITEMS_PER_QUERY = 10;
const AREAS = ['media_activity', 'economy', 'politics', 'tourism', 'health', 'disasters'];

export function buildBingNewsUrl(query: string, market: string): string {
  const url = new URL(BING_NEWS_RSS_BASE);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'rss');
  url.searchParams.set('mkt', market);
  url.searchParams.set('qft', 'interval="7"');
  return url.toString();
}

/** Bing の追跡URLから RSS に埋め込まれた元記事URLを取り出す。 */
export function bingArticleUrl(link: string | undefined): string | undefined {
  if (!link) return undefined;
  try {
    const wrapper = new URL(link);
    const target = wrapper.hostname.endsWith('.bing.com') && wrapper.pathname === '/news/apiclick.aspx'
      ? wrapper.searchParams.get('url') : link;
    if (!target) return undefined;
    const article = new URL(target);
    return ['http:', 'https:'].includes(article.protocol) ? article.toString() : undefined;
  } catch { return undefined; }
}

const CATALOG_ENTRY: SourceCatalogEntry = {
  id: 'bing-news', url: BING_NEWS_RSS_BASE, publisher: 'Bing News', languages: [],
  areas: AREAS, sourceType: 'international_media', verificationBasis: 'unverified_collection',
  pollIntervalMs: 300_000, contentPolicy: 'excerpt_only',
};

export function createBingNewsProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'bing_news', areas: AREAS, latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    collectionWindowDays: 7, timeoutMs: 10_000,
    async run(input: ProviderInput, signal: AbortSignal) {
      const queries = planNewsQueries(input, 'bing_news');
      const outcomes = await Promise.allSettled(queries.map(async (planned) => {
        const query = planned.query.replace(/\s+when:7d$/u, '');
        const preferredMarket = `${planned.language}-${input.region.countryCode ?? 'US'}`;
        const markets = [...new Set([preferredMarket, 'en-US'])];
        for (const market of markets) {
          const response = await fetchProviderResponse(buildBingNewsUrl(query, market), {
            sourceId: 'bing_news', timeoutMs: 6000, format: 'xml', signal, fetchFn: runFetch,
          });
          const now = new Date();
          const entries = parseFeed(await response.text(), 'bing-news')
            .filter((entry) => isRecentPublication(entry.publishedAt, now))
            .flatMap((entry) => {
              const url = bingArticleUrl(entry.link);
              if (!url) return [];
              const publisher = new URL(url).hostname.replace(/^www\./u, '');
              return [{ ...entry, link: url, publisher, sourceUrl: new URL(url).origin }];
            })
            .slice(0, MAX_ITEMS_PER_QUERY);
          if (entries.length === 0 && market !== markets.at(-1)) continue;
          return feedEntriesToAcquisition(entries, CATALOG_ENTRY, input, now).map((item) => ({
            ...item,
            areas: [planned.area],
            evidence: item.evidence ? { ...item.evidence, acquisition: { providerId: 'bing_news', query } } : undefined,
            detail: item.detail ? { ...item.detail, structuredData: { ...item.detail.structuredData, searchFacet: planned.facet, searchQuery: query, searchMarket: market } } : undefined,
          }));
        }
        return [] as AcquisitionItem[];
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
          : outcome.value.length === 0 ? 'no_recent_items'
          : outcome.value.length < 3 ? `sparse_recent_items:${outcome.value.length}` : undefined;
        return reason ? [{ area: queries[index].area, reason: `${queries[index].facet} ${reason}` }] : [];
      });
      return {
        items, coverage: [...new Set(items.flatMap((item) => item.areas ?? []))],
        ...(gaps.length ? { gaps } : {}),
        ...(succeeded.length < outcomes.length ? { status: 'partial' as const } : {}),
      };
    },
  };
}
