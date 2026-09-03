import { Hono } from 'hono';
import { McpSessionManager } from '../mcp.js';

export const mcpSessionManager = new McpSessionManager();

export async function handleMcpRequest(c: any) {
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

export const mcpRoutes = new Hono();

// Streamable HTTP エンドポイント (POST /mcp, GET /mcp, DELETE /mcp)
mcpRoutes.all('/mcp', handleMcpRequest);
mcpRoutes.all('/sse', handleMcpRequest);
mcpRoutes.all('/message', handleMcpRequest);
