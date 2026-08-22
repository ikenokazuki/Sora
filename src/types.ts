import { z } from 'zod';

export type ScrapeFormat = 'markdown' | 'html' | 'rawHtml' | 'links' | 'screenshot' | 'jsonLd' | 'images' | 'tables';

export interface TableData {
  id?: string;
  caption?: string;
  headers: string[];
  rows: Record<string, string>[];
}

export interface MediaInfo {
  type: 'youtube' | 'video' | 'audio';
  videoId?: string;
  duration?: string;
  thumbnail?: string;
  chapters?: Array<{ title: string; time: string; seconds: number }>;
}

export interface Citation {
  text: string;
  url: string;
  context?: string;
}

export interface ImageItem {
  url: string;
  alt?: string;
  title?: string;
  caption?: string;
  isMainImage?: boolean;
  width?: number;
  height?: number;
}

export interface MarkdownChunk {
  index: number;
  heading?: string;
  content: string;
  estimatedTokens: number;
}

export interface LinkStatus {
  url: string;
  status: number;
  ok: boolean;
}

export interface CookieParam {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface ScrapeResult {
  url: string;
  title: string;
  content: string;
  isTruncated: boolean;
  contentType: string;
  source: 'web';
  renderedWithBrowser?: boolean;
  cached?: boolean;
  ogImage?: string;
  description?: string;
  publishedTime?: string;
  author?: string;
  siteName?: string;
  highlights?: string[];
  summary?: string[];
  citations?: Citation[];
  chunks?: MarkdownChunk[];
  characterCount?: number;
  wordCount?: number;
  readingTimeMin?: number;
  promptContext?: string;
  highlightedContent?: string;
  media?: MediaInfo;
  links?: string[];
  linksWithStatus?: LinkStatus[];
  images?: ImageItem[];
  jsonLd?: any[];
  tables?: TableData[];
  extracted?: Record<string, string | null>;
  metadata?: Record<string, any>;
  estimatedTokens?: number;
  html?: string;
  rawHtml?: string;
  screenshot?: string; // base64 PNG
}

export interface BrowserActionStep {
  type: 'click' | 'fill' | 'type' | 'press' | 'select' | 'scroll' | 'wait' | 'evaluate' | 'navigate' | 'screenshot';
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  ms?: number;
  delay?: number;
  clear?: boolean;
  distance?: number;
  direction?: 'up' | 'down';
  script?: string;
  url?: string;
}

export interface BrowserActionOptions {
  url?: string;
  sessionId?: string;
  createSession?: boolean;
  closeSession?: boolean;
  ownerToken?: string;
  actions?: BrowserActionStep[];
  extract?: {
    markdown?: boolean;
    screenshot?: boolean;
    html?: boolean;
  };
  timeout?: number;
  proxyUrl?: string;
}

export interface BrowserActionResult {
  success: boolean;
  url: string;
  sessionId?: string;
  sessionClosed?: boolean;
  markdown?: string;
  screenshot?: string;
  html?: string;
  actionOutputs?: Array<{
    step: number;
    type: string;
    result?: any;
    error?: string;
  }>;
  error?: string;
  renderedWithBrowser?: boolean;
  source: 'browser';
}

export interface BatchScrapeResult {
  total: number;
  successful: number;
  failed: number;
  results: ScrapeResult[];
  errors: Array<{ url: string; error: string }>;
}

export interface SitemapEntry {
  url: string;
  lastmod?: string;
}

export interface TransitSearchOptions {
  from: string;
  to: string;
  via?: string[];
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  date?: string;
  time?: string;
  timeType?: 'departure' | 'arrival' | 'first_train' | 'last_train' | 'unspecified';
  ticket?: 'ic' | 'cash';
  seatPreference?: 'any' | 'reserved' | 'non_reserved' | 'green';
  walkSpeed?: 'fast' | 'slightly_fast' | 'slightly_slow' | 'slow' | 'normal';
  sortBy?: 'time' | 'transfer' | 'fare';
  useAirline?: boolean;
  useShinkansen?: boolean;
  useExpress?: boolean;
  useHighwayBus?: boolean;
  useLocalBus?: boolean;
  useFerry?: boolean;
}

export interface WeatherForecastOptions {
  city: string;
  days?: number;
  noCache?: boolean;
}

// ==========================================
// 構造化エラーレスポンス型
// ==========================================
export interface ApiErrorResponse {
  error: string;
  code: string;
  status: number;
  retryable: boolean;
  details?: any;
}

// ==========================================
// 共通 Zod スキーマ
// ==========================================
export const CookieParamSchema = z.object({
  name: z.string().describe('Cookie 名'),
  value: z.string().describe('Cookie 値'),
  domain: z.string().optional().describe('対象ドメイン (例: ".example.com")'),
  path: z.string().optional().describe('対象パス (デフォルト: "/")'),
  httpOnly: z.boolean().optional().describe('HttpOnly 属性'),
  secure: z.boolean().optional().describe('Secure 属性 (HTTPS のみ送信)'),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('SameSite ポリシー'),
});

export const ScrapeRequestSchema = z.object({
  url: z.string().min(1, 'url は必須です').describe('スクレイピング対象の完全な URL (http/https) または PDF URL'),
  maxChars: z.number().int().positive().optional().describe('抽出する最大文字数 (デフォルト: 10000)'),
  mode: z.enum(['auto', 'fast', 'browser']).optional().describe('動作モード: "auto"(スマート自動判定, デフォルト), "fast"(最速静的HTTP), "browser"(Stealth Chromium)'),
  renderJs: z.boolean().optional().describe('常にブラウザ描画を強制するか (mode="browser" と同等)'),
  fastOnly: z.boolean().optional().describe('常に静的取得を強制するか (mode="fast" と同等)'),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional().describe('取得する出力フォーマット配列 (デフォルト: ["markdown"])'),
  onlyMainContent: z.boolean().optional().describe('ヘッダー・フッター・サイドバー等のノイズを除外し、記事本文のみを抽出するか (デフォルト: true)'),
  selectors: z.record(z.string(), z.string()).optional().describe('ピンポイント抽出用 CSS セレクタ連想配列 (例: {"price": ".item-price", "title": "h1"})'),
  clipSelector: z.string().optional().describe('特定要素のみを切り抜いてスクリーンショット撮影する CSS セレクタ (例: "#chart")'),
  headers: z.record(z.string(), z.string()).optional().describe('リクエスト時に送信するカスタム HTTP ヘッダー連想配列'),
  cookies: z.array(CookieParamSchema).optional().describe('リクエスト時に送信するカスタム Cookie 配列'),
  removeSelectors: z.array(z.string()).optional().describe('Markdown 変換前に徹底パージする不要要素の CSS セレクタ配列 (例: [".ad", ".comments"])'),
  query: z.string().optional().describe('ハイライト抽出用キーワード'),
  extractHighlights: z.boolean().optional().describe('指定キーワードに関連する重要文（ハイライト）を自動抽出するか'),
  extractSummary: z.boolean().optional().describe('超高速な抽出型自動要約 (TL;DR) を生成するか'),
  extractCitations: z.boolean().optional().describe('本文中の出典・外部引用リンク一覧を抽出するか'),
  chunkMarkdown: z.boolean().optional().describe('RAG 用セマンティック・チャンキングを行うか (見出し階層＆トークン数付き)'),
  chunkSize: z.number().int().positive().optional().describe('チャンクあたりの文字数目安 (デフォルト: 1000)'),
  validateLinks: z.boolean().optional().describe('抽出されたページ内リンクの健全性・到達性を並行検証するか'),
  formatAsPrompt: z.boolean().optional().describe('LLM に最適化された標準 XML プロンプトラッパー形式を生成するか'),
  highlightMatches: z.boolean().optional().describe('本文中の検索一致語句を <mark> でハイライトするか'),
  maskPii: z.boolean().optional().describe('メールアドレス・電話番号・クレカ等の個人情報を自動マスキングするか'),
  webhookUrl: z.string().optional().describe('スクレイプ完了時に結果ペイロードを通知する Webhook URL (非同期)'),
  retries: z.number().int().min(0).max(3).optional().describe('接続失敗時の自動リトライ回数 (0〜3, デフォルト: 0)'),
  retryDelayMs: z.number().int().positive().optional().describe('リトライ待機ディレイ (ミリ秒)'),
  proxyUrl: z.string().optional().describe('経由するプロキシ URL (http/https/socks5)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスして強制再取得するか'),
  timeoutMs: z.number().int().positive().optional().describe('タイムアウト時間 (ミリ秒, デフォルト: 30000)'),
});

export const BatchScrapeRequestSchema = z.object({
  urls: z.array(z.string()).min(1, 'urls は 1 件以上指定してください').describe('一括スクレイピング対象の URL 配列 (最大20件)'),
  concurrency: z.number().int().min(1).max(20).optional().describe('並行フェッチワーカー数 (デフォルト: 3, 最大: 5)'),
  maxChars: z.number().int().positive().optional().describe('各ページの最大文字数 (デフォルト: 10000)'),
  mode: z.enum(['auto', 'fast', 'browser']).optional().describe('動作モード: "auto", "fast", "browser"'),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional().describe('取得する出力形式配列'),
  onlyMainContent: z.boolean().optional().describe('記事本文のみを抽出するか (デフォルト: true)'),
  selectors: z.record(z.string(), z.string()).optional().describe('ピンポイント抽出用 CSS セレクタ連想配列'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const BrowserActionRequestSchema = z.object({
  url: z.string().optional().describe('操作対象の Web ページ URL (新規開始時に指定、既存セッション継続時は省略可能)'),
  sessionId: z.string().optional().describe('既存の対話セッションID (前回の操作に続けて同じタブで操作する場合に指定)'),
  ownerToken: z.string().optional().describe('マルチターン対話セッションの所有者検証トークン'),
  createSession: z.boolean().optional().describe('新しい対話セッションを作成し、次回以降も状態を維持するか (デフォルト: false)'),
  closeSession: z.boolean().optional().describe('指定したセッションを終了してブラウザリソースを解放するか (デフォルト: false)'),
  actions: z.array(z.object({
    type: z.enum(['click', 'fill', 'type', 'press', 'select', 'scroll', 'wait', 'evaluate', 'navigate', 'screenshot']).describe('アクション種別: "click", "fill", "type", "press", "select", "scroll", "wait", "evaluate", "navigate", "screenshot"'),
    selector: z.string().optional().describe('操作対象の CSS セレクタ (例: "#search-input", "button.submit")'),
    text: z.string().optional().describe('入力テキスト、またはクリック対象の表示テキスト (例: "検索", "ログイン")'),
    value: z.string().optional().describe('select タグで選択する値'),
    key: z.string().optional().describe('press で押下するキー名 (例: "Enter", "Tab", "Escape")'),
    x: z.number().optional().describe('クリック座標 X'),
    y: z.number().optional().describe('クリック座標 Y'),
    ms: z.number().optional().describe('wait 時の待機時間 (ミリ秒)'),
    script: z.string().optional().describe('evaluate で実行する JavaScript コード文字列'),
    fullPage: z.boolean().optional().describe('screenshot 時にフルページ撮影するか'),
  })).optional().describe('順次実行するブラウザアクションの配列'),
  extract: z.object({
    markdown: z.boolean().optional().describe('操作後のページ本文を Markdown で抽出するか (デフォルト: true)'),
    html: z.boolean().optional().describe('操作後の生 HTML を抽出するか (デフォルト: false)'),
    screenshot: z.boolean().optional().describe('操作後の画面スクリーンショット（Base64 PNG）を取得するか (デフォルト: false)'),
    screenshotFullPage: z.boolean().optional().describe('フルページスクリーンショットにするか (デフォルト: false)'),
    clipSelector: z.string().optional().describe('特定要素のみを切り抜く CSS セレクタ'),
    maxChars: z.number().optional().describe('最大抽出文字数 (デフォルト: 30000)'),
  }).optional().describe('操作完了後に抽出するデータ指定'),
  timeout: z.number().optional().describe('全体のタイムアウト時間 (ミリ秒, デフォルト: 30000)'),
  proxyUrl: z.string().optional().describe('経由するプロキシ URL'),
});

export const CrawlRequestSchema = z.object({
  url: z.string().min(1, 'url は必須です').describe('クロール開始のベース URL (例: "https://example.com/docs")'),
  maxPages: z.number().int().positive().optional().describe('巡回する最大ページ数 (デフォルト: 10, 最大: 50)'),
  maxDepth: z.number().int().positive().optional().describe('リンク探索の最大深度 (デフォルト: 2)'),
  includePatterns: z.array(z.string()).optional().describe('対象を絞り込むワイルドカードパターン (例: ["/docs/**", "/guide/*"])'),
  excludePatterns: z.array(z.string()).optional().describe('クロールから除外するワイルドカードパターン (例: ["/tag/**", "*.pdf"])'),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional().describe('取得する形式配列'),
  onlyMainContent: z.boolean().optional().describe('記事本文のみ抽出するか (デフォルト: true)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const MapRequestSchema = z.object({
  url: z.string().min(1, 'url は必須です').describe('サイトマップ探索対象のベース URL (例: "https://example.com")'),
  limit: z.number().int().positive().optional().describe('取得する最大 URL 件数 (デフォルト: 200, 最大: 1000)'),
  includeSubdomains: z.boolean().optional().describe('サブドメインも含めるか (デフォルト: false)'),
  since: z.string().optional().describe('指定日時以降に更新された URL のみ抽出するフィルタ (例: "2026-08-01")'),
  until: z.string().optional().describe('指定日時以前に更新された URL のみ抽出するフィルタ'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const RealtimeSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('リアルタイム検索キーワード (X/Twitter の生の声)'),
  sort: z.enum(['recent', 'popular']).optional().describe('並び順: "recent"(新着順, デフォルト) または "popular"(話題順)'),
  limit: z.number().int().min(1).max(40).optional().describe('取得件数 (デフォルト: 20, 最大: 40)'),
  page: z.number().int().positive().optional().describe('ページ番号 (1-based, デフォルト: 1)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const TransitRouteRequestSchema = z.object({
  from: z.string().min(1, 'from は必須です').describe('出発駅・バス停・施設名 (例: "新宿", "東京駅")'),
  to: z.string().min(1, 'to は必須です').describe('到着駅・バス停・施設名 (例: "横浜", "京都")'),
  via: z.array(z.string()).optional().describe('経由駅リスト (最大3駅, 例: ["品川"])'),
  sortBy: z.enum(['time', 'transfer', 'fare']).optional().describe('並び順: "time"(早い順), "transfer"(乗換少ない順), "fare"(安い順)'),
  seatPreference: z.enum(['any', 'reserved', 'non_reserved', 'green']).optional().describe('座席種別: "any", "reserved"(指定席), "non_reserved"(自由席), "green"(グリーン車)'),
  walkSpeed: z.enum(['fast', 'slightly_fast', 'slightly_slow', 'slow', 'normal']).optional().describe('徒歩速度設定'),
});

export const WeatherRequestSchema = z.object({
  city: z.string().min(1, 'city は必須です').describe('市区町村名または都道府県名（例: "天童市", "軽井沢", "箱根", "浦安", "東京", "大阪", "福岡", "那覇"）、もしくは6桁の地点ID'),
  days: z.number().int().positive().optional().describe('取得する予報日数 (1〜3日, デフォルト: 3)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const SearchWebQuerySchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('Web 検索キーワード'),
  includeDomains: z.array(z.string()).optional().describe('結果を絞り込むドメイン配列 (例: ["natalie.mu"])'),
  excludeDomains: z.array(z.string()).optional().describe('結果から除外するドメイン配列'),
  updated: z.enum(['day', 'week', 'month', 'year']).optional().describe('期間指定: "day"(24h以内), "week"(1週間以内), "month"(1ヶ月以内), "year"(1年以内)'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20, 最大: 50)'),
  page: z.number().int().positive().optional().describe('ページ番号 (1-based)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const IntegratedSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('検索キーワード'),
  includeDomains: z.array(z.string()).optional().describe('結果を絞り込むドメイン配列'),
  excludeDomains: z.array(z.string()).optional().describe('結果から除外するドメイン配列'),
  limit: z.number().int().min(1).max(20).optional().describe('本文取得する上位結果件数 (デフォルト: 5, 最大: 20)'),
  fetchContent: z.boolean().optional().describe('上位サイトの Markdown 本文を並行取得するか (デフォルト: true)'),
  maxCharsPerResult: z.number().int().positive().optional().describe('各ページの最大文字数 (デフォルト: 10000)'),
  includeRealtime: z.boolean().optional().describe('リアルタイム最新速報 (X) も併せて取得するか (デフォルト: true)'),
  dedup: z.boolean().optional().describe('重複・類似項目を自動排除するか (デフォルト: false)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const SuggestRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('検索語句プレフィックス'),
  limit: z.number().int().min(1).max(20).optional().describe('取得するサジェスト候補件数 (デフォルト: 10)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

// ==========================================
// Zod -> OpenAPI 3.0 自動スキーマジェネレーター
// ==========================================
export function zodToOpenApiSchema(schema: z.ZodTypeAny): any {
  let description = schema.description || (schema as any)._def?.description;
  let res: any = {};

  if (schema instanceof z.ZodString) {
    res = { type: 'string' };
  } else if (schema instanceof z.ZodNumber) {
    res = { type: 'number' };
  } else if (schema instanceof z.ZodBoolean) {
    res = { type: 'boolean' };
  } else if (schema instanceof z.ZodEnum) {
    res = { type: 'string', enum: (schema as any)._def.values };
  } else if (schema instanceof z.ZodArray) {
    res = { type: 'array', items: zodToOpenApiSchema((schema as any)._def.type) };
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    const inner = zodToOpenApiSchema((schema as any)._def.innerType);
    if (!description) description = inner.description;
    res = { ...inner };
  } else if (schema instanceof z.ZodRecord) {
    res = { type: 'object', additionalProperties: true };
  } else if (schema instanceof z.ZodObject) {
    const shape = (schema as any).shape;
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const field = shape[key];
      properties[key] = zodToOpenApiSchema(field);
      if (
        !(field instanceof z.ZodOptional) &&
        !(field instanceof z.ZodNullable) &&
        !(field._def?.typeName === 'ZodOptional')
      ) {
        required.push(key);
      }
    }
    res = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  } else {
    res = { type: 'string' };
  }

  if (description) {
    res.description = description;
  }
  return res;
}

export function generateOpenApiDocument() {
  return {
    openapi: '3.0.0',
    info: {
      title: 'Sora Web Scraping, Deep Search, Transit & MCP API',
      version: '2.0.0',
      description: 'Unified High-Performance Web Scraping, Realtime X Search, Transit & Public Open Data Service (Distroless & Zero-Middleware)',
    },
    paths: {
      '/health': {
        get: { summary: 'ヘルスチェック & コンポーネント稼働状態', responses: { '200': { description: 'OK' } } },
      },
      '/metrics': {
        get: { summary: 'Prometheus / JSON 運用メトリクス', responses: { '200': { description: 'OK' } } },
      },
      '/scrape': {
        post: {
          summary: '単一 Web ページ / PDF スクレイピング (RAGチャンキング・出典抽出・読了時間・PII保護対応)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ScrapeRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'ScrapeResult' } },
        },
      },
      '/scrape/stream': {
        post: {
          summary: '単一 Web ページ スクレイピング進行状況 SSE ストリーミング',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ScrapeRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'Server-Sent Events (start, fetch, render, enrich, done)' } },
        },
      },
      '/scrape/batch': {
        post: {
          summary: '複数 URL 一括並行スクレイピング (最大20件)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(BatchScrapeRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'BatchScrapeResult' } },
        },
      },
      '/crawl': {
        post: {
          summary: '再帰的サブページクロール',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(CrawlRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/crawl/stream': {
        post: {
          summary: '再帰的サブページクロール SSE ストリーミング',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(CrawlRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'Server-Sent Events' } },
        },
      },
      '/map': {
        post: {
          summary: 'サイトマップ & URL マッピング',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(MapRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/browser/action': {
        post: {
          summary: 'ステートレス / ステートフル ブラウザ自動操作',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(BrowserActionRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/search': {
        post: {
          summary: '深層統合検索 (Web + X/Twitter + 並行本文取得・重複排除)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(IntegratedSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/search/web': {
        post: {
          summary: 'Yahoo! Web 検索',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(SearchWebQuerySchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/search/realtime': {
        post: {
          summary: 'Yahoo! リアルタイム検索 (X/Twitter 生の声)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(RealtimeSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/search/suggest': {
        post: {
          summary: 'Yahoo! サジェスト（キーワード自動補完）',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(SuggestRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/transit/route': {
        post: {
          summary: 'Yahoo! 路線情報スクレイピング (乗換案内・料金・所要時間)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(TransitRouteRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/weather': {
        post: {
          summary: '気象庁公式オープンデータ 天気予報・概況文',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(WeatherRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  };
}
