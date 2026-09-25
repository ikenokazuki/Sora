import { researchCountryContext, type ResearchDependencies } from './report.js';
import { createGdacsProvider } from './providers/gdacs.js';
import { createGdeltExportProvider } from './providers/gdelt_files.js';
import { createUsgsProvider } from './providers/usgs.js';
import { createEonetProvider } from './providers/eonet.js';
import { createGlobalFeedsProvider } from './providers/feeds.js';
import { createGoogleNewsProvider } from './providers/google_news.js';
import { createBingNewsProvider } from './providers/bing_news.js';
import { createWikiCurrentProvider } from './providers/wiki_current.js';
import { createBaiduHotProvider } from './providers/baidu_hot.js';
import { createSo360SearchProvider } from './providers/so360_search.js';
import { createWeiboHotProvider } from './providers/weibo_hot.js';
import { createZhihuHotProvider } from './providers/zhihu_hot.js';
import { createToutiaoHotProvider } from './providers/toutiao_hot.js';
import { createWallstreetLiveProvider } from './providers/wallstreet_live.js';
import { createCctvNewsProvider } from './providers/cctv_news.js';
import { createThepaperHotProvider } from './providers/thepaper_hot.js';
import { createBlueskyProvider } from './providers/bluesky.js';
import { createFediverseProvider } from './providers/fediverse.js';
import { createYahooRealtimeProvider } from './providers/yahoo_realtime_jp.js';
import { ProviderHttpError, defaultProviderCache } from './provider_registry.js';
import { searchYahooRealtimePage } from '../yahoo_realtime_api.js';
import type { GdeltFetch } from './providers/gdelt.js';
import { createNagerProvider } from './providers/nager.js';
import { createWikidataProvider } from './providers/wikidata.js';
import { createWorldBankProvider } from './providers/worldbank.js';
import { createOfficialWebProvider, type WebSearchItem } from './providers/official_web.js';
import type { ScrapedArticle } from './providers/official_web.js';
import { OFFICIAL_DOMAIN_SEEDS, seedDomainsForCountry } from './official_domains.js';
import { resolveRegion } from './region.js';
import { compactCountryReport } from './response.js';
import type { CountryContextReport, CountryContextRequest, CountrySource } from './types.js';

/** 既定 provider。地域限定の取得先は capability で対象外を示す。gdelt DOC は上流復旧まで除外。 */
export const defaultCountryIntelProviderIds = [
  'gdelt_export', 'gdacs', 'usgs', 'eonet', 'global_feeds', 'google_news', 'bing_news', 'wiki_current', 'baidu_hot', 'so360_search', 'weibo_hot', 'zhihu_hot', 'toutiao_hot', 'wallstreet_live', 'cctv_news', 'thepaper_hot', 'official_web', 'bluesky', 'yahoo_realtime', 'fediverse', 'worldbank', 'nager', 'wikidata',
] as const;

export interface DefaultRuntimeOptions {
  fetchFn?: GdeltFetch;
  /** official_web の検索器。未指定時は実在の Yahoo Web 検索を使う（地域条件を落とす再検索は無効）。 */
  officialWebSearch?: (query: string, maxItems: number, signal: AbortSignal) => Promise<WebSearchItem[]>;
  /** 無効化する provider ID（カンマ区切り）の上書き。未指定時は `SORA_INTEL_DISABLED` を読む。 */
  disabledProviders?: readonly string[];
  /**
   * 本文補完の取得器。未指定時は内蔵スクレイパ（fast mode、ブラウザなし）を使う。
   * `SORA_INTEL_SCRAPE=off` で無効化できる。テストは明示的に上書きすること。
   */
  scrapeArticle?: (url: string, signal: AbortSignal) => Promise<ScrapedArticle>;
}

/** 環境変数または明示指定で無効化された provider ID の集合。 */
export function disabledCountryIntelProviders(overrides?: readonly string[]): ReadonlySet<string> {
  const raw = overrides ?? (process.env.SORA_INTEL_DISABLED ?? '');
  const ids = (Array.isArray(raw) ? raw : String(raw).split(',')).map((id) => id.trim()).filter(Boolean);
  return new Set(ids);
}

/** 内蔵スクレイパの本文取得アダプタ。fast mode（ブラウザなし）、再試行なし。 */
export function createScrapeArticleAdapter(): (url: string, signal: AbortSignal) => Promise<ScrapedArticle> {
  return async (url: string, signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason;
    const { scrapeUrl } = await import('../../scraper.js');
    const result = await scrapeUrl({
      url, mode: 'fast', maxChars: 12000, timeoutMs: 4000, retries: 0,
      onlyMainContent: true, extractHighlights: false, noCache: true,
    });
    if (signal.aborted) throw signal.reason;
    return { content: result.content, title: result.title };
  };
}

/** Yahoo Web 検索アダプタ。地域条件を落とすフォールバック再検索は行わない。 */
export function createYahooWebSearchAdapter(): (query: string, maxItems: number, signal: AbortSignal) => Promise<WebSearchItem[]> {
  return async (query: string, maxItems: number, signal: AbortSignal) => {
    const { searchYahooWeb, fetchYahooWebDirect } = await import('../yahoo.js');
    if (signal.aborted) return [];
    let result: { items?: Array<Record<string, unknown>> } | undefined;
    try {
      result = await searchYahooWeb({ query, disableFallback: true });
    } catch {}
    if (signal.aborted) return [];
    const items = Array.isArray(result?.items) ? result.items : [];
    const mapped = items.slice(0, Math.max(0, maxItems)).flatMap((item: Record<string, unknown>) => {
      const url = typeof item.url === 'string' ? item.url : typeof item.link === 'string' ? item.link : undefined;
      if (!url) return [];
      const title = typeof item.title === 'string' ? item.title : undefined;
      const snippet = typeof item.snippet === 'string' ? item.snippet : typeof item.description === 'string' ? item.description : undefined;
      const domain = typeof item.domain === 'string' ? item.domain : undefined;
      const publishedAt = typeof item.publishedAt === 'string' ? item.publishedAt : undefined;
      return [{ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(domain ? { domain } : {}), ...(publishedAt ? { publishedAt } : {}) }];
    });
    // MCPバイナリ429時の直取得フォールバック。地域条件は維持する。
    if (mapped.length > 0 || signal.aborted) return mapped;
    try {
      const direct = await fetchYahooWebDirect(query, maxItems, signal);
      return direct.map((item) => ({ url: item.url, ...(item.title ? { title: item.title } : {}), ...(item.snippet ? { snippet: item.snippet } : {}), ...(item.domain ? { domain: item.domain } : {}) }));
    } catch {
      return [];
    }
  };
}

export function createDefaultCountryIntelDependencies(
  overrides: Omit<ResearchDependencies, 'providers'> = {},
  options: DefaultRuntimeOptions = {},
): ResearchDependencies {
  const fetchFn = options.fetchFn;
  const disabled = disabledCountryIntelProviders(options.disabledProviders);
  return {
    ...overrides,
    cache: overrides.cache ?? defaultProviderCache,
    scrapeArticle: overrides.scrapeArticle
      ?? options.scrapeArticle
      ?? (process.env.SORA_INTEL_SCRAPE === 'off' ? undefined : createScrapeArticleAdapter()),
    providers: [
      createGdeltExportProvider({ fetchFn }),
      createGdacsProvider(fetchFn),
      createUsgsProvider(fetchFn),
      createEonetProvider(fetchFn),
      createGlobalFeedsProvider(fetchFn),
      createGoogleNewsProvider(fetchFn),
      createBingNewsProvider(fetchFn),
      createWikiCurrentProvider(fetchFn),
      createBaiduHotProvider(fetchFn),
      createSo360SearchProvider(fetchFn),
      createWeiboHotProvider(fetchFn),
      createZhihuHotProvider(fetchFn),
      createToutiaoHotProvider(fetchFn),
      createWallstreetLiveProvider(fetchFn),
      createCctvNewsProvider(fetchFn),
      createThepaperHotProvider(fetchFn),
      createOfficialWebProvider({
        searchWeb: options.officialWebSearch ?? createYahooWebSearchAdapter(),
        verifiedDomains: OFFICIAL_DOMAIN_SEEDS.map((seed) => seed.domain),
      }),
      createBlueskyProvider(),
      createYahooRealtimeProvider({ searchYahooRealtime: async (query, signal) => {
        if (signal.aborted) throw signal.reason;
        const page = await searchYahooRealtimePage({ query, sort: 'recent', limit: 30 }, { timeoutMs: 8000 }).catch((error: unknown) => {
          const match = /^Yahoo realtime HTTP (\d{3})$/.exec(error instanceof Error ? error.message : '');
          if (match) throw new ProviderHttpError(Number(match[1]));
          throw error;
        });
        if (signal.aborted) throw signal.reason;
        return page.items.map((item) => ({
          url: item.url, text: item.text,
          ...(item.created_at ? { postedAt: new Date(item.created_at * 1000).toISOString() } : {}),
        ...(item.author_handle ? { user: item.author_handle } : {}),
        }));
      } }),
      createFediverseProvider(),
      createWorldBankProvider(fetchFn),
      createNagerProvider(fetchFn),
      createWikidataProvider(fetchFn),
    ].filter((provider) => !disabled.has(provider.id)),
  };
}

/** REST / MCP 共通の default 実行口。report() 自体は injectable なまま維持する。 */
export async function researchCountryWithDefaults(
  request: CountryContextRequest,
  overrides: Omit<ResearchDependencies, 'providers'> = {},
  options: DefaultRuntimeOptions = {},
): Promise<CountryContextReport> {
  const region = resolveRegion(request.region);
  const nowIso = new Date().toISOString();
  const seedSources: CountrySource[] = seedDomainsForCountry(region.countryCode).map((domain) => ({
    id: 'seed:' + domain,
    regionId: region.id,
    domain,
    sourceType: 'official',
    discoveredAt: nowIso,
    verifiedAt: nowIso,
    verificationStatus: 'verified' as const,
    discoveryMethod: 'manual_seed' as const,
    verificationBasis: 'manual_seed' as const,
  }));
  const merged = createDefaultCountryIntelDependencies(
    { ...overrides, sources: [...(overrides.sources ?? []), ...seedSources] },
    options,
  );
  const report = await researchCountryContext(request, merged);
  return request.verbose ? report : compactCountryReport(report);
}
