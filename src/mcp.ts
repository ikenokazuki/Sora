import { McpServer, type RegisteredTool, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  scrapeUrl,
  scrapeBatchUrls,
  callYahooMcp,
  searchYahooWeb,
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
} from './scraper.js';
import { formatCompactScrapeResult } from './response_cleaner.js';
import { sanitizeJsonSchemaForGemini } from './schema_sanitizer.js';
import { SORA_VERSION } from './types.js';

export type SoraModule = 'web' | 'browser' | 'yahoo' | 'life' | 'disaster' | 'watch' | 'music' | 'gov' | 'trade' | 'media';
export type GhostFetchModule = SoraModule; // backward-compatibility alias

export interface McpServerOptions {
  modules?: (SoraModule | 'all')[];
  deferTools?: boolean;
}

export interface ToolCatalogEntry {
  name: string;
  category: SoraModule;
  description: string;
  keywords: string[];
  handle: RegisteredTool;
}

/**
 * ツール登録用ヘルパー。
 * defaultEnabled が false の場合は即座に handle.disable() を呼び出して
 * 初期状態では tools/list に露出しないようにし、カタログにメタ情報を保管します。
 */
export function registerTool<Args extends ZodRawShapeCompat>(
  mcpServer: McpServer,
  toolCatalog: Map<string, ToolCatalogEntry>,
  name: string,
  category: SoraModule,
  description: string,
  schema: Args,
  handler: ToolCallback<Args>,
  opts: { defaultEnabled: boolean; keywords?: string[] },
): RegisteredTool {
  const handle = mcpServer.tool(name, description, schema, handler);
  if (!opts.defaultEnabled) {
    handle.disable();
  }
  toolCatalog.set(name, {
    name,
    category,
    description,
    keywords: opts.keywords ?? [],
    handle,
  });
  return handle;
}

/**
 * ツールカタログからキーワードにマッチするエントリを検索します。
 * 空白区切りの複数キーワードに対応し、ツール名・カテゴリ名・キーワード配列・説明文のいずれかに
 * 部分一致するツールを抽出します。
 */
export function searchCatalog(
  toolCatalog: Map<string, ToolCatalogEntry>,
  query: string,
): ToolCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const terms = q.split(/\s+/).filter(Boolean);
  const allMatches: ToolCatalogEntry[] = [];
  const someMatches: ToolCatalogEntry[] = [];

  for (const entry of toolCatalog.values()) {
    const isMatch = (term: string) => {
      return (
        entry.name.toLowerCase().includes(term) ||
        entry.category.toLowerCase().includes(term) ||
        entry.keywords.some((k) => k.toLowerCase().includes(term)) ||
        entry.description.toLowerCase().includes(term)
      );
    };

    if (terms.every(isMatch)) {
      allMatches.push(entry);
    } else if (terms.some(isMatch)) {
      someMatches.push(entry);
    }
  }

  return allMatches.length > 0 ? allMatches : someMatches;
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

export const SORA_MCP_INSTRUCTIONS = `# Sora MCP Server - AI Interaction & Tool Routing Guidelines

## 1. Zero-Refusal & Active Investigation Policy
- **NEVER refuse to answer or give up by claiming "a specific tool is not available"** (e.g. "I have no tool for live concert schedules, business hours, release dates, etc.").
- If a query asks for factual, real-time, time-sensitive, or external information not covered by a Tier 1 specialized domain tool, **you MUST ALWAYS use the Universal Search tools (\`search_deep\` or \`search_web\`)** to actively investigate official websites, announcements, schedules, and documents from the web.

## 2. Two-Tier Tool Decision Framework

### Tier 1: Official Specialized Domain Directives (MANDATORY TOOL CALL)
For queries strictly within the following 6 domains, **NEVER answer using internal parametric knowledge, estimations, or general web search**. You MUST invoke the corresponding specialized Sora MCP tool:
1. US Export Compliance & Tariffs (HTS classification, CPSC certificates & 2026 eFiling mandate, FDA PGA flags FD1-FD4): Use 'trade' tools (predict_hts_code, check_cpsc_certificate, check_fda_regulated, verify_hts_code, check_product_compliance).
2. Japanese Laws & Diet Minutes (Official e-Gov API v2, National Diet Library minutes): Use 'gov' tools (search_laws, get_law_text, search_diet_minutes).
3. Japan Weather & Disaster Information (Japan Meteorological Agency direct CDN, JARTIC road traffic, P2P Earthquake): Use 'disaster' / 'life' tools (get_weather, search_disaster_warnings, search_earthquake, search_road_traffic).
4. Japan Domestic Transit & Flights (Yahoo! Transit IC fares & transfer routes, airport flight delays & cancellations, GSI elevation): Use 'life' / 'disaster' tools (search_route, get_flight_status, get_elevation).
5. Real-time Social Trends & Q&A (X/Twitter realtime posts, trending ranking, Yahoo! Chiebukuro): Use 'yahoo' tools (search_realtime, search_trend, search_chiebukuro, suggest_keywords).
6. Music Metadata & Catalog (Official iTunes API metadata, previews, artwork): Use 'music' tools (search_song, search_artist, search_music).

### Tier 2: Universal Web & Deep Search (ALL OTHER REAL-WORLD QUERIES)
For ANY query requiring up-to-date facts, event dates, or external context outside Tier 1, invoke:
- **\`search_deep\` (Primary Recommended Tool)**:
  Combines web search + deep article scraping (Clean Markdown) + X/Twitter realtime pulse in one shot.
  *Use for*:
  - Live concert schedules, performance dates, match schedules, festivals, timetables
  - Product release dates, specs, pricing, updates, availability
  - Company/store business hours, locations, official statements, news releases
  - Person/entity latest activities, appearances, biographies, award history
  - Current events, breaking news, troubleshooting, technology documentation
- **\`search_web\` (Candidate URL & Snippet Discovery)**:
  Fetches title, URL, and snippet list. *RULE*: If snippets lack specific details (e.g. exact dates, venue times, terms), DO NOT guess or conclude prematurely. You MUST invoke \`scrape\` on the most relevant official URL(s) to read the full content before answering.
- **\`scrape\` / \`scrape_batch\`**:
  Fetches full clean Markdown content from specific URLs identified through search or provided by the user.
- **\`browser_action\`**:
  Use when dynamic browser interactions (clicking, form submission, SPA rendering) are needed.

## 3. Interactive Clarification Flow
- When tools return 'inputCompleteness: "partial"' or 'clarifyingQuestions', do not guess missing parameters (e.g., material, target age). Promptly present the returned questions and impact explanation to the user to obtain accurate specifications.`;

export function createMcpServer(options?: McpServerOptions): McpServer {
  const mcpServer = new McpServer(
    {
      name: 'Sora',
      version: SORA_VERSION,
    },
    {
      instructions: SORA_MCP_INSTRUCTIONS,
    },
  );

  const toolCatalog = new Map<string, ToolCatalogEntry>();
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

  // =========================================================================
  // 🌐 Category 1: Core Web & Crawling (モジュール: 'web')
  // =========================================================================
  if (shouldEnableWeb) {
    // Tool 1: scrape (単一 URL / PDF スクレイプ) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      'scrape',
      'web',
      '【単一URL・PDF本文抽出】指定した URL の Web ページまたは PDF をスクレイピングし、記事本文をクリーンな Markdown に変換して返却します。動的・SPA サイトは DOM Quiescence（静止検知）と一時 BrowserContext 分離により、不要アセットを高速遮断しながら安全・高速に描画完了を待機。イベント構造化（Schema.org Event/MusicEvent）、パンくず階層パス、テーブル結合セル（colspan/rowspan）の2D正規化、および重要告知画像（フライヤー・タイムテーブル・図表）スコアリングに対応。※返却: { title, content, events, breadcrumb, images, tables, pageType, publishedTime, author, siteName, ... }',
      {
        url: z.string().url().describe('スクレイピング対象の完全な URL (http/https) (例: "https://example.com/article")'),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .optional()
          .describe('抽出する最大文字数 (デフォルト: 30000)'),
        mode: z
          .enum(['auto', 'fast', 'browser'])
          .optional()
          .describe('スクレイプ動作モード: "auto" (スマート自動判定, デフォルト), "fast" (静的フェッチ最速限定), "browser" (Stealth Chromium JS完全実行)'),
        formats: z
          .array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables']))
          .optional()
          .describe('取得するコンテンツ形式: "markdown", "html", "rawHtml", "links", "screenshot", "jsonLd", "images", "tables" (デフォルト: ["markdown"])'),
        fullPage: z
          .boolean()
          .optional()
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
          .describe('クエリに関連する重要文（ハイライト）を自動抽出して付与するか (デフォルト: false)'),
        onlyHighlights: z
          .boolean()
          .optional()
          .describe('抽出されたハイライトのみを本文 content として返し、ノイズ全文を削除するか (デフォルト: false)'),
        extractSummary: z
          .boolean()
          .optional()
          .describe('超高速な抽出型自動要約（TL;DR 上位重要文リスト）を生成して付与するか (デフォルト: false)'),
        extractCitations: z
          .boolean()
          .optional()
          .describe('本文内の出典・引用リンク一覧をコンテキスト付きで抽出するか (デフォルト: false)'),
        chunkMarkdown: z
          .boolean()
          .optional()
          .describe('RAG 用に見出しや段落単位でセマンティック・チャンキングした chunks を生成するか (デフォルト: false)'),
        chunkSize: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('チャンキング時の最大文字数目安 (デフォルト: 1000)'),
        validateLinks: z
          .boolean()
          .optional()
          .describe('抽出されたリンクの到達性・HTTPステータスを並行検証するか (デフォルト: false)'),
        formatAsPrompt: z
          .boolean()
          .optional()
          .describe('LLM に最適化された標準 XML プロンプトラッパー形式を生成するか (デフォルト: false)'),
        stripLinks: z
          .boolean()
          .optional()
          .describe('Markdown 内のリンク [テキスト](url) から URL を除去してプレーンテキスト化し、LLM トークンを削減するか (デフォルト: false)'),
        filterLinkDensity: z
          .boolean()
          .optional()
          .describe('リンク密度が極端に高いナビゲーション・タグ一覧・関連記事ブロックを自動パージするか (デフォルト: false)'),
        highlightMatches: z
          .boolean()
          .optional()
          .describe('本文中の検索一致語句をハイライトするか (デフォルト: false)'),
        maskPii: z
          .boolean()
          .optional()
          .describe('メール・電話番号・クレジットカード番号等の個人情報・機密情報を自動マスキングするか (デフォルト: false)'),
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
          .describe('記事本文のみを抽出するか (デフォルト: true)。false にするとナビゲーションやヘッダー/フッターも含めて抽出'),
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
          .describe('接続失敗時の自動リトライ回数 (0〜3, デフォルト: 0)'),
        verbose: z
          .boolean()
          .optional()
          .describe('デバッグ用: quality スコアや evidence 等の内部詳細メタデータを含めるか (デフォルト: false)'),
        keepDataImages: z
          .boolean()
          .optional()
          .describe('base64 インライン画像を Markdown 内で置換せず保持するか (デフォルト: false, [画像: alt] に軽量化)'),
      },
      async ({ url, maxChars, mode, formats, fastOnly, renderJs, extractHighlights, onlyHighlights, extractSummary, extractCitations, chunkMarkdown, chunkSize, validateLinks, formatAsPrompt, stripLinks, filterLinkDensity, highlightMatches, maskPii, webhookUrl, query, onlyMainContent, selectors, clipSelector, headers, removeSelectors, retries, verbose, keepDataImages }) => {
        try {
          const result = await scrapeUrl({ url, maxChars, mode, formats, fastOnly, renderJs, extractHighlights, onlyHighlights, extractSummary, extractCitations, chunkMarkdown, chunkSize, validateLinks, formatAsPrompt, stripLinks, filterLinkDensity, highlightMatches, maskPii, webhookUrl, query, onlyMainContent, selectors, clipSelector, headers, removeSelectors, retries, keepDataImages });
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
      'scrape_batch',
      'web',
      '【複数 URL 一括並行スクレイプ】複数の Web ページ URL を指定し、ドメインスロットリングを維持しながら高速に並行スクレイピングして一括返却します。',
      {
        urls: z.array(z.string().url()).min(1).max(20).describe('スクレイピング対象の URL 配列 (最大 20 件)'),
        concurrency: z.number().int().min(1).max(5).optional().describe('並行フェッチワーカー数 (デフォルト: 3, 最大: 5)'),
        maxChars: z.number().int().min(1).max(50_000).optional().describe('各ページの最大文字数 (デフォルト: 10000)'),
        mode: z.enum(['auto', 'fast', 'browser']).optional().describe('動作モード: "auto" (静的フェッチ失敗時に自動ブラウザ昇格, デフォルト), "fast" (静的HTTPのみ), "browser" (常時Headless Chromium)'),
        formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional().describe('取得フォーマット'),
        selectors: z.record(z.string(), z.string()).optional().describe('特定要素のみをピンポイント抽出する CSS セレクタ連想配列'),
        clipSelector: z.string().optional().describe('指定した要素のみを切り抜く CSS セレクタ'),
        headers: z.record(z.string(), z.string()).optional().describe('リクエスト時に送信するカスタム HTTP ヘッダー連想配列'),
        removeSelectors: z.array(z.string()).optional().describe('除去したいノイズ要素の CSS セレクタ配列'),
        query: z.string().optional().describe('ハイライト抽出用キーワード'),
        extractHighlights: z.boolean().optional().describe('各ページからキーワードに関連する重要文（ハイライト）を自動抽出するか'),
        onlyHighlights: z.boolean().optional().describe('抽出されたハイライトのみを各ページの本文 content として返し、ノイズ全文を削除するか'),
        extractSummary: z.boolean().optional().describe('超高速な抽出型自動要約（TL;DR）を生成するか'),
        extractCitations: z.boolean().optional().describe('本文内の出典・引用リンク一覧を抽出するか'),
        chunkMarkdown: z.boolean().optional().describe('RAG 用セマンティック・チャンキングを行うか'),
        chunkSize: z.number().int().min(1).optional().describe('チャンク文字数目安'),
        validateLinks: z.boolean().optional().describe('抽出リンクの健全性を検証するか'),
        formatAsPrompt: z.boolean().optional().describe('LLM に最適化された標準 XML プロンプトラッパー形式を生成するか'),
        stripLinks: z.boolean().optional().describe('Markdown 内のリンク [テキスト](url) から URL を除去してプレーンテキスト化するか'),
        filterLinkDensity: z.boolean().optional().describe('リンク密度が極端に高いナビゲーション・タグ一覧ブロックを自動パージするか'),
        highlightMatches: z.boolean().optional().describe('本文中の検索一致語句をハイライトするか'),
        maskPii: z.boolean().optional().describe('個人情報・機密情報を自動マスキングするか'),
        webhookUrl: z.string().optional().describe('一括スクレイプ完了時に結果ペイロードを通知する Webhook URL (非同期)'),
        retries: z.number().int().min(0).max(3).optional().describe('接続失敗時の自動リトライ回数 (0〜3)'),
        onlyMainContent: z.boolean().optional().describe('記事本文のみを抽出するか (デフォルト: true)'),
        verbose: z.boolean().optional().describe('デバッグ用: quality スコアや evidence 等の内部詳細メタデータを含めるか (デフォルト: false)'),
      },
      async ({ urls, concurrency, maxChars, mode, formats, selectors, clipSelector, headers, removeSelectors, query, extractHighlights, onlyHighlights, extractSummary, extractCitations, chunkMarkdown, chunkSize, validateLinks, formatAsPrompt, stripLinks, filterLinkDensity, highlightMatches, maskPii, webhookUrl, retries, onlyMainContent, verbose }) => {
        try {
          const result = await scrapeBatchUrls({ urls, concurrency, maxChars, mode, formats, selectors, clipSelector, headers, removeSelectors, query, extractHighlights, onlyHighlights, extractSummary, extractCitations, chunkMarkdown, chunkSize, validateLinks, formatAsPrompt, stripLinks, filterLinkDensity, highlightMatches, maskPii, webhookUrl, retries, onlyMainContent });
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
      { defaultEnabled: deferredDefault, keywords: ['一括スクレイプ', '並行', '複数URL', 'バッチ'] },
    );

    // Tool 2: search_deep (超高精度 統合検索・本文一括取得) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      'search_deep',
      'web',
      '【万能深層Web検索・最新事実/スケジュール/イベント調査】Web 検索に加え、上位サイトの本文スクレイピング（Clean Markdown）＋リアルタイム速報（X）を一括取得して返却します。ライブ・公演日程、新製品・発売日、営業時間・店舗情報、人物・企業の最新動向、時事ニュースなど、専用APIが存在しないあらゆる実世界データの調査に必須の一次ツールです。1回の呼び出しで記事本文まで深く読み込んで包括的・根拠ある回答を作成します（広く候補URL一覧を探したい場合は search_web を使用）。※他の専門機能や拡張ツールが必要な場合は、まず search_tools で専用ツールを検索・有効化してください。',
      {
        query: z.string().min(1).describe('検索キーワード (例: "TypeScript 5.5 新機能", "最新AI動向")'),
        limit: z.number().int().min(1).max(20).optional().describe('スクレイピングする上位結果の件数 (デフォルト: 5, 最大: 20)'),
        scrapeContent: z.boolean().optional().describe('上位結果のページ本文を取得するか (デフォルト: true)'),
        includeRealtime: z.boolean().optional().describe('リアルタイム速報（Xの生の声）を含めるか (デフォルト: true)'),
        realtimeSort: z.enum(['recent', 'popular']).optional().describe('リアルタイム速報の並び順: "recent" (新着順, デフォルト) または "popular" (話題順)'),
        maxChars: z.number().int().min(1).max(50_000).optional().describe('各ページの最大文字数 (デフォルト: 10000)'),
        includeDomains: z.array(z.string()).optional().describe('検索結果を絞り込むドメインリスト'),
        excludeDomains: z.array(z.string()).optional().describe('除外するドメインリスト'),
        formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional().describe('取得するコンテンツ形式: "markdown", "html", "rawHtml", "links", "screenshot", "jsonLd", "images", "tables" (デフォルト: ["markdown"])'),
        extractHighlights: z.boolean().optional().describe('各ページからクエリに関連する重要文（ハイライト）を自動抽出して付与するか (デフォルト: false)'),
        dedup: z.boolean().optional().describe('検索結果およびリアルタイム速報の重複・類似項目を自動排除するか (デフォルト: false)'),
        onlyMainContent: z.boolean().optional().describe('記事本文のみを抽出するか (デフォルト: true)'),
        verbose: z.boolean().optional().describe('デバッグ用: 内部詳細メタデータを含めるか (デフォルト: false)'),
      },
      async ({ query, limit, scrapeContent, includeRealtime, realtimeSort, maxChars, includeDomains, excludeDomains, formats, extractHighlights, dedup, onlyMainContent, verbose }) => {
        try {
          const result = await integratedSearch({
            query,
            limit,
            scrapeContent,
            includeRealtime,
            realtimeSort,
            maxChars,
            includeDomains,
            excludeDomains,
            formats,
            extractHighlights,
            dedup,
            onlyMainContent,
            verbose,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['深層検索', '統合検索', 'Web検索', '本文取得', 'X速報', 'スケジュール', 'イベント', 'ライブ日程', '発売日', '営業時間', '最新情報'] },
    );

    // Tool 3: map_site (サイトマップ探索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'map_site',
      'web',
      '【サイトマップ探索】指定 URL のサイトマップ (sitemap.xml) またはページ内リンクを探索し、サイト内の全 URL 一覧を高速抽出します。ドメイン全体のページ構成把握に最適です。',
      {
        url: z.string().url().describe('探索対象の Web サイト URL (例: "https://example.com")'),
        limit: z.number().int().min(1).max(1000).optional().describe('取得する最大 URL 件数 (デフォルト: 200, 最大: 1000)'),
        since: z.string().optional().describe('指定した日付・日時以降に更新されたページのみを抽出するフィルタ (例: "2026-08-01", "2026-01-01T00:00:00Z")'),
      },
      async ({ url, limit, since }) => {
        try {
          const result = await mapSiteUrl({ url, limit, since });
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
      'crawl_site',
      'web',
      '【サイト内再帰クロール】指定 URL を起点として同一ドメイン配下の Web ページを再帰的に巡回（クロール）し、各ページの Markdown 本文を一括収集します。ドキュメントサイト等のまとめ読みに最適です。',
      {
        url: z.string().url().describe('クロール開始 URL (例: "https://example.com/docs")'),
        maxPages: z.number().int().min(1).max(50).optional().describe('巡回する最大ページ数 (デフォルト: 10, 最大: 50)'),
        maxChars: z.number().int().min(1).max(50_000).optional().describe('1ページあたりの最大文字数 (デフォルト: 15000)'),
        includePatterns: z.array(z.string()).optional().describe('クロール対象を絞り込むワイルドカードパターン一覧 (例: ["/docs/**", "/guide/*"])'),
        excludePatterns: z.array(z.string()).optional().describe('クロールから除外するワイルドカードパターン一覧 (例: ["/tag/**", "*.pdf"])'),
        formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images'])).optional().describe('取得するコンテンツ形式 (デフォルト: ["markdown"])'),
        query: z.string().optional().describe('巡回ページからハイライトを抽出するキーワード'),
        extractHighlights: z.boolean().optional().describe('巡回した各ページからキーワードに関連する重要文（ハイライト）を自動抽出するか'),
        onlyHighlights: z.boolean().optional().describe('抽出されたハイライトのみを各ページの本文 content として返し、ノイズ全文を削除するか'),
      },
      async ({ url, maxPages, maxChars, includePatterns, excludePatterns, formats, query, extractHighlights, onlyHighlights }) => {
        try {
          const result = await crawlSiteUrl({ url, maxPages, maxChars, includePatterns, excludePatterns, formats, query, extractHighlights, onlyHighlights });
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
      { defaultEnabled: deferredDefault, keywords: ['クロール', '再帰巡回', 'ドメイン探索', '一括収集'] },
    );

    // Tool 5: search_web (基本 Web 検索・概要取得) - CORE (defaultEnabled: true)
    registerTool(
      mcpServer,
      toolCatalog,
      'search_web',
      'web',
      '【万能Web検索・候補探索】Web 検索を実行し、タイトル・概要スニペット・URL 一覧を高速取得します。イベント日程、商品情報、店舗情報、最新ニュース、公式告知などの候補URL一覧を素早く探索・リストアップしたい場合に最適です。※スニペットだけでは不確定・不十分な詳細事項（正確な開場開演時間や規約等）は、ヒットした公式URLを scrape で精読するか search_deep を使用してください。',
      {
        query: z.string().min(1).describe('検索キーワード (例: "東京都 天気", "Next.js 15")'),
        includeDomains: z.array(z.string()).optional().describe('結果を絞り込むドメインリスト (例: ["natalie.mu", "oricon.co.jp"])'),
        excludeDomains: z.array(z.string()).optional().describe('結果から除外するドメインリスト'),
        updated: z.enum(['all', 'day', 'week', 'year']).optional().describe('期間指定: "all"(指定なし), "day"(24時間以内), "week"(1週間以内), "year"(1年以内)'),
      },
      async ({ query, includeDomains, excludeDomains, updated }) => {
        try {
          const result = await searchYahooWeb({ query, includeDomains, excludeDomains, updated });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Search error: ${err?.message || err}` }],
          };
        }
      },
      { defaultEnabled: true, keywords: ['Web検索', '検索', 'URL一覧', 'Google検索', 'Yahoo検索', 'イベント検索', '告知検索', 'スケジュール'] },
    );
  }

  // =========================================================================
  // 🤖 Category 2: Browser Actions & Automation (モジュール: 'browser')
  // =========================================================================
  if (shouldEnableBrowser) {
    registerTool(
      mcpServer,
      toolCatalog,
      'browser_action',
      'browser',
      '【対話型ブラウザ自動操作】Web ページを開き、クリック・テキスト入力・キー押下・スクロール・待機・JavaScript実行・スクリーンショット取得などの一連のアクションを順次実行して最終結果を返します。ボタンのテキスト指定クリックや、sessionId によるマルチターン対話セッション維持にも対応。',
      {
        url: z.string().url().optional().describe('操作対象の Web ページ URL (新規開始時に指定、既存セッション継続時は省略可能)'),
        sessionId: z.string().optional().describe('既存の対話セッションID (前回の操作に続けて同じタブで操作する場合に指定)'),
        createSession: z.boolean().optional().describe('新しい対話セッションを作成し、次回以降も状態を維持するか (デフォルト: false)'),
        closeSession: z.boolean().optional().describe('指定したセッションを終了してブラウザリソースを解放するか (デフォルト: false)'),
        actions: z
          .array(
            z.object({
              type: z.enum(['click', 'fill', 'type', 'press', 'select', 'scroll', 'wait', 'evaluate', 'navigate']).describe('アクション種別: "click", "fill", "type", "press", "select", "scroll", "wait", "evaluate", "navigate"'),
              url: z.string().url().optional().describe('navigate 時に遷移する URL'),
              selector: z.string().optional().describe('操作対象の CSS セレクタ (例: "#search-input", "button.submit")'),
              text: z.string().optional().describe('入力テキスト、またはクリック対象の表示テキスト (例: "検索", "ログイン")'),
              value: z.string().optional().describe('select タグで選択する値'),
              key: z.string().optional().describe('press で押下するキー名 (例: "Enter", "Tab", "Escape")'),
              direction: z.enum(['down', 'up']).optional().describe('スクロール方向 (デフォルト: "down")'),
              distance: z.number().optional().describe('スクロール移動量 (px, デフォルト: 800)'),
              ms: z.number().optional().describe('待機時間 (ミリ秒)'),
              script: z.string().optional().describe('evaluate で実行する JavaScript コード文字列'),
              clear: z.boolean().optional().describe('fill 時に既存の入力をクリアするか (デフォルト: true)'),
              delay: z.number().optional().describe('操作後の待機ディレイ (ミリ秒)'),
            }),
          )
          .optional()
          .describe('順次実行するブラウザアクションの配列'),
        extract: z
          .object({
            markdown: z.boolean().optional().describe('操作後のページ本文を Markdown で抽出するか (デフォルト: true)'),
            html: z.boolean().optional().describe('操作後の生 HTML を抽出するか (デフォルト: false)'),
            screenshot: z.boolean().optional().describe('操作後の画面スクリーンショット（Base64 PNG）を取得するか (デフォルト: false)'),
            screenshotFullPage: z.boolean().optional().describe('フルページスクリーンショットにするか (デフォルト: true)'),
            maxChars: z.number().optional().describe('最大抽出文字数 (デフォルト: 30000)'),
          })
          .optional()
          .describe('操作完了後に抽出するデータ指定'),
        timeout: z.number().optional().describe('全体のタイムアウト時間 (ミリ秒, デフォルト: 30000)'),
      },
      async (opts) => {
        try {
          const result = await executeBrowserActions(opts as any);
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
      'search_image',
      'yahoo',
      '【Yahoo 画像検索】画像の URL・サムネイル・寸法（幅/高さ）・元ページ URL を取得します。',
      {
        query: z.string().min(1).describe('画像検索キーワード (例: "富士山", "猫 写真")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)'),
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
      'search_video',
      'yahoo',
      '【Yahoo 動画検索】YouTube 等の動画 URL・タイトル・再生時間・サムネイルを取得します。',
      {
        query: z.string().min(1).describe('動画検索キーワード (例: "料理 レシピ 動画")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)'),
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
      'search_news',
      'yahoo',
      '【ニュース速報直結】大手報道機関の最新ニュース記事（タイトル・サマリー・配信メディア・配信日時・記事 URL）をYahoo!ニュースから取得します。時事問題・公式発表の調査に最適です。返却: { results: [{ title, snippet, media, publishedAt, url }] }',
      {
        query: z.string().min(1).describe('ニュース検索キーワード (例: "選挙", "経済動向", "ノーベル賞")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)'),
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

    // Tool 10: search_chiebukuro (Yahoo 知恵袋検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'search_chiebukuro',
      'yahoo',
      '【必須・Web検索代替不可】Yahoo! 知恵袋の Q&A・人々の悩み・生活の知恵・利用者のリアルな体験談や口コミは、一般Web検索ではなく必ず本ツールで検索してください。質問タイトル・本文スニペット・回答数・解決ステータスを取得します。返却: { results: [{ questionTitle, questionBody, answerSnippet, bestAnswer }] }',
      {
        query: z.string().min(1).describe('知恵袋検索キーワード (例: "おすすめ プログラミング言語", "引越し 挨拶")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)'),
      },
      async ({ query, limit }) => {
        try {
          const result = await searchYahooChiebukuro({ query, limit });
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
      'suggest_keywords',
      'yahoo',
      '【公式サジェスト直結】Yahoo! JAPAN のキーワード補完サジェストを取得し、指定語句の入力候補・よく一緒に検索される複合検索需要・関連語を返します。返却: { query, suggestions: [...] }',
      {
        query: z.string().min(1).describe('検索語句プレフィックス (例: "東京 観光")'),
        limit: z.number().int().min(1).max(30).optional().describe('取得件数 (デフォルト: 10)'),
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

    // Tool 12: search_realtime (Yahoo リアルタイム検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'search_realtime',
      'yahoo',
      '【必須・Web検索代替不可】X (旧 Twitter) 上の最新ポスト・リアルタイムな世論や生の声・バズワードを調べる場合、一般Web検索では取得できないため必ず本ツールを実行してください。アイドルのライブ出演・物販タイテ・緊急告知・イベント現地の生の声など、直近・リアルタイムの状況把握に最適です。新着順 (recent) と 話題順 (popular) の切り替えに対応。返却: { query, sort, items: [{ text, postedAt, user, url }] }',
      {
        query: z.string().min(1).describe('リアルタイム検索キーワード (例: "地震", "電車遅延", "イベント名")'),
        sort: z
          .enum(['recent', 'popular'])
          .optional()
          .describe('並び順: "recent" (新着順, デフォルト) または "popular" (話題・エンゲージメント順)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe('取得件数 (デフォルト: 20, 最大: 40)'),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('ページ番号 (1-based, デフォルト: 1)'),
      },
      async ({ query, sort, limit, page }) => {
        try {
          const result = await searchYahooRealtime({
            query,
            sort: sort || 'recent',
            ...(limit ? { limit } : {}),
            ...(page ? { page } : {}),
          });

          const responsePayload = {
            source: 'x',
            query,
            effectiveQuery: result.effectiveQuery,
            isFallback: result.isFallback,
            sort: sort || 'recent',
            count: result.count,
            items: result.items,
          };

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
      'search_trend',
      'yahoo',
      '【公式トレンド直結】いま日本国内で最も話題になっている急上昇トレンドキーワード上位 20 件（順位・キーワード・ポスト数・要約）は、必ず本ツールで取得してください。返却: { trends: [{ rank, keyword, score }] }',
      {
        limit: z.number().int().min(1).max(50).optional().describe('取得するトレンド件数 (デフォルト: 20)'),
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
  }

  // =========================================================================
  // 🗾 Category 4: Japanese Daily Life Services (モジュール: 'life')
  // =========================================================================
  if (shouldEnableLife) {
    // Tool 14: search_route (電車・鉄道 乗換案内) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'search_route',
      'life',
      '【公式直結・推測運賃厳禁】日本国内の電車・新幹線・地下鉄等の駅間最適ルート・所要時間・乗換回数・IC/きっぷ運賃は、推測で不正確な案内をせず必ずYahoo!路線情報直結の本ツールで探索してください。経由駅指定（最大3駅）や日時指定に対応。返却: { routes: [{ departure, arrival, duration, transferCount, fare, steps }] }',
      {
        from: z.string().min(1).describe('出発駅名 (例: "東京", "新大阪", "博多")'),
        to: z.string().min(1).describe('到着駅名 (例: "新宿", "京都", "天神")'),
        via: z.array(z.string()).max(3).optional().describe('経由駅名リスト (最大3駅, 例: ["品川", "横浜"])'),
        date: z.string().regex(/^\d{8}$/).optional().describe('検索日 (YYYYMMDD形式, 例: "20260825")'),
        time: z.string().regex(/^\d{4}$/).optional().describe('検索時刻 (HHMM形式, 例: "0930")'),
        timeType: z.enum(['departure', 'arrival', 'first_train', 'last_train']).optional()
          .describe('時刻指定タイプ: "departure"(出発時刻), "arrival"(到着時刻), "first_train"(始発), "last_train"(終電)'),
        ticket: z.enum(['ic', 'cash']).optional().describe('運賃タイプ: "ic"(IC運賃), "cash"(きっぷ運賃)'),
        seatPreference: z.enum(['non_reserved', 'reserved', 'green']).optional()
          .describe('座席指定: "non_reserved"(自由席), "reserved"(指定席), "green"(グリーン車)'),
        walkSpeed: z.enum(['fast', 'slightly_fast', 'slightly_slow', 'slow']).optional()
          .describe('歩く速度'),
        sortBy: z.enum(['time', 'transfer', 'fare']).optional()
          .describe('並び順: "time"(早い順), "transfer"(乗り換え少ない順), "fare"(安い順)'),
        useAirline: z.boolean().optional().describe('空路を使う (デフォルト: true)'),
        useShinkansen: z.boolean().optional().describe('新幹線を使う (デフォルト: true)'),
        useExpress: z.boolean().optional().describe('有料特急を使う (デフォルト: true)'),
        useHighwayBus: z.boolean().optional().describe('高速バスを使う (デフォルト: true)'),
        useLocalBus: z.boolean().optional().describe('路線バスを使う (デフォルト: true)'),
        useFerry: z.boolean().optional().describe('フェリーを使う (デフォルト: true)'),
      },
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

    // Tool 15: get_weather (日本の天気予報 - 気象庁公式オープンデータ直結) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'get_weather',
      'life',
      '【公式直結・推測厳禁】日本国内各地の天気予報・予想気温・降水確率・概況は、一般的な推測を行わず必ず気象庁公式オープンデータ直結の本ツールを実行してください。全国 1,805 市区町村名（例: "天童市", "軽井沢", "箱根", "浦安", "別府", "石垣島"）または都道府県名・地点IDに対応。返却: { areaName, forecasts: [{ date, weather, pop, tempMin, tempMax }] }',
      {
        city: z.string().min(1).describe('市区町村名または都道府県名（例: "天童市", "軽井沢", "箱根", "浦安", "東京", "大阪", "福岡", "那覇"）、もしくは6桁の地点ID（例: "130010"）'),
        days: z.number().int().min(1).max(3).optional().describe('取得する予報日数 (1〜3日, デフォルト: 3)'),
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
      'get_flight_status',
      'life',
      '【公式運航情報直結】主要空港（羽田、成田、伊丹、関西、中部、新千歳、福岡、那覇等）の国内線・国際線フライトリアルタイム運航状況・欠航・遅延ステータスおよび理由詳細は、推測せず必ず本ツールで確認してください。返却: { airportName, summary, flights: [{ flightNumber, airline, scheduledTime, status }] }',
      {
        airport: z.string().optional().describe('対象空港名またはコード (例: "羽田", "成田", "伊丹", "関空", "中部", "新千歳", "福岡", "那覇", "HND", "NRT", "ITM", "KIX", "NGO", デフォルト: "羽田")'),
        type: z.enum(['departure', 'arrival']).optional().describe('発着区分: "departure"(出発) または "arrival"(到着) (デフォルト: "departure")'),
        category: z.enum(['domestic', 'international']).optional().describe('路線区分: "domestic"(国内線) または "international"(国際線) (デフォルト: "domestic")'),
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
  }

  // =========================================================================
  // 🚨 Category 5: Disaster & Emergency (モジュール: 'disaster')
  // =========================================================================
  if (shouldEnableDisaster) {
    // Tool 16: search_road_traffic (リアルタイム道路交通情報 - JARTIC連携) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'search_road_traffic',
      'disaster',
      '【JARTIC道路交通直結】日本全国の高速道路・都市高速・主要有料道路のリアルタイム道路交通情報（事故・渋滞・通行止め・車線規制・チェーン規制・工事等）は、推測せずJARTIC（日本道路交通情報センター）連携の本ツールで取得してください。返却: { roadName, conditions: [{ section, status, cause }] }',
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

    // Tool 17: search_disaster_warnings (気象警報・注意報) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
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

    // Tool 18: search_earthquake (リアルタイム地震速報・履歴) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'search_earthquake',
      'disaster',
      '【公式地震速報直結】最新の地震履歴（発生時刻、震源地、マグニチュード、深さ、最大震度、津波有無、観測地点）は、推測せずP2P地震情報および気象庁公式速報直結の本ツールで取得してください。返却: { earthquakes: [{ time, epicenter, maxIntensity, magnitude }] }',
      {
        limit: z.number().int().min(1).max(20).optional().describe('取得件数 (1〜20, デフォルト: 5)'),
        minIntensity: z.number().int().optional().describe('最小震度フィルター (10=震度1, 20=震度2, 30=震度3, 40=震度4, 45=震度5弱, 50=震度5強)'),
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

    // Tool: get_elevation (国土地理院 住所ジオコーディング & 標高・海抜判定) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'get_elevation',
      'disaster',
      '【国土地理院直結】住所地名からの海抜標高（m）および正確な緯度経度は、推測せず必ず国土地理院公式オープンデータ直結の本ツールでミリ精度取得してください。水害・津波リスク判定に必須です。返却: { elevationMeters, dataAccuracy, lat, lon }',
      {
        address: z.string().optional().describe('住所・地名文字列 (例: "東京都千代田区永田町1-7-1", "富士山頂")'),
        lat: z.number().optional().describe('緯度 (住所未指定時に直接指定, 例: 35.681236)'),
        lon: z.number().optional().describe('経度 (住所未指定時に直接指定, 例: 139.767125)'),
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
  }

  // =========================================================================
  // 👁️ Category 6: Watch & Diff Monitoring (モジュール: 'watch')
  // =========================================================================
  if (shouldEnableWatch) {
    // Tool 19: watch_register (監視ターゲット登録) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'watch_register',
      'watch',
      '【Webページ差分監視登録】Web ページの変更監視ターゲットを登録し、初期ハッシュベースラインを構築します。チケット当落、再販監視、お知らせ検知等に利用可能。',
      {
        url: z.string().url().describe('監視対象の Web ページ URL (例: "https://example.com/status")'),
        title: z.string().optional().describe('監視ターゲットの識別用タイトル (例: "チケット当落発表")'),
        selector: z.string().optional().describe('ピンポイントで監視する CSS セレクタ (例: "#status")'),
        webhookUrl: z.string().url().optional().describe('差分検知時に通知する Webhook URL'),
        intervalSeconds: z.number().int().min(1).optional().describe('監視インターバル目安 (秒, デフォルト: 3600)'),
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
      'search_song',
      'music',
      '【iTunes公式直結】楽曲タイトル（曲名）を指定して、iTunes公式メタデータ（正確な曲名、高解像度ジャケット画像、30秒試聴音源URL、アーティスト名、リリース日、Apple Musicリンク）をピンポイント検索します。返却: { results: [{ trackName, artistName, previewUrl, artworkUrl }] }',
      {
        query: z.string().min(1).describe('検索曲名・楽曲タイトル (例: "アイドル", "夜に駆ける", "Subtitle")'),
        country: z.string().optional().describe('国コード (デフォルト: "jp")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)'),
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
      { defaultEnabled: deferredDefault, keywords: ['楽曲検索', '曲名', 'iTunes', '音楽', 'Apple Music'] },
    );

    // Tool 23: search_artist (iTunes アーティスト名指定 音楽・アルバム・アーティスト検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'search_artist',
      'music',
      '【iTunes公式直結】アーティスト名を指定して、公式メタデータから指定アーティストの代表曲一覧、アルバム一覧、アーティスト基本情報（Apple Musicリンク等）を正確に取得します。※歌手・アーティスト公式カタログメタデータを検索します。ライブ・公演日程や最新の出演スケジュール・最新活動情報は search_deep または search_realtime を使用してください。返却: { results: [...] }',
      {
        query: z.string().min(1).describe('アーティスト名 (例: "YOASOBI", "Official髭男dism", "Ado")'),
        country: z.string().optional().describe('国コード (デフォルト: "jp")'),
        entity: z.enum(['song', 'album', 'musicArtist']).optional().describe('検索エンティティ: "song" (楽曲一覧), "album" (アルバム一覧), "musicArtist" (アーティスト情報) (デフォルト: "song")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)'),
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
      { defaultEnabled: deferredDefault, keywords: ['アーティスト検索', 'ディスコグラフィ', '歌手', 'iTunes', 'アルバム'] },
    );

    // Tool 24: search_music (iTunes 音楽・アルバム・アーティスト汎用検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'search_music',
      'music',
      '【iTunes公式直結】楽曲・アルバム・アーティストの複合キーワード全文検索をiTunes公式メタデータに対して行います（曲名・アーティスト名が明確な場合は search_song / search_artist を推奨）。返却: { results: [...] }',
      {
        query: z.string().min(1).describe('検索キーワード (曲名、アーティスト名、アルバム名の自由入力)'),
        country: z.string().optional().describe('国コード (デフォルト: "jp")'),
        entity: z.enum(['song', 'album', 'musicArtist']).optional().describe('検索エンティティ: "song", "album", "musicArtist" (デフォルト: "song")'),
        attribute: z.enum(['songTerm', 'artistTerm', 'albumTerm']).optional().describe('属性絞り込み: "songTerm" (曲名), "artistTerm" (アーティスト名), "albumTerm" (アルバム名)'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)'),
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
      { defaultEnabled: deferredDefault, keywords: ['汎用音楽検索', 'アルバム', 'iTunes', '音楽'] },
    );
  }

  // =========================================================================
  // 🏛️ Category 8: Government & Law Data (モジュール: 'gov')
  // =========================================================================
  if (shouldEnableGov) {
    // Tool 25: search_laws (e-Gov キーワード法令検索) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'search_laws',
      'gov',
      '【必須・推測回答厳禁】日本の法律・政令・府省令の検索・調査では、学習知識で条文番号や法令名を推測せず、必ずデジタル庁・総務省公式e-Gov法令API v2直結の本ツールを実行してください。現行法令名、法令番号、公布年月日の一覧を取得します。返却: { totalCount, laws: [{ lawId, lawNum, lawTitle }] }',
      {
        keyword: z.string().min(1).describe('法令検索キーワード (例: "著作権法", "労働基準法", "民法")'),
        limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)'),
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
      'get_law_text',
      'gov',
      '【公式条文直結・創作厳禁】日本の法令条文の確認では、架空の条文・条項を創作（法律ハルシネーション）せず、必ず本ツールで公式e-Govの正確な条文Markdownを取得してください。章・節・条・項・号が正確に構造化された本文を返します。返却: { lawTitle, lawNum, articles: [{ articleNumber, caption, text }] }',
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
      'search_diet_minutes',
      'gov',
      '【公式議事録直結】国会（衆議院・参議院）の本会議・委員会における議員・閣僚・総理大臣の発言・答弁は推測せず、国立国会図書館公式APIにより戦後〜最新（2026年）までの公式議事録全文を検索してください。法律の立法趣旨や政策議論のファクトチェックに必須です。返却: { totalCount, speeches: [{ speaker, speakerPosition, speech, date }] }',
      {
        keyword: z.string().optional().describe('検索キーワード・質問内容 (例: "人工知能", "少子化対策")'),
        speaker: z.string().optional().describe('発言者名・議員名・閣僚名 (例: "総理大臣", "河野太郎")'),
        nameOfHouse: z.enum(['衆議院', '参議院']).optional().describe('院名 ("衆議院" または "参議院")'),
        nameOfMeeting: z.string().optional().describe('委員会名・本会議名 (例: "予算委員会", "本会議", "内閣委員会")'),
        from: z.string().optional().describe('開会日付範囲 開始 (YYYY-MM-DD)'),
        until: z.string().optional().describe('開会日付範囲 終了 (YYYY-MM-DD)'),
        limit: z.number().int().min(1).max(30).optional().describe('取得件数 (1〜30, デフォルト: 10)'),
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
      'verify_hts_code',
      'trade',
      '【公式照合・推測厳禁】推論・入手したHTSコード候補を米国USITC公式データ(hts.usitc.gov)と照合し実在検証・正式品目名・一般関税率を取得します。HTS Revision 18等の大統領布告・通商法301条Chapter 99特別追加関税リスクも提示。6桁一致時は詳細仕様の確認質問(clarifyingQuestions)を返却します。返却: { verified, matchLevel, officialDescription, generalRate, clarifyingQuestions }',
      {
        htsCode: z.string().min(1).describe('検証したいHTSコード（例: "9503.00.0073"）。推測ではなく既知・候補のコードを指定すること'),
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

    // Tool: check_product_compliance (商品統合コンプライアンス一括判定) - DEFERRED
    registerTool(
      mcpServer,
      toolCatalog,
      'check_product_compliance',
      'trade',
      '【必須・即時推測厳禁】商品ページURLや品名・素材から、HTS推測・実在検証・FDA実務判定・CPSC証明書および2026年7月eFiling義務を一連のパイプラインとして一括実行し、通関前アクションプランを含む総合診断レポートを返します。推測による安易な回答は通関事故に直結するため必ず本ツールを実行してください。返却: { overallStatus, hts, fda, cpsc, clarifyingQuestions, impactExplanation, actionPlan }',
      {
        url: z.string().url().optional().describe('商品ページのURL（Amazon、ECサイト、メーカー公式等。指定時は自動でスクレイピングして商品情報を取得）'),
        productName: z.string().optional().describe('商品名・タイトル（例: "Wooden Building Blocks for Toddlers", "薬用美白クリーム", "Bicycle Helmet"）'),
        description: z.string().optional().describe('商品の詳細説明・仕様・素材・用途など'),
        htsCode: z.string().optional().describe('既知または候補のHTSコード（指定時は最優先で検証。未指定時は推測エンジンで自動特定）'),
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
  // 🔍 Category 10: Tool Discovery & Dynamic Activation (メタツール) - CORE (defaultEnabled: true)
  // =========================================================================
  mcpServer.tool(
    'search_tools',
    '【ツール検索・動的有効化】現在無効化されているSoraの追加ツールをキーワードで検索し、' +
      '一致したツールを現在のセッションで有効化します。天気・乗換案内・知恵袋・リアルタイム速報・音楽・法令・防災情報など、' +
      '専門機能を利用する際は、まずこのツールで対象ツールを検索してください。',
    {
      query: z.string().describe('検索キーワードまたはカテゴリ名（例: "天気", "知恵袋", "乗換", "地震", "法令", "音楽", "yahoo"）'),
    },
    async ({ query }) => {
      const matches = searchCatalog(toolCatalog, query);
      const newlyEnabled: string[] = [];
      const alreadyEnabled: string[] = [];

      for (const entry of matches) {
        if (!entry.handle.enabled) {
          entry.handle.enable();
          const cleanDesc = entry.description.replace(/^【.*?】/, '').slice(0, 80);
          const tag = entry.description.match(/^【(.*?)】/)?.[0] || '';
          newlyEnabled.push(`- ${entry.name}: ${tag}${cleanDesc}...`);
        } else {
          alreadyEnabled.push(entry.name);
        }
      }

      if (newlyEnabled.length === 0 && alreadyEnabled.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `"${query}" に一致する追加ツールは見つかりませんでした。\n利用可能なカテゴリ: web (一括/クロール), browser (操作), yahoo (知恵袋/画像/動画/ニュース/リアルタイム/トレンド), life (天気/乗換), disaster (道路交通/警報/地震), watch (Web監視), music (楽曲/歌手), gov (法令)`,
            },
          ],
        };
      }

      const messages: string[] = [];
      if (newlyEnabled.length > 0) {
        messages.push(`以下のツールをセッション内で有効化しました:\n${newlyEnabled.join('\n')}\n\n対象ツールを直接呼び出してください。`);
      }
      if (alreadyEnabled.length > 0) {
        messages.push(`以下のツールはすでに有効化されています: ${alreadyEnabled.join(', ')}`);
      }

      return {
        content: [{ type: 'text', text: messages.join('\n\n') }],
      };
    },
  );

  return mcpServer;
}

export interface McpSessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastActive: number;
}

/**
 * MCP Streamable HTTP 仕様準拠のマルチセッションマネージャー
 * 各クライアント接続ごとに独立したセッションとトランスポートを管理し、
 * セッションIDに基づくルーティング、放置セッションの自動回収（TTL）、
 * 並行リクエストの安全なディスパッチを行います。
 */
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

  /**
   * HTTP リクエスト（POST / GET / DELETE）を適切なセッションのトランスポートにルーティング
   */
  public async handleRequest(req: Request, options?: { parsedBody?: any }): Promise<Response> {
    const sessionId = req.headers.get('mcp-session-id');

    // 1. 既存セッションが存在する場合
    if (sessionId && this.sessions.has(sessionId)) {
      const entry = this.sessions.get(sessionId)!;
      entry.lastActive = Date.now();
      const res = await entry.transport.handleRequest(req, options);
      return sanitizeMcpResponse(res);
    }

    // 2. セッションIDが指定されているが存在しない場合 (セッション切れ / 不正ID)
    if (sessionId && !this.sessions.has(sessionId)) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Session not found',
          },
          id: null,
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // 3. セッション新規作成 (initialize リクエスト時)
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
      // ステートフルセッション作成
      const server = createMcpServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          this.sessions.set(newSessionId, {
            server,
            transport,
            lastActive: Date.now(),
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

    // 4. initialize 以外の単発・ステートレスリクエスト (例: 単発 tools/list, tools/call)
    const statelessServer = createMcpServer();
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

    const transformStream = new TransformStream({
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
