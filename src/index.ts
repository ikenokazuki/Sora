import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  PORT,
  CHROME_EXECUTABLE_PATH,
  YAHOO_MCP_PATH,
  DEFAULT_MAX_CHARS,
  CACHE_TTL_TREND,
  getCacheSize,
  getCacheMetrics,
  getBotDetectionMetrics,
  clearCache,
  getFromCache,
  setToCache,
  scrapeUrl,
  scrapeBatchUrls,
  callYahooMcp,
  searchYahooWeb,
  integratedSearch,
  mapSiteUrl,
  crawlSiteUrl,
  fetchRealtimeTrends,
  normalizeRealtimeItem,
  filterByDomains,
  searchYahooImage,
  searchYahooVideo,
  searchYahooNews,
  searchYahooChiebukuro,
  getSuggestedKeywords,
  searchTransitRoute,
  fetchWeatherForecast,
  executeBrowserActions,
  fetchWeatherWarnings,
  fetchRecentEarthquakes,
  fetchRoadTraffic,
  registerWatchTarget,
  checkWatchTarget,
  checkAllWatchTargets,
  listWatchTargets,
  deleteWatchTarget,
  searchMusic,
  searchSong,
  searchArtist,
  searchLaws,
  getLawData,
  searchDietMinutes,
  fetchElevationAndCoordinates,
  fetchFlightStatus,
  checkCpscCertificate,
  checkFdaRegulated,
  verifyHtsCode,
  checkProductCompliance,
  inspectImage,
  InspectImageRequestSchema,
  checkDetailedHealth,
  closeSharedBrowser,
  isSharedBrowserConnected,
} from './scraper.js';
import {
  ScrapeRequestSchema,
  BatchScrapeRequestSchema,
  BrowserActionRequestSchema,
  DisasterWarningsRequestSchema,
  EarthquakeRequestSchema,
  RoadTrafficRequestSchema,
  WatchRegisterRequestSchema,
  WatchCheckRequestSchema,
  SongSearchRequestSchema,
  ArtistSearchRequestSchema,
  MusicSearchRequestSchema,
  LawSearchRequestSchema,
  LawDataRequestSchema,
  DietMinutesSearchRequestSchema,
  ElevationRequestSchema,
  FlightStatusRequestSchema,
  CpscCertificateCheckRequestSchema,
  FdaRegulatedCheckRequestSchema,
  VerifyHtsCodeRequestSchema,
  ProductComplianceRequestSchema,
  generateOpenApiDocument,
  SORA_VERSION,
  type ApiErrorResponse,
} from './types.js';
import {
  getActiveSessionCount,
  closeAllBrowserSessions,
} from './browser_session.js';
import { createAuthMiddleware, extractAuthToken } from './auth.js';
import { createMcpServer, createMcpTransport, McpSessionManager } from './mcp.js';

export const app = new Hono();

// ==========================================
// 構造化エラーレスポンス ヘルパー
// ==========================================
export function formatError(
  c: any,
  message: string,
  code = 'INTERNAL_ERROR',
  status: 400 | 401 | 403 | 404 | 408 | 422 | 429 | 500 | 502 = 500,
  retryable = false,
  details?: any,
) {
  return c.json(
    {
      error: message,
      code,
      status,
      retryable,
      ...(details ? { details } : {}),
    },
    status,
  );
}

// ==========================================
// 1. CORS, セキュリティヘッダー & DoS 防御 (Body Limit)
// ==========================================
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'mcp-session-id',
      'mcp-protocol-version',
      'x-request-id',
      'Last-Event-ID',
    ],
    exposeHeaders: ['mcp-session-id', 'mcp-protocol-version', 'X-Response-Time'],
  }),
);

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  const path = c.req.path;
  if (path !== '/docs' && path !== '/swagger' && path !== '/') {
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none';");
  }
  return next();
});

app.use(
  '*',
  bodyLimit({
    maxSize: 10 * 1024 * 1024, // 10MB
    onError: (c) => {
      return c.json({ error: 'Payload Too Large: Request body exceeds 10MB limit' }, 413);
    },
  }),
);

// ==========================================
// 2. Request ID, 応答時間計測 & 構造化ログミドルウェア
// ==========================================
app.use('*', async (c, next) => {
  const start = performance.now();
  const reqId = c.req.header('x-request-id') || randomUUID();
  c.header('x-request-id', reqId);

  await next();

  const latencyMs = Math.round((performance.now() - start) * 100) / 100;
  c.header('X-Response-Time', `${latencyMs}ms`);

  const path = c.req.path;
  if (path !== '/health' && path !== '/metrics') {
    const logPayload = {
      timestamp: new Date().toISOString(),
      reqId,
      method: c.req.method,
      path,
      status: c.res.status,
      latencyMs,
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'direct',
      userAgent: c.req.header('user-agent') || '',
    };
    if (process.env.LOG_FORMAT === 'json') {
      console.log(JSON.stringify(logPayload));
    }
  }
});

app.use('*', createAuthMiddleware());

// ==========================================
// 3. グレースフル・シャットダウン (ブラウザプロセス完全解放)
// ==========================================
let isShuttingDown = false;
export async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await Promise.allSettled([
    closeAllBrowserSessions(),
    closeSharedBrowser(),
  ]);
}

if (typeof process !== 'undefined') {
  process.on('SIGINT', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
}

// ==========================================
// 2. MCP Server & Streamable HTTP 初期化 (マルチセッション対応)
// ==========================================
export const mcpSessionManager = new McpSessionManager();

async function handleMcpRequest(c: any) {
  const rawReq = c.req.raw;
  let parsedBody: any;
  if (rawReq.method === 'POST') {
    try {
      parsedBody = await c.req.json();
    } catch {
      // no json or invalid
    }
  }

  // Accept ヘッダーの正規化（406 Not Acceptable の完全回避）
  const accept = rawReq.headers.get('accept') || '';
  let req = rawReq;
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    const headers = new Headers(rawReq.headers);
    headers.set('accept', 'application/json, text/event-stream');
    req = new Request(rawReq.url, {
      method: rawReq.method,
      headers,
    });
  }
  return mcpSessionManager.handleRequest(req, { parsedBody });
}

// Streamable HTTP エンドポイント (POST /mcp, GET /mcp, DELETE /mcp)
app.all('/mcp', handleMcpRequest);
app.all('/sse', handleMcpRequest);
app.all('/message', handleMcpRequest);

// ==========================================
// 3. REST API ルーティング
// ==========================================
app.get('/', (c) => {
  return c.json({
    service: 'sora',
    description: 'Unified Web Scraping, Deep Search, Transit & MCP Service',
    version: SORA_VERSION,
    endpoints: {
      health: 'GET /health',
      metrics: 'GET /metrics',
      docs: 'GET /docs (Scalar API Reference), GET /swagger (Swagger UI)',
      openapi: 'GET /openapi.json (OpenAPI 3.0.0 Specification)',
      mcp: 'POST/GET /mcp (Streamable HTTP / SSE)',
      sse: 'GET /sse, POST /message',
      scrape: 'POST /scrape',
      scrapeStream: 'POST /scrape/stream (SSE)',
      scrapeBatch: 'POST /scrape/batch',
      searchWeb: 'POST /search/web',
      searchRealtime: 'POST /search/realtime',
      searchTrend: 'POST /search/trend',
      searchIntegrated: 'POST /search',
      searchStream: 'POST /search/stream',
      searchImage: 'POST /search/image',
      searchVideo: 'POST /search/video',
      searchNews: 'POST /search/news',
      searchChiebukuro: 'POST /search/chiebukuro',
      searchSuggest: 'POST /search/suggest',
      transitRoute: 'POST /transit/route',
      weather: 'POST/GET /weather, GET /weather/:city',
      disasterWarnings: 'POST /disaster/warnings',
      disasterEarthquake: 'POST /disaster/earthquake',
      trafficRoad: 'POST/GET /traffic/road, GET /traffic/road/:pref',
      watchRegister: 'POST /watch/register',
      watchCheck: 'POST /watch/check',
      watchList: 'GET /watch/list',
      watchDelete: 'DELETE /watch/:id',
      searchSong: 'POST /search/song, POST /search/music/song',
      searchArtist: 'POST /search/artist, POST /search/music/artist',
      searchMusic: 'POST /search/music',
      govLaws: 'POST /gov/laws',
      govLawText: 'POST /gov/law-text',
      govDietMinutes: 'POST/GET /gov/diet-minutes',
      geoElevation: 'POST/GET /geo/elevation',
      trafficFlight: 'POST/GET /traffic/flight, GET /traffic/flight/:airport',
      browserAction: 'POST /browser/action, POST /action',
      tradeCpscCheck: 'POST /trade/cpsc-check',
      tradeFdaCheck: 'POST /trade/fda-check',
      tradeHtsVerify: 'POST /trade/hts-verify',
      tradeCompliance: 'POST /trade/compliance',
      map: 'POST /map',
      crawl: 'POST /crawl',
      crawlStream: 'POST /crawl/stream',
      cacheClear: 'POST /cache/clear',
    },
  });
});

app.get('/health', async (c) => {
  const detailed = c.req.query('detailed');
  if (detailed === 'true' || detailed === '1') {
    const report = await checkDetailedHealth();
    return c.json(report, report.status === 'ok' ? 200 : 503);
  }
  return c.json({
    status: 'ok',
    service: 'sora',
    cachedEntries: getCacheSize(),
    chromiumAvailable: !!CHROME_EXECUTABLE_PATH,
    yahooMcpAvailable: existsSync(YAHOO_MCP_PATH),
    mcpConnected: true,
    activeMcpSessions: mcpSessionManager.getActiveSessionCount(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', (c) => {
  const format = c.req.query('format');
  const accept = c.req.header('accept') || '';
  const mem = process.memoryUsage();
  const cache = getCacheMetrics();
  const botDetection = getBotDetectionMetrics();
  const activeSessions = getActiveSessionCount();
  const uptime = Math.floor(process.uptime());

  if (format === 'prometheus' || accept.includes('text/plain')) {
    const lines = [
      '# HELP sora_uptime_seconds Process uptime in seconds',
      '# TYPE sora_uptime_seconds gauge',
      `sora_uptime_seconds ${uptime}`,
      '# HELP sora_memory_rss_bytes Resident set size in bytes',
      '# TYPE sora_memory_rss_bytes gauge',
      `sora_memory_rss_bytes ${mem.rss}`,
      '# HELP sora_memory_heap_used_bytes Heap used in bytes',
      '# TYPE sora_memory_heap_used_bytes gauge',
      `sora_memory_heap_used_bytes ${mem.heapUsed}`,
      '# HELP sora_cache_entries Total cache entries',
      '# TYPE sora_cache_entries gauge',
      `sora_cache_entries ${cache.size}`,
      '# HELP sora_cache_hits_total Total cache hits',
      '# TYPE sora_cache_hits_total counter',
      `sora_cache_hits_total ${cache.hits}`,
      '# HELP sora_cache_misses_total Total cache misses',
      '# TYPE sora_cache_misses_total counter',
      `sora_cache_misses_total ${cache.misses}`,
      '# HELP sora_cache_hit_rate Cache hit rate',
      '# TYPE sora_cache_hit_rate gauge',
      `sora_cache_hit_rate ${cache.hitRatio}`,
      '# HELP sora_active_browser_sessions Active browser sessions count',
      '# TYPE sora_active_browser_sessions gauge',
      `sora_active_browser_sessions ${activeSessions}`,
      '# HELP sora_bot_upgrade_total Static fetch results that triggered SPA/bot detection and were upgraded to browser rendering',
      '# TYPE sora_bot_upgrade_total counter',
      `sora_bot_upgrade_total ${botDetection.upgradeCount}`,
      '# HELP sora_bot_retry_total Browser-rendered results still flagged as SPA/bot after first render, triggering a retry',
      '# TYPE sora_bot_retry_total counter',
      `sora_bot_retry_total ${botDetection.retryCount}`,
    ];
    return c.text(lines.join('\n') + '\n', 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  }

  return c.json({
    status: 'ok',
    service: 'sora',
    uptimeSeconds: uptime,
    cache,
    botDetection,
    activeSessions,
    chromium: {
      available: !!CHROME_EXECUTABLE_PATH,
      sharedConnected: isSharedBrowserConnected(),
    },
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
  });
});

app.post('/cache/clear', (c) => {
  const count = clearCache();
  return c.json({ status: 'ok', cleared: count });
});

// 単一 URL / PDF スクレイプ (マルチフォーマット対応)
app.post('/scrape', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = ScrapeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await scrapeUrl(parsed.data);
    return c.json(result);
  } catch (err: any) {
    const msg = err.message || 'Scrape failed';
    const isSecurity = msg.includes('セキュリティ上の理由') || msg.includes('遮断') || msg.includes('DNS Rebinding') || msg.includes('Forbidden');
    const isTimeout = msg.includes('timeout') || msg.includes('タイムアウト') || msg.includes('timed out');
    const code = isSecurity ? 'SSRF_BLOCKED' : isTimeout ? 'TIMEOUT' : 'SCRAPE_ERROR';
    const status = isSecurity ? 403 : isTimeout ? 408 : 500;
    return formatError(c, msg, code, status, !isSecurity);
  }
});

// 単一 URL スクレイプ SSE ストリーミング (POST /scrape/stream)
app.post('/scrape/stream', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = ScrapeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  return streamSSE(c, async (stream) => {
    try {
      await scrapeUrl({
        ...parsed.data,
        onProgress: async (evt) => {
          await stream.writeSSE({
            event: evt.stage === 'done' ? 'done' : 'progress',
            data: JSON.stringify(evt),
          });
        },
      });
    } catch (err: any) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          error: err.message || 'Scrape failed',
          code: 'SCRAPE_ERROR',
        }),
      });
    }
  });
});

// 複数 URL 一括並行スクレイプ (POST /scrape/batch)
app.post('/scrape/batch', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = BatchScrapeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'urls must be a non-empty array of URLs (max: 20)', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await scrapeBatchUrls(parsed.data);
    return c.json(result);
  } catch (err: any) {
    const msg = err.message || 'Batch scrape failed';
    const isSecurity = msg.includes('セキュリティ上の理由') || msg.includes('遮断') || msg.includes('DNS Rebinding') || msg.includes('Forbidden');
    const code = isSecurity ? 'SSRF_BLOCKED' : 'BATCH_SCRAPE_ERROR';
    return formatError(c, msg, code, isSecurity ? 403 : 500, !isSecurity);
  }
});

// 対話型ブラウザ自動操作 (POST /browser/action & POST /action)
const handleBrowserAction = async (c: any) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = BrowserActionRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid browser action parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  const body = parsed.data;
  if (!body.url && !body.sessionId) {
    return formatError(c, 'url or sessionId is required', 'INVALID_INPUT', 400, false);
  }

  try {
    const result = await executeBrowserActions({
      url: body.url,
      sessionId: body.sessionId,
      ownerToken: extractAuthToken(c),
      createSession: body.createSession,
      closeSession: body.closeSession,
      actions: body.actions,
      extract: body.extract,
      timeout: body.timeout,
    });

    return c.json(result);
  } catch (err: any) {
    const msg = err.message || 'Browser action failed';
    const isForbidden = msg.includes('Forbidden') || msg.includes('permission');
    const isSecurity = isForbidden || msg.includes('private or blocked') || msg.includes('遮断');
    const isTimeout = msg.includes('timeout') || msg.includes('タイムアウト');
    const code = isForbidden ? 'FORBIDDEN' : isSecurity ? 'SSRF_BLOCKED' : isTimeout ? 'TIMEOUT' : 'BROWSER_ERROR';
    const status = isSecurity ? 403 : isTimeout ? 408 : 500;
    return formatError(c, msg, code, status, !isSecurity);
  }
};

app.post('/browser/action', handleBrowserAction);
app.post('/action', handleBrowserAction);

// Yahoo リアルタイム検索 (X 生ツイート & フライヤー画像)
app.post('/search/realtime', async (c) => {
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

    const mcpRes = await callYahooMcp('yahoo_realtime_search', {
      query,
      sort,
      ...(limit ? { limit } : {}),
      ...(page ? { page } : {}),
    });
    const content = mcpRes?.content?.[0]?.text || '';
    let parsedData = content;
    try {
      const json = JSON.parse(content);
      if (json && Array.isArray(json.items)) {
        json.items = json.items.map((item: any) => normalizeRealtimeItem(item));
      }
      parsedData = json;
    } catch {}

    const responseData = {
      query,
      sort,
      source: 'x',
      type: 'realtime',
      data: parsedData,
      cached: false,
    };

    if (!body.noCache) setToCache(cacheKey, responseData, CACHE_TTL_TREND);
    return c.json(responseData);
  } catch (err: any) {
    return c.json({ error: err.message || 'Realtime search failed' }, 500);
  }
});

// Yahoo リアルタイム急上昇トレンド
app.post('/search/trend', async (c) => {
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
app.post('/search/web', async (c) => {
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
app.post('/search', async (c) => {
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
    });

    return c.json(finalResponse);
  } catch (err: any) {
    return c.json({ error: err.message || 'Integrated search failed' }, 500);
  }
});

// サイトマップ & URL マッピング (/map)
app.post('/map', async (c) => {
  try {
    const body = await c.req.json();
    if (!body || !body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    const result = await mapSiteUrl({
      url: body.url,
      limit: body.limit,
      includeSubdomains: body.includeSubdomains,
      timeoutMs: body.timeoutMs,
      since: body.since,
    });

    return c.json(result);
  } catch (err: any) {
    const isSecurity = err.message?.includes('セキュリティ上の理由');
    return c.json({ error: err.message || 'Map failed' }, isSecurity ? 403 : 500);
  }
});

// サブページ再帰的クロール (/crawl)
app.post('/crawl', async (c) => {
  try {
    const body = await c.req.json();
    if (!body || !body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    const result = await crawlSiteUrl({
      url: body.url,
      maxPages: body.maxPages,
      maxDepth: body.maxDepth,
      maxChars: body.maxChars,
      timeoutMs: body.timeoutMs,
      concurrency: body.concurrency,
      includePatterns: body.includePatterns,
      excludePatterns: body.excludePatterns,
      formats: body.formats,
      webhookUrl: body.webhookUrl,
      query: body.query,
      extractHighlights: body.extractHighlights,
      onlyHighlights: body.onlyHighlights,
      noCache: body.noCache,
    });

    return c.json(result);
  } catch (err: any) {
    const isSecurity = err.message?.includes('セキュリティ上の理由');
    return c.json({ error: err.message || 'Crawl failed' }, isSecurity ? 403 : 500);
  }
});

// サブページ再帰的クロール SSE ストリーミング (/crawl/stream)
app.post('/crawl/stream', async (c) => {
  try {
    const body = await c.req.json();
    if (!body || !body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'start',
        data: JSON.stringify({ url: body.url, status: 'crawling' }),
      });

      const result = await crawlSiteUrl({
        url: body.url,
        maxPages: body.maxPages,
        maxDepth: body.maxDepth,
        maxChars: body.maxChars,
        timeoutMs: body.timeoutMs,
        concurrency: body.concurrency,
        includePatterns: body.includePatterns,
        excludePatterns: body.excludePatterns,
        formats: body.formats,
        query: body.query,
        extractHighlights: body.extractHighlights,
        onlyHighlights: body.onlyHighlights,
        noCache: body.noCache,
        onPageCrawled: (page: any, count: number) => {
          stream.writeSSE({
            event: 'page',
            data: JSON.stringify({ count, page }),
          });
        },
      });

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ count: result.count, url: result.url }),
      });
    });
  } catch (err: any) {
    const isSecurity = err.message?.includes('セキュリティ上の理由');
    return c.json({ error: err.message || 'Crawl stream failed' }, isSecurity ? 403 : 500);
  }
});

// Yahoo 画像検索
app.post('/search/image', async (c) => {
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
app.post('/search/video', async (c) => {
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
app.post('/search/news', async (c) => {
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
app.post('/search/chiebukuro', async (c) => {
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
app.post('/search/suggest', async (c) => {
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
app.post('/transit/route', async (c) => {
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

// 天気予報 (POST /weather)
app.post('/weather', async (c) => {
  try {
    const body = await c.req.json();
    const city = body?.city;
    if (!city || typeof city !== 'string') {
      return c.json({ error: 'city is required' }, 400);
    }

    const days = body?.days ? parseInt(body.days, 10) : undefined;
    const result = await fetchWeatherForecast({ city, days, noCache: body?.noCache });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Weather forecast failed' }, 500);
  }
});

// 天気予報 (GET /weather & GET /weather/:city)
app.get('/weather/:city', async (c) => {
  try {
    const city = c.req.param('city');
    const daysParam = c.req.query('days');
    const days = daysParam ? parseInt(daysParam, 10) : undefined;
    const noCache = c.req.query('noCache') === 'true';

    const result = await fetchWeatherForecast({ city, days, noCache });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Weather forecast failed' }, 500);
  }
});

app.get('/weather', async (c) => {
  try {
    const city = c.req.query('city') || '東京';
    const daysParam = c.req.query('days');
    const days = daysParam ? parseInt(daysParam, 10) : undefined;
    const noCache = c.req.query('noCache') === 'true';

    const result = await fetchWeatherForecast({ city, days, noCache });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || 'Weather forecast failed' }, 500);
  }
});

// ==========================================
// 4. 防災・地震・変更監視・音楽 REST エンドポイント
// ==========================================

// 気象警報・注意報 (POST /disaster/warnings)
app.post('/disaster/warnings', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = DisasterWarningsRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid disaster warnings parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchWeatherWarnings(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Disaster warnings fetch failed', 'DISASTER_ERROR', 500);
  }
});

// 地震速報・履歴 (POST /disaster/earthquake)
app.post('/disaster/earthquake', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = EarthquakeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid earthquake parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchRecentEarthquakes(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Earthquake search failed', 'EARTHQUAKE_ERROR', 500);
  }
});

// 道路交通情報 (POST /traffic/road)
app.post('/traffic/road', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = RoadTrafficRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid road traffic parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchRoadTraffic(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Road traffic fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

// 道路交通情報 GET (GET /traffic/road & GET /traffic/road/:pref)
app.get('/traffic/road', async (c) => {
  const pref = c.req.query('pref');
  const road = c.req.query('road');
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchRoadTraffic({ pref, road, noCache });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Road traffic fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

app.get('/traffic/road/:pref', async (c) => {
  const pref = c.req.param('pref');
  const road = c.req.query('road');
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchRoadTraffic({ pref, road, noCache });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Road traffic fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

// 監視ターゲット登録 (POST /watch/register)
app.post('/watch/register', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = WatchRegisterRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid watch register parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await registerWatchTarget(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Watch target registration failed', 'WATCH_ERROR', 500);
  }
});

// 差分スキャン実行 (POST /watch/check)
app.post('/watch/check', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = WatchCheckRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid watch check parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = parsed.data.id
      ? await checkWatchTarget(parsed.data.id)
      : await checkAllWatchTargets();
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Watch check failed', 'WATCH_ERROR', 500);
  }
});

// 監視ターゲット一覧 (GET /watch/list)
app.get('/watch/list', (c) => {
  try {
    const targets = listWatchTargets();
    return c.json({ count: targets.length, targets });
  } catch (err: any) {
    return formatError(c, err.message || 'Watch list failed', 'WATCH_ERROR', 500);
  }
});

// 監視ターゲット削除 (DELETE /watch/:id)
app.delete('/watch/:id', (c) => {
  const id = c.req.param('id');
  if (!id) {
    return formatError(c, 'Target id is required', 'INVALID_INPUT', 400);
  }
  const deleted = deleteWatchTarget(id);
  return c.json({ success: deleted, id });
});

// 曲名指定 楽曲メタデータ検索 (POST /search/song & POST /search/music/song)
const handleSongSearch = async (c: any) => {
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
app.post('/search/song', handleSongSearch);
app.post('/search/music/song', handleSongSearch);

// アーティスト名指定 音楽メタデータ検索 (POST /search/artist & POST /search/music/artist)
const handleArtistSearch = async (c: any) => {
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
app.post('/search/artist', handleArtistSearch);
app.post('/search/music/artist', handleArtistSearch);

// 音楽メタデータ検索 (汎用・後方互換: POST /search/music)
app.post('/search/music', async (c) => {
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

// e-Gov キーワード法令検索 (POST /gov/laws)
app.post('/gov/laws', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = LawSearchRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'keyword is required for law search', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await searchLaws(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Law search failed', 'GOV_ERROR', 500);
  }
});

// e-Gov 法令条文・本文詳細取得 (POST /gov/law-text)
app.post('/gov/law-text', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = LawDataRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'lawId is required for law text retrieval', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await getLawData(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Law text retrieval failed', 'GOV_ERROR', 500);
  }
});

// 米国CPSC適合証明書 eFiling義務化判定 (POST /trade/cpsc-check)
app.post('/trade/cpsc-check', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = CpscCertificateCheckRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'htsCode and targetAge are required for CPSC certificate check', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await checkCpscCertificate(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'CPSC certificate check failed', 'TRADE_ERROR', 500);
  }
});

// 米国FDA規制対象 簡易判定 (POST /trade/fda-check)
app.post('/trade/fda-check', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = FdaRegulatedCheckRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'htsCode is required for FDA regulation check', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = checkFdaRegulated(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'FDA regulation check failed', 'TRADE_ERROR', 500);
  }
});

// HTS/HSコード実在確認・検証 (POST /trade/hts-verify)
app.post('/trade/hts-verify', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = VerifyHtsCodeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'htsCode and productDescription are required for HTS code verification', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await verifyHtsCode(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'HTS code verification failed', 'TRADE_ERROR', 500);
  }
});

// 商品統合コンプライアンス一括判定 (POST /trade/compliance)
app.post('/trade/compliance', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = ProductComplianceRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid product compliance parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await checkProductCompliance(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Product compliance check failed', 'TRADE_ERROR', 500);
  }
});

// 国会会議録検索 (POST /gov/diet-minutes & GET /gov/diet-minutes)
app.post('/gov/diet-minutes', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = DietMinutesSearchRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid diet minutes search parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await searchDietMinutes(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Diet minutes search failed', 'GOV_ERROR', 500);
  }
});

app.get('/gov/diet-minutes', async (c) => {
  const keyword = c.req.query('keyword') || c.req.query('query') || c.req.query('any');
  const speaker = c.req.query('speaker');
  const nameOfHouse = c.req.query('nameOfHouse') as '衆議院' | '参議院' | undefined;
  const nameOfMeeting = c.req.query('nameOfMeeting') || c.req.query('meeting');
  const from = c.req.query('from');
  const until = c.req.query('until');
  const limitStr = c.req.query('limit');
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await searchDietMinutes({
      keyword,
      speaker,
      nameOfHouse,
      nameOfMeeting,
      from,
      until,
      limit,
      noCache,
    });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Diet minutes search failed', 'GOV_ERROR', 500);
  }
});

// 国土地理院 住所ジオコーディング & 標高取得 (POST /geo/elevation & GET /geo/elevation)
app.post('/geo/elevation', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = ElevationRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid elevation parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchElevationAndCoordinates(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Elevation fetch failed', 'GEO_ERROR', 500);
  }
});

app.get('/geo/elevation', async (c) => {
  const address = c.req.query('address') || c.req.query('q');
  const latStr = c.req.query('lat');
  const lonStr = c.req.query('lon');
  const lat = latStr ? parseFloat(latStr) : undefined;
  const lon = lonStr ? parseFloat(lonStr) : undefined;
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchElevationAndCoordinates({
      address,
      lat,
      lon,
      noCache,
    });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Elevation fetch failed', 'GEO_ERROR', 500);
  }
});

// 主要空港フライト運航状況検索 (POST /traffic/flight, GET /traffic/flight, GET /traffic/flight/:airport)
app.post('/traffic/flight', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = FlightStatusRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return formatError(c, 'Invalid flight status parameters', 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await fetchFlightStatus(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Flight status fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

app.get('/traffic/flight', async (c) => {
  const airport = c.req.query('airport');
  const type = c.req.query('type') as 'departure' | 'arrival' | undefined;
  const category = c.req.query('category') as 'domestic' | 'international' | undefined;
  const flightNumber = c.req.query('flightNumber') || c.req.query('flight');
  const keyword = c.req.query('keyword') || c.req.query('query');
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchFlightStatus({
      airport,
      type,
      category,
      flightNumber,
      keyword,
      noCache,
    });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Flight status fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

app.get('/traffic/flight/:airport', async (c) => {
  const airport = c.req.param('airport');
  const type = c.req.query('type') as 'departure' | 'arrival' | undefined;
  const category = c.req.query('category') as 'domestic' | 'international' | undefined;
  const flightNumber = c.req.query('flightNumber') || c.req.query('flight');
  const keyword = c.req.query('keyword') || c.req.query('query');
  const noCache = c.req.query('noCache') === 'true' || c.req.query('noCache') === '1';

  try {
    const result = await fetchFlightStatus({
      airport,
      type,
      category,
      flightNumber,
      keyword,
      noCache,
    });
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Flight status fetch failed', 'TRAFFIC_ERROR', 500);
  }
});

// ==========================================
// 3.4 Media & Vision OCR APIs
// ==========================================
app.post('/media/inspect-image', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = InspectImageRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await inspectImage(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Image inspection failed', 'MEDIA_ERROR', 500);
  }
});

// ==========================================
// 3.5 対話型 API ドキュメント (Scalar API Reference & Swagger UI)
// ==========================================
// OpenAPI 仕様書エンドポイント (Zod スキーマから完全自動生成)
app.get('/openapi.json', (c) => {
  return c.json(generateOpenApiDocument());
});

// モダンな API リファレンス (Scalar UI: パラメータの意味・型・制約を初期表示で美しく一覧化)
app.get('/docs', (c) => {
  const html = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sora API Reference</title>
  </head>
  <body>
    <script
      id="api-reference"
      data-url="/openapi.json"
      data-configuration='{"theme":"purple","darkMode":true,"layout":"modern","showSidebar":true}'
      src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"
    ></script>
  </body>
</html>`;
  return c.html(html);
});

// 従来の Swagger UI (互換用)
app.get('/swagger', (c) => {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sora API Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis],
        layout: "BaseLayout",
        defaultModelRendering: 'model',
        defaultModelsExpandDepth: 2
      });
    };
  </script>
</body>
</html>`;
  return c.html(html);
});

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    fetch: app.fetch,
  });
  console.log(`Starting Sora service on port ${PORT}...`);
}
