// REST と MCP の Yahoo の画像・動画・ニュース・知恵袋・サジェスト・リアルタイムの検索。
// キャッシュのキーと残す時間は REST の今までのもので、REST と MCP は同じ項目を共有する。noCache（読まず・書かない）は REST だけが渡す。
import { CACHE_TTL_TREND, getFromCache, searchCacheTtl, setToCache } from './cache.js';
import {
  buildRealtimeSearchCacheKey,
  createWebAnchorHints,
  getSuggestedKeywords,
  searchYahooChiebukuro,
  searchYahooImage,
  searchYahooNews,
  searchYahooRealtime,
  searchYahooVideo,
  type YahooRealtimeOptions,
  type YahooVideoSearchOptions,
} from './services/yahoo.js';
import { attachVideoTranscripts } from './services/youtube.js';

type NoCache = { noCache?: boolean };

/** キャッシュを引き、無ければ run の結果を ttl だけ残す（0 なら残さない）。 */
async function withCache<T>(key: string, noCache: boolean | undefined, run: () => Promise<T>, ttl: (value: T) => number = searchCacheTtl): Promise<T> {
  if (!noCache) {
    const cached = getFromCache<T>(key);
    if (cached) return cached;
  }
  const value = await run();
  const ms = noCache ? 0 : ttl(value);
  if (ms > 0) setToCache(key, value, ms);
  return value;
}

export function searchImageCached({ noCache, ...o }: { query: string; limit?: number; page?: number } & NoCache) {
  return withCache(`search:image:${o.query}:${o.limit || ''}:${o.page || ''}`, noCache, () => searchYahooImage(o));
}

/** transcripts は呼び出し側で決めた本数（youtube モジュールが無効なら 0）。 */
export function searchVideoCached({ noCache, transcripts = 0, transcriptChars = 2000, ...o }: YahooVideoSearchOptions & NoCache & { transcripts?: number; transcriptChars?: number }) {
  const filters = `${o.updated && o.updated !== 'all' ? `:u${o.updated}` : ''}${o.platform && o.platform !== 'all' ? `:p${o.platform}` : ''}`;
  const key = `search:video:${o.query}:${o.limit || ''}:${o.page || ''}${transcripts ? `:t${transcripts}x${transcriptChars}` : ''}${filters}`;
  return withCache(key, noCache, async () => {
    const result = await searchYahooVideo(o);
    return transcripts ? attachVideoTranscripts(result, o.query, { count: transcripts, maxChars: transcriptChars }) : result;
  });
}

export function searchNewsCached({ noCache, ...o }: { query: string; limit?: number } & NoCache) {
  return withCache(`search:news:${o.query}:${o.limit || ''}`, noCache, () => searchYahooNews(o));
}

export function searchChiebukuroCached({ noCache, ...o }: Parameters<typeof searchYahooChiebukuro>[0] & NoCache) {
  return withCache(`search:chiebukuro:${o.query}:${o.limit || ''}:${o.page || ''}:${o.status || 'all'}`, noCache, () => searchYahooChiebukuro(o));
}

export function suggestKeywordsCached({ noCache, ...o }: { query: string; limit?: number } & NoCache) {
  return withCache(`search:suggest:${o.query}:${o.limit || ''}`, noCache, () => getSuggestedKeywords(o));
}

/** search_realtime の応答（REST の形。MCP は data を開いて返す）。一部の検索が失敗した応答は残さない。 */
export function searchRealtimeCached({ noCache, ...options }: YahooRealtimeOptions & NoCache) {
  const verbose = options.verbose === true;
  return withCache(`${buildRealtimeSearchCacheKey(options)}:${verbose ? 'verbose' : 'compact'}`, noCache, async () => {
    const r = await searchYahooRealtime({ ...options, ...(options.query ? { anchorHints: createWebAnchorHints(options.query) } : {}) });
    return {
      query: r.originalQuery,
      effectiveQuery: r.effectiveQuery,
      isFallback: r.isFallback,
      ...(r.partial === true ? { partial: true, providerErrors: r.providerErrors || [] } : {}),
      sort: options.sort ?? 'recent',
      source: 'x',
      type: 'realtime',
      focus: r.focus,
      // 1件の投稿に揃わなかった語、検索に使った別名、上限で省いた件数は通常応答にも出す
      ...(r.missingTerms?.length ? { missingTerms: r.missingTerms } : {}),
      ...(r.aliasTerms?.length ? { aliasTerms: r.aliasTerms } : {}),
      ...(r.omittedCount ? { omittedCount: r.omittedCount } : {}),
      // Verbose-only provenance: compact by default, full diagnostics on demand.
      ...(verbose
        ? {
            retrievalQueries: r.retrievalQueries,
            contributingQueries: r.contributingQueries,
            resultsMerged: r.resultsMerged,
            executedWaves: r.executedWaves,
            stopReason: r.stopReason,
            requiredTerms: r.requiredTerms,
            coveredTerms: r.coveredTerms,
            missingTerms: r.missingTerms,
            ...(r.anchorTerm ? { anchorTerm: r.anchorTerm } : {}),
            ...(r.anchorFiltered !== undefined ? { anchorFiltered: r.anchorFiltered } : {}),
          }
        : {}),
      data: { count: r.count, items: r.items },
      cached: false,
    };
  }, (data) => (data.partial === true ? 0 : CACHE_TTL_TREND));
}
