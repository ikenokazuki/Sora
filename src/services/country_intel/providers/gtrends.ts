import { normalizeEvidence } from '../evidence.js';
import type { ProviderInput, AcquisitionItem, CountryIntelProvider } from '../provider_registry.js';
import { ProviderHttpError, ProviderNetworkError } from '../provider_registry.js';
import { fetchProviderResponse } from '../provider_http.js';
import type { GdeltFetch } from './gdelt.js';
import type { EvidenceDetail } from '../detail.js';
export const GTRENDS_DAILY_URL = 'https://trends.google.com/trends/api/dailytrends';
export const GTRENDS_MAX_ITEMS = 20;
export interface GtrendsEntry { query: string; traffic: string; url: string; }
/** 国コードは地域派生。geo省略時は世界版。 */
export function buildGtrendsDailyUrl(region: ProviderInput['region']): string {
  const params = new URLSearchParams({ hl: region.languages?.[0] || 'en-US', ns: '15' });
  if (region.countryCode) params.set('geo', region.countryCode);
  return GTRENDS_DAILY_URL + '?' + params.toString();
}
/** 先頭の )]}', 除去後にJSON解析。 */
export function parseGtrendsDaily(text: string): GtrendsEntry[] {
  const cleaned = text.replace(/^[^\{]*/, '');
  let data: { default?: { trendingSearchesDays?: Array<{ trendingSearches?: Array<{ title?: { query?: string }; formattedTraffic?: string }> }> } };
  try {
    data = JSON.parse(cleaned) as typeof data;
  } catch {
    return [];
  }
  const out: GtrendsEntry[] = [];
  for (const day of data.default?.trendingSearchesDays ?? []) {
    for (const item of day.trendingSearches ?? []) {
      const query = item.title?.query?.trim();
      if (!query) continue;
      out.push({ query, traffic: item.formattedTraffic ?? '', url: 'https://trends.google.com/trends/explore?q=' + encodeURIComponent(query) });
      if (out.length >= GTRENDS_MAX_ITEMS) return out;
    }
  }
  return out;
}
export function createGtrendsProvider(fetchFn?: GdeltFetch): CountryIntelProvider {
  const runFetch: GdeltFetch = fetchFn ?? ((async (url: string, init?: RequestInit) => fetch(url, init)) as GdeltFetch);
  return {
    id: 'gtrends', areas: ['media_activity', 'current_events'], latencyClass: 'near_realtime', defaultTtlSeconds: 3600,
    collectionWindowDays: 1,
    async run(input: ProviderInput, signal: AbortSignal) {
      let res: Response;
      try {
        res = await fetchProviderResponse(buildGtrendsDailyUrl(input.region), { sourceId: 'gtrends', timeoutMs: 8000, format: 'text', signal, fetchFn: runFetch });
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderHttpError) throw e;
        throw new ProviderNetworkError(String(e));
      }
      const entries = parseGtrendsDaily(await res.text());
      const at = new Date().toISOString();
      const items: AcquisitionItem[] = entries.map((entry, index) => {
        const excerpt = entry.traffic ? entry.query + ' (' + entry.traffic + ')' : entry.query;
        const evidence = normalizeEvidence({ url: entry.url, title: entry.query, excerpt, publisher: 'Google Trends', sourceType: 'structured_dataset', primarySource: false, latencyClass: 'near_realtime' }, input.region, new Date());
        const detail: EvidenceDetail = { evidenceId: evidence.id, providerId: 'gtrends', providerItemId: 'trend-' + String(index), sourceRecordUrl: entry.url, contentKind: 'excerpt', blocks: [{ index, text: excerpt }], structuredData: { traffic: entry.traffic }, retrievedAt: at, timeBasis: 'provider_publication', geographyBasis: 'unknown', sourceStatus: 'unverified', contentTruncated: false };
        return { evidence, detail, areas: ['media_activity'] as readonly string[] };
      });
      return { items, coverage: ['media_activity'] };
    },
  };
}
