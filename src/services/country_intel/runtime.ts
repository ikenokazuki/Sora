import { researchCountryContext, type ResearchDependencies } from './report.js';
import { createGdacsProvider } from './providers/gdacs.js';
import { createGdeltExportProvider } from './providers/gdelt_files.js';
import { createUsgsProvider } from './providers/usgs.js';
import { createEonetProvider } from './providers/eonet.js';
import { createGlobalFeedsProvider } from './providers/feeds.js';
import { createBlueskyProvider } from './providers/bluesky.js';
import { createGdeltProvider, type GdeltFetch } from './providers/gdelt.js';
import { createNagerProvider } from './providers/nager.js';
import { createWikidataProvider } from './providers/wikidata.js';
import { createWorldBankProvider } from './providers/worldbank.js';
import { createOfficialWebProvider, type WebSearchItem } from './providers/official_web.js';
import type { ScrapedArticle } from './providers/official_web.js';
import type { CountryContextReport, CountryContextRequest } from './types.js';

/** fetch 注入のみで構成できる default provider。yahoo_realtime は日本専用のため対象外。 */
export const defaultCountryIntelProviderIds = [
  'gdelt', 'gdelt_export', 'gdacs', 'usgs', 'eonet', 'global_feeds', 'official_web', 'bluesky', 'worldbank', 'nager', 'wikidata',
] as const;

export interface DefaultRuntimeOptions {
  fetchFn?: GdeltFetch;
  /** official_web の検索器。未指定時は実在の Yahoo Web 検索を使う（地域条件を落とす再検索は無効）。 */
  officialWebSearch?: (query: string, maxItems: number, signal: AbortSignal) => Promise<WebSearchItem[]>;
  /**
   * 本文補完の取得器。未指定時は内蔵スクレイパ（fast mode、ブラウザなし）を使う。
   * `SORA_INTEL_SCRAPE=off` で無効化できる。テストは明示的に上書きすること。
   */
  scrapeArticle?: (url: string, signal: AbortSignal) => Promise<ScrapedArticle>;
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
    const { searchYahooWeb } = await import('../yahoo.js');
    if (signal.aborted) return [];
    const result = await searchYahooWeb({ query, disableFallback: true });
    if (signal.aborted) return [];
    const items = Array.isArray(result?.items) ? result.items : [];
    return items.slice(0, Math.max(0, maxItems)).flatMap((item: Record<string, unknown>) => {
      const url = typeof item.url === 'string' ? item.url : typeof item.link === 'string' ? item.link : undefined;
      if (!url) return [];
      const title = typeof item.title === 'string' ? item.title : undefined;
      const snippet = typeof item.snippet === 'string' ? item.snippet : typeof item.description === 'string' ? item.description : undefined;
      const domain = typeof item.domain === 'string' ? item.domain : undefined;
      const publishedAt = typeof item.publishedAt === 'string' ? item.publishedAt : undefined;
      return [{ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(domain ? { domain } : {}), ...(publishedAt ? { publishedAt } : {}) }];
    });
  };
}

export function createDefaultCountryIntelDependencies(
  overrides: Omit<ResearchDependencies, 'providers'> = {},
  options: DefaultRuntimeOptions = {},
): ResearchDependencies {
  const fetchFn = options.fetchFn;
  return {
    ...overrides,
    scrapeArticle: overrides.scrapeArticle
      ?? options.scrapeArticle
      ?? (process.env.SORA_INTEL_SCRAPE === 'off' ? undefined : createScrapeArticleAdapter()),
    providers: [
      createGdeltProvider(fetchFn),
      createGdeltExportProvider({ fetchFn }),
      createGdacsProvider(fetchFn),
      createUsgsProvider(fetchFn),
      createEonetProvider(fetchFn),
      createGlobalFeedsProvider(fetchFn),
      createOfficialWebProvider({ searchWeb: options.officialWebSearch ?? createYahooWebSearchAdapter() }),
      createBlueskyProvider(),
      createWorldBankProvider(fetchFn),
      createNagerProvider(fetchFn),
      createWikidataProvider(fetchFn),
    ],
  };
}

/** REST / MCP 共通の default 実行口。report() 自体は injectable なまま維持する。 */
export function researchCountryWithDefaults(
  request: CountryContextRequest,
  overrides: Omit<ResearchDependencies, 'providers'> = {},
  options: DefaultRuntimeOptions = {},
): Promise<CountryContextReport> {
  return researchCountryContext(request, createDefaultCountryIntelDependencies(overrides, options));
}
