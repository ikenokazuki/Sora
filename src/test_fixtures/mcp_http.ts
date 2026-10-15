/** 実際のクライアントと同じ HTTP の経路（POST /mcp）で MCP を呼ぶ補助。`app.request` を渡す。 */
export type AppRequest = (path: string, init?: RequestInit) => Response | Promise<Response>;

export interface McpHttpResult {
  /** 応答の JSON-RPC メッセージ。 */
  message: any;
  /** 応答本文の文字数（クライアントが受け取る量）。 */
  chars: number;
}

export interface McpHttpSession {
  rpc(method: string, params?: unknown): Promise<McpHttpResult>;
  /** initialize の結果（instructions を含む）。 */
  initialized: McpHttpResult;
}

function parseBody(text: string): any {
  if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
  const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).pop();
  return data ? JSON.parse(data) : {};
}

/** セッションを開く（initialize まで済ませる）。 */
export async function openMcpSession(request: AppRequest): Promise<McpHttpSession> {
  let session: string | null = null;
  let nextId = 1;
  const rpc = async (method: string, params: unknown = {}): Promise<McpHttpResult> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (session) headers['mcp-session-id'] = session;
    const res = await request('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) });
    const text = await res.text();
    session = res.headers.get('mcp-session-id') ?? session;
    return { message: parseBody(text), chars: text.length };
  };
  const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-probe', version: '1' } });
  return { rpc, initialized };
}
