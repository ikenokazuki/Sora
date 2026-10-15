import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tenantIdForApiKey } from './security/tenant_context.js';
import { readFileSync } from 'node:fs';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { sanitizeJsonSchemaForGemini } from './schema_sanitizer.js';
import { SORA_VERSION } from './types.js';
import { incrementSecurityCounter } from './security/metrics.js';
import { isModuleActive, type McpServerOptions, type McpSessionState, type ToolCatalogEntry, type ToolRegistrationContext } from './mcp/registry.js';
import { buildSoraMcpInstructions } from './mcp/instructions.js';
import { registerToolSearch } from './mcp/tools_search.js';
import { registerWebTools } from './mcp/tools_web.js';
import { registerBrowserTools } from './mcp/tools_browser.js';
import { registerYahooTools } from './mcp/tools_yahoo.js';
import { registerLifeTools } from './mcp/tools_life.js';
import { registerDisasterTools } from './mcp/tools_disaster.js';
import { registerWatchTools } from './mcp/tools_watch.js';
import { registerMusicTools } from './mcp/tools_music.js';
import { registerGovTools } from './mcp/tools_gov.js';
import { registerTradeTools } from './mcp/tools_trade.js';
import { registerMediaTools } from './mcp/tools_media.js';
import { registerIntelTools } from './mcp/tools_intel.js';

export {
  clearSharedActivatedTools,
  isModuleActive,
  registerStructuredTool,
  registerTool,
  searchCatalog,
  SHARED_ACTIVATED_TOOLS,
} from './mcp/registry.js';
export type { GhostFetchModule, McpServerOptions, McpSessionState, SoraModule, ToolCatalogEntry } from './mcp/registry.js';
export { buildSoraMcpInstructions, SORA_MCP_INSTRUCTIONS } from './mcp/instructions.js';

/** createMcpServer が作ったサーバーのツール台帳（クライアント生成などの読み取り用）。 */
const TOOL_CATALOGS = new WeakMap<McpServer, Map<string, ToolCatalogEntry>>();
export function toolCatalogOf(server: McpServer): ReadonlyMap<string, ToolCatalogEntry> {
  return TOOL_CATALOGS.get(server) ?? new Map();
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const instructions = buildSoraMcpInstructions(options?.modules);
  const mcpServer = new McpServer(
    {
      name: 'Sora',
      version: SORA_VERSION,
    },
    {
      instructions,
    },
  );

  const toolCatalog = new Map<string, ToolCatalogEntry>();
  // Session-scoped activation: search_tools enables tools for this server
  // instance only. A caller-provided McpSessionState stays live-linked.
  const sessionActivated: Set<string> =
    options?.sessionState?.activatedTools ?? new Set<string>();
  if (options?.sessionState) {
    options.sessionState.activatedTools = sessionActivated;
  }
  const serverTenantId = options?.sessionState?.tenantId ?? 'legacy';
  const isDeferEnabled = options?.deferTools ?? (process.env.SORA_DEFER_TOOLS !== 'false');
  const deferredDefault = !isDeferEnabled;

  const shouldEnableWeb = isModuleActive('web', options?.modules);
  const shouldEnableBrowser = isModuleActive('browser', options?.modules);
  const shouldEnableYahoo = isModuleActive('yahoo', options?.modules);
  const shouldEnableLife = isModuleActive('life', options?.modules);
  const shouldEnableDisaster = isModuleActive('disaster', options?.modules);
  const shouldEnableWatch = isModuleActive('watch', options?.modules);
  const shouldEnableMusic = isModuleActive('music', options?.modules);
  const shouldEnableGov = isModuleActive('gov', options?.modules);
  const shouldEnableTrade = isModuleActive('trade', options?.modules);
  const shouldEnableMedia = isModuleActive('media', options?.modules) || isModuleActive('web', options?.modules);
  const shouldEnableIntel = isModuleActive('intel', options?.modules);

  const context: ToolRegistrationContext = { mcpServer, toolCatalog, sessionActivated, deferredDefault, options, serverTenantId };
  if (shouldEnableWeb) registerWebTools(context);
  if (shouldEnableBrowser) registerBrowserTools(context);
  if (shouldEnableYahoo) registerYahooTools(context);
  if (shouldEnableLife) registerLifeTools(context);
  if (shouldEnableDisaster) registerDisasterTools(context);
  if (shouldEnableWatch) registerWatchTools(context);
  if (shouldEnableMusic) registerMusicTools(context);
  if (shouldEnableGov) registerGovTools(context);
  if (shouldEnableTrade) registerTradeTools(context);
  if (shouldEnableMedia) registerMediaTools(context);
  if (shouldEnableIntel) registerIntelTools(context);
  registerToolSearch(context, {web: shouldEnableWeb, browser: shouldEnableBrowser, yahoo: shouldEnableYahoo, life: shouldEnableLife, disaster: shouldEnableDisaster, watch: shouldEnableWatch, music: shouldEnableMusic, gov: shouldEnableGov, trade: shouldEnableTrade, media: shouldEnableMedia});

  // 深層調査スキルをMCPリソースとして配布する。接続した呼出元は
  // sora-skill://sora-deep-research を読むだけで手順を取得できる。
  try {
    const skillUrls = [
      new URL('../plugins/sora-deep-research/skills/sora-deep-research/SKILL.md', import.meta.url),
      new URL('../docs/skills/sora-research/SKILL.md', import.meta.url),
    ];
    let skillText: string | null = null;
    for (const u of skillUrls) {
      try {
        const text = readFileSync(u, 'utf8');
        if (text.trim()) {
          skillText = text;
          break;
        }
      } catch {}
    }
    if (skillText) {
      const text = skillText;
      mcpServer.resource(
        'sora-deep-research-skill',
        'sora-skill://sora-deep-research',
        { mimeType: 'text/markdown' },
        async (uri) => ({
          contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
        }),
      );
    }
  } catch {}

  TOOL_CATALOGS.set(mcpServer, toolCatalog);
  return mcpServer;
}

export interface McpSessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastActive: number;
  state: McpSessionState;
}

/**
 * MCP Streamable HTTP 仕様準拠のマルチセッションマネージャー
 * 各クライアント接続ごとに独立したセッションとトランスポートを管理し、
 * セッションIDに基づくルーティング、放置セッションの自動回収（TTL）、
 * 並行リクエストの安全なディスパッチを行います。
 */
/** Tenant identity for MCP session ownership and tenant-scoped tool handlers. */
export function mcpTenantFromRequest(req: Request): string {
  try {
    const auth = req.headers.get('authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return tenantIdForApiKey(m[1].trim());
    const key = req.headers.get('x-api-key');
    if (key?.trim()) return tenantIdForApiKey(key.trim());
  } catch {}
  return 'legacy';
}

/** 同時に保持する MCP セッション数の既定上限。1 セッションは JS ヒープ約 3〜4MB を保持する（50 ツールの定義を持つため） */
export const DEFAULT_MAX_MCP_SESSIONS = 100;
/** 上限に達したとき、直近これだけの間に使われたセッションは退避せず守る（initialize の連打で稼働中の接続を追い出させない） */
export const DEFAULT_MCP_MIN_IDLE_BEFORE_EVICT_MS = 30_000;

/** SORA_MCP_MAX_SESSIONS の解釈。正の整数ならそれ、未設定や不正な値は既定値。 */
export function resolveMaxMcpSessions(raw: string | undefined): number {
  const n = raw && /^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : NaN;
  return n > 0 ? n : DEFAULT_MAX_MCP_SESSIONS;
}

export class McpSessionManager {
  private sessions = new Map<string, McpSessionEntry>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly minIdleBeforeEvictMs: number;
  /** initialize の処理中でまだ sessions に載っていない数。並行する initialize が上限を超えないよう予約として数える */
  private pendingInitializations = 0;

  constructor(options?: { sessionTtlMs?: number; maxSessions?: number; minIdleBeforeEvictMs?: number }) {
    this.sessionTtlMs = options?.sessionTtlMs ?? 60 * 60 * 1000; // 1時間 TTL
    this.maxSessions =
      options?.maxSessions !== undefined && Number.isInteger(options.maxSessions) && options.maxSessions > 0
        ? options.maxSessions
        : resolveMaxMcpSessions(process.env.SORA_MCP_MAX_SESSIONS);
    this.minIdleBeforeEvictMs = options?.minIdleBeforeEvictMs ?? DEFAULT_MCP_MIN_IDLE_BEFORE_EVICT_MS;
    this.cleanupInterval = setInterval(() => this.cleanupStaleSessions(), 5 * 60 * 1000);
    if (typeof this.cleanupInterval === 'object' && 'unref' in this.cleanupInterval) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * 新しいセッションを 1 つ受け入れる余地を作る。登録済み＋作成中が上限に達していたら、
   * 最も長く使われていないセッションを閉じて空ける。ただし直近まで使われていたものは守る。
   * 空けられなければ false（呼び出し側が 503 を返す）。
   */
  private makeRoomForSession(): boolean {
    while (this.sessions.size + this.pendingInitializations >= this.maxSessions) {
      let oldestId: string | undefined;
      let oldestActive = Infinity;
      for (const [id, session] of this.sessions) {
        if (session.lastActive < oldestActive) {
          oldestActive = session.lastActive;
          oldestId = id;
        }
      }
      if (oldestId === undefined || Date.now() - oldestActive < this.minIdleBeforeEvictMs) return false;
      this.sessions.get(oldestId)?.transport.close().catch(() => {});
      this.sessions.delete(oldestId);
      incrementSecurityCounter('sora_mcp_session_evicted_total');
    }
    return true;
  }

  /** Route HTTP requests to their session without sharing activation state. */
  public async handleRequest(req: Request, options?: { parsedBody?: unknown }): Promise<Response> {
    const sessionId = req.headers.get('mcp-session-id');
    const tenantId = mcpTenantFromRequest(req);

    // 1. 既存セッションは作成時と同じテナントからのみ利用できる。
    if (sessionId) {
      const entry = this.sessions.get(sessionId);
      if (!entry || entry.state.tenantId !== tenantId) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      }
      entry.lastActive = Date.now();
      const res = await entry.transport.handleRequest(req, options);
      return sanitizeMcpResponse(res);
    }

    // 2. セッション新規作成 (initialize リクエスト時)
    let parsedBody = options?.parsedBody;
    if (parsedBody === undefined && req.method === 'POST') {
      try {
        parsedBody = await req.clone().json();
      } catch {
        // invalid json
      }
    }

    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    const isInit = messages.some((m) => m && m.method === 'initialize');

    if (isInit) {
      // セッションは数 MB を保持するので、無制限に作らせない（未認証の連続 initialize によるメモリ枯渇の防止）
      if (!this.makeRoomForSession()) {
        incrementSecurityCounter('sora_mcp_session_rejected_total');
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Too many active MCP sessions. Retry later.' },
            id: null,
          }),
          { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } },
        );
      }
      this.pendingInitializations++;
      try {
        const state: McpSessionState = { activatedTools: new Set<string>(), tenantId };
        const server = createMcpServer({ sessionState: state });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newSessionId) => {
            this.sessions.set(newSessionId, {
              server,
              transport,
              lastActive: Date.now(),
              state,
            });
          },
          onsessionclosed: (closedSessionId) => {
            this.sessions.delete(closedSessionId);
          },
        });

        await server.connect(transport);
        const res = await transport.handleRequest(req, { parsedBody });
        return sanitizeMcpResponse(res);
      } finally {
        this.pendingInitializations--;
      }
    }

    // 3. 単発リクエストでは明示的に呼ばれたツールだけをその要求内で有効化する。
    // tools/list と search_tools の結果は別の要求や接続へ持ち越さない。
    const activatedTools = new Set<string>();
    for (const message of messages) {
      if (message?.method === 'tools/call' && typeof message.params?.name === 'string') {
        activatedTools.add(message.params.name.replace(/^default\./, ''));
      }
    }
    const statelessServer = createMcpServer({ sessionState: { activatedTools, tenantId } });
    const statelessTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await statelessServer.connect(statelessTransport);
    const res = await statelessTransport.handleRequest(req, { parsedBody });
    return sanitizeMcpResponse(res);
  }

  private cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActive > this.sessionTtlMs) {
        session.transport.close().catch(() => {});
        this.sessions.delete(id);
      }
    }
  }

  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  public clearAllSessions() {
    for (const [, session] of this.sessions.entries()) {
      session.transport.close().catch(() => {});
    }
    this.sessions.clear();
  }
}

/**
 * tools/list の1ツールを整形する。inputSchema は Gemini 互換化、outputSchema は既定で除外。
 * outputSchema は国別インテリジェンス2ツールだけで約160KBあり、ホストがモデルへ丸ごと渡すと
 * プロンプト長とレイテンシを押し上げる。tools/call 側の structuredContent 検証は影響を受けない。
 * 旧挙動が必要なクライアント向けに SORA_TOOL_OUTPUT_SCHEMA=true で復活できる。
 */
function slimListedTool(t: any) {
  const { outputSchema, ...rest } = t;
  return {
    ...rest,
    ...(process.env.SORA_TOOL_OUTPUT_SCHEMA === 'true' && outputSchema ? { outputSchema } : {}),
    inputSchema: sanitizeJsonSchemaForGemini(t.inputSchema),
  };
}

/** JSON-RPC メッセージが tools/list の結果なら、各ツールを slimListedTool で整形して返す（それ以外はそのまま）。 */
export function slimToolsListMessage<T>(message: T): T {
  const m: any = message;
  if (!m || !Array.isArray(m.result?.tools)) return message;
  return { ...m, result: { ...m.result, tools: m.result.tools.map(slimListedTool) } };
}

/**
 * MCP レスポンスに含まれる tools/list の inputSchema を Gemini / Vertex AI 互換に自動サニタイズ
 */
export async function sanitizeMcpResponse(res: Response): Promise<Response> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const cloned = res.clone();
      const body: any = await cloned.json();
      let modified = false;

      const sanitizeToolList = (result: any) => {
        if (result && Array.isArray(result.tools)) {
          result.tools = result.tools.map(slimListedTool);
          return true;
        }
        return false;
      };

      if (body) {
        if (Array.isArray(body)) {
          for (const item of body) {
            if (item?.result?.tools) {
              sanitizeToolList(item.result);
              modified = true;
            }
          }
        } else if (body.result?.tools) {
          sanitizeToolList(body.result);
          modified = true;
        }
      }

      if (modified) {
        const headers = new Headers(res.headers);
        const newBody = JSON.stringify(body);
        headers.set('content-length', String(Buffer.byteLength(newBody)));
        return new Response(newBody, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
    } catch {
      // JSON パース失敗時は元のレスポンスを返却
    }
  } else if (contentType.includes('text/event-stream') && res.body) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const transformStream = new TransformStream({
      start(controller) {
        // 15秒ごとに SSE keep-alive コメントを送信して中間プロキシやクライアントの早期切断を防止
        pingTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': keep-alive\n\n'));
          } catch {
            if (pingTimer) clearInterval(pingTimer);
          }
        }, 15000);
        if (typeof pingTimer === 'object' && pingTimer && 'unref' in pingTimer) {
          pingTimer.unref();
        }
      },
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            try {
              const parsed = JSON.parse(dataStr);
              let changed = false;
              if (parsed?.result?.tools && Array.isArray(parsed.result.tools)) {
                parsed.result.tools = parsed.result.tools.map(slimListedTool);
                changed = true;
              }
              if (changed) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n`));
                continue;
              }
            } catch {}
          }
          controller.enqueue(encoder.encode(line + '\n'));
        }
      },
      flush(controller) {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (buffer.length > 0) {
          controller.enqueue(encoder.encode(buffer));
        }
      },
    });

    return new Response(res.body.pipeThrough(transformStream), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  return res;
}
