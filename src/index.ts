import { Hono } from 'hono';
import { existsSync } from 'fs';
import {
  PORT,
  CHROME_EXECUTABLE_PATH,
  YAHOO_MCP_PATH,
  DEFAULT_MAX_CHARS,
  getCacheSize,
  clearCache,
  getFromCache,
  setToCache,
  scrapeUrl,
  callYahooMcp,
  searchYahooWeb,
  integratedSearch,
  mapSiteUrl,
  crawlSiteUrl,
  fetchRealtimeTrends,
  filterByDomains,
  searchYahooImage,
  searchYahooVideo,
  searchYahooNews,
  searchYahooChiebukuro,
  getSuggestedKeywords,
  searchTransitRoute,
  fetchWeatherForecast,
  executeBrowserActions,
} from './scraper.js';
import { createAuthMiddleware } from './auth.js';
import { createMcpServer, createMcpTransport } from './mcp.js';

const app = new Hono();

// ==========================================
// 1. 認証ミドルウェア (API Key / Localhost Bypass)
// ==========================================
app.use('*', createAuthMiddleware());

// ==========================================
// 2. MCP Server & Streamable HTTP / SSE 初期化
// ==========================================
const mcpServer = createMcpServer();
const mcpTransport = createMcpTransport();

async function handleMcpRequest(c: any) {
  if (!mcpServer.isConnected()) {
    await mcpServer.connect(mcpTransport);
  }
  return mcpTransport.handleRequest(c);
}

// Streamable HTTP & SSE エンドポイント
app.all('/mcp', handleMcpRequest);
app.all('/sse', handleMcpRequest);
app.all('/message', handleMcpRequest);

// ==========================================
// 3. REST API ルーティング
// ==========================================
app.get('/', (c) => {
  return c.json({
    service: 'ghostfetch',
    description: 'Unified Web Scraping, Search, Transit & MCP Service',
    version: '2.0.0',
    endpoints: {
      health: 'GET /health',
      mcp: 'POST/GET /mcp (Streamable HTTP / SSE)',
      sse: 'GET /sse, POST /message',
      scrape: 'POST /scrape',
      searchWeb: 'POST /search/web',
      searchRealtime: 'POST /search/realtime',
      searchTrend: 'POST /search/trend',
      searchIntegrated: 'POST /search',
      searchImage: 'POST /search/image',
      searchVideo: 'POST /search/video',
      searchNews: 'POST /search/news',
      searchChiebukuro: 'POST /search/chiebukuro',
      searchSuggest: 'POST /search/suggest',
      transitRoute: 'POST /transit/route',
      weather: 'POST/GET /weather, GET /weather/:city',
      map: 'POST /map',
      crawl: 'POST /crawl',
      cacheClear: 'POST /cache/clear',
    },
  });
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'ghostfetch',
    cachedEntries: getCacheSize(),
    chromiumAvailable: !!CHROME_EXECUTABLE_PATH,
    yahooMcpAvailable: existsSync(YAHOO_MCP_PATH),
    mcpConnected: mcpServer.isConnected(),
    timestamp: new Date().toISOString(),
  });
});

app.post('/cache/clear', (c) => {
  const count = clearCache();
  return c.json({ status: 'ok', cleared: count });
});

// 単一 URL / PDF スクレイプ
app.post('/scrape', async (c) => {
  try {
    const body = await c.req.json();
    if (!body || !body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    const result = await scrapeUrl({
      url: body.url,
      maxChars: body.maxChars,
      mode: body.mode,
      fastOnly: body.fastOnly,
      renderJs: body.renderJs,
      proxyUrl: body.proxyUrl,
      timeoutMs: body.timeoutMs,
      noCache: body.noCache,
      extractHighlights: body.extractHighlights,
      query: body.query,
    });

    return c.json(result);
  } catch (err: any) {
    const isSecurity = err.message?.includes('セキュリティ上の理由');
    return c.json(
      {
        error: err.message || 'Scrape failed',
        url: (err as any).url,
      },
      isSecurity ? 403 : 500,
    );
  }
});

// 対話型ブラウザ自動操作 (POST /browser/action & POST /action)
const handleBrowserAction = async (c: any) => {
  try {
    const body = await c.req.json();
    const url = body?.url;
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    const result = await executeBrowserActions({
      url,
      actions: body.actions,
      extract: body.extract,
      timeout: body.timeout,
      proxyUrl: body.proxyUrl,
    });

    return c.json(result);
  } catch (err: any) {
    const isSecurity = err.message?.includes('forbidden') || err.message?.includes('private or blocked');
    return c.json(
      {
        error: err.message || 'Browser action failed',
        url: (err as any).url,
      },
      isSecurity ? 403 : 500,
    );
  }
};

app.post('/browser/action', handleBrowserAction);
app.post('/action', handleBrowserAction);

// Yahoo リアルタイム検索 (X 生ツイート & フライヤー画像)
app.post('/search/realtime', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const cacheKey = `search:realtime:${query}`;
    if (!body.noCache) {
      const cached = getFromCache<any>(cacheKey);
      if (cached) return c.json(cached);
    }

    const mcpRes = await callYahooMcp('yahoo_realtime_search', { query });
    const content = mcpRes?.content?.[0]?.text || '';
    let parsedData = content;
    try {
      const json = JSON.parse(content);
      if (json && Array.isArray(json.items)) {
        json.items = json.items.map((item: any) => ({ source: 'x' as const, ...item }));
      }
      parsedData = json;
    } catch {}

    const responseData = {
      query,
      source: 'x',
      type: 'realtime',
      data: parsedData,
      cached: false,
    };

    if (!body.noCache) setToCache(cacheKey, responseData);
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
    const limit = Math.min(body?.limit || 3, 10);
    const scrapeContent = body?.scrapeContent !== false;
    const includeRealtime = body?.includeRealtime !== false;
    const maxChars = body?.maxChars || DEFAULT_MAX_CHARS;
    const noCache = body?.noCache ?? false;
    const includeDomains = body?.includeDomains;
    const excludeDomains = body?.excludeDomains;
    const updated = body?.updated;
    const proxyUrl = body?.proxyUrl;
    const extractHighlights = body?.extractHighlights;

    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const finalResponse = await integratedSearch({
      query,
      limit,
      scrapeContent,
      includeRealtime,
      maxChars,
      noCache,
      includeDomains,
      excludeDomains,
      updated,
      proxyUrl,
      extractHighlights,
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
      proxyUrl: body.proxyUrl,
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
      proxyUrl: body.proxyUrl,
    });

    return c.json(result);
  } catch (err: any) {
    const isSecurity = err.message?.includes('セキュリティ上の理由');
    return c.json({ error: err.message || 'Crawl failed' }, isSecurity ? 403 : 500);
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

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    fetch: app.fetch,
  });
  console.log(`Starting GhostFetch service on port ${PORT}...`);
}

export { app };
