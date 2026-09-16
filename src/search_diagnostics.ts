export interface SearchDiagnosticsInput {
  originalQuery: string;
  effectiveQuery: string;
  webEffectiveQuery?: string;
  webIsFallback?: boolean;
  webResultCount: number;
  includeRealtime: boolean;
  realtimeOriginalQuery?: string;
  realtimeEffectiveQuery?: string;
  realtimeIsFallback?: boolean;
  realtimeCount?: number;
  officialAccountId?: string;
  results: Array<Record<string, any>>;
}

/**
 * Verbose-only, observational diagnostics.
 *
 * This helper MUST NOT influence retrieval, ranking, selection, or source content.
 * It only summarizes values that have already been produced by the normal pipeline.
 */
export function buildSearchDiagnostics(input: SearchDiagnosticsInput): Record<string, any> {
  const retrievalQueries: string[] = [];
  const seen = new Set<string>();

  const addQuery = (value?: string) => {
    const q = typeof value === 'string' ? value.trim() : '';
    if (!q || seen.has(q)) return;
    seen.add(q);
    retrievalQueries.push(q);
  };

  // The original query is always attempted by the current fallback strategy.
  addQuery(input.originalQuery);
  addQuery(input.webEffectiveQuery);
  if (input.includeRealtime) {
    addQuery(input.realtimeOriginalQuery);
    addQuery(input.realtimeEffectiveQuery);
    if (input.officialAccountId) addQuery(`id:${input.officialAccountId}`);
  }

  const sourceIdentity = input.results.map((item, index) => ({
    rank: index + 1,
    source: item.source || 'web',
    ...(item.url || item.link ? { url: item.url || item.link } : {}),
    ...(item.siteName ? { siteName: item.siteName } : {}),
    ...(item.pageType ? { pageType: item.pageType } : {}),
    ...(item.author ? { author: item.author } : {}),
    ...(item.twitterHandle ? { twitterHandle: item.twitterHandle } : {}),
    isSnippetFallback: item.isSnippetFallback === true,
    hasScrapeError: Boolean(item.scrapeError),
    ...(item.xSourceIsolation
      ? { sourceIsolation: item.xSourceIsolation }
      : {}),
  }));

  const selectedHighlights = input.results
    .map((item, index) => ({
      rank: index + 1,
      ...(item.url || item.link ? { url: item.url || item.link } : {}),
      highlights: Array.isArray(item.highlights)
        ? item.highlights.filter((value: unknown): value is string => typeof value === 'string')
        : [],
    }))
    .filter((entry) => entry.highlights.length > 0);

  return {
    originalQuery: input.originalQuery,
    effectiveQuery: input.effectiveQuery,
    retrievalQueries,
    retrievalQueryScope: 'observed_original_and_effective_queries',
    web: {
      effectiveQuery: input.webEffectiveQuery || input.originalQuery,
      isFallback: input.webIsFallback === true,
      resultCount: input.webResultCount,
    },
    ...(input.includeRealtime
      ? {
          realtime: {
            originalQuery: input.realtimeOriginalQuery || input.originalQuery,
            effectiveQuery: input.realtimeEffectiveQuery || input.originalQuery,
            isFallback: input.realtimeIsFallback === true,
            count: input.realtimeCount ?? 0,
            ...(input.officialAccountId ? { officialAccountId: input.officialAccountId } : {}),
          },
        }
      : {}),
    sourceIdentity,
    selectedHighlights,
  };
}
