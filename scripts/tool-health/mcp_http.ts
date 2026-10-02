// Minimal Streamable-HTTP MCP client over fetch (shared by smoke test and live runner).
export interface McpHttpSession {
  baseUrl: string;
  sessionId?: string;
  extraHeaders?: Record<string, string>;
}

export function parseJsonRpcPayload(rawText: string, id?: number | string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    // SSE streams may carry several data: messages (progress + final result).
    // Prefer the message matching our id, else the last one carrying a result.
    const messages: unknown[] = [];
    for (const line of rawText.split('\n')) {
      const trimmed = line.startsWith('data: ') ? line.replace(/^data:\s*/, '') : '';
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed));
      } catch {}
    }
    if (id !== undefined) {
      const match = messages.find((m) => (m as { id?: unknown })?.id === id);
      if (match !== undefined) return match;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as { result?: unknown })?.result !== undefined) return messages[i];
    }
    if (messages.length > 0) return messages[messages.length - 1];
    throw new Error('unparseable MCP response');
  }
}

export async function mcpPost(
  session: McpHttpSession,
  payload: unknown,
  timeoutMs: number,
  method = 'POST',
): Promise<{ status: number; headers: Headers; body: unknown; text: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(session.sessionId ? { 'mcp-session-id': session.sessionId } : {}),
    ...(session.extraHeaders ?? {}),
  };
  const res = await fetch(session.baseUrl + '/mcp', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = parseJsonRpcPayload(text, (payload as { id?: number | string })?.id);
    } catch {
      body = null;
    }
  }
  return { status: res.status, headers: res.headers, body, text };
}

export async function mcpInitialize(session: McpHttpSession, timeoutMs: number): Promise<string> {
  const res = await mcpPost(session, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tool-health', version: '1.0.0' } },
  }, timeoutMs);
  if (res.status !== 200) throw new Error('initialize failed with HTTP ' + res.status);
  const sid = res.headers.get('mcp-session-id');
  if (!sid) throw new Error('initialize returned no session id');
  session.sessionId = sid;
  await mcpPost(session, { jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs);
  return sid;
}

export async function mcpCall(session: McpHttpSession, name: string, args: Record<string, unknown>, timeoutMs: number, id = 2): Promise<unknown> {
  const res = await mcpPost(session, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, timeoutMs);
  if (res.status !== 200) throw new Error(`tools/call ${name} HTTP ${res.status}`);
  return res.body;
}

export async function mcpClose(session: McpHttpSession, timeoutMs: number): Promise<void> {
  if (!session.sessionId) return;
  await fetch(session.baseUrl + '/mcp', {
    method: 'DELETE',
    headers: { 'mcp-session-id': session.sessionId, ...(session.extraHeaders ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => {});
  session.sessionId = undefined;
}
