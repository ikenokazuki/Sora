import { Hono } from 'hono';
import {
  DEFAULT_MAX_CHARS,
  CACHE_TTL_TREND,
  getFromCache,
  setToCache,
  callYahooMcp,
  searchYahooWeb,
  integratedSearch,
  fetchRealtimeTrends,
  normalizeRealtimeItem,
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
} from '../types.js';
import { formatError } from './utils.js';

export const searchRoutes = new Hono();

// Yahoo リアルタイム検索 (X 生ツイート & フライヤー画像)
searchRoutes.post('/search/realtime', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    const sort = body?.sort === 'popular' ? 'popular' : 'recent';
    const limit = typeof body?.limit === 'number' ? Math.min(Math.max(body.limit, 1), 40) : undefined;
    const page = typeof body?.page === 'number' ? Math.max(body.page, 1) : undefined;

    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const cacheKey = `search:realtime:${query}:${sort}:${limit || 20}:${page || 1}`;
    if (!body.noCache) {
      const cached = getFromCache<any>(cacheKey);
      if (cached) return c.json(cached);
    }

    const realtimeRes = await searchYahooRealtime({
      query,
      sort,
      ...(limit ? { limit } : {}),
      ...(page ? { page } : {}),
    });

    const responseData = {
      query,
      effectiveQuery: realtimeRes.effectiveQuery,
      isFallback: realtimeRes.isFallback,
      sort,
      source: 'x',
      type: 'realtime',
      data: {
        count: realtimeRes.count,
        items: realtimeRes.items,
      },
      cached: false,
    };

    if (!body.noCache) setToCache(cacheKey, responseData, CACHE_TTL_TREND);
    return c.json(responseData);
  } catch (err: any) {
    return c.json({ error: err.message || 'Realtime search failed' }, 500);
  }
});

// Yahoo リアルタイム急上昇トレンド
searchRoutes.post('/search/trend', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const limit = Math.min(body?.limit || 20, 50);
    const result = await fetchRealtimeTrends(limit);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Search trend failed' }, 500);
  }
});

// Yahoo Web 検索
searchRoutes.post('/search/web', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const includeDomains = body?.includeDomains;
    const excludeDomains = body?.excludeDomains;
    const updated = body?.updated;
    const cacheKey = `search:web:${query}:${(includeDomains || []).join(',')}:${(excludeDomains || []).join(',')}:${updated || 'all'}`;
    if (!body.noCache) {
      const cached = getFromCache<any>(cacheKey);
      if (cached) return c.json(cached);
    }

    const parsedData = await searchYahooWeb({ query, includeDomains, excludeDomains, updated });

    const responseData = {
      query,
      source: 'web',
      type: 'web',
      data: parsedData,
      cached: false,
    };

    if (!body.noCache) setToCache(cacheKey, responseData);
    return c.json(responseData);
  } catch (err: any) {
    return c.json({ error: err.message || 'Web search failed' }, 500);
  }
});

// Firecrawl / Tavily 互換統合深層検索
searchRoutes.post('/search', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    const limit = Math.min(body?.limit || 5, 20);
    const scrapeContent = body?.scrapeContent !== false;
    const includeRealtime = body?.includeRealtime !== false;
    const realtimeSort = body?.realtimeSort === 'popular' ? 'popular' : 'recent';
    const maxChars = body?.maxChars || DEFAULT_MAX_CHARS;
    const noCache = body?.noCache ?? false;
    const includeDomains = body?.includeDomains;
    const excludeDomains = body?.excludeDomains;
    const updated = body?.updated;
    const extractHighlights = body?.extractHighlights;
    const onlyMainContent = body?.onlyMainContent;
    const formats = body?.formats;

    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const finalResponse = await integratedSearch({
      query,
      limit,
      scrapeContent,
      includeRealtime,
      realtimeSort,
      maxChars,
      noCache,
      includeDomains,
      excludeDomains,
      updated,
      extractHighlights,
      onlyMainContent,
      formats,
      dedup: body?.dedup,
      verbose: body?.verbose ?? c.req.query('verbose') === 'true',
    });

    return c.json(finalResponse);
  } catch (err: any) {
    return c.json({ error: err.message || 'Integrated search failed' }, 500);
  }
});

// Yahoo 画像検索
searchRoutes.post('/search/image', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const cacheKey = `search:image:${query}:${body?.limit || ''}:${body?.page || ''}`;
    if (!body.noCache) {
      const cached = getFromCache<any>(cacheKey);
      if (cached) return c.json(cached);
    }

    const result = await searchYahooImage({ query, limit: body.limit, page: body.page });
    if (!body.noCache) setToCache(cacheKey, result);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Image search failed' }, 500);
  }
});

// Yahoo 動画検索
searchRoutes.post('/search/video', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const cacheKey = `search:video:${query}:${body?.limit || ''}:${body?.page || ''}`;
    if (!body.noCache) {
      const cached = getFromCache<any>(cacheKey);
      if (cached) return c.json(cached);
    }

    const result = await searchYahooVideo({ query, limit: body.limit, page: body.page });
    if (!body.noCache) setToCache(cacheKey, result);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Video search failed' }, 500);
  }
});

// Yahoo ニュース検索
searchRoutes.post('/search/news', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const cacheKey = `search:news:${query}:${body?.limit || ''}`;
    if (!body.noCache) {
      const cached = getFromCache<any>(cacheKey);
      if (cached) return c.json(cached);
    }

    const result = await searchYahooNews({ query, limit: body.limit });
    if (!body.noCache) setToCache(cacheKey, result);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'News search failed' }, 500);
  }
});

// Yahoo 知恵袋検索
searchRoutes.post('/search/chiebukuro', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const cacheKey = `search:chiebukuro:${query}:${body?.limit || ''}:${body?.page || ''}:${body?.status || 'all'}`;
    if (!body.noCache) {
      const cached = getFromCache<any>(cacheKey);
      if (cached) return c.json(cached);
    }

    const result = await searchYahooChiebukuro({ query, limit: body.limit, page: body.page, status: body.status });
    if (!body.noCache) setToCache(cacheKey, result);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Chiebukuro search failed' }, 500);
  }
});

// Yahoo サジェスト（キーワード補完）
searchRoutes.post('/search/suggest', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const cacheKey = `search:suggest:${query}:${body?.limit || ''}`;
    if (!body.noCache) {
      const cached = getFromCache<any>(cacheKey);
      if (cached) return c.json(cached);
    }

    const result = await getSuggestedKeywords({ query, limit: body.limit });
    if (!body.noCache) setToCache(cacheKey, result);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Suggest keywords failed' }, 500);
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
  } catch (err: any) {
    return c.json({ error: err.message || 'Transit route search failed' }, 500);
  }
});

// 曲名指定 楽曲メタデータ検索 (POST /search/song & POST /search/music/song)
export const handleSongSearch = async (c: any) => {
  let rawBody: any;
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
  } catch (err: any) {
    return formatError(c, err.message || 'Song search failed', 'MUSIC_ERROR', 500);
  }
};
searchRoutes.post('/search/song', handleSongSearch);
searchRoutes.post('/search/music/song', handleSongSearch);

// アーティスト名指定 音楽メタデータ検索 (POST /search/artist & POST /search/music/artist)
export const handleArtistSearch = async (c: any) => {
  let rawBody: any;
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
  } catch (err: any) {
    return formatError(c, err.message || 'Artist search failed', 'MUSIC_ERROR', 500);
  }
};
searchRoutes.post('/search/artist', handleArtistSearch);
searchRoutes.post('/search/music/artist', handleArtistSearch);

// 音楽メタデータ検索 (汎用・後方互換: POST /search/music)
searchRoutes.post('/search/music', async (c) => {
  let rawBody: any;
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
  } catch (err: any) {
    return formatError(c, err.message || 'Music search failed', 'MUSIC_ERROR', 500);
  }
});
