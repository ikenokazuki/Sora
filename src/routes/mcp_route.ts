import { Hono, type Context } from 'hono';
import { McpSessionManager } from '../mcp.js';
import { chargeQuota } from '../security/quota.js';
import { quotaResponse } from './utils.js';

export const mcpSessionManager = new McpSessionManager();

export async function handleMcpRequest(c: Context) {
  const rawReq = c.req.raw;
  let parsedBody: unknown;
  if (rawReq.method === 'POST') {
    try {
      parsedBody = await c.req.json();
    } catch {
      // no json or invalid
    }
  }

  // JSON-RPC のバッチ（配列）は、入っている呼び出しの数を日次クォータに数える（要求の 1 回は、認証が数えている）。
  // 超えるなら、MCP に渡さず 429（設計 6。穴 26）
  if (Array.isArray(parsedBody)) {
    try {
      chargeQuota(c.get('tenant')?.tenantId ?? 'legacy', parsedBody.length - 1);
    } catch (err) {
      const overQuota = quotaResponse(c, err);
      if (overQuota) return overQuota;
      throw err;
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
  // tenant は、認証のミドルウェアが決めたものだけを使う（生のヘッダーから別に作らない）
  return mcpSessionManager.handleRequest(req, { parsedBody, tenantId: c.get('tenant')?.tenantId });
}

export const mcpRoutes = new Hono();

// Streamable HTTP エンドポイント (POST /mcp, GET /mcp, DELETE /mcp)
mcpRoutes.all('/mcp', handleMcpRequest);
mcpRoutes.all('/sse', handleMcpRequest);
mcpRoutes.all('/message', handleMcpRequest);
