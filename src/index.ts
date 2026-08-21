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
  integratedSearch,
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
    description: 'Unified Web Scraping, Search & MCP Service',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      mcp: 'POST/GET /mcp (Streamable HTTP / SSE)',
      sse: 'GET /sse, POST /message',
      scrape: 'POST /scrape { url, maxChars?, fastOnly?, timeoutMs?, noCache? }',
      searchWeb: 'POST /search/web { query, noCache? }',
      searchRealtime: 'POST /search/realtime { query, noCache? }',
      searchIntegrated: 'POST /search { query, limit?, scrapeContent?, includeRealtime?, maxChars?, noCache? }',
      cacheClear: 'POST /cache/clear',
    },
  });
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'web-fetcher',
    cachedEntries: getCacheSize(),
    chromiumAvailable: !!CHROME_EXECUTABLE_PATH || !!process.env.BROWSERLESS_URL,
    yahooMcpAvailable: existsSync(YAHOO_MCP_PATH),
    mcpConnected: mcpServer.isConnected(),
    timestamp: new Date().toISOString(),
  });
});

app.post('/cache/clear', (c) => {
  const count = clearCache();
  return c.json({ status: 'ok', cleared: count });
});

// 単一 URL スクレイプ
app.post('/scrape', async (c) => {
  try {
    const body = await c.req.json();
    if (!body || !body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    const result = await scrapeUrl({
      url: body.url,
      maxChars: body.maxChars,
      fastOnly: body.fastOnly,
      timeoutMs: body.timeoutMs,
      noCache: body.noCache,
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
      parsedData = JSON.parse(content);
    } catch {}

    const responseData = {
      query,
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

// Yahoo Web 検索
app.post('/search/web', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    if (!query || typeof query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }

    const cacheKey = `search:web:${query}`;
    if (!body.noCache) {
      const cached = getFromCache<any>(cacheKey);
      if (cached) return c.json(cached);
    }

    const mcpRes = await callYahooMcp('yahoo_web_search', { query });
    const content = mcpRes?.content?.[0]?.text || '';
    let parsedData = content;
    try {
      parsedData = JSON.parse(content);
    } catch {}

    const responseData = {
      query,
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

// Firecrawl 互換: 検索 + 上位サイト並行スクレイプ + リアルタイム検索 (AI 向け一括エンドポイント)
app.post('/search', async (c) => {
  try {
    const body = await c.req.json();
    const query = body?.query;
    const limit = Math.min(body?.limit || 3, 10);
    const scrapeContent = body?.scrapeContent !== false; // デフォルト true
    const includeRealtime = body?.includeRealtime !== false; // デフォルト true
    const maxChars = body?.maxChars || DEFAULT_MAX_CHARS;
    const noCache = body?.noCache ?? false;

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
    });

    return c.json(finalResponse);
  } catch (err: any) {
    return c.json({ error: err.message || 'Integrated search failed' }, 500);
  }
});

console.log(`Starting web-fetcher service on port ${PORT}...`);

export { app };
export default {
  port: PORT,
  fetch: app.fetch,
};
