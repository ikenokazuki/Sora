import { feedEntriesToAcquisition, parseFeed } from './feeds.js';
export const GOOGLE_NEWS_RSS_BASE = 'https://news.google.com/rss/search';
export const GOOGLE_NEWS_MAX_ITEMS = 15;
import type { SourceCatalogEntry } from '../source_catalog.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';

/** 地域派生のみでURL生成。gl=国コード、hl=第一言語、ceid=国:言語。国別テーブルは持たない。 */
export function buildGoogleNewsSearchUrl(region: ProviderInput['region']): string | undefined {
  const query = region.name?.trim();
  if (!query) return undefined;
  const lang = region.languages?.[0] || 'en';
  const params = new URLSearchParams({ q: query, hl: lang });
  if (region.countryCode) {
    params.set('gl', region.countryCode);
    params.set('ceid', region.countryCode + ':' + lang);
  }
  return GOOGLE_NEWS_RSS_BASE + '?' + params.toString();
}

const CATALOG_ENTRY: SourceCatalogEntry = {
  id: 'google-news',
  url: GOOGLE_NEWS_RSS_BASE,
  publisher: 'Google News',
  languages: [],
  areas: ['media_activity', 'current_events'],
  sourceType: 'international_media',
  verificationBasis: 'unverified_collection',
  pollIntervalMs: 300_000,
  contentPolicy: 'excerpt_only',
};

export function createGoogleNewsProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'google_news', areas: ['media_activity', 'current_events'], latencyClass: 'near_realtime', defaultTtlSeconds: 900,
    collectionWindowDays: 1,
    async run(input: ProviderInput, signal: AbortSignal) {
      const url = buildGoogleNewsSearchUrl(input.region);
      if (!url) return { items: [] as AcquisitionItem[], coverage: [] };
      let res: Response;
      try {
        res = await fetchProviderResponse(url, { sourceId: 'google_news', timeoutMs: 8000, format: 'xml', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const xml = await res.text();
      const items = feedEntriesToAcquisition(parseFeed(xml, 'google-news'), CATALOG_ENTRY, input, new Date());
      return { items: items.slice(0, GOOGLE_NEWS_MAX_ITEMS), coverage: ['media_activity'] };
    },
  };
}
