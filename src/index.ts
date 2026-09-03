import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'crypto';
import {
  PORT,
  closeSharedBrowser,
  closeDatabase,
} from './scraper.js';
import {
  closeAllBrowserSessions,
} from './browser_session.js';
import { createAuthMiddleware } from './auth.js';

// ドメイン別サブルーター
import { formatError } from './routes/utils.js';
import { mcpSessionManager, mcpRoutes } from './routes/mcp_route.js';
import { systemRoutes } from './routes/system.js';
import { scrapeRoutes } from './routes/scrape.js';
import { searchRoutes } from './routes/search.js';
import { browserRoutes } from './routes/browser.js';
import { tradeRoutes } from './routes/trade.js';
import { publicDataRoutes } from './routes/public_data.js';
import { watchRoutes } from './routes/watch.js';
import { mediaRoutes } from './routes/media.js';

export { formatError, mcpSessionManager };

export const app = new Hono();

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
// 3. サブルーターのマウント
// ==========================================
app.route('/', systemRoutes);
app.route('/', mcpRoutes);
app.route('/', scrapeRoutes);
app.route('/', searchRoutes);
app.route('/', browserRoutes);
app.route('/', tradeRoutes);
app.route('/', publicDataRoutes);
app.route('/', watchRoutes);
app.route('/', mediaRoutes);

// ==========================================
// 4. グレースフル・シャットダウン (ブラウザプロセス・DB完全解放)
// ==========================================
let isShuttingDown = false;
export async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await Promise.allSettled([
    closeAllBrowserSessions(),
    closeSharedBrowser(),
    closeDatabase(),
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
// 5. サーバー起動 (Bun.serve)
// ==========================================
if (import.meta.main) {
  const server = Bun.serve({
    port: PORT,
    fetch: app.fetch,
  });
  console.log(`Starting Sora service on port ${PORT}...`);

  const cleanup = async (signal: string) => {
    console.log(`Received ${signal}, shutting down Sora gracefully...`);
    try {
      server.stop(true);
      await gracefulShutdown();
    } catch (err) {
      console.error('Error during graceful shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
}
