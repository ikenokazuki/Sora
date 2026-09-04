import { Hono } from 'hono';
import { existsSync } from 'fs';
import {
  CHROME_EXECUTABLE_PATH,
  YAHOO_MCP_PATH,
  getCacheSize,
  getCacheMetrics,
  getBotDetectionMetrics,
  clearCache,
  checkDetailedHealth,
  isSharedBrowserConnected,
} from '../scraper.js';
import { getActiveSessionCount } from '../browser_session.js';
import { SORA_VERSION, generateOpenApiDocument } from '../types.js';
import { mcpSessionManager } from './mcp_route.js';

export const systemRoutes = new Hono();

systemRoutes.get('/', (c) => {
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
      tradeHtsPredict: 'POST /trade/hts-predict',
      tradeCompliance: 'POST /trade/compliance',
      mediaInspectImage: 'POST /media/inspect-image',
      map: 'POST /map',
      crawl: 'POST /crawl',
      crawlStream: 'POST /crawl/stream',
      cacheClear: 'POST /cache/clear',
    },
  });
});

systemRoutes.get('/health', async (c) => {
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

systemRoutes.get('/metrics', (c) => {
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

systemRoutes.post('/cache/clear', (c) => {
  const count = clearCache();
  return c.json({ status: 'ok', cleared: count });
});

// OpenAPI 仕様書エンドポイント (Zod スキーマから完全自動生成)
systemRoutes.get('/openapi.json', (c) => {
  return c.json(generateOpenApiDocument());
});

// モダンな API リファレンス (Scalar UI: パラメータの意味・型・制約を初期表示で美しく一覧化)
systemRoutes.get('/docs', (c) => {
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
systemRoutes.get('/swagger', (c) => {
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
