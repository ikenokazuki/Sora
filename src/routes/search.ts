import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import {
  integratedSearch,
  fetchRealtimeTrends,
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
  TransitRouteRequestSchema,
  TrendSearchRequestSchema,
} from '../types.js';
import { buildYahooRealtimeQuery } from '../services/yahoo.js';
import { fetchXPostDetail } from '../services/x_detail.js';
import { dropNullFields, formatError, jsonBodyOr400 } from './utils.js';
import { SearchWebRequestSchema, searchWebForRest } from '../search_web_formats.js';
import { formatIntegratedSearchHostResponse } from '../integrated_search_host_response.js';
import { errorMessage } from '../errors.js';
import { isModuleActive } from '../mcp/registry.js';
import { searchChiebukuroCached, searchImageCached, searchNewsCached, searchRealtimeCached, searchVideoCached, suggestKeywordsCached } from '../yahoo_search_cache.js';

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
    const rawBody = await jsonBodyOr400(c);
    if (rawBody instanceof Response) return rawBody;
    const parsed = RealtimeSearchRequestSchema.safeParse(rawBody);
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

    try {
      if (!buildYahooRealtimeQuery(options)) {
        return c.json({ error: 'query, accountId, hashtags, or other search constraints are required' }, 400);
      }
    } catch (err) {
      return c.json({ error: errorMessage(err) || 'Invalid realtime request' }, 400);
    }

    try {
      return c.json(await searchRealtimeCached({ ...options, noCache: body.noCache }));
    } catch (err) {
      return c.json({ error: errorMessage(err) || 'Realtime search failed' }, 502);
    }
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
    const parsed = TrendSearchRequestSchema.safeParse(dropNullFields((await c.req.json().catch(() => ({}))) || {}));
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    return c.json(await fetchRealtimeTrends(parsed.data.limit));
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Search trend failed' }, 500);
  }
});

// Yahoo Web 検索（formats 未指定は従来どおり軽量、指定時のみ追加スクレイプ）
searchRoutes.post('/search/web', async (c) => {
  try {
    const rawBody = await jsonBodyOr400(c);
    if (rawBody instanceof Response) return rawBody;
    const parsed = SearchWebRequestSchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: 'invalid search_web request', details: parsed.error.format() }, 400);
    return c.json(await searchWebForRest(parsed.data));
  } catch (err) { return c.json({ error: errorMessage(err) || 'Web search failed' }, 500); }
});

// Firecrawl / Tavily 互換統合深層検索 (Deep Search)
// 項目ごとの入力エラーの文言（前からの文言）。ほかの項目は「項目名: 理由」
const DEEP_FIELD_ERRORS: Record<string, string> = {
  query: 'query is required',
  responseMode: 'responseMode must be "full" or "evidence"',
  maxTotalChars: 'maxTotalChars must be an integer between 1000 and 500000',
  realtimeFocus: 'realtimeFocus must be "official" or "public"',
  realtimeAnchor: 'realtimeAnchor must be a string of at most 100 characters',
  realtimeLimit: 'realtimeLimit must be an integer between 1 and 100',
  includeMedia: 'includeMedia must be a boolean',
};
const handleIntegratedSearch = async (c: Context) => {
  try {
    const body = await jsonBodyOr400(c);
    if (body instanceof Response) return body;
    // MCP の search_deep と同じスキーマで確かめる。null の項目は指定なし。responseMode の既定（evidence）はスキーマの default から取る
    const parsed = IntegratedSearchRequestSchema.safeParse(dropNullFields(body));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = String(issue?.path[0] ?? '');
      return c.json({ error: DEEP_FIELD_ERRORS[field] ?? `${field || 'body'}: ${issue?.message ?? 'invalid value'}`, details: parsed.error.format() }, 400);
    }
    const { responseMode, maxTotalChars, ...options } = parsed.data;
    const verbose = options.verbose ?? c.req.query('verbose') === 'true';
    const tenantId = c.get('tenant')?.tenantId ?? 'legacy';
    const finalResponse = await integratedSearch({ ...options, tenantId, verbose });

    return c.json(
      formatIntegratedSearchHostResponse(finalResponse, {
        responseMode,
        explicitFormats: options.formats,
        verbose,
        maxTotalChars,
        includeMedia: options.includeMedia,
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
    const rawBody = await jsonBodyOr400(c);
    if (rawBody instanceof Response) return rawBody;
    const parsed = ImageSearchRequestSchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    return c.json(await searchImageCached(parsed.data));
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Image search failed' }, 500);
  }
});

// Yahoo 動画検索
searchRoutes.post('/search/video', async (c) => {
  try {
    const rawBody = await jsonBodyOr400(c);
    if (rawBody instanceof Response) return rawBody;
    const parsed = VideoSearchRequestSchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    // ponytail: youtube モジュールが無効な設定では transcripts を無視する
    const transcripts = isModuleActive('youtube') ? parsed.data.transcripts ?? 0 : 0;
    return c.json(await searchVideoCached({ ...parsed.data, transcripts }));
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Video search failed' }, 500);
  }
});

// Yahoo ニュース検索
searchRoutes.post('/search/news', async (c) => {
  try {
    const rawBody = await jsonBodyOr400(c);
    if (rawBody instanceof Response) return rawBody;
    const parsed = NewsSearchRequestSchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    return c.json(await searchNewsCached(parsed.data));
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'News search failed' }, 500);
  }
});

// Yahoo 知恵袋検索
searchRoutes.post('/search/chiebukuro', async (c) => {
  try {
    const rawBody = await jsonBodyOr400(c);
    if (rawBody instanceof Response) return rawBody;
    const parsed = ChiebukuroSearchRequestSchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    return c.json(await searchChiebukuroCached(parsed.data));
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Chiebukuro search failed' }, 500);
  }
});

// Yahoo サジェスト（キーワード補完）
searchRoutes.post('/search/suggest', async (c) => {
  try {
    const rawBody = await jsonBodyOr400(c);
    if (rawBody instanceof Response) return rawBody;
    const parsed = SuggestRequestSchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: inputErrorMessage(parsed.error) }, 400);
    return c.json(await suggestKeywordsCached(parsed.data));
  } catch (err) {
    return c.json({ error: errorMessage(err) || 'Suggest keywords failed' }, 500);
  }
});

// 乗換案内
searchRoutes.post('/transit/route', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = TransitRouteRequestSchema.safeParse(dropNullFields(rawBody));
  if (!parsed.success) {
    return formatError(c, 'Invalid transit route parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    return c.json(await searchTransitRoute(parsed.data));
  } catch (err) {
    return formatError(c, errorMessage(err) || 'Transit route search failed', 'TRANSIT_ERROR', 500);
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
    return formatError(c, 'Invalid music search parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await searchMusic(parsed.data);
    return c.json(result);
  } catch (err) {
    return formatError(c, errorMessage(err) || 'Music search failed', 'MUSIC_ERROR', 500);
  }
});
