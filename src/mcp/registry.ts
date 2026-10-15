import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { XPostDetailProvider } from '../services/x_detail.js';

export type SoraModule = 'web' | 'browser' | 'yahoo' | 'life' | 'disaster' | 'watch' | 'music' | 'gov' | 'trade' | 'media' | 'intel';
export type GhostFetchModule = SoraModule; // backward-compatibility alias

export interface McpServerOptions {
  modules?: (SoraModule | 'all')[];
  deferTools?: boolean;
  /** Session-scoped activation state. A fresh set is created when omitted. */
  sessionState?: McpSessionState;
  intelResearch?: (request: unknown) => Promise<unknown>;
  /** Test seam for the X post fetcher. Production uses the shared singleton. */
  xDetailProvider?: XPostDetailProvider;
}

export interface ToolCatalogEntry {
  name: string;
  category: SoraModule;
  description: string;
  keywords: string[];
  handle: RegisteredTool;
  compatibilityHandle?: RegisteredTool;
}

/**
 * @deprecated Process-global activation leaks across MCP sessions/tenants.
 * Kept for compatibility only; core code uses per-session McpSessionState.
 */
export const SHARED_ACTIVATED_TOOLS = new Set<string>();

/** Per-session dynamic tool activation (RFC P1-SEC-06). */
export interface McpSessionState {
  activatedTools: Set<string>;
  tenantId?: string;
}

/** MCP の応答 JSON。字下げはトークンを約1割増やすので、verbose 指定時だけ付ける（search_deep・search_realtime と同じ）。 */
export function toolJson(value: unknown, verbose?: boolean): string {
  return verbose === true ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

export function clearSharedActivatedTools(): void {
  SHARED_ACTIVATED_TOOLS.clear();
}

/**
 * ツール登録用ヘルパー。
 * defaultEnabled が false で、かつ過去に search_tools で動的有効化されていない場合は
 * handle.disable() を呼び出して初期 tools/list に露出しないようにし、カタログにメタ情報を保管します。
 */
export function registerTool<Args extends ZodRawShapeCompat>(
  mcpServer: McpServer,
  toolCatalog: Map<string, ToolCatalogEntry>,
  sessionActivated: Set<string> = SHARED_ACTIVATED_TOOLS,
  name: string,
  category: SoraModule,
  description: string,
  schema: Args,
  handler: ToolCallback<Args>,
  opts: { defaultEnabled: boolean; keywords?: string[] },
): RegisteredTool {
  const handle = mcpServer.tool(name, description, schema, handler);
  const isEnabled = opts.defaultEnabled || sessionActivated.has(name);
  if (!isEnabled) {
    handle.disable();
  }

  // LibreChat may look up the model-emitted `default.` name verbatim before dispatch.
  // Publish that alias only alongside an activated deferred tool, keeping startup lean.
  const compatibilityHandle = !opts.defaultEnabled
    ? mcpServer.tool(`default.${name}`, description, schema, handler)
    : undefined;
  if (!isEnabled) compatibilityHandle?.disable();

  toolCatalog.set(name, {
    name,
    category,
    description,
    keywords: opts.keywords ?? [],
    handle,
    compatibilityHandle,
  });
  return handle;
}

export function registerStructuredTool<Args extends ZodRawShapeCompat>(mcpServer: McpServer, toolCatalog: Map<string, ToolCatalogEntry>, sessionActivated: Set<string> = SHARED_ACTIVATED_TOOLS, name: string, category: SoraModule, description: string, schema: Args, outputSchema: AnySchema, handler: ToolCallback<Args>, opts: { defaultEnabled: boolean; keywords?: string[] }): RegisteredTool {
  const config = { description, inputSchema: schema, outputSchema, annotations: { readOnlyHint: true } };
  const handle = mcpServer.registerTool(name, config, handler as never);
  const isEnabled = opts.defaultEnabled || sessionActivated.has(name);
  if (!isEnabled) {
    handle.disable();
  }
  const compatibilityHandle = !opts.defaultEnabled ? mcpServer.registerTool('default.' + name, config, handler as never) : undefined;
  if (!isEnabled) compatibilityHandle?.disable();
  toolCatalog.set(name, { name, category, description, keywords: opts.keywords ?? [], handle, compatibilityHandle });
  return handle;
}

const SEARCH_STOP_WORDS = new Set([
  '検索', 'けんさく', 'けんさ', '探す', 'さがす', '調べる', 'しらべる', '調査',
  'ツール', 'つーる', 'tool', 'tools', 'search', 'find', 'get',
  'の', 'を', 'に', 'で', 'と', 'は', 'が', 'も',
]);

/**
 * ツールカタログからキーワードにマッチするエントリを検索します。
 * 空白区切りの複数キーワードに対応し、ストップワード（検索、ツール等）を除去します。
 * 数値スコアではなく、一致の種類を優先順位として扱います。
 */
export function searchCatalog(
  toolCatalog: Map<string, ToolCatalogEntry>,
  query: string,
): ToolCatalogEntry[] {
  const normalizedQuery = query.trim().toLowerCase().replace(/^default\./, '');
  if (!normalizedQuery) return [];

  const rawTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  const meaningfulTerms = rawTerms.filter((t) => !SEARCH_STOP_WORDS.has(t));
  const terms = meaningfulTerms.length > 0 ? meaningfulTerms : rawTerms;

  // 明示的なカテゴリ指定は、そのカテゴリ全体を公開する契約を維持する。
  const categoryMatches = [...toolCatalog.values()].filter(
    (entry) => entry.category.toLowerCase() === normalizedQuery,
  );
  if (categoryMatches.length > 0) return categoryMatches;

  const entries = [...toolCatalog.values()];
  const valuesFor = (entry: ToolCatalogEntry) => {
    const nameLower = entry.name.toLowerCase();
    return {
      name: nameLower,
      category: entry.category.toLowerCase(),
      description: entry.description.toLowerCase(),
      keywords: entry.keywords.map((keyword) => keyword.toLowerCase()),
    };
  };
  const matchesTerm = (entry: ToolCatalogEntry, term: string) => {
    const values = valuesFor(entry);
    return values.name.includes(term)
      || values.category.includes(term)
      || values.description.includes(term)
      || values.keywords.some(
        (keyword) => keyword.includes(term) || ([...keyword].length >= 2 && term.includes(keyword)),
      );
  };

  const tiers = [
    entries.filter((entry) => {
      const name = entry.name.toLowerCase();
      return name === normalizedQuery
        || name === `search_${normalizedQuery}`
        || name === `get_${normalizedQuery}`;
    }),
    entries.filter((entry) => entry.keywords.some(
      (keyword) => keyword.toLowerCase() === normalizedQuery,
    )),
    entries.filter((entry) => terms.every((term) => matchesTerm(entry, term))),
    entries.filter((entry) => terms.some((term) => matchesTerm(entry, term))),
  ];

  return (tiers.find((matches) => matches.length > 0) ?? []).slice(0, 3);
}

/** モジュールが有効化されているかを判定 */
export function isModuleActive(mod: SoraModule, explicitModules?: (SoraModule | 'all')[]): boolean {
  if (explicitModules && explicitModules.length > 0) {
    if (explicitModules.includes('all')) return true;
    return explicitModules.includes(mod);
  }
  const envVal = process.env.ENABLED_MODULES?.toLowerCase().trim();
  if (!envVal || envVal === 'all' || envVal === '*') return true;
  const activeList = envVal.split(',').map((s) => s.trim());
  return activeList.includes(mod) || activeList.includes('all');
}

/** 各モジュールのツール登録関数に渡す、サーバー単位の共通状態。 */
export interface ToolRegistrationContext {
  mcpServer: McpServer;
  toolCatalog: Map<string, ToolCatalogEntry>;
  sessionActivated: Set<string>;
  deferredDefault: boolean;
  options?: McpServerOptions;
  serverTenantId: string;
}

