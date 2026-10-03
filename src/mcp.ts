import { McpServer, type RegisteredTool, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tenantIdForApiKey } from './security/tenant_context.js';
import { readFileSync } from 'node:fs';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  scrapeUrl,
  scrapeBatchUrls,
  callYahooMcp,
  integratedSearch,
  mapSiteUrl,
  crawlSiteUrl,
  fetchRealtimeTrends,
  normalizeRealtimeItem,
  searchYahooRealtime,
  filterByDomains,
  searchYahooImage,
  searchYahooVideo,
  searchYahooNews,
  searchYahooChiebukuro,
  getSuggestedKeywords,
  searchTransitRoute,
  fetchWeatherForecast,
  executeBrowserActions,
  fetchWeatherWarnings,
  fetchRecentEarthquakes,
  fetchRoadTraffic,
  registerWatchTarget,
  checkWatchTarget,
  checkAllWatchTargets,
  listWatchTargets,
  deleteWatchTarget,
  searchMusic,
  searchSong,
  searchArtist,
  searchLaws,
  getLawData,
  searchDietMinutes,
  fetchElevationAndCoordinates,
  fetchFlightStatus,
  checkCpscCertificate,
  checkFdaRegulated,
  verifyHtsCode,
  predictHtsCode,
  checkProductCompliance,
  inspectImage,
  trackPackage,
} from './scraper.js';
import { formatCompactScrapeResult } from './response_cleaner.js';
import { formatCompactRealtimeResponse } from './search_compact.js';
import { SEARCH_WEB_INPUT_SHAPE, searchWebWithFormats } from './search_web_formats.js';
import { defaultXDetailProvider, fetchXPostDetail, type XPostDetailProvider } from './services/x_detail.js';
import { hotelService, type HotelService } from './services/hotels/index.js';
import { HotelSearchInputSchema, type HotelSearchResult } from './services/hotels/types.js';
import { IntegratedSearchResponseModeSchema, serializeIntegratedSearchMcpResponse } from './integrated_search_host_response.js';
import { sanitizeJsonSchemaForGemini } from './schema_sanitizer.js';
import { SORA_VERSION, ScrapeFormatSchema, HighlightAlgorithmSchema, DEFAULT_HIGHLIGHT_ALGORITHM, INTEGRATED_SEARCH_INPUT_SHAPE, TRANSIT_ROUTE_INPUT_SHAPE, SCRAPE_BATCH_INPUT_SHAPE, BrowserActionStepSchema, EarthquakeScaleSchema, ChiebukuroStatusSchema } from './types.js';
import { CountryContextReportSchema, IntelSocialInputSchema, COUNTRY_INTEL_TOPICS, SocialPlatformSchema, type CountryContextReport } from './services/country_intel/types.js';
import { ContextUpdatesSchema, EvidencePageSchema } from './services/country_intel/detail.js';

export type SoraModule = 'web' | 'browser' | 'yahoo' | 'life' | 'disaster' | 'watch' | 'music' | 'gov' | 'trade' | 'media' | 'intel';
export type GhostFetchModule = SoraModule; // backward-compatibility alias

export interface McpServerOptions {
  modules?: (SoraModule | 'all')[];
  deferTools?: boolean;
  /** Session-scoped activation state. A fresh set is created when omitted. */
  sessionState?: McpSessionState;
  intelResearch?: (request: unknown) => Promise<unknown>;
  /** Test seam for the experimental hotel search. Production uses the shared singleton. */
  hotelService?: HotelService;
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

export function buildSoraMcpInstructions(activeModules?: (SoraModule | 'all')[]): string {
  const hasMod = (mod: SoraModule) => isModuleActive(mod, activeModules);

  const hasWeb = hasMod('web');
  const hasBrowser = hasMod('browser');
  const hasYahoo = hasMod('yahoo');
  const hasLife = hasMod('life');
  const hasDisaster = hasMod('disaster');
  const hasMusic = hasMod('music');
  const hasGov = hasMod('gov');
  const hasTrade = hasMod('trade');
  const hasIntel = hasMod('intel');

  const lines: string[] = [
    '# Sora MCP Server - AI Interaction & Tool Routing Guidelines',
    '',
    '## 1. Zero-Refusal & Active Investigation Policy',
    '- **NEVER refuse to answer or give up by claiming "a specific tool is not available"** (e.g. "I have no tool for live concert schedules, business hours, release dates, etc.").',
  ];

  if (hasWeb) {
    lines.push(
      '- If a query asks for factual, real-time, time-sensitive, or external information not covered by a Tier 1 specialized domain tool, **you MUST ALWAYS use the Universal Search tools (`search_deep` or `search_web`)** to actively investigate official websites, announcements, schedules, and documents from the web.',
    );
  } else {
    lines.push(
      '- If a query asks for factual, real-time, time-sensitive, or external information, actively investigate using the currently available tools and modules without inventing data.',
    );
  }

  lines.push(
    '',
    '## 2. Dynamic Tool Discovery Protocol',
    '- **Visible Tools**: If the required specialized tool is visible in `tools/list`, **call it directly without calling `search_tools`**.',
    '- **Hidden / Deferred Tools**: If a required specialized tool is not visible in `tools/list`, call `search_tools` with relevant keywords to search and dynamically activate it in the current session, then invoke the activated tool.',
    '- **Unavailable Modules**: If `search_tools` cannot find the requested tool, the server module may be disabled or unavailable by server configuration. In this case, use an appropriate available safe fallback without inventing data.',
  );

  if (hasWeb || hasBrowser) {
    lines.push('', '## 3. Web Tool Overlap & Primary Boundaries');
    if (hasWeb) {
      lines.push(
        '- **`search_web`**: URL / snippet discovery (fast & lightweight candidate search by default) + optional same-call extraction via `formats: ["markdown"]`.',
        '- **`search_deep`**: Universal deep investigation combining Web search + full-article scraping + realtime X + Deep Evidence Rerank.',
        '- **`scrape` / `scrape_batch`**: Known URL content extraction (single or batch) for deep reading of specific pages/documents.',
        '- **`search_social_posts` / `fetch_social_post`**: Public SNS posts (Weibo keyword-latest search; Threads/Instagram/Facebook public-post discovery plus body). X posts are out of scope here; use `search_realtime`.' ,
        '- **`crawl_site`**: Same-site multi-page traversal for documentation or full-site knowledge collection.',
      );
    }
    if (hasBrowser) {
      lines.push(
        '- **`browser_action`**: Interactive browser operation requiring clicks, form fills, JS execution, or complex dynamic rendering.',
      );
    }
  }

  lines.push('', '## 4. Two-Tier Tool Decision Framework');

  const tier1Directives: string[] = [];
  if (hasTrade) {
    tier1Directives.push(
      "1. US Export Compliance & Tariffs (HTS classification, CPSC certificates & 2026 eFiling mandate, FDA PGA flags FD1-FD4): Use 'trade' tools (check_product_compliance [CORE], predict_hts_code, check_cpsc_certificate, check_fda_regulated, verify_hts_code).\n   - CRITICAL HTS RULE: When classifying, estimating, or predicting HTS codes for a product, invoke 'check_product_compliance' with 'htsCode' OMITTED (undefined). NEVER inject or invent your own guessed HTS code into 'htsCode'! Sora's official USITC semantic engine automatically determines the true 10-digit HTS code. You may ONLY supply 'htsCode' if the user explicitly provided a specific HTS code in their query.",
    );
  }
  if (hasGov) {
    tier1Directives.push(
      "2. Japanese Laws & Diet Minutes (Official e-Gov API v2, National Diet Library minutes): Use 'gov' tools (search_laws [CORE], get_law_text, search_diet_minutes).",
    );
  }
  if (hasLife) {
    tier1Directives.push(
      "3. Japan Weather, Domestic Transit & Flights (Japan Meteorological Agency direct CDN, Yahoo! Transit IC fares & transfer routes, airport flight delays & cancellations): Use 'life' tools (get_weather [CORE], search_route [CORE], get_flight_status).",
    );
    tier1Directives.push(
      "4. Package & Delivery Tracking (Yamato Transport, Sagawa Express, Japan Post domestic & international/EMS, Seino, Fukuyama Transporting, UPS, FedEx, DHL Express delivery status & event history): 'track_package' is a deferred tool (hidden by default). You MUST first call 'search_tools' with query '荷物追跡' to dynamically activate it, then call 'track_package'.",
    );
  }
  if (hasDisaster) {
    tier1Directives.push(
      "5. Japan Disaster & Emergency Information (Japan Meteorological Agency weather warnings, P2P Earthquake, JARTIC road traffic, GSI elevation): Use 'disaster' tools (search_disaster_warnings [CORE], search_earthquake [CORE], search_road_traffic, get_elevation, search_poi).",
    );
  }
  if (hasYahoo) {
    tier1Directives.push(
      "6. Real-time Social Trends & Q&A (X/Twitter realtime posts, trending ranking, Yahoo! Chiebukuro): Use 'yahoo' tools (search_realtime [CORE], search_chiebukuro [CORE], search_trend, suggest_keywords).",
    );
  }
  if (hasMusic) {
    tier1Directives.push(
      "7. Music Metadata & Catalog (Official iTunes API metadata, previews, artwork): Use 'music' tools (search_song, search_artist, search_music).",
    );
  }
  if (hasIntel) {
    tier1Directives.push(
      "8. Country & Region Intelligence (evidence-backed country context, calendars, polls, Japan projection; no sentiment or risk scores): 'research_country_context' is a deferred tool (hidden by default). You MUST first call 'search_tools' with query '国地域' to dynamically activate it, then call 'research_country_context'.",
    );
  }

  if (tier1Directives.length > 0) {
    lines.push(
      '',
      '### Tier 1: Official Specialized Domain Directives (MANDATORY TOOL CALL)',
      'For queries strictly within the following domains, **NEVER answer using internal parametric knowledge, estimations, or general web search**. Follow the Dynamic Tool Discovery Protocol to invoke the corresponding specialized Sora MCP tool:',
      tier1Directives.join('\n'),
    );
  }

  if (hasWeb) {
    lines.push(
      '',
      '### Tier 2: Universal Web & Deep Search (ALL OTHER REAL-WORLD QUERIES)',
      'For ANY query requiring up-to-date facts, event dates, or external context outside Tier 1, invoke:',
      '- **`search_deep` (Primary Recommended Tool for Deep Web + X Investigation)**:',
      '  Combines web search + deep article scraping (Clean Markdown) + X/Twitter realtime pulse with Deep Evidence Rerank.',
      '  - **`responseMode: "evidence"`**: Use for focused or local fact confirmation (e.g. specific dates/times, lyricists, single spec details, localized proof). Returns query-selected highlights and omits redundant full Markdown when safe.',
      '  - **`responseMode: "full"` (Default)**: Use for whole-document summaries, exhaustive enumeration, broad comparison, or when page-wide context is needed.',
      '  - **Evidence Escalation**: If evidence is insufficient, ambiguous, or conflicting across sources, re-fetch with `responseMode: "full"` or specify `formats: ["markdown"]` (which preserves full Markdown even in evidence mode).',
      '  - *Token Efficiency*: Do not prune or reduce upstream acquisition/retrieval early to save tokens; rely on post-acquisition safe projection (evidence mode).',
      '- **`search_web` (Candidate Discovery & Optional 1-Call Enrichment)**:',
      '  - **URL / Snippet Discovery**: Call with `formats` omitted for lightweight candidate search without scraping.',
      '  - **Search + Content in One Call**: Specify `formats: ["markdown"]` (or `formats: ["markdown", "tables"]`) to scrape top results and attach requested formats in a single round-trip.',
      '  - *Note*: If snippets lack specific details, read the page using `scrape`. However, do NOT force a redundant second `scrape` call if `search_web` with `formats` already retrieved the necessary content.',
    );
  }

  lines.push(
    '',
    '## 5. Interactive Clarification Flow',
    "- When tools return 'inputCompleteness: \"partial\"' or 'clarifyingQuestions', do not guess missing parameters (e.g., material, target age). Promptly present the returned questions and impact explanation to the user to obtain accurate specifications.",
  );

  return lines.join('\n');
}

export const SORA_MCP_INSTRUCTIONS = buildSoraMcpInstructions();

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

  // =========================================================================
  // 🌐 Category 1: Core Web & Crawling (モジュール: 'web')
  // =========================================================================
  if (shouldEnableWeb) {
    // Tool 1: scrape (単一 URL / PDF スクレイプ) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'scrape',
      'web',
      '【単一URL・PDF本文抽出】指定した既知 URL の Web ページまたは PDF をスクレイピングし、記事本文をクリーンな Markdown に変換して返却します（既知URLの精読・本文抽出）。動的・SPA サイトの描画待機、イベント構造化、テーブル2D正規化に対応。候補URL探索は search_web / search_deep、サイト全体巡回は crawl_site、対話操作は browser_action を使用してください。',
      {
        url: z.string().url().describe('スクレイピング対象の完全な URL (http/https) (例: "https://example.com/article")'),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .optional()
          .describe('抽出する最大文字数 (デフォルト: 30000)').meta({ default: 30000 }),
        mode: z
          .enum(['auto', 'fast', 'browser'])
          .optional()
          .describe('スクレイプ動作モード: "auto" (スマート自動判定, デフォルト), "fast" (静的フェッチ最速限定), "browser" (Stealth Chromium JS完全実行)').meta({ default: 'auto' }),
        formats: z.array(ScrapeFormatSchema)
          .optional()
          .describe('取得するコンテンツ形式: "markdown", "html", "rawHtml", "links", "screenshot", "jsonLd", "images", "tables" (デフォルト: ["markdown"])').meta({ default: ['markdown'] }),
        fullPage: z
          .boolean()
          .optional()
          .default(true)
          .describe('スクリーンショット撮影時にページ最下部までフルページ撮影するか (デフォルト: true)'),
        fastOnly: z
          .boolean()
          .optional()
          .describe('【互換用】静的フェッチのみに限定するか (mode: "fast" と同等)'),
        renderJs: z
          .boolean()
          .optional()
          .describe('【互換用】Stealth Chromium で JS 完全実行するか (mode: "browser" と同等)'),
        extractHighlights: z
          .boolean()
          .optional()
          .describe('クエリに関連する重要文（ハイライト）を自動抽出して付与するか (省略時: query指定時はtrue、未指定時はfalse)'),
        onlyHighlights: z
          .boolean()
          .optional()
          .describe('抽出されたハイライトのみを本文 content として返し、ノイズ全文を削除するか (デフォルト: false)').meta({ default: false }),
        extractSummary: z
          .boolean()
          .optional()
          .describe('超高速な抽出型自動要約（TL;DR 上位重要文リスト）を生成して付与するか (デフォルト: false)').meta({ default: false }),
        extractCitations: z
          .boolean()
          .optional()
          .describe('本文内の出典・引用リンク一覧をコンテキスト付きで抽出するか (デフォルト: false)').meta({ default: false }),
        chunkMarkdown: z
          .boolean()
          .optional()
          .describe('RAG 用に見出しや段落単位でセマンティック・チャンキングした chunks を生成するか (デフォルト: false)').meta({ default: false }),
        chunkSize: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .optional()
          .describe('チャンキング時の最大文字数目安 (デフォルト: 1000, 上限: 100000)').meta({ default: 1000 }),
        validateLinks: z
          .boolean()
          .optional()
          .describe('抽出されたリンクの到達性・HTTPステータスを並行検証するか (デフォルト: false)').meta({ default: false }),
        formatAsPrompt: z
          .boolean()
          .optional()
          .describe('LLM に最適化された標準 XML プロンプトラッパー形式を生成するか (デフォルト: false)').meta({ default: false }),
        stripLinks: z
          .boolean()
          .optional()
          .describe('Markdown 内のリンク [テキスト](url) から URL を除去してプレーンテキスト化し、LLM トークンを削減するか (デフォルト: false)').meta({ default: false }),
        filterLinkDensity: z
          .boolean()
          .optional()
          .describe('リンク密度が極端に高いナビゲーション・タグ一覧・関連記事ブロックを自動パージするか (デフォルト: false)').meta({ default: false }),
        highlightMatches: z
          .boolean()
          .optional()
          .describe('本文中の検索一致語句をハイライトするか (デフォルト: false)').meta({ default: false }),
        maskPii: z
          .boolean()
          .optional()
          .describe('メール・電話番号・クレジットカード番号等の個人情報・機密情報を自動マスキングするか (デフォルト: false)').meta({ default: false }),
        webhookUrl: z
          .string()
          .optional()
          .describe('スクレイプ完了時に結果ペイロードを通知する Webhook URL (非同期)'),
        query: z
          .string()
          .optional()
          .describe('ハイライト抽出に使用するキーワード・検索文'),
        onlyMainContent: z
          .boolean()
          .optional()
          .describe('記事本文のみを抽出するか (デフォルト: true)。false にするとナビゲーションやヘッダー/フッターも含めて抽出').meta({ default: true }),
        selectors: z
          .record(z.string(), z.string())
          .optional()
          .describe('特定要素のみをピンポイント抽出する CSS セレクタまたは属性指定の連想配列 (例: {"price": ".product-price", "link": "a.btn@href"})'),
        clipSelector: z
          .string()
          .optional()
          .describe('指定した要素のみを切り抜いてスクリーンショットを撮影する CSS セレクタ (例: "#chart", ".pricing-table")'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('リクエスト時に送信するカスタム HTTP ヘッダー連想配列 (例: {"Accept-Language": "ja", "User-Agent": "..."})'),
        removeSelectors: z
          .array(z.string())
          .optional()
          .describe('Markdown 変換前に除去したいノイズ要素の CSS セレクタ配列 (例: [".ad-banner", ".comments", "#related"])'),
        retries: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe('接続失敗時の自動リトライ回数 (0〜3, デフォルト: 0)').meta({ default: 0 }),
        verbose: z
          .boolean()
          .optional()
          .describe('デバッグ用: quality スコアや evidence 等の内部詳細メタデータを含めるか (デフォルト: false)').meta({ default: false }),
        keepDataImages: z
          .boolean()
          .optional()
          .describe('base64 インライン画像を Markdown 内で置換せず保持するか (デフォルト: false, [画像: alt] に軽量化)').meta({ default: false }),
        evidenceMode: z
          .enum(['full', 'highlights', 'contextual_highlights'])
          .optional()
          .describe('証拠提示モード: "full"(デフォルト全文), "highlights"(抽出文のみ), "contextual_highlights"(前後文脈・見出し・表ヘッダーを保持したパッセージ)').meta({ default: 'full' }),
        includeDiagnostics: z
          .boolean()
          .optional()
          .describe('クエリ網羅率や証拠シグナル等の客観的観測量（Evidence Diagnostics）を付与するか (省略時: false。現在はハイライト診断が verbose 時のみ出力されるため、単独指定では診断は付与されない)'),
        includeDiscrepancies: z
          .boolean()
          .optional()
          .describe('日付・金額・バージョンの不一致候補を検出して対比提示するか (省略時: false。現在は単独指定では不一致候補は付与されない)'),
        safeNormalize: z
          .boolean()
          .optional()
          .describe('漢数字（万）や単位（km/ms）等の決定論的正規化と導出履歴（derivations）を付与するか (デフォルト: false)').meta({ default: false }),
        reorderUFlat: z
          .boolean()
          .optional()
          .describe('Lost in the Middle 対策: 抽出ハイライトを U字型（最重要情報を先頭と末尾）に並び替えるか (デフォルト: false)').meta({ default: false }),
        diversityWeight: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('MMR 多様性制御パラメータ λ: 1.0に近いほどクエリ関連度重視、0.0に近いほど重複排除・新規性重視 (デフォルト: 0.7)').meta({ default: 0.7 }),
        annotateTemporal: z
          .boolean()
          .optional()
          .describe('相対時間表現（明日、来週等）に公開日時を基準とした絶対日時注記 [YYYY-MM-DD] を決定論的に付与するか (デフォルト: false)').meta({ default: false }),
        minimizeTables: z
          .boolean()
          .optional()
          .describe('HTML テーブルの空欄列・冗長列を自動パージしてトークン消費を圧縮するか (デフォルト: true)').meta({ default: true }),
        highlightAlgorithm: HighlightAlgorithmSchema
          .optional()
          .default(DEFAULT_HIGHLIGHT_ALGORITHM)
          .describe('ハイライト選択アルゴリズム: "rho-select-v2"(デフォルト: 論文版クエリ証明書付き最適化), "rho-select"(旧レガシー版), "rho-bm25", "legacy"'),
        highlightOverheadTokens: z
          .number()
          .int()
          .min(1)
          .max(4096)
          .optional()
          .describe('ρSelect の固定コンテキストオーバーヘッドトークン数 τ (デフォルト: 96)').meta({ default: 96 }),
        highlightMaxCount: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('ハイライト最大選択件数 (デフォルト: 3)').meta({ default: 3 }),
      },
      async ({ url, maxChars, mode, formats, fullPage, fastOnly, renderJs, extractHighlights, onlyHighlights, evidenceMode, includeDiagnostics, includeDiscrepancies, safeNormalize, extractSummary, extractCitations, chunkMarkdown, chunkSize, validateLinks, formatAsPrompt, stripLinks, filterLinkDensity, highlightMatches, maskPii, webhookUrl, query, onlyMainContent, selectors, clipSelector, headers, removeSelectors, retries, verbose, keepDataImages, reorderUFlat, diversityWeight, annotateTemporal, minimizeTables, highlightAlgorithm, highlightOverheadTokens, highlightMaxCount }) => {
        try {
          const result = await scrapeUrl({ url, tenantId: serverTenantId, maxChars, mode, formats, fullPage, fastOnly, renderJs, extractHighlights, onlyHighlights, evidenceMode, includeDiagnostics, includeDiscrepancies, safeNormalize, extractSummary, extractCitations, chunkMarkdown, chunkSize, validateLinks, formatAsPrompt, stripLinks, filterLinkDensity, highlightMatches, maskPii, webhookUrl, query, onlyMainContent, selectors, clipSelector, headers, removeSelectors, retries, keepDataImages, reorderUFlat, diversityWeight, annotateTemporal, minimizeTables, highlightAlgorithm, highlightOverheadTokens, highlightMaxCount });
          const formatted = formatCompactScrapeResult(result, { verbose });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(formatted, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Scrape error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['スクレイプ', 'Web抽出', 'URL', 'Markdown', 'PDF', '記事本文'] },
    );

    // Tool 1.5: scrape_batch (複数 URL 一括並行スクレイプ) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'scrape_batch',
      'web',
      '【複数 URL 一括並行スクレイプ】複数の Web ページ URL を指定し、ドメインスロットリングを維持しながら高速に並行スクレイピングして一括返却します。',
      SCRAPE_BATCH_INPUT_SHAPE,
      async ({ urls, concurrency, maxChars, mode, formats, selectors, clipSelector, headers, removeSelectors, query, extractHighlights, onlyHighlights, evidenceMode, includeDiagnostics, includeDiscrepancies, safeNormalize, extractSummary, extractCitations, chunkMarkdown, chunkSize, validateLinks, formatAsPrompt, stripLinks, filterLinkDensity, highlightMatches, maskPii, webhookUrl, retries, onlyMainContent, verbose, reorderUFlat, diversityWeight, annotateTemporal, minimizeTables, highlightAlgorithm, highlightOverheadTokens, highlightMaxCount }) => {
        try {
          const result = await scrapeBatchUrls({ urls, tenantId: serverTenantId, concurrency, maxChars, mode, formats, selectors, clipSelector, headers, removeSelectors, query, extractHighlights, onlyHighlights, evidenceMode, includeDiagnostics, includeDiscrepancies, safeNormalize, extractSummary, extractCitations, chunkMarkdown, chunkSize, validateLinks, formatAsPrompt, stripLinks, filterLinkDensity, highlightMatches, maskPii, webhookUrl, retries, onlyMainContent, reorderUFlat, diversityWeight, annotateTemporal, minimizeTables, highlightAlgorithm, highlightOverheadTokens, highlightMaxCount });
          const formattedResults = result.results?.map((r: any) => formatCompactScrapeResult(r, { verbose })) ?? [];
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ...result, results: formattedResults }, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Batch scrape error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['一括スクレイプ', '一括取得', '複数URL', '並行取得', 'バッチ'] },
    );

    // Tool 2: search_deep (超高精度 統合検索・本文一括取得) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_deep',
      'web',
      '【万能深層Web検索・包括調査】Web検索＋上位サイト本文自動スクレイピング（Clean Markdown）＋Xリアルタイム速報を一括取得し、深層エビデンス駆動リランキング（Deep Evidence Rerank）で回答根拠のあるソースを最上位化します（Web+X統合深層調査）。最新事実、ライブ・公演日程、新製品・発売日、営業時間、人物動向等の包括調査に使用します。返却量を抑える場合は responseMode（full: 全文重視 / evidence: 局所事実・ハイライト優先）を選択可能。候補URL探索は search_web、既知URLの精読は scrape を使用してください。',
      INTEGRATED_SEARCH_INPUT_SHAPE,
      async ({ query, limit, scrapeContent, adaptiveScrape, scrapeBudget, includeRealtime, realtimeSort, officialAccountId, maxChars, noCache, includeDomains, excludeDomains, updated, formats, extractHighlights, dedup, onlyMainContent, verbose, reorderUFlat, enablePrf, diversityWeight, annotateTemporal, minimizeTables, highlightAlgorithm, highlightOverheadTokens, highlightMaxCount, responseMode }) => {
        try {
          const result = await integratedSearch({
            query,
            tenantId: serverTenantId,
            limit,
            scrapeContent,
            adaptiveScrape,
            scrapeBudget,
            includeRealtime,
            realtimeSort,
            officialAccountId,
            maxChars,
            noCache,
            includeDomains,
            excludeDomains,
            updated,
            formats,
            extractHighlights,
            dedup,
            onlyMainContent,
            verbose,
            reorderUFlat,
            enablePrf,
            diversityWeight,
            annotateTemporal,
            minimizeTables,
            highlightAlgorithm,
            highlightOverheadTokens,
            highlightMaxCount,
          });
          return {
            content: [{
              type: 'text',
              text: serializeIntegratedSearchMcpResponse(result, {
                responseMode,
                explicitFormats: formats,
                extractHighlights,
                verbose,
              }),
            }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['深層検索', '統合検索', 'Web検索', '本文取得', 'X速報', 'スケジュール', 'イベント', 'ライブ日程', '発売日', '営業時間', '最新情報', 'deep_search', 'deep-search', 'deep search'] },
    );

    // Tool 3: map_site (サイトマップ探索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'map_site',
      'web',
      '【サイトマップ探索】指定 URL のサイトマップ (sitemap.xml) またはページ内リンクを探索し、サイト内の全 URL 一覧を高速抽出します。ドメイン全体のページ構成把握に最適です。',
      {
        url: z.string().url().describe('探索対象の Web サイト URL (例: "https://example.com")'),
        limit: z.number().int().min(1).max(1000).optional().describe('取得する最大 URL 件数 (デフォルト: 200, 最大: 1000)').meta({ default: 200 }),
        since: z.string().optional().describe('指定した日付・日時以降に更新されたページのみを抽出するフィルタ (例: "2026-08-01", "2026-01-01T00:00:00Z")'),
        until: z.string().optional().describe('指定日時以前に更新された URL のみ抽出するフィルタ'),
      },
      async ({ url, limit, since, until }) => {
        try {
          const result = await mapSiteUrl({ url, limit, since, until });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Map site error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['サイトマップ', 'URL一覧', 'サイト構造', 'リンク収集'] },
    );

    // Tool 4: crawl_site (サイト内再帰クロール) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'crawl_site',
      'web',
      '【同一サイト内再帰巡回】指定 URL を起点として同一ドメイン配下の Web ページを再帰的に巡回（クロール）し、複数ページの Markdown 本文を一括収集します（同一サイトの複数ページ巡回）。ドキュメントサイト等のまとめ読みに最適です。単一ページの取得は scrape、動的対話操作は browser_action を使用してください。',
      {
        url: z.string().url().describe('クロール開始 URL (例: "https://example.com/docs")'),
        maxPages: z.number().int().min(1).max(50).optional().describe('巡回する最大ページ数 (デフォルト: 10, 最大: 50)').meta({ default: 10 }),
        maxChars: z.number().int().min(1).max(50_000).optional().describe('1ページあたりの最大文字数 (デフォルト: 15000)').meta({ default: 15000 }),
        includePatterns: z.array(z.string()).optional().describe('クロール対象を絞り込むワイルドカードパターン一覧 (例: ["/docs/**", "/guide/*"])'),
        excludePatterns: z.array(z.string()).optional().describe('クロールから除外するワイルドカードパターン一覧 (例: ["/tag/**", "*.pdf"])'),
        formats: z.array(ScrapeFormatSchema).optional().describe('取得するコンテンツ形式 (デフォルト: ["markdown"])').meta({ default: ['markdown'] }),
        query: z.string().optional().describe('巡回ページからハイライトを抽出するキーワード'),
        extractHighlights: z.boolean().optional().describe('巡回した各ページからキーワードに関連する重要文（ハイライト）を自動抽出するか'),
        onlyHighlights: z.boolean().optional().describe('抽出されたハイライトのみを各ページの本文 content として返し、ノイズ全文を削除するか'),
        reorderUFlat: z.boolean().optional().describe('Lost in the Middle 対策: 各ページの抽出パッセージおよびクロール結果全体を U字型で並べ替えるか (デフォルト: false)').meta({ default: false }),
        diversityWeight: z.number().min(0).max(1).optional().describe('MMR によるパッセージ多様性比率 (0.0〜1.0, デフォルト: 0.7)').meta({ default: 0.7 }),
        annotateTemporal: z
          .boolean()
          .optional()
          .describe('相対時間表現（明日、来週等）に公開日時を基準とした絶対日時注記 [YYYY-MM-DD] を決定論的に付与するか (デフォルト: false)').meta({ default: false }),
        minimizeTables: z
          .boolean()
          .optional()
          .describe('HTML テーブルの空欄列・冗長列を自動パージしてトークン消費を圧縮するか (デフォルト: true)').meta({ default: true }),
        highlightAlgorithm: HighlightAlgorithmSchema
          .optional()
          .default(DEFAULT_HIGHLIGHT_ALGORITHM)
          .describe('ハイライト選択アルゴリズム: "rho-select-v2"(デフォルト: 論文版クエリ証明書付き最適化), "rho-select"(旧レガシー版), "rho-bm25", "legacy"'),
        highlightOverheadTokens: z
          .number()
          .int()
          .min(1)
          .max(4096)
          .optional()
          .describe('ρSelect の固定コンテキストオーバーヘッドトークン数 τ (デフォルト: 96)').meta({ default: 96 }),
        highlightMaxCount: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('ハイライト最大選択件数 (デフォルト: 3)').meta({ default: 3 }),
      },
      async ({ url, maxPages, maxChars, includePatterns, excludePatterns, formats, query, extractHighlights, onlyHighlights, reorderUFlat, diversityWeight, annotateTemporal, minimizeTables, highlightAlgorithm, highlightOverheadTokens, highlightMaxCount }) => {
        try {
          const result = await crawlSiteUrl({ url, tenantId: serverTenantId, maxPages, maxChars, includePatterns, excludePatterns, formats, query, extractHighlights, onlyHighlights, reorderUFlat, diversityWeight, annotateTemporal, minimizeTables, highlightAlgorithm, highlightOverheadTokens, highlightMaxCount });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Crawl site error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['クロール', 'サイト巡回', '再帰巡回', '全ページ取得', 'まとめ読み', 'ドメイン探索', '一括収集'] },
    );

    // Tool 5: search_web (基本 Web 検索 + optional requested-format extraction) - CORE
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_web',
      'web',
      '【万能Web検索・候補探索】ニュース、イベント日程、発売日、営業時間、公式告知などの候補URLおよび概要スニペットを高速探索します（URL/スニペット探索）。formats を指定した場合は上位検索結果を追加スクレイプし、1回の呼び出しで記事本文や指定形式をインライン返却可能です（同一呼出での本文抽出）。深層Web+リアルタイムX調査や深層リランキングが必要な場合は search_deep、既知URLの精読は scrape を使用してください。',
      SEARCH_WEB_INPUT_SHAPE,
      async (options) => {
        try {
          const result = await searchWebWithFormats(options as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text', text: `Search error: ${err?.message || err}` }] };
        }
      },
      { defaultEnabled: true, keywords: ['Web検索','検索','URL一覧','Google検索','Yahoo検索','イベント検索','告知検索','スケジュール','Markdown'] },
    );
    // Tool 5b: search_social_posts (公開SNS投稿検索: Weibo新着 / Meta公開投稿)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_social_posts',
      'web',
      '【公開SNS投稿検索】Weiboのキーワード新着検索、Threads/Instagram/Facebookの公開投稿の発見＋本文取得を行います。追加費用・ログイン不要。Xの投稿は対象外のため search_realtime を使ってください。返却: { status, platform, query, searchMode, items: [{ id, url, author, text, textKind, publishedAt, timeStatus, inRequestedWindow, method, metrics, comments }], matchedInWindow, unknownTime, excluded, failures }。status が partial/unavailable の場合は failures を確認し、empty は一致なしの意味です。',
      {
        platform: SocialPlatformSchema.describe('対象SNS'),
        query: z.string().min(1).max(500).describe('検索語（現地語推奨）'),
        limit: z.number().int().min(1).max(30).optional().default(10).describe('取得件数 (デフォルト: 10, 最大: 30)'),
        lookbackHours: z.number().int().min(1).max(2160).optional().default(24).describe('遡及時間 (デフォルト: 24, 最大: 2160)。Weiboは期間外を除外、Metaは索引期間の目安＋本文日時で再判定'),
      },
      async ({ platform, query, limit, lookbackHours }) => {
        try {
          const { createSocialService } = await import('./services/social/index.js');
          const { createProdWeiboHttp, createProdMetaHttp, createProdMetaBrowser, createProdSessionOpener, createProdWebSearch } = await import('./services/social/transport.js');
          const svc = createSocialService({
            weiboHttp: createProdWeiboHttp(),
            sessionOpener: createProdSessionOpener(),
            metaHttp: createProdMetaHttp(),
            metaBrowser: createProdMetaBrowser(),
            webSearch: createProdWebSearch(),
          });
          const signal = AbortSignal.timeout(55000);
          const result = await svc.search({ platform, query, limit: limit ?? 10, lookbackHours: lookbackHours ?? 24 }, { signal, deadlineAt: Date.now() + 55000 });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text', text: `Social search error: ${err?.message || err}` }] };
        }
      },
      { defaultEnabled: true, keywords: ['SNS', 'Weibo', '微博', 'Threads', 'Instagram', 'Facebook', '投稿検索', 'ソーシャル'] },
    );
    // Tool 5c: fetch_social_post (既知SNS投稿の取得)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'fetch_social_post',
      'web',
      '【既知SNS投稿の取得】Weibo/Threads/Instagram/Facebookの公開投稿URLから本文・日時・反応を取得します。Weiboは長文・人気コメントの補完に対応。Metaのコメント取得は対象外です。Xの投稿は対象外のため search_realtime を使ってください。',
      {
        url: z.string().min(1).describe('公開投稿URL'),
        commentLimit: z.number().int().min(0).max(20).optional().default(10).describe('Weiboコメント取得件数 (デフォルト: 10, Metaでは無視)'),
      },
      async ({ url, commentLimit }) => {
        try {
          const { createSocialService } = await import('./services/social/index.js');
          const { createProdWeiboHttp, createProdMetaHttp, createProdMetaBrowser, createProdSessionOpener, createProdWebSearch } = await import('./services/social/transport.js');
          const svc = createSocialService({
            weiboHttp: createProdWeiboHttp(),
            sessionOpener: createProdSessionOpener(),
            metaHttp: createProdMetaHttp(),
            metaBrowser: createProdMetaBrowser(),
            webSearch: createProdWebSearch(),
          });
          const signal = AbortSignal.timeout(30000);
          const result = await svc.fetch({ url, commentLimit: commentLimit ?? 10 }, { signal, deadlineAt: Date.now() + 30000 });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text', text: `Social fetch error: ${err?.message || err}` }] };
        }
      },
      { defaultEnabled: true, keywords: ['SNS', 'Weibo', '微博', 'Threads', 'Instagram', 'Facebook', '投稿取得', 'コメント'] },
    );
  }

  // =========================================================================
  // 🤖 Category 2: Browser Actions & Automation (モジュール: 'browser')
  // =========================================================================
  if (shouldEnableBrowser) {
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'browser_action',
      'browser',
      '【対話型ブラウザ自動操作】Chromium 実ブラウザを用いて、クリック・フォーム入力・キー押下・スクロール・待機・JavaScript実行・スクリーンショット取得などの対話的操作を順次実行します（対話・動的操作・レンダリングが必須なケース）。単純な静的ページの本文抽出は scrape、Web検索・調査は search_deep / search_web を使用してください。',
      {
        url: z.string().url().optional().describe('操作対象の Web ページ URL (新規開始時に指定、既存セッション継続時は省略可能)'),
        sessionId: z.string().optional().describe('既存の対話セッションID (前回の操作に続けて同じタブで操作する場合に指定)'),
        ownerToken: z.string().optional().describe('マルチターン対話セッションの所有者検証トークン'),
        createSession: z.boolean().optional().describe('新しい対話セッションを作成し、次回以降も状態を維持するか (デフォルト: false)').meta({ default: false }),
        closeSession: z.boolean().optional().describe('指定したセッションを終了してブラウザリソースを解放するか (デフォルト: false)').meta({ default: false }),
        actions: z.array(BrowserActionStepSchema).optional().describe('順次実行するブラウザアクションの配列'),
        extract: z
          .object({
            markdown: z.boolean().optional().describe('操作後のページ本文を Markdown で抽出するか (デフォルト: true)').meta({ default: true }),
            html: z.boolean().optional().describe('操作後の生 HTML を抽出するか (デフォルト: false)').meta({ default: false }),
            screenshot: z.boolean().optional().describe('操作後の画面スクリーンショット（Base64 PNG）を取得するか (デフォルト: false)').meta({ default: false }),
            screenshotFullPage: z.boolean().optional().describe('フルページスクリーンショットにするか (デフォルト: true)').meta({ default: true }),
            clipSelector: z.string().optional().describe('特定要素のみを切り抜く CSS セレクタ'),
            maxChars: z.number().optional().describe('最大抽出文字数 (デフォルト: 30000)').meta({ default: 30000 }),
          })
          .optional()
          .describe('操作完了後に抽出するデータ指定'),
        timeout: z.number().optional().describe('全体のタイムアウト時間 (ミリ秒, デフォルト: 30000)').meta({ default: 30000 }),
      },
      async (opts) => {
        try {
          const result = await executeBrowserActions({ ...(opts as any), tenantId: serverTenantId });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Browser action error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['ブラウザ操作', 'クリック', '入力', 'スクリーンショット', 'Stealth Chromium', 'セッション'] },
    );
  }

  // =========================================================================
  // 🇯🇵 Category 3: Yahoo! JAPAN Services (モジュール: 'yahoo')
  // =========================================================================
  if (shouldEnableYahoo) {
    // Tool 7: search_image (Yahoo 画像検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_image',
      'yahoo',
      '【Yahoo 画像検索】画像の URL・サムネイル・寸法（幅/高さ）・元ページ URL を取得します。',
      {
        query: z.string().min(1).describe('画像検索キーワード (例: "富士山", "猫 写真")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)').meta({ default: 20 }),
      },
      async ({ query, limit }) => {
        try {
          const result = await searchYahooImage({ query, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Image search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['画像検索', '写真', 'イラスト', 'Yahoo'] },
    );

    // Tool 8: search_video (Yahoo 動画検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_video',
      'yahoo',
      '【Yahoo 動画検索】YouTube 等の動画 URL・タイトル・再生時間・サムネイルを取得します。',
      {
        query: z.string().min(1).describe('動画検索キーワード (例: "料理 レシピ 動画")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)').meta({ default: 20 }),
      },
      async ({ query, limit }) => {
        try {
          const result = await searchYahooVideo({ query, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Video search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['動画検索', 'YouTube', 'Yahoo'] },
    );

    // Tool 9: search_news (Yahoo ニュース検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_news',
      'yahoo',
      '【ニュース速報直結】大手報道機関の最新ニュース記事（タイトル・サマリー・配信メディア・配信日時・記事 URL）をYahoo!ニュースから取得します。時事問題・公式発表の調査に最適です。返却: { source, query, count, items: [{ title, url, publisher, publishedTime, snippet }] }',
      {
        query: z.string().min(1).describe('ニュース検索キーワード (例: "選挙", "経済動向", "ノーベル賞")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)').meta({ default: 20 }),
      },
      async ({ query, limit }) => {
        try {
          const result = await searchYahooNews({ query, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `News search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['ニュース検索', '記事', '時事', 'Yahoo'] },
    );

    // Tool 10: search_chiebukuro (Yahoo 知恵袋検索) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_chiebukuro',
      'yahoo',
      '【必須・Web検索代替不可】Yahoo! 知恵袋の Q&A・人々の悩み・生活の知恵・利用者のリアルな体験談や口コミは、一般Web検索ではなく必ず本ツールで検索してください。質問タイトル・本文スニペット・回答数・解決ステータスを取得します。返却: { source, query, count, items: [{ title, url, status, bestAnswer, snippet }] }',
      {
        query: z.string().min(1).describe('知恵袋検索キーワード (例: "おすすめ プログラミング言語", "引越し 挨拶")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 10)').meta({ default: 10 }),
        status: ChiebukuroStatusSchema.optional()
          .describe('回答状況: "all"(すべて, デフォルト), "open"(回答受付中), "vote"(投票受付中), "solved"(解決済み)')
          .meta({ default: 'all' }),
      },
      async ({ query, limit, status }) => {
        try {
          const result = await searchYahooChiebukuro({ query, limit, status });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Chiebukuro search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['知恵袋', 'Q&A', '質問回答', '悩み', 'Yahoo'] },
    );

    // Tool 11: suggest_keywords (サジェスト / キーワード補完) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'suggest_keywords',
      'yahoo',
      '【公式サジェスト直結】Yahoo! JAPAN のキーワード補完サジェストを取得し、指定語句の入力候補・よく一緒に検索される複合検索需要・関連語を返します。返却: { query, suggestions: [...] }',
      {
        query: z.string().min(1).describe('検索語句プレフィックス (例: "東京 観光")'),
        limit: z.number().int().min(1).max(20).optional().describe('取得件数 (デフォルト: 10, 上限: 20)').meta({ default: 10 }),
      },
      async ({ query, limit }) => {
        try {
          const result = await getSuggestedKeywords({ query, limit });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Suggest error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['サジェスト', '関連キーワード', '予測', 'Yahoo'] },
    );

    // Tool 12: search_realtime (Yahoo リアルタイム検索) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_realtime',
      'yahoo',
      '【必須・Web検索代替不可】X上の最新ポスト・世論・特定アカウント告知調査用。Yahoo公式仕様で特定アカウント(id:xxx)、宛先(@xxx)、ハッシュタグ(#xxx)、除外(-xxx)、OR検索対応。物販タイテ・緊急告知・現地速報把握に最適。新着順(recent)/話題順(popular)対応。返却: { query, effectiveQuery, isFallback, sort, data: { count, items } } (verbose:trueで検索診断追加、一部失敗時はpartial:trueとproviderErrorsを付与)',
      {
        query: z
          .string()
          .optional()
          .describe('検索キーワード (例: "タイテ", "地震", "強化月間ライブ")。accountId や hashtags を指定する場合は省略可能。※クエリ内に "from:アカウント" を書いた場合も自動で "id:アカウント" に安全に正規化されます。'),
        accountId: z
          .string()
          .optional()
          .describe('【特定アカウントの発言絞り込み】Xアカウント名（例: "Yahoo_JAPAN_PR", "kimisora_JPN"）。@の有無問わず自動で id:xxx に変換します。'),
        fromUser: z.string().optional().describe('accountId のエイリアス (LLM 互換用)'),
        toAccount: z.string().optional().describe('【特定アカウント宛ての投稿】宛先アカウント名（@xxx に変換）'),
        hashtags: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('【特定ハッシュタグ絞り込み】ハッシュタグ（例: "#君と見るそら", "地震"）。#の有無問わず付与します。'),
        excludeWords: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('【除外キーワード】除外したい単語（-単語 に変換）'),
        orWords: z.array(z.string()).optional().describe('【OR検索】いずれかを含む単語の配列 (単語A 単語B) に変換'),
        url: z.string().optional().describe('【URL/ドメイン絞り込み】含まれるURLまたはドメイン名'),
        sort: z
          .enum(['recent', 'popular'])
          .optional()
          .describe('並び順: "recent" (新着順, デフォルト) または "popular" (話題・エンゲージメント順)').meta({ default: 'recent' }),
        limit: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe('取得件数 (デフォルト: 20, 最大: 40)').meta({ default: 20 }),
        page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('ページ番号 (1-based, デフォルト: 1, 上限: 100)').meta({ default: 1 }),
        verbose: z
          .boolean()
          .optional()
          .describe('デバッグ用: retrievalQueries 等の検索診断を含めるか (デフォルト: false)').meta({ default: false }),
      },
      async ({ query, accountId, fromUser, toAccount, hashtags, excludeWords, orWords, url, sort, limit, page, verbose }) => {
        try {
          const result = await searchYahooRealtime({
            query,
            accountId,
            fromUser,
            toAccount,
            hashtags,
            excludeWords,
            orWords,
            url,
            sort: sort || 'recent',
            ...(limit ? { limit } : {}),
            ...(page ? { page } : {}),
            ...(verbose === true ? { verbose: true } : {}),
          });

          const responsePayload = formatCompactRealtimeResponse(
            {
              source: 'x',
              query: result.originalQuery,
              effectiveQuery: result.effectiveQuery,
              isFallback: result.isFallback,
              ...((result as any).partial === true
                ? { partial: true, providerErrors: (result as any).providerErrors || [] }
                : {}),
              retrievalQueries: (result as any).retrievalQueries || [],
              contributingQueries: (result as any).contributingQueries || [],
              resultsMerged: (result as any).resultsMerged || false,
              sort: sort || 'recent',
              count: result.count,
              items: result.items,
            },
            { verbose },
          );

          return {
            content: [{ type: 'text', text: JSON.stringify(responsePayload, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Realtime search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['リアルタイム検索', 'X', 'Twitter', 'ツイート', 'トレンド', '速報'] },
    );

    // Tool 13: search_trend (Yahoo トレンド急上昇) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_trend',
      'yahoo',
      '【公式トレンド直結】いま日本国内で最も話題になっている急上昇トレンドキーワード上位 20 件（順位・キーワード・ポスト数・要約）は、必ず本ツールで取得してください。返却: { source, type, count, items: [{ rank, keyword, tweetCount, url }], timestamp }',
      {
        limit: z.number().int().min(1).max(50).optional().describe('取得するトレンド件数 (デフォルト: 20)').meta({ default: 20 }),
      },
      async ({ limit }) => {
        try {
          const result = await fetchRealtimeTrends(limit);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Trend search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['急上昇トレンド', '話題', 'ランキング', 'リアルタイム'] },
    );

    // Tool 12b: fetch_x_post (X個別投稿の全文取得) - DEFERRED
    {
      const xDetail = options?.xDetailProvider ?? defaultXDetailProvider;
      registerTool(
        mcpServer,
        toolCatalog,
        sessionActivated,
        'fetch_x_post',
        'yahoo',
        '【X個別投稿の全文取得】search_realtimeで見つけたX投稿のうち詳しく知りたい1件の全文・投稿日時・メディアをFxTwitter経由で取得します（ID突合検証済みのみ返却、未検証の推測は返しません）。返却: { found, statusId, detail: { text, isNoteTweet, author, createdAt, media } }',
        {
          statusId: z.string().optional().describe('X投稿の数値ステータスID (例: "2100871827090501852")'),
          url: z.string().optional().describe('X投稿URL (例: "https://x.com/xxx/status/123…")。statusIdの代わりに指定可'),
        },
        async (opts) => {
          try {
            const result = await fetchXPostDetail(opts, xDetail);
            if (!result.found) {
              return {
                isError: true,
                content: [{ type: 'text', text: `X post not found: ${result.reason}` }],
              };
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `X post fetch error: ${err?.message || err}` }],
            };
          }
        },
        { defaultEnabled: deferredDefault, keywords: ['X', 'ツイート', 'ポスト', '全文', 'ステータス', 'status'] },
      );
    }
  }

  // =========================================================================
  // 🗾 Category 4: Japanese Daily Life Services (モジュール: 'life')
  // =========================================================================
  if (shouldEnableLife) {
    // Tool 14: search_route (電車・鉄道 乗換案内) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_route',
      'life',
      '【公式直結・推測運賃厳禁】日本国内の電車・新幹線・地下鉄等の駅間最適ルート・所要時間・乗換回数・IC/きっぷ運賃は、推測で不正確な案内をせず必ずYahoo!路線情報直結の本ツールで探索してください。経由駅指定（最大3駅）や日時指定に対応。返却: { routes: [{ departure, arrival, duration, transferCount, fare, steps }] }',
      TRANSIT_ROUTE_INPUT_SHAPE,
      async (opts) => {
        try {
          const result = await searchTransitRoute(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Transit route error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['乗換案内', '電車', 'ルート', '経路', '交通', '時刻表'] },
    );

    // Tool 15: get_weather (日本の天気予報 - 気象庁公式オープンデータ直結) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'get_weather',
      'life',
      '【公式直結・推測厳禁】日本国内各地の天気予報・予想気温・降水確率・概況は、一般的な推測を行わず必ず気象庁公式オープンデータ直結の本ツールを実行してください。全国 1,805 市区町村名（例: "天童市", "軽井沢", "箱根", "浦安", "別府", "石垣島"）または都道府県名・地点IDに対応。今日から最大7日先（計8日分）の週間予報を取得可能。返却: { source, title, forecasts: [{ date, telop, temperature, chanceOfRain }] }',
      {
        city: z.string().min(1).describe('市区町村名または都道府県名（例: "天童市", "軽井沢", "箱根", "浦安", "東京", "大阪", "福岡", "那覇"）、もしくは6桁の地点ID（例: "130010"）'),
        days: z.number().int().min(1).max(8).optional().describe('取得する予報日数 (1〜8日, デフォルト: 7)').meta({ default: 7 }),
      },
      async ({ city, days }) => {
        try {
          const result = await fetchWeatherForecast({ city, days });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Weather forecast error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['天気予報', '気象', '気温', '降水確率', '週間天気', '天気'] },
    );

    // Tool: get_flight_status (フライト航空運行情報) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'get_flight_status',
      'life',
      '【公式運航情報直結】主要空港（羽田、成田、伊丹、関西、中部、新千歳、福岡、那覇等）の国内線・国際線フライトリアルタイム運航状況・欠航・遅延ステータスおよび理由詳細は、推測せず必ず本ツールで確認してください。返却: { airportName, summary, flights: [{ flightNumber, airline, scheduledTime, status }] }',
      {
        airport: z.string().optional().describe('対象空港名またはコード (例: "羽田", "成田", "伊丹", "関空", "中部", "新千歳", "福岡", "那覇", "HND", "NRT", "ITM", "KIX", "NGO", デフォルト: "羽田")').meta({ default: '羽田' }),
        type: z.enum(['departure', 'arrival']).optional().describe('発着区分: "departure"(出発) または "arrival"(到着) (デフォルト: "departure")').meta({ default: 'departure' }),
        category: z.enum(['domestic', 'international']).optional().describe('路線区分: "domestic"(国内線) または "international"(国際線) (デフォルト: "domestic")').meta({ default: 'domestic' }),
        flightNumber: z.string().optional().describe('特定の便名で絞り込む場合 (例: "ANA2421", "JAL505")'),
        keyword: z.string().optional().describe('目的地・出発地・航空会社名などのキーワード絞り込み (例: "那覇", "全日本空輸")'),
      },
      async (opts) => {
        try {
          const result = await fetchFlightStatus(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Flight status error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['フライト', '航空', '飛行機', '空港', '欠航', '遅延', '羽田', '成田', 'JAL', 'ANA'] },
    );

    // Tool: track_package (主要運送会社・UPS・FedEx・DHL Express 荷物追跡)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'track_package',
      'life',
      '【公式直結・荷物追跡】日本の主要運送会社（ヤマト運輸・佐川急便・日本郵便 国内+国際EMS/UPU S10・西濃運輸・福山通運）および国際配送（UPS・FedEx・DHL Express）の荷物追跡情報・配送ステータス（配達中、配達完了、引受、持ち戻り等）および詳細履歴を取得します。運送会社コード（yamato, sagawa, japanpost, seino, fukutsu, ups, fedex, dhl）を指定可能。未指定または "auto" の場合は伝票番号から候補会社をローカル自動判別・検証照会します。返却: { carrier, carrierName, trackingNumber, status, statusText, events: [{ date, status, location }], trackingUrl }',
      {
        trackingNumber: z.string().min(1).describe('荷物の追跡番号・送り状番号・お問い合わせ番号（ハイフン有無問わず、全角半角対応）'),
        carrier: z.enum(['yamato', 'sagawa', 'japanpost', 'seino', 'fukutsu', 'ups', 'fedex', 'dhl', 'auto']).optional()
          .describe('運送会社コード: "yamato"(ヤマト運輸), "sagawa"(佐川急便), "japanpost"(日本郵便 国内+国際), "seino"(西濃運輸), "fukutsu"(福山通運), "ups"(UPS), "fedex"(FedEx), "dhl"(DHL Express)。省略または "auto" で自動判別'),
        preferredCarriers: z.array(z.enum(['yamato', 'sagawa', 'japanpost', 'seino', 'fukutsu', 'ups', 'fedex', 'dhl'])).optional()
          .describe('優先的に検証する運送会社候補のヒント配列'),
        originCountry: z.string().optional().describe('差出元の国コード（ISO 2文字）'),
        destinationCountry: z.string().optional().describe('お届け先の国コード（ISO 2文字）'),
        noCache: z.boolean().optional().describe('キャッシュをバイパスして最新情報を強制再取得するか'),
      },
      async ({ trackingNumber, carrier, preferredCarriers, originCountry, destinationCountry, noCache }) => {
        try {
          const result = await trackPackage({
            trackingNumber,
            carrier: carrier ?? 'auto',
            preferredCarriers,
            originCountry,
            destinationCountry,
            noCache: noCache ?? false,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Package tracking error: ${err?.message || err}` }],
          };
        }
      },
      {
        defaultEnabled: deferredDefault,
        keywords: [
          '荷物追跡',
          '荷物',
          '配送',
          '配達',
          '追跡',
          '配送状況',
          '宅配便',
          '宅急便',
          'ヤマト',
          'クロネコヤマト',
          '佐川',
          '佐川急便',
          '日本郵便',
          '郵便',
          'ゆうパック',
          '西濃運輸',
          '福山通運',
          'UPS',
          'FedEx',
          'フェデックス',
          'DHL',
          'DHL Express',
          'EMS',
          '国際郵便',
          'UPU',
          '伝票番号',
          '送り状',
          'tracking',
          'package',
        ],
      },
    );

    // Tool: search_hotel_availability (楽天トラベル宿泊検索・実験的) - DEFERRED
    // Gated by SORA_RAKUTEN_TRAVEL_ENABLED so default tool counts stay unchanged.
    if (process.env.SORA_RAKUTEN_TRAVEL_ENABLED === 'true') {
      const resolvedHotelService = options?.hotelService ?? hotelService;
      registerTool(
        mcpServer,
        toolCatalog,
        sessionActivated,
        'search_hotel_availability',
        'life',
        '【実験的・楽天トラベル直結】東京駅・京都駅・草津温泉の宿泊施設について、指定日・人数の空室プランと税込料金を楽天トラベルの公開検索から取得します（実験フラグ SORA_RAKUTEN_TRAVEL_ENABLED=true が必要）。施設名・住所は未対応のため null を返します。対応外の場所は取得せず理由を返します。返却: { status, hotels: [{ id, plans: [{ planId, rooms: [{ roomId, amount, currency, basis, taxStatus }] }] }], failures }',
        {
          location: z.string().min(1).describe('宿泊地（観測済み: "東京駅", "京都駅", "草津温泉"）'),
          checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('チェックイン日 (YYYY-MM-DD)'),
          checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('チェックアウト日 (YYYY-MM-DD, チェックインより後)'),
          adults: z.number().int().min(1).max(10).describe('大人人数（1室あたり, 上限: 10）'),
          rooms: z.number().int().min(1).max(1).optional().describe('部屋数（1のみ, デフォルト: 1）').meta({ default: 1 }),
          limit: z.number().int().min(1).max(10).optional().describe('最大施設件数（1〜10, デフォルト: 5）').meta({ default: 5 }),
        },
        async (opts) => {
          const parsed = HotelSearchInputSchema.safeParse(opts);
          if (!parsed.success) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Hotel search input error: ${parsed.error.issues[0]?.message}` }],
            };
          }
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            try {
              const result: HotelSearchResult = await resolvedHotelService.searchHotelAvailability(parsed.data, {
                signal: controller.signal,
                deadlineAt: Date.now() + 20000,
              });
              if (result.status === 'unavailable') {
                return {
                  isError: true,
                  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
              }
              return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              };
            } finally {
              clearTimeout(timer);
            }
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Hotel search error: ${err?.message || err}` }],
            };
          }
        },
        {
          defaultEnabled: deferredDefault,
          keywords: ['ホテル', '宿泊', '旅館', '空室', '楽天トラベル', 'hotel'],
        },
      );
    }
  }

  // =========================================================================
  // 🚨 Category 5: Disaster & Emergency (モジュール: 'disaster')
  // =========================================================================
  if (shouldEnableDisaster) {
    // Tool 16: search_road_traffic (リアルタイム道路交通情報 - JARTIC連携) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_road_traffic',
      'disaster',
      '【JARTIC道路交通直結】日本全国の高速道路・都市高速・主要有料道路のリアルタイム道路交通情報（事故・渋滞・通行止め・車線規制・チェーン規制・工事等）は、推測せずJARTIC（日本道路交通情報センター）連携の本ツールで取得してください。返却: { pref, road, updatedAt, hasIssues, summary, items: [{ roadName, direction, status, section, cause }] }',
      {
        pref: z.string().optional().describe('都道府県名またはコード (例: "東京都", "愛知県", "大阪府", "福岡県", "13")'),
        road: z.string().optional().describe('道路名 (例: "東名高速", "首都高", "中央道", "名神高速", "阪神高速", "東北道")'),
      },
      async (opts) => {
        try {
          const result = await fetchRoadTraffic(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Road traffic error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['道路交通情報', '通行止め', '渋滞', '高速道路', '規制', 'JARTIC'] },
    );

    // Tool 17: search_disaster_warnings (気象警報・注意報) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_disaster_warnings',
      'disaster',
      '【気象庁公式防災直結】大雨・洪水・暴風・大雪・波浪等の特別警報・気象警報・注意報は、一般Web検索の古い情報に頼らず必ず気象庁公式データ直結の本ツールで市区町村単位でリアルタイム取得してください。返却: { areaName, warnings: [{ name, level, status }] }',
      {
        city: z.string().optional().describe('市区町村名または都道府県名 (例: "東京", "新宿区", "大阪府", "福岡")'),
        areaCode: z.string().optional().describe('気象庁エリアコード (6桁または2桁, 例: "130000", "130010")'),
      },
      async (opts) => {
        try {
          const result = await fetchWeatherWarnings(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Disaster warnings error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['気象警報', '注意報', '特別警報', '防災', '気象庁', '大雨', '台風'] },
    );

    // Tool 18: search_earthquake (リアルタイム地震速報・履歴) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_earthquake',
      'disaster',
      '【公式地震速報直結】最新の地震履歴（発生時刻、震源地、マグニチュード、深さ、最大震度、津波有無、観測地点）は、推測せずP2P地震情報および気象庁公式速報直結の本ツールで取得してください。返却: { earthquakes: [{ time, epicenter, maxIntensity, magnitude }] }',
      {
        limit: z.number().int().min(1).max(20).optional().describe('取得件数 (1〜20, デフォルト: 5)').meta({ default: 5 }),
        minIntensity: EarthquakeScaleSchema.optional()
          .describe('最小震度コード (10=震度1, 20=震度2, 30=震度3, 40=震度4, 45=震度5弱, 50=震度5強, 55=震度6弱, 60=震度6強, 70=震度7, デフォルト: 10)')
          .meta({ default: 10 }),
      },
      async (opts) => {
        try {
          const result = await fetchRecentEarthquakes(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Earthquake search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['地震情報', '震度', '震源地', '津波', '気象庁', '地震'] },
    );

    // Tool: get_elevation (geocoding.jp 座標解決 & 国土地理院 標高取得) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'get_elevation',
      'disaster',
      '【標高・座標取得必須】座標や標高を推測せず、本ツールで取得してください。住所・地名をgeocoding.jpで座標化し、国土地理院から海抜標高（m）を取得します。未キャッシュの地名解決は全ツール共有で10秒間隔となり、待機する場合があります。needsVerificationがtrueならmatchedTitleが意図した場所か確認してください。座標既知ならlat/lonを指定できます。返却: { elevationMeters, dataAccuracy, lat, lon, matchedTitle, geocodingSource, needsVerification }',
      {
        address: z.string().optional().describe('住所・地名文字列 (例: "東京都千代田区永田町1-7-1", "富士山頂")'),
        lat: z.number().optional().describe('緯度 (住所未指定時に直接指定, 例: 35.681236)'),
        lon: z.number().optional().describe('経度 (住所未指定時に直接指定, 例: 139.767125)'),
        noCache: z.boolean().optional().describe('座標解決・標高のキャッシュを使わず再取得する。10秒間隔は維持'),
      },
      async (opts) => {
        try {
          const result = await fetchElevationAndCoordinates(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Elevation error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['標高', '海抜', 'ジオコーディング', '国土地理院', '住所検索', '座標', '津波リスク', '水害'] },
    );

    // Tool: search_poi (OpenPOI 全国施設POI検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_poi',
      'disaster',
      '【OpenPOI直結・全国337万件】施設名・住所キーワードと位置範囲から施設を検索し、緯度経度付きで返します。複数語はORのため、場所はqueryに混ぜずcenterへ分離してください。centerはgeocoding.jpで座標化します。未キャッシュの解決は全ツール共有で10秒間隔となり、待機する場合があります。centerResolved.needsVerificationがtrueならaddressが意図した地域か確認し、異なる場合は地域名を補って再検索してください。候補一覧は返りません。座標既知ならlat/lon。get_elevation / search_routeと組み合わせ可能。返却: { centerResolved, count, pois: [{ name, address, lat, lng, licenses, attributions }] }',
      {
        query: z.string().trim().min(1).max(200).optional().describe('施設・住所キーワード (例: "ラーメン", "世田谷区 カフェ")'),
        lat: z.number().min(-90).max(90).optional().describe('中心緯度 (lon とペア指定)'),
        lon: z.number().min(-180).max(180).optional().describe('中心経度 (lat とペア指定)'),
        radiusMeters: z.number().int().min(1).max(100000).optional().describe('中心からの半径m (デフォルト: 5000)').meta({ default: 5000 }),
        center: z.string().trim().min(1).max(200).optional().describe('中心地名 (例: "渋谷", "原宿")。geocoding.jpで座標化する。lat/lonとは排他'),
        bbox: z.string().optional().describe('矩形範囲 "minLng,minLat,maxLng,maxLat"'),
        limit: z.number().int().min(1).max(50).optional().default(10).describe('最大件数 (1-50, デフォルト: 10)'),
        noCache: z.boolean().optional().describe('地名解決のキャッシュを使わず再取得する。10秒間隔は維持'),
      },
      async (opts) => {
        try {
          const { searchOpenPoi } = await import('./services/poi.js');
          const result = await searchOpenPoi(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `POI search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['POI', '施設検索', '施設', '住所検索', '避難所', '病院', '地図', '座標', '周辺施設', 'poi', 'places', '営業許可'] },
    );
  }

  // =========================================================================
  // 👁️ Category 6: Watch & Diff Monitoring (モジュール: 'watch')
  // =========================================================================
  if (shouldEnableWatch) {
    // Tool 19: watch_register (監視ターゲット登録) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'watch_register',
      'watch',
      '【Webページ差分監視登録】Web ページの変更監視ターゲットを登録し、初期ハッシュベースラインを構築します。チケット当落、再販監視、お知らせ検知等に利用可能。',
      {
        url: z.string().url().describe('監視対象の Web ページ URL (例: "https://example.com/status")'),
        title: z.string().optional().describe('監視ターゲットの識別用タイトル (例: "チケット当落発表")'),
        selector: z.string().optional().describe('ピンポイントで監視する CSS セレクタ (例: "#status")'),
        webhookUrl: z.string().url().optional().describe('差分検知時に通知する Webhook URL'),
        intervalSeconds: z.number().int().min(1).max(604_800).optional().describe('監視インターバル目安 (秒, デフォルト: 3600, 上限: 604800)').meta({ default: 3600 }),
      },
      async (opts) => {
        try {
          const result = await registerWatchTarget(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Watch register error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['Web監視登録', '差分監視', '更新通知', 'URL監視'] },
    );

    // Tool 20: watch_check (差分スキャン実行) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'watch_check',
      'watch',
      '【Webページ差分スキャン実行】登録された監視ターゲットの差分スキャンを実行し、変化の有無・ハッシュ値・スナップショットを返します。差分検知時は自動で Webhook を発火します。',
      {
        id: z.string().optional().describe('特定の監視ターゲット ID (省略時は全登録ターゲットを一括スキャン)'),
      },
      async ({ id }) => {
        try {
          const result = id ? await checkWatchTarget(id) : await checkAllWatchTargets();
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Watch check error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['Web監視チェック', '更新確認', '差分取得'] },
    );

    // Tool 21: watch_list (監視ターゲット一覧) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'watch_list',
      'watch',
      '【Webページ監視ターゲット一覧】現在 SQLite に永続化されている監視ターゲットの一覧および最終チェック状態を取得します。',
      {},
      async () => {
        try {
          const result = listWatchTargets();
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Watch list error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['Web監視一覧', '登録確認', 'ターゲット一覧'] },
    );

    // Tool: watch_delete (監視ターゲット削除) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'watch_delete',
      'watch',
      '【Webページ監視ターゲット削除】指定したIDの監視ターゲットをSQLiteから削除し、以後の差分監視を停止します。',
      {
        id: z.string().min(1).describe('削除する監視ターゲットのID'),
      },
      async ({ id }) => {
        try {
          const deleted = deleteWatchTarget(id);
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: deleted, id }, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Watch delete error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['Web監視削除', 'ターゲット削除', '監視解除'] },
    );
  }

  // =========================================================================
  // 🎵 Category 7: Music Metadata (モジュール: 'music')
  // =========================================================================
  if (shouldEnableMusic) {
    // Tool 22: search_song (iTunes 曲名指定 楽曲メタデータ検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_song',
      'music',
      '【iTunes公式直結】楽曲タイトル（曲名）を指定して、iTunes公式メタデータ（正確な曲名、高解像度ジャケット画像、30秒試聴音源URL、アーティスト名、リリース日、Apple Musicリンク）をピンポイント検索します。返却: { query, country, count, items: [{ trackName, artistName, previewUrl, artworkUrl }], source }',
      {
        query: z.string().min(1).describe('検索曲名・楽曲タイトル (例: "アイドル", "夜に駆ける", "Subtitle")'),
        country: z.string().optional().describe('国コード (デフォルト: "jp")').meta({ default: 'jp' }),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)').meta({ default: 20 }),
      },
      async (opts) => {
        try {
          const result = await searchSong(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Artist search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['楽曲検索', '楽曲', '曲名', '曲の検索', '曲', '歌', 'ソング', 'iTunes', '音楽', 'Apple Music', 'ミュージック'] },
    );

    // Tool 23: search_artist (iTunes アーティスト名指定 音楽・アルバム・アーティスト検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_artist',
      'music',
      '【iTunes公式直結】アーティスト名を指定して、公式メタデータから指定アーティストの代表曲一覧、アルバム一覧、アーティスト基本情報（Apple Musicリンク等）を正確に取得します。※歌手・アーティスト公式カタログメタデータを検索します。ライブ・公演日程や最新の出演スケジュール・最新活動情報は search_deep または search_realtime を使用してください。返却: { query, country, count, items, source }',
      {
        query: z.string().min(1).describe('アーティスト名 (例: "YOASOBI", "Official髭男dism", "Ado")'),
        country: z.string().optional().describe('国コード (デフォルト: "jp")').meta({ default: 'jp' }),
        entity: z.enum(['song', 'album', 'musicArtist']).optional().describe('検索エンティティ: "song" (楽曲一覧), "album" (アルバム一覧), "musicArtist" (アーティスト情報) (デフォルト: "song")').meta({ default: 'song' }),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)').meta({ default: 20 }),
      },
      async (opts) => {
        try {
          const result = await searchArtist(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Artist search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['アーティスト検索', 'アーティスト', 'ディスコグラフィ', '歌手', 'バンド', 'ミュージシャン', 'iTunes', 'アルバム'] },
    );

    // Tool 24: search_music (iTunes 音楽・アルバム・アーティスト汎用検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_music',
      'music',
      '【iTunes公式直結】楽曲・アルバム・アーティストの複合キーワード全文検索をiTunes公式メタデータに対して行います（曲名・アーティスト名が明確な場合は search_song / search_artist を推奨）。返却: { query, country, entity, count, items, source }',
      {
        query: z.string().min(1).describe('検索キーワード (曲名、アーティスト名、アルバム名の自由入力)'),
        country: z.string().optional().describe('国コード (デフォルト: "jp")').meta({ default: 'jp' }),
        entity: z.enum(['song', 'album', 'musicArtist']).optional().describe('検索エンティティ: "song", "album", "musicArtist" (デフォルト: "song")').meta({ default: 'song' }),
        attribute: z.enum(['songTerm', 'artistTerm', 'albumTerm']).or(z.string()).optional().describe('属性絞り込み: "songTerm" (曲名), "artistTerm" (アーティスト名), "albumTerm" (アルバム名)'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)').meta({ default: 20 }),
      },
      async (opts) => {
        try {
          const result = await searchMusic(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Music search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['汎用音楽検索', '音楽検索', '音楽', '楽曲', '曲', 'アルバム', 'iTunes', 'ミュージック'] },
    );
  }

  // =========================================================================
  // 🏛️ Category 8: Government & Law Data (モジュール: 'gov')
  // =========================================================================
  if (shouldEnableGov) {
    // Tool 25: search_laws (e-Gov キーワード法令検索) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_laws',
      'gov',
      '【必須・推測回答厳禁】日本の法律・政令・府省令の検索・調査では、学習知識で条文番号や法令名を推測せず、必ずデジタル庁・総務省公式e-Gov法令API v2直結の本ツールを実行してください。現行法令名、法令番号、公布年月日の一覧を取得します。返却: { count, items: [{ id, title, lawNum, enforcementDate }], source }',
      {
        keyword: z.string().min(1).describe('法令検索キーワード (例: "著作権法", "労働基準法", "民法")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)').meta({ default: 20 }),
      },
      async (opts) => {
        try {
          const result = await searchLaws(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Law search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['法令検索', '法律', '政令', 'e-Gov', '条文検索'] },
    );

    // Tool 26: get_law_text (e-Gov 法令条文詳細取得) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'get_law_text',
      'gov',
      '【公式条文直結・創作厳禁】日本の法令条文の確認では、架空の条文・条項を創作（法律ハルシネーション）せず、必ず本ツールで公式e-Govの正確な条文Markdownを取得してください。章・節・条・項・号が正確に構造化された本文を返します。返却: { id, title, lawNum, markdown, articleCount, source }',
      {
        lawId: z.string().min(1).describe('e-Gov 法令ID (例: "129AC0000000089")'),
      },
      async (opts) => {
        try {
          const result = await getLawData(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Law data error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['法令条文取得', '条文', 'e-Gov', '法律本文'] },
    );

    // Tool: search_diet_minutes (国会会議録 発言・答弁全文検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'search_diet_minutes',
      'gov',
      '【公式議事録直結】国会（衆議院・参議院）の本会議・委員会における議員・閣僚・総理大臣の発言・答弁は推測せず、国立国会図書館公式APIにより戦後〜最新（2026年）までの公式議事録全文を検索してください。法律の立法趣旨や政策議論のファクトチェックに必須です。返却: { count, totalHits, items: [{ speaker, date, title }], source }',
      {
        keyword: z.string().optional().describe('検索キーワード・質問内容 (例: "人工知能", "少子化対策")'),
        speaker: z.string().optional().describe('発言者名・議員名・閣僚名 (例: "総理大臣", "河野太郎")'),
        nameOfHouse: z.enum(['衆議院', '参議院']).optional().describe('院名 ("衆議院" または "参議院")'),
        nameOfMeeting: z.string().optional().describe('委員会名・本会議名 (例: "予算委員会", "本会議", "内閣委員会")'),
        from: z.string().optional().describe('開会日付範囲 開始 (YYYY-MM-DD)'),
        until: z.string().optional().describe('開会日付範囲 終了 (YYYY-MM-DD)'),
        limit: z.number().int().min(1).max(30).optional().describe('取得件数 (1〜30, デフォルト: 10)').meta({ default: 10 }),
      },
      async (opts) => {
        try {
          const result = await searchDietMinutes(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Diet minutes search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['国会会議録', '国会', '国会議事録', '答弁', '衆議院', '参議院', '委員会', '議員発言', '立法趣旨'] },
    );
  }

  // =========================================================================
  // 🚢 Category: Trade Compliance (モジュール: 'trade')
  // =========================================================================
  if (shouldEnableTrade) {
    // Tool: check_cpsc_certificate (CPSC 適合証明書eFiling義務化判定) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'check_cpsc_certificate',
      'trade',
      '【必須・即時推測厳禁】米国CPSC適合証明書（GCC/CPC）要否および2026年7月完全義務化されたCBP ACE電子申告（eFiling）義務を判定する際は、推測せず必ず本ツールを実行してください。非対象時のACE免責申告コード(Disclaimer)や根拠条文（16 CFR）を提示します。素材や年齢層が不明な場合は推測で埋めず未指定/unknownで呼び出すこと。不足時は確認質問(clarifyingQuestions)と影響説明を返却します。返却: { certificateRequired, eFilingRequired, applicableRegulations, clarifyingQuestions, impactExplanation }',
      {
        htsCode: z.string().min(1).describe('HTSコード（例: "9503.00.0073"）。判定の主軸キー'),
        targetAge: z.enum(['adult', 'child', 'unknown']).describe('対象年齢層（child: 12歳以下, adult: 一般/大人, unknown: 未指定/不明）。【推測値の入力厳禁】不明な場合は"unknown"を指定すること'),
        material: z.string().optional().describe('主な素材（鉛・フタル酸エステル規制関連で重要）。【推測値の入力厳禁】不明な場合は省略すること'),
        productCategory: z.string().optional().describe('製品カテゴリの補足（例: toy, furniture, electronics, textile）。【推測値の入力厳禁】不明な場合は省略すること'),
        description: z.string().optional().describe('自由記述の補足説明'),
      },
      async (opts) => {
        try {
          const result = await checkCpscCertificate(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `CPSC certificate check error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['CPSC', 'GCC', 'CCC', 'eFiling', '適合証明書', '輸出', '輸入', 'HTS', '貿易', 'コンプライアンス'] },
    );

    // Tool: check_fda_regulated (FDA規制対象実務判定 FD1〜FD4) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'check_fda_regulated',
      'trade',
      '【必須・即時推測厳禁】米国FDA規制対象（FD1〜FD4フラグ・Prior Notice要否・MoCRA・ACE免責Disclaimer要件）を判定する際は、推測せず必ず本ツールを実行してください。食器・調理器具の食品接触用途が不明な場合は推測で埋めず省略すること。判定影響と確認質問(clarifyingQuestions)を返却します。返却: { fdaRegulatedLikely, fdFlag, possiblePrograms, priorNoticeRequired, clarifyingQuestions, impactExplanation }',
      {
        htsCode: z.string().min(1).describe('HTSコード（例: "3004.90.0000", "2106.90.9998"）'),
        productDescription: z.string().optional().describe('製品の自由記述説明（用途・素材等の補助情報）'),
        foodContact: z.boolean().optional().describe('食品・飲料接触用途か（true: 接触, false: 非接触）。食器・調理器具(Chapter 39/69/70/73等)のFDA適用分岐に使用。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
      },
      async (opts) => {
        try {
          const result = checkFdaRegulated(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `FDA regulation check error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['FDA', '食品医薬品局', 'Prior Notice', '事前通知', 'FD Flag', 'MoCRA', '輸出', '輸入', 'HTS', '貿易', 'コンプライアンス'] },
    );

    // Tool: verify_hts_code (HTS/HSコード実在確認・検証) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'verify_hts_code',
      'trade',
      '【公式照合・推測厳禁】ユーザーから明示提示されたHTSコードを米国USITC公式データ(hts.usitc.gov)と照合し実在検証・正式品目名・一般関税率を取得します。HTS Revision 18等の大統領布告・通商法301条Chapter 99特別追加関税リスクも提示。6桁一致時は詳細仕様の確認質問(clarifyingQuestions)を返却します。返却: { verified, matchLevel, officialDescription, generalRate, clarifyingQuestions }',
      {
        htsCode: z.string().min(1).describe('検証したいHTSコード（例: "9503.00.0073"）。【推測入力禁止】ユーザーから明示提示された検証対象コードを指定すること'),
        productDescription: z.string().min(1).describe('製品の説明（素材・用途・機能・加工度合い等）。推論根拠の明示'),
      },
      async (opts) => {
        try {
          const result = await verifyHtsCode(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `HTS code verification error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['HTS', 'HSコード', '関税分類', 'USITC', '実在確認', '検証', '関税率', '輸出', '輸入', '貿易', 'コンプライアンス'] },
    );

    // Tool: predict_hts_code (商品情報からのHTS/HSコード推測エンジン) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'predict_hts_code',
      'trade',
      '【必須・即時推測厳禁】商品名・説明文・素材・用途からUSITC公式現行関税率表とセマンティック照合を行い、米国通関用10桁HTSコード候補、一般関税率、CPSC/FDA規制要件を自動推測します。【推測値のでっち上げ厳禁】素材・年齢・食品接触・電池等が不明な場合は勝手に埋めず省略して呼び出すこと。実務的影響(impactExplanation)と確認質問(clarifyingQuestions)を返却し追加ヒアリングを誘導します。返却: { detectedSubheading, bestMatch, candidates, clarifyingQuestions, impactExplanation }',
      {
        productName: z.string().min(1).describe('商品名・品名（例: "Wooden Building Blocks for Toddlers", "Ceramic Coffee Mug", "Green Tea"）'),
        description: z.string().optional().describe('商品の詳細説明、機能、用途など'),
        material: z.string().optional().describe('主な素材（例: wood, ceramic, cotton, stainless steel, plastic）。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
        productCategory: z.string().optional().describe('製品カテゴリ（例: Toys, Tableware, Apparel, Cosmetics, Food, Electronics）。【推測値の入力厳禁】不明な場合は省略すること'),
        targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下, adult: 大人/一般, unknown: 不明）。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
        foodContact: z.boolean().optional().describe('食品・飲料接触用途か（true/false）。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
        hasBattery: z.boolean().optional().describe('電池・バッテリーを搭載しているか（true/false）。【推測値のでっち上げ厳禁】不明な場合は省略すること'),
      },
      async (opts) => {
        try {
          const result = await predictHtsCode(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `HTS code prediction error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['HTS推測', 'HS推測', '関税分類推測', 'コード検索', 'USITC', '輸出', '輸入', '貿易', 'コンプライアンス'] },
    );

    // Tool: check_product_compliance (商品統合コンプライアンス一括判定) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'check_product_compliance',
      'trade',
      '【必須・即時推測厳禁】商品ページURLや品名・素材から、HTS推測・実在検証・FDA実務判定・CPSC証明書および2026年7月eFiling義務を一連のパイプラインとして一括実行し、通関前アクションプランを含む総合診断レポートを返します。HTSコードを推定したい場合はhtsCode引数を必ず未指定（省略）にしてください。未指定時にSoraのUSITC公式推測エンジンが自動特定します。LLM独自の推測HTSコードを渡すことは厳禁です。返却: { product, overallStatus, summary, htsVerification, htsPrediction, fda, cpsc, clarifyingQuestions, impactExplanation, actionPlan }',
      {
        url: z.string().url().optional().describe('商品ページのURL（Amazon、ECサイト、メーカー公式等。指定時は自動でスクレイピングして商品情報を取得）'),
        productName: z.string().optional().describe('商品名・タイトル（例: "Wooden Building Blocks for Toddlers", "薬用美白クリーム", "Bicycle Helmet"）'),
        description: z.string().optional().describe('商品の詳細説明・仕様・素材・用途など'),
        htsCode: z.string().optional().describe('ユーザーからプロンプト内で明示的に提示された既知のHTSコード（指定時は最優先で検証）。【LLM自身の推測・候補値の入力厳禁！】HTSコードを推測・特定したい場合は必ず省略（未指定）にすること。未指定時にSoraのUSITC公式推測エンジンが自動で高精度に特定します'),
        targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下の子供向け, adult: 一般/大人向け, unknown: 未指定/不明）。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
        material: z.string().optional().describe('主な素材（例: plastic, wood, metal, cotton）。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
        productCategory: z.string().optional().describe('製品カテゴリ（例: toy, apparel, cosmetics, food, electronics, helmet）'),
        foodContact: z.boolean().optional().describe('食品・飲料に接触する用途か（true: 飲み物や食べ物を入れる/口をつける等の食品接触用途, false: 装飾等の非食品接触用途）。Kitchenware等のカテゴリでFDA食品接触安全基準の判定要否に必要。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
        hasBattery: z.boolean().optional().describe('電池・バッテリーを使用する製品か（true: ボタン電池・コイン電池またはリチウムイオン電池等を内蔵/同梱, false: 電池不使用）。Electronics等のカテゴリでCPSC規制カテゴリ判定・DOT/PHMSA危険物表示要否に必要。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
        batteryType: z.enum(['button_coin', 'other']).optional().describe('電池の種類（button_coin: ボタン電池・コイン電池, other: リチウムイオン電池等その他の電池）。hasBattery=trueの場合のみ意味を持つ。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
      },
      async (opts) => {
        try {
          const result = await checkProductCompliance(opts);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Product compliance check error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['商品判定', 'コンプライアンス', 'FDA', 'CPSC', 'eFiling', 'GCC', 'CCC', 'HTS', '貿易一括判定', '輸出', '輸入'] },
    );
  }

  // =========================================================================
  // 📷 Category 9: Media & Vision (モジュール: 'media')
  // =========================================================================
  if (shouldEnableMedia) {
    // Tool: inspect_image (画像取得 & マルチモーダル視覚入力 Base64 返却) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'inspect_image',
      'media',
      '【画像視覚解析・マルチモーダル入力】WebページやSNS投稿内の重要画像URL（チラシ、時刻表、表、図等）を取得し、MCP ImageContent（Base64）として直接AIに視覚入力します。※単なるアイキャッチや装飾画像には呼び出さず、テキスト回答に不可欠な画像に限定してください。返却: ImageContent',
      {
        url: z.string().url().describe('読み取り対象の画像URL (https://...)'),
      },
      async (opts) => {
        try {
          const result = await inspectImage(opts);
          return {
            content: [
              {
                type: 'image',
                data: result.imageContent.data,
                mimeType: result.imageContent.mimeType,
              },
              {
                type: 'text',
                text: result.markdown || `Image loaded: ${result.url}`,
              },
            ],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Image inspection error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['画像', 'チラシ', 'タイムテーブル', '告知', 'ポスター', '写真', 'スクリーンショット', '視覚', 'inspect', 'image', 'media'] },
    );
  }

  // =========================================================================
  // 🌍 Category 9: Country & Region Intelligence (モジュール: 'intel')
  // =========================================================================
  if (shouldEnableIntel) {
    registerStructuredTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'research_country_context',
      'intel',
      '【国地域インテリジェンス・証拠基盤】指定した国・地域の政治・経済・安全・災害・保健・旅行・カレンダー・世論調査を分野横断で取得します。初回応答は代表証拠、全件はcontextIdで参照可能。評価・推奨は含めません。限界: 一部証拠は公表日時なし、SNSは対象言語・範囲限定、未観測範囲の明示は呼出元が確認すること。本ツール単独で判断の十分性を保証しない。調査手順はリソース sora-skill://sora-deep-research を読む。返却: CountryContextReport',
      {
        region: z.string().min(1).describe('国・地域名またはコード (例: "South Korea", "KR", "台湾")'),
        query: z.string().optional().describe('追加の調査クエリ'),
        topics: z.array(z.enum(COUNTRY_INTEL_TOPICS)).optional().describe('対象トピック (politics, economy, disasters 等)'),
        period: z.enum(['7d', '30d', '90d']).optional().default('30d').describe('調査期間 (デフォルト: "30d")'),
        includeSocial: z.boolean().optional().default(false).describe('SNS投稿観測を含めるか (日本はYahooリアルタイムの日本語投稿も取得。地域・言語の不足は明示)'),
        social: IntelSocialInputSchema.optional().describe('SNS観測条件 (platforms/queries/urls/lookbackHours)'),
        noCache: z.boolean().optional().default(false).describe('キャッシュをバイパスするか'),
        verbose: z.boolean().optional().default(false).describe('全件の詳細出力を要求するか (既定は分野別の代表証拠)'),
      },
      CountryContextReportSchema,
      async (opts) => {
        try {
          const research = options?.intelResearch ?? (async (request: unknown) => {
            const { researchCountryWithDefaults } = await import('./services/country_intel/runtime.js');
            return researchCountryWithDefaults(request as never);
          });
          const result = (await research(opts)) as CountryContextReport;
          const text = JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text }], structuredContent: result as never };
        } catch (err: unknown) {
          return { isError: true, content: [{ type: 'text', text: `Country intelligence error: ${err instanceof Error ? err.message : err}` }] };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['国地域', 'カントリー', 'country', '地域情勢', '海外情勢', 'intel', 'intelligence', 'コンテキスト'] },
    );
    registerStructuredTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'get_country_context',
      'intel',
      '保存済み国地域レポートをcontextIdで取得します。返却: CountryContextReport',
      {
        contextId: z.string().min(1).describe('コンテキストID'),
      },
      CountryContextReportSchema,
      async (opts) => {
        try {
          const { getPersistedCountryContext } = await import('./services/country_intel/report.js');
          const result = getPersistedCountryContext(opts.contextId) as CountryContextReport | undefined;
          if (!result) return { isError: true, content: [{ type: 'text', text: 'Country context not found: ' + opts.contextId }] };
          const text = JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text }], structuredContent: result as never };
        } catch (err: unknown) {
          return { isError: true, content: [{ type: 'text', text: 'Country intelligence error: ' + (err instanceof Error ? err.message : err) }] };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['国地域', 'コンテキスト', 'context', 'スナップショット'] },
    );
    registerStructuredTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'get_country_context_evidence',
      'intel',
      'レポートの根拠原文・構造化データをページ取得します。属さないIDは拒否。',
      {
        contextId: z.string().min(1).describe('コンテキストID'),
        evidenceIds: z.array(z.string()).optional().describe('根拠ID一覧 (省略時はページ走査)'),
        cursor: z.string().optional().describe('次ページカーソル'),
        limit: z.number().int().min(1).max(100).optional().describe('取得件数 (1〜100, デフォルト: 40)').meta({ default: 40 }),
      },
      EvidencePageSchema,
      async (opts) => {
        try {
          const { getEvidencePage } = await import('./services/country_intel/db.js');
          const result = getEvidencePage(opts.contextId, { ids: opts.evidenceIds, cursor: opts.cursor, limit: opts.limit });
          const text = JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text }], structuredContent: result as never };
        } catch (err: unknown) {
          return { isError: true, content: [{ type: 'text', text: 'Country intelligence error: ' + (err instanceof Error ? err.message : err) }] };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['国地域', '根拠', 'evidence', '原文', '詳細'] },
    );
    registerStructuredTool(
      mcpServer,
      toolCatalog,
      sessionActivated,
      'get_country_context_updates',
      'intel',
      '前回以降の追加・訂正・削除・取得障害の差分を取得します。',
      {
        contextId: z.string().min(1).describe('コンテキストID'),
        cursor: z.string().optional().describe('差分カーソル'),
      },
      ContextUpdatesSchema,
      async (opts) => {
        try {
          const { getContextUpdates } = await import('./services/country_intel/db.js');
          const result = getContextUpdates(opts.contextId, opts.cursor);
          const text = JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text }], structuredContent: result as never };
        } catch (err: unknown) {
          return { isError: true, content: [{ type: 'text', text: 'Country intelligence error: ' + (err instanceof Error ? err.message : err) }] };
        }
      },
      { defaultEnabled: deferredDefault, keywords: ['国地域', '更新', '差分', 'updates'] },
    );
  }

  // =========================================================================
  // 🔍 Category 10: Tool Discovery & Dynamic Activation (メタツール) - CORE (defaultEnabled: true)
  // =========================================================================
  mcpServer.tool(
    'search_tools',
    '【追加ツール検索・動的有効化】現在 tools/list に表示されていないSoraの追加ツールをキーワードで検索し、' +
      '一致したツールを現在のセッションで有効化します。すでに tools/list に表示されているツールは直接実行してください。' +
      '荷物追跡（track_package）やフライト情報（get_flight_status）、音楽詳細、国会会議録など、初期状態で非表示の追加機能を利用する際に使用します。' +
      '本ツールで検索しても見つからない場合は、該当モジュールが無効化・利用不可となっている可能性があります。' +
      '現在 tools/list に表示されている利用可能なツールや他の手段を使用してください。',
    {
      query: z.string().describe('検索キーワードまたはカテゴリ名（例: "荷物追跡", "ヤマト", "佐川", "郵便", "UPS", "音楽", "国会", "trade", "life"）'),
    },
    async ({ query }) => {
      const matches = searchCatalog(toolCatalog, query);
      const newlyEnabled: string[] = [];
      const alreadyEnabled: string[] = [];

      for (const entry of matches) {
        sessionActivated.add(entry.name);
        if (!entry.handle.enabled) {
          entry.handle.enable();
          entry.compatibilityHandle?.enable();
          const cleanDesc = entry.description.replace(/^【.*?】/, '').slice(0, 80);
          const tag = entry.description.match(/^【(.*?)】/)?.[0] || '';
          newlyEnabled.push(`- ${entry.name}: ${tag}${cleanDesc}... (状態: 有効化完了)`);
        } else {
          alreadyEnabled.push(`- ${entry.name} (状態: 既に有効)`);
        }
      }

      if (newlyEnabled.length === 0 && alreadyEnabled.length === 0) {
        const activeCategories: string[] = [];
        if (shouldEnableWeb) activeCategories.push('web (一括/クロール)');
        if (shouldEnableBrowser) activeCategories.push('browser (操作)');
        if (shouldEnableYahoo) activeCategories.push('yahoo (知恵袋/画像/動画/ニュース/リアルタイム/トレンド)');
        if (shouldEnableLife) activeCategories.push('life (天気/乗換/荷物追跡)');
        if (shouldEnableDisaster) activeCategories.push('disaster (道路交通/警報/地震)');
        if (shouldEnableWatch) activeCategories.push('watch (Web監視)');
        if (shouldEnableMusic) activeCategories.push('music (楽曲/歌手)');
        if (shouldEnableGov) activeCategories.push('gov (法令)');
        if (shouldEnableTrade) activeCategories.push('trade (輸出/HTS/CPSC/FDA)');
        if (shouldEnableMedia) activeCategories.push('media (画像検査)');

        const categoryText = activeCategories.length > 0
          ? `\n現在有効なカテゴリ: ${activeCategories.join(', ')}`
          : '';

        return {
          content: [
            {
              type: 'text',
              text: `"${query}" に一致する追加ツールは見つかりませんでした。\n該当機能のサーバーモジュールが無効化・利用不可となっている可能性があります。${categoryText}`,
            },
          ],
        };
      }

      const messages: string[] = [];
      if (newlyEnabled.length > 0) {
        messages.push(`以下のツールをセッション内で有効化しました:\n${newlyEnabled.join('\n')}\n\n対象ツールを直接呼び出してください。`);
      }
      if (alreadyEnabled.length > 0) {
        messages.push(`以下のツールはすでに有効化されています:\n${alreadyEnabled.join('\n')}`);
      }

      return {
        content: [{ type: 'text', text: messages.join('\n\n') }],
      };
    },
  );

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
    if (m && m[1]) return tenantIdForApiKey(m[1].trim());
    const key = req.headers.get('x-api-key');
    if (key && key.trim()) return tenantIdForApiKey(key.trim());
  } catch {}
  return 'legacy';
}

export class McpSessionManager {
  private sessions = new Map<string, McpSessionEntry>();
  private cleanupInterval: any;
  private readonly sessionTtlMs: number;

  constructor(options?: { sessionTtlMs?: number }) {
    this.sessionTtlMs = options?.sessionTtlMs ?? 60 * 60 * 1000; // 1時間 TTL
    this.cleanupInterval = setInterval(() => this.cleanupStaleSessions(), 5 * 60 * 1000);
    if (typeof this.cleanupInterval === 'object' && 'unref' in this.cleanupInterval) {
      this.cleanupInterval.unref();
    }
  }

  /** Route HTTP requests to their session without sharing activation state. */
  public async handleRequest(req: Request, options?: { parsedBody?: any }): Promise<Response> {
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
          result.tools = result.tools.map((t: any) => ({
            ...t,
            inputSchema: sanitizeJsonSchemaForGemini(t.inputSchema),
          }));
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

    let pingTimer: any = null;

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
                parsed.result.tools = parsed.result.tools.map((t: any) => ({
                  ...t,
                  inputSchema: sanitizeJsonSchemaForGemini(t.inputSchema),
                }));
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

export function createMcpTransport(options?: any) {
  return new WebStandardStreamableHTTPServerTransport(options);
}
