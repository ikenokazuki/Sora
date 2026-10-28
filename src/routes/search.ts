import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import {
  DEFAULT_MAX_CHARS,
  CACHE_TTL_TREND,
  getFromCache,
  searchCacheTtl,
  setToCache,
  integratedSearch,
  fetchRealtimeTrends,
  searchYahooRealtime,
  searchYahooImage,
  searchYahooVideo,
  searchYahooNews,
  searchYahooChiebukuro,
  getSuggestedKeywords,
  searchTransitRoute,
  searchMusic,
  searchSong,
  searchArtist,
} from '../scraper.js';
import {
  SongSearchRequestSchema,
  ArtistSearchRequestSchema,
  MusicSearchRequestSchema,
  IntegratedSearchRequestSchema,
  RealtimeSearchRequestSchema,
  ImageSearchRequestSchema,
  VideoSearchRequestSchema,
  NewsSearchRequestSchema,
  ChiebukuroSearchRequestSchema,
  SuggestRequestSchema,
} from '../types.js';
import { buildRealtimeSearchCacheKey, buildYahooRealtimeQuery, createWebAnchorHints } from '../services/yahoo.js';
import { fetchXPostDetail } from '../services/x_detail.js';
import { formatError } from './utils.js';
import { SearchWebRequestSchema, searchWebForRest } from '../search_web_formats.js';
import { IntegratedSearchResponseModeSchema, formatIntegratedSearchHostResponse } from '../integrated_search_host_response.js';
import { errorMessage } from '../errors.js';
import { isModuleActive } from '../mcp/registry.js';
import { attachVideoTranscripts } from '../services/youtube.js';

export const searchRoutes = new Hono();

// Yahoo リアルタイム検索 (X 生ツイート & フライヤー画像)
// 項目ごとの入力エラーの文言（REST の応答で返す）
const REALTIME_FIELD_ERRORS: Record<string, string> = {
  sort: 'sort must be "recent" or "popular"',
  limit: 'limit must be an integer 1-40',
  page: 'page must be an integer 1-100',
  focus: 'focus must be "official" or "public"',
  anchor: 'anchor must be a string of at most 100 characters',
};

const handleRealtimeSearch = async (c: Context) => {
  try {
    const parsed = RealtimeSearchRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = String(issue?.path[0] ?? '');
      return c.json({ error: REALTIME_FIELD_ERRORS[field] ?? `${field || 'body'}: ${issue?.message ?? 'invalid value'}` }, 400);
    }
    const body = parsed.data;
    const { query, accountId, fromUser, toAccount, hashtags, excludeWords, orWords, url, limit, page, focus } = body;
    const sort = body.sort ?? 'recent';
    const anchor = body.anchor?.trim() || undefined;

    const options = {
      query,
      accountId,
      fromUser,
      toAccount,
      hashtags,
      excludeWords,
      orWords,
      url,
      sort,
      ...(limit !== undefined ? { limit } : {}),
      ...(page !== undefined ? { page } : {}),
      ...(focus ? { focus } : {}),
      ...(anchor ? { anchor } : {}),
      ...(body.verbose === true ? { verbose: true } : {}),
    };

    let cacheKey: string;
    try {
      if (!buildYahooRealtimeQuery(options)) {
        return c.json({ error: 'query, accountId, hashtags, or other search constraints are required' }, 400);
      }
      cacheKey = `${buildRealtimeSearchCacheKey(options)}:${body.verbose === true ? 'verbose' : 'compact'}`;
    } catch (err) {
      return c.json({ error: errorMessage(err) || 'Invalid realtime request' }, 400);
    }
    if (!body.noCache) {
      const cached = getFromCache<unknown>(cacheKey);
      if (cached) return c.json(cached);
    }

    let realtimeRes: Awaited<ReturnType<typeof searchYahooRealtime>>;
    try {
      realtimeRes = await searchYahooRealtime({ ...options, ...(query ? { anchorHints: createWebAnchorHints(query) } : {}) });
    } catch (err) {
      return c.json({ error: errorMessage(err) || 'Realtime search failed' }, 502);
    }

    const responseData = {
      query: realtimeRes.originalQuery,
      effectiveQuery: realtimeRes.effectiveQuery,
      isFallback: realtimeRes.isFallback,
      ...(realtimeRes.partial === true
        ? { partial: true, providerErrors: realtimeRes.providerErrors || [] }
        : {}),
      sort,
      source: 'x',
      type: 'realtime',
      focus: realtimeRes.focus,
      // 1件の投稿に揃わなかった語、検索に使った別名、上限で省いた件数は通常応答にも出す
      ...(realtimeRes.missingTerms?.length ? { missingTerms: realtimeRes.missingTerms } : {}),
      ...(realtimeRes.aliasTerms?.length ? { aliasTerms: realtimeRes.aliasTerms } : {}),
      ...(realtimeRes.omittedCount ? { omittedCount: realtimeRes.omittedCount } : {}),
      // Verbose-only provenance: compact by default, full diagnostics on demand.
      ...(body.verbose === true
        ? {
            retrievalQueries: realtimeRes.retrievalQueries,
            contributingQueries: realtimeRes.contributingQueries,
            resultsMerged: realtimeRes.resultsMerged,
            executedWaves: realtimeRes.executedWaves,
            stopReason: realtimeRes.stopReason,
            requiredTerms: realtimeRes.requiredTerms,
            coveredTerms: realtimeRes.coveredTerms,
            missingTerms: realtimeRes.missingTerms,
            ...(realtimeRes.anchorTerm ? { anchorTerm: realtimeRes.anchorTerm } : {}),
            ...(realtimeRes.anchorFiltered !== undefined ? { anchorFiltered: realtimeRes.anchorFiltered } : {}),
          }
        : {}),
      data: {
        count: realtimeRes.count,
        items: realtimeRes.items,
      },
      cached: false,
    };

    if (!body.noCache && realtimeRes.partial !== true) setToCache(cacheKey, responseData, CACHE_TTL_TREND);
    return c.json(responseData);
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Realtime search failed' }, 500);
  }
};

searchRoutes.post('/search/realtime', handleRealtimeSearch);
searchRoutes.post('/realtime', handleRealtimeSearch);

// X個別投稿の全文取得 (FxTwitter経由・ID突合検証済みのみ返却)
searchRoutes.post('/realtime/post', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const result = await fetchXPostDetail({ statusId: body?.statusId, url: body?.url });
    if (!result.found) {
      if (result.reason === 'invalid_input') {
        return c.json({ error: 'statusId または有効なX投稿URLを指定してください' }, 400);
      }
      return c.json({ error: '投稿が見つかりませんでした' }, 404);
    }
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'X投稿の取得に失敗しました' }, 500);
  }
});

// Yahoo リアルタイム急上昇トレンド
searchRoutes.post('/search/trend', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const result = await fetchRealtimeTrends(body?.limit);
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Search trend failed' }, 500);
  }
});

// Yahoo Web 検索（formats 未指定は従来どおり軽量、指定時のみ追加スクレイプ）
searchRoutes.post('/search/web', async (c) => {
  try {
    const rawBody = await c.req.json();
    const parsed = SearchWebRequestSchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: 'invalid search_web request', details: parsed.error.format() }, 400);
    return c.json(await searchWebForRest(parsed.data));
  } catch (err) { return c.json({ error: errorMessage(err) || 'Web search failed' }, 500); }
});

// Firecrawl / Tavily 互換統合深層検索 (Deep Search)
const adaptiveSearchOptionsSchema = IntegratedSearchRequestSchema.pick({ adaptiveScrape: true, scrapeBudget: true, scrapeDeadlineMs: true, videos: true });
const handleIntegratedSearch = async (c: Context) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    const limit = Math.min(body?.limit || 5, 20);
    const scrapeContent = body?.scrapeContent !== false;
    const includeRealtime = body?.includeRealtime !== false;
    const realtimeSort = body?.realtimeSort === 'popular' ? 'popular' : 'recent';
    const officialAccountId = body?.officialAccountId;
    const maxChars = body?.maxChars || DEFAULT_MAX_CHARS;
    const noCache = body?.noCache ?? false;
    const includeDomains = body?.includeDomains;
    const excludeDomains = body?.excludeDomains;
    const updated = body?.updated;
    const extractHighlights = body?.extractHighlights;
    const onlyMainContent = body?.onlyMainContent;
    const formats = body?.formats;
    const responseModeParsed = IntegratedSearchResponseModeSchema.safeParse(
      body?.responseMode ?? 'full',
    );
    if (!responseModeParsed.success) {
      return c.json({ error: 'responseMode must be "full" or "evidence"' }, 400);
    }
    const responseMode = responseModeParsed.data;

    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const maxTotalCharsParsed = IntegratedSearchRequestSchema.shape.maxTotalChars.safeParse(body?.maxTotalChars);
    if (!maxTotalCharsParsed.success) {
      return c.json({ error: 'maxTotalChars must be an integer between 1000 and 500000' }, 400);
    }
    const realtimeFocusParsed = IntegratedSearchRequestSchema.shape.realtimeFocus.safeParse(body?.realtimeFocus);
    if (!realtimeFocusParsed.success) {
      return c.json({ error: 'realtimeFocus must be "official" or "public"' }, 400);
    }
    const realtimeAnchorParsed = IntegratedSearchRequestSchema.shape.realtimeAnchor.safeParse(body?.realtimeAnchor);
    if (!realtimeAnchorParsed.success) {
      return c.json({ error: 'realtimeAnchor must be a string of at most 100 characters' }, 400);
    }
    const realtimeLimitParsed = IntegratedSearchRequestSchema.shape.realtimeLimit.safeParse(body?.realtimeLimit);
    if (!realtimeLimitParsed.success) {
      return c.json({ error: 'realtimeLimit must be an integer between 1 and 100' }, 400);
    }
    const includeMediaParsed = IntegratedSearchRequestSchema.shape.includeMedia.safeParse(body?.includeMedia);
    if (!includeMediaParsed.success) {
      return c.json({ error: 'includeMedia must be a boolean' }, 400);
    }

    const adaptiveOptions = adaptiveSearchOptionsSchema.safeParse(body);
    if (!adaptiveOptions.success) {
      return c.json({ error: 'invalid adaptive search options', details: adaptiveOptions.error.format() }, 400);
    }

    const tenantId = c.get('tenant')?.tenantId ?? 'legacy';
    const finalResponse = await integratedSearch({
      query,
      tenantId,
      limit,
      scrapeContent,
      ...adaptiveOptions.data,
      includeRealtime,
      realtimeSort,
      realtimeFocus: realtimeFocusParsed.data,
      realtimeAnchor: realtimeAnchorParsed.data,
      realtimeLimit: realtimeLimitParsed.data,
      officialAccountId,
      maxChars,
      noCache,
      includeDomains,
      excludeDomains,
      updated,
      extractHighlights,
      onlyMainContent,
      formats,
      dedup: body?.dedup,
      reorderUFlat: body?.reorderUFlat,
      enablePrf: body?.enablePrf,
      diversityWeight: body?.diversityWeight,
      annotateTemporal: body?.annotateTemporal,
      minimizeTables: body?.minimizeTables,
      highlightMaxCount: body?.highlightMaxCount,
      verbose: body?.verbose ?? c.req.query('verbose') === 'true',
    });

    return c.json(
      formatIntegratedSearchHostResponse(finalResponse, {
        responseMode,
        explicitFormats: formats,
        extractHighlights,
        verbose: body?.verbose ?? c.req.query('verbose') === 'true',
        maxTotalChars: maxTotalCharsParsed.data,
        includeMedia: includeMediaParsed.data,
      }),
    );
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Integrated search failed' }, 500);
  }
};

searchRoutes.post('/search', handleIntegratedSearch);
searchRoutes.post('/search/deep', handleIntegratedSearch);
searchRoutes.post('/search/integrated', handleIntegratedSearch);
searchRoutes.post('/deep-search', handleIntegratedSearch);

/** 入力エラーの最初の1件を文言にする。query の誤りは従来どおり "query is required"。 */
function inputErrorMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = String(issue?.path[0] ?? '');
  if (field === 'query') return 'query is required';
  return `${field || 'body'}: ${issue?.message ?? 'invalid value'}`;
}

// Yahoo 画像検索
searchRoutes.post('/search/image', async (c) => {
  try {
    const parsed = ImageSearchRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    const { query, limit, page, noCache } = parsed.data;

    const cacheKey = `search:image:${query}:${limit || ''}:${page || ''}`;
    if (!noCache) {
      const cached = getFromCache<unknown>(cacheKey);
      if (cached) return c.json(cached);
    }

    const result = await searchYahooImage({ query, limit, page });
    if (!noCache) setToCache(cacheKey, result, searchCacheTtl(result));
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Image search failed' }, 500);
  }
});

// Yahoo 動画検索
searchRoutes.post('/search/video', async (c) => {
  try {
    const parsed = VideoSearchRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    const { query, limit, page, noCache, updated, platform } = parsed.data;
    // ponytail: youtube モジュールが無効な設定では transcripts を無視する
    const transcripts = isModuleActive('youtube') ? parsed.data.transcripts ?? 0 : 0;
    const transcriptChars = parsed.data.transcriptChars ?? 2000;

    const filters = `${updated && updated !== 'all' ? `:u${updated}` : ''}${platform && platform !== 'all' ? `:p${platform}` : ''}`;
    const cacheKey = `search:video:${query}:${limit || ''}:${page || ''}${transcripts ? `:t${transcripts}x${transcriptChars}` : ''}${filters}`;
    if (!noCache) {
      const cached = getFromCache<unknown>(cacheKey);
      if (cached) return c.json(cached);
    }

    let result = await searchYahooVideo({ query, limit, page, updated, platform });
    if (transcripts) result = await attachVideoTranscripts(result, query, { count: transcripts, maxChars: transcriptChars });
    if (!noCache) setToCache(cacheKey, result, searchCacheTtl(result));
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Video search failed' }, 500);
  }
});

// Yahoo ニュース検索
searchRoutes.post('/search/news', async (c) => {
  try {
    const parsed = NewsSearchRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    const { query, limit, noCache } = parsed.data;

    const cacheKey = `search:news:${query}:${limit || ''}`;
    if (!noCache) {
      const cached = getFromCache<unknown>(cacheKey);
      if (cached) return c.json(cached);
    }

    const result = await searchYahooNews({ query, limit });
    if (!noCache) setToCache(cacheKey, result, searchCacheTtl(result));
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'News search failed' }, 500);
  }
});

// Yahoo 知恵袋検索
searchRoutes.post('/search/chiebukuro', async (c) => {
  try {
    const parsed = ChiebukuroSearchRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    const { query, limit, page, status, noCache } = parsed.data;

    const cacheKey = `search:chiebukuro:${query}:${limit || ''}:${page || ''}:${status || 'all'}`;
    if (!noCache) {
      const cached = getFromCache<unknown>(cacheKey);
      if (cached) return c.json(cached);
    }

    const result = await searchYahooChiebukuro({ query, limit, page, status });
    if (!noCache) setToCache(cacheKey, result, searchCacheTtl(result));
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Chiebukuro search failed' }, 500);
  }
});

// Yahoo サジェスト（キーワード補完）
searchRoutes.post('/search/suggest', async (c) => {
  try {
    const parsed = SuggestRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    const { query, limit, noCache } = parsed.data;

    const cacheKey = `search:suggest:${query}:${limit || ''}`;
    if (!noCache) {
      const cached = getFromCache<unknown>(cacheKey);
      if (cached) return c.json(cached);
    }

    const result = await getSuggestedKeywords({ query, limit });
    if (!noCache) setToCache(cacheKey, result, searchCacheTtl(result));
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Suggest keywords failed' }, 500);
  }
});

// 乗換案内
searchRoutes.post('/transit/route', async (c) => {
  try {
    const body = await c.req.json();
    if (!body?.from || !body?.to) {
      return c.json({ error: 'from and to are required' }, 400);
    }

    const result = await searchTransitRoute({
      from: body.from,
      to: body.to,
      via: body.via,
      year: body.year,
      month: body.month,
      day: body.day,
      hour: body.hour,
      minute: body.minute,
      date: body.date,
      time: body.time,
      timeType: body.timeType,
      ticket: body.ticket,
      seatPreference: body.seatPreference,
      walkSpeed: body.walkSpeed,
      sortBy: body.sortBy,
      useAirline: body.useAirline,
      useShinkansen: body.useShinkansen,
      useExpress: body.useExpress,
      useHighwayBus: body.useHighwayBus,
      useLocalBus: body.useLocalBus,
      useFerry: body.useFerry,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Transit route search failed' }, 500);
  }
});

// 曲名指定 楽曲メタデータ検索 (POST /search/song & POST /search/music/song)
export const handleSongSearch = async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = SongSearchRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'query is required for song search', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await searchSong(parsed.data);
    return c.json(result);
  } catch (err) {
    return formatError(c, errorMessage(err) || 'Song search failed', 'MUSIC_ERROR', 500);
  }
};
searchRoutes.post('/search/song', handleSongSearch);
searchRoutes.post('/search/music/song', handleSongSearch);

// アーティスト名指定 音楽メタデータ検索 (POST /search/artist & POST /search/music/artist)
export const handleArtistSearch = async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = ArtistSearchRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'query is required for artist search', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await searchArtist(parsed.data);
    return c.json(result);
  } catch (err) {
    return formatError(c, errorMessage(err) || 'Artist search failed', 'MUSIC_ERROR', 500);
  }
};
searchRoutes.post('/search/artist', handleArtistSearch);
searchRoutes.post('/search/music/artist', handleArtistSearch);

// 音楽メタデータ検索 (汎用・後方互換: POST /search/music)
searchRoutes.post('/search/music', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = MusicSearchRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'query is required for music search', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await searchMusic(parsed.data);
    return c.json(result);
  } catch (err) {
    return formatError(c, errorMessage(err) || 'Music search failed', 'MUSIC_ERROR', 500);
  }
});
