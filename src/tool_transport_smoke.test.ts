import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpCall, mcpClose, mcpInitialize, mcpPost, parseJsonRpcPayload, type McpHttpSession } from '../scripts/tool-health/mcp_http.js';

let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = '';
let origin = '';
let previousPort: string | undefined;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'transport-smoke-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
  delete process.env.WEB_FETCHER_API_KEY;
  delete process.env.API_KEY;
  // Claim a free port first so the MCP allowlist covers this exact origin.
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
  const port = probe.port;
  probe.stop(true);
  previousPort = process.env.PORT;
  process.env.PORT = String(port);
  // Fresh module instance: other test files may have imported index.ts already
  // with different env (bun shares one module registry across test files).
  const { app, mcpSessionManager } = await import(`./index.js?transport-smoke=${Date.now()}`);
  void mcpSessionManager;
  server = Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${port}`;
  origin = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  try { server?.stop(true); } catch {}
  const { closeDb } = await import('./db.js');
  closeDb();
  delete process.env.SORA_DB_PATH;
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  rmSync(directory, { recursive: true, force: true });
});

describe('tool transport over real HTTP', () => {
  test('initialize -> tools/list -> search_tools activation -> call -> session delete', async () => {
    const session: McpHttpSession = { baseUrl, extraHeaders: { Origin: origin } };
    await mcpInitialize(session, 15000);
    expect(session.sessionId).toBeTruthy();
    const list = await mcpPost(session, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 15000);
    expect(list.status).toBe(200);
    const names = ((list.body as any)?.result?.tools ?? []).map((t: any) => t.name);
    expect(names).toContain('search_tools');
    expect(names).not.toContain('track_package');
    await mcpCall(session, 'search_tools', { query: '荷物追跡' }, 15000, 3);
    const list2 = await mcpPost(session, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, 15000);
    const names2 = ((list2.body as any)?.result?.tools ?? []).map((t: any) => t.name);
    expect(names2).toContain('track_package');
    await mcpClose(session, 5000);
    expect(session.sessionId).toBeUndefined();
  }, 60000);
  test('evil origin and untrusted host are rejected without a session', async () => {
    const evil: McpHttpSession = { baseUrl, extraHeaders: { Origin: 'https://evil.example', Host: 'evil.example' } };
    const res = await mcpPost(evil, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 15000);
    expect(res.status).toBe(403);
    expect(evil.sessionId).toBeUndefined();
    const nullOrigin: McpHttpSession = { baseUrl, extraHeaders: { Origin: 'null' } };
    const res2 = await mcpPost(nullOrigin, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 15000);
    expect(res2.status).toBe(403);
  }, 60000);
  test('OPTIONS preflight answers with the narrow allowlist origin', async () => {
    const res = await fetch(baseUrl + '/mcp', { method: 'OPTIONS', headers: { Origin: origin } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  }, 30000);
  test('JSON-RPC payload parser reads SSE data lines', () => {
    const parsed = parseJsonRpcPayload('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n') as any;
    expect(parsed.id).toBe(1);
  });
});
