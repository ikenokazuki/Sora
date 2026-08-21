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
    service: 'web-fetcher',
    description: 'Unified Web Scraping, Search & MCP Service (Firecrawl / Tavily Compatible)',
    version: '1.1.0',
    endpoints: {
      health: 'GET /health',
      mcp: 'POST/GET /mcp (Streamable HTTP / SSE)',
      sse: 'GET /sse, POST /message',
      scrape: 'POST /scrape { url, maxChars?, fastOnly?, timeoutMs?, extractHighlights?, query?, noCache? }',
      searchWeb: 'POST /search/web { query, includeDomains?, excludeDomains?, noCache? }',
      searchRealtime: 'POST /search/realtime { query, noCache? }',
      searchTrend: 'POST /search/trend { limit? }',
      searchIntegrated: 'POST /search { query, limit?, scrapeContent?, includeRealtime?, maxChars?, includeDomains?, excludeDomains?, extractHighlights?, noCache? }',
      map: 'POST /map { url, limit?, includeSubdomains? }',
      crawl: 'POST /crawl { url, maxPages?, maxDepth?, maxChars? }',
      cacheClear: 'POST /cache/clear',
    },
  });
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'web-fetcher',
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
    });

    return c.json(result);
  } catch (err: any) {
    const isSecurity = err.message?.includes('セキュリティ上の理由');
    return c.json({ error: err.message || 'Crawl failed' }, isSecurity ? 403 : 500);
  }
});

if (import.meta.main || process.env.NODE_ENV !== 'test') {
  Bun.serve({
    port: PORT,
    fetch: app.fetch,
  });
  console.log(`Starting web-fetcher service on port ${PORT}...`);
}

export { app };
