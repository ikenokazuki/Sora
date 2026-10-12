import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_MCP_SESSIONS, McpSessionManager, resolveMaxMcpSessions } from './mcp.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';

// MCP セッションは 1 つあたり数 MB を保持する。以前は上限がなく、initialize を連打するだけでメモリが尽きた。

const rpcHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2024-11-05',
};

const managers: McpSessionManager[] = [];
function newManager(options?: ConstructorParameters<typeof McpSessionManager>[0]) {
  const m = new McpSessionManager(options);
  managers.push(m);
  return m;
}

afterEach(() => {
  while (managers.length) managers.pop()!.clearAllSessions();
  resetSecurityMetrics();
  delete process.env.SORA_MCP_MAX_SESSIONS;
});

async function initialize(manager: McpSessionManager) {
  const res = await manager.handleRequest(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: rpcHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'session-limit-test', version: '1' } },
    }),
  }));
  await res.text();
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), retryAfter: res.headers.get('retry-after') };
}

/** そのセッションでリクエストを送る。生きていれば 200、退避済みなら 404。 */
async function ping(manager: McpSessionManager, sessionId: string) {
  const res = await manager.handleRequest(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { ...rpcHeaders, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  }));
  await res.text();
  return res.status;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('resolveMaxMcpSessions', () => {
  test('正の整数はそのまま、未設定や不正な値は既定値', () => {
    expect(resolveMaxMcpSessions('50')).toBe(50);
    expect(resolveMaxMcpSessions(' 7 ')).toBe(7);
    for (const raw of [undefined, '', '0', '-3', 'abc', '1.5', 'NaN']) {
      expect(resolveMaxMcpSessions(raw)).toBe(DEFAULT_MAX_MCP_SESSIONS);
    }
  });

  test('環境変数 SORA_MCP_MAX_SESSIONS が上限になり、コンストラクタ引数が優先される', async () => {
    process.env.SORA_MCP_MAX_SESSIONS = '1';
    const fromEnv = newManager({ minIdleBeforeEvictMs: 60_000 });
    expect((await initialize(fromEnv)).status).toBe(200);
    expect((await initialize(fromEnv)).status).toBe(503);

    const explicit = newManager({ maxSessions: 2, minIdleBeforeEvictMs: 60_000 });
    expect((await initialize(explicit)).status).toBe(200);
    expect((await initialize(explicit)).status).toBe(200);
    expect((await initialize(explicit)).status).toBe(503);
  });
});

describe('MCP セッション数の上限', () => {
  test('直近まで使われていたセッションで満杯なら、新しい initialize は 503 と Retry-After で断り、既存は守る', async () => {
    const manager = newManager({ maxSessions: 2, minIdleBeforeEvictMs: 60_000 });
    const a = await initialize(manager);
    const b = await initialize(manager);
    expect([a.status, b.status]).toEqual([200, 200]);

    const c = await initialize(manager);
    expect(c.status).toBe(503);
    expect(c.sessionId).toBeNull();
    expect(c.retryAfter).toBe('5');
    expect(manager.getActiveSessionCount()).toBe(2);
    expect(await ping(manager, a.sessionId!)).toBe(200);
    expect(await ping(manager, b.sessionId!)).toBe(200);
    expect(getSecurityMetrics().sora_mcp_session_rejected_total).toBe(1);
  });

  test('しばらく使われていないセッションがあれば、最も古く使われたものを退避して受け入れる', async () => {
    const manager = newManager({ maxSessions: 2, minIdleBeforeEvictMs: 30 });
    const a = await initialize(manager);
    const b = await initialize(manager);
    await sleep(50);
    expect(await ping(manager, a.sessionId!)).toBe(200); // a を使う → 最も古く使われたのは b

    await sleep(50);
    const c = await initialize(manager);
    expect(c.status).toBe(200);
    expect(manager.getActiveSessionCount()).toBe(2);
    expect(await ping(manager, b.sessionId!)).toBe(404); // b が退避された
    expect(await ping(manager, a.sessionId!)).toBe(200);
    expect(await ping(manager, c.sessionId!)).toBe(200);
    expect(getSecurityMetrics().sora_mcp_session_evicted_total).toBe(1);
  });

  test('initialize を大量に送っても保持数は上限を超えない（並行でも）', async () => {
    const manager = newManager({ maxSessions: 3, minIdleBeforeEvictMs: 0 });
    const results = await Promise.all(Array.from({ length: 12 }, () => initialize(manager)));
    for (const r of results) expect([200, 503]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(manager.getActiveSessionCount()).toBeLessThanOrEqual(3);

    for (let i = 0; i < 10; i++) await initialize(manager);
    expect(manager.getActiveSessionCount()).toBeLessThanOrEqual(3);
  });

  test('DELETE で閉じたセッションの枠は、すぐ次の接続に使える', async () => {
    const manager = newManager({ maxSessions: 1, minIdleBeforeEvictMs: 60_000 });
    const a = await initialize(manager);
    expect((await initialize(manager)).status).toBe(503);

    const del = await manager.handleRequest(new Request('http://localhost/mcp', {
      method: 'DELETE', headers: { ...rpcHeaders, 'mcp-session-id': a.sessionId! },
    }));
    expect(del.status).toBe(200);
    expect(manager.getActiveSessionCount()).toBe(0);
    expect((await initialize(manager)).status).toBe(200);
  });

  test('上限に達していても、既存セッションへのリクエスト・セッション無しの単発リクエストは影響を受けない', async () => {
    const manager = newManager({ maxSessions: 1, minIdleBeforeEvictMs: 60_000 });
    const a = await initialize(manager);
    expect(await ping(manager, a.sessionId!)).toBe(200);

    const stateless = await manager.handleRequest(new Request('http://localhost/mcp', {
      method: 'POST', headers: rpcHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    }));
    expect(stateless.status).toBe(200);
    expect(manager.getActiveSessionCount()).toBe(1);
  });
});
