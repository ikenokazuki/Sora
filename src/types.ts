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
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});

export const ScrapeRequestSchema = z.object({
  url: z.string().min(1, 'url は必須です'),
  maxChars: z.number().int().positive().optional(),
  mode: z.enum(['auto', 'fast', 'browser']).optional(),
  renderJs: z.boolean().optional(),
  fastOnly: z.boolean().optional(),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional(),
  onlyMainContent: z.boolean().optional(),
  selectors: z.record(z.string(), z.string()).optional(),
  clipSelector: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  cookies: z.array(CookieParamSchema).optional(),
  removeSelectors: z.array(z.string()).optional(),
  query: z.string().optional(),
  extractHighlights: z.boolean().optional(),
  extractSummary: z.boolean().optional(),
  extractCitations: z.boolean().optional(),
  chunkMarkdown: z.boolean().optional(),
  chunkSize: z.number().int().positive().optional(),
  validateLinks: z.boolean().optional(),
  formatAsPrompt: z.boolean().optional(),
  highlightMatches: z.boolean().optional(),
  maskPii: z.boolean().optional(),
  webhookUrl: z.string().optional(),
  retries: z.number().int().min(0).max(3).optional(),
  retryDelayMs: z.number().int().positive().optional(),
  proxyUrl: z.string().optional(),
  noCache: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const BatchScrapeRequestSchema = z.object({
  urls: z.array(z.string()).min(1, 'urls は 1 件以上指定してください'),
  concurrency: z.number().int().min(1).max(20).optional(),
  maxChars: z.number().int().positive().optional(),
  mode: z.enum(['auto', 'fast', 'browser']).optional(),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional(),
  onlyMainContent: z.boolean().optional(),
  selectors: z.record(z.string(), z.string()).optional(),
  noCache: z.boolean().optional(),
});

export const BrowserActionRequestSchema = z.object({
  url: z.string().optional(),
  sessionId: z.string().optional(),
  ownerToken: z.string().optional(),
  createSession: z.boolean().optional(),
  closeSession: z.boolean().optional(),
  actions: z.array(z.object({
    type: z.enum(['click', 'fill', 'type', 'press', 'select', 'scroll', 'wait', 'evaluate', 'navigate', 'screenshot']),
    selector: z.string().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    ms: z.number().optional(),
    script: z.string().optional(),
    fullPage: z.boolean().optional(),
  })).optional(),
  extract: z.object({
    markdown: z.boolean().optional(),
    html: z.boolean().optional(),
    screenshot: z.boolean().optional(),
    screenshotFullPage: z.boolean().optional(),
    clipSelector: z.string().optional(),
    maxChars: z.number().optional(),
  }).optional(),
  timeout: z.number().optional(),
  proxyUrl: z.string().optional(),
});

export const CrawlRequestSchema = z.object({
  url: z.string().min(1, 'url は必須です'),
  maxPages: z.number().int().positive().optional(),
  maxDepth: z.number().int().positive().optional(),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional(),
  onlyMainContent: z.boolean().optional(),
  noCache: z.boolean().optional(),
});

export const MapRequestSchema = z.object({
  url: z.string().min(1, 'url は必須です'),
  limit: z.number().int().positive().optional(),
  includeSubdomains: z.boolean().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  noCache: z.boolean().optional(),
});

export const RealtimeSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です'),
  sort: z.enum(['recent', 'popular']).optional(),
  limit: z.number().int().min(1).max(40).optional(),
  page: z.number().int().positive().optional(),
  noCache: z.boolean().optional(),
});

export const TransitRouteRequestSchema = z.object({
  from: z.string().min(1, 'from は必須です'),
  to: z.string().min(1, 'to は必須です'),
  via: z.array(z.string()).optional(),
  sortBy: z.enum(['time', 'transfer', 'fare']).optional(),
  seatPreference: z.enum(['any', 'reserved', 'non_reserved', 'green']).optional(),
  walkSpeed: z.enum(['fast', 'slightly_fast', 'slightly_slow', 'slow', 'normal']).optional(),
});

export const WeatherRequestSchema = z.object({
  city: z.string().min(1, 'city は必須です'),
  days: z.number().int().positive().optional(),
  noCache: z.boolean().optional(),
});

export const SearchWebQuerySchema = z.object({
  query: z.string().min(1, 'query は必須です'),
  includeDomains: z.array(z.string()).optional(),
  excludeDomains: z.array(z.string()).optional(),
  updated: z.enum(['day', 'week', 'month', 'year']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  page: z.number().int().positive().optional(),
  noCache: z.boolean().optional(),
});

export const IntegratedSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です'),
  includeDomains: z.array(z.string()).optional(),
  excludeDomains: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  fetchContent: z.boolean().optional(),
  maxCharsPerResult: z.number().int().positive().optional(),
  includeRealtime: z.boolean().optional(),
  dedup: z.boolean().optional(),
  noCache: z.boolean().optional(),
});

export const SuggestRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です'),
  limit: z.number().int().min(1).max(20).optional(),
  noCache: z.boolean().optional(),
});

// ==========================================
// Zod -> OpenAPI 3.0 自動スキーマジェネレーター
// ==========================================
export function zodToOpenApiSchema(schema: z.ZodTypeAny): any {
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: (schema as any)._def.values };
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodToOpenApiSchema((schema as any)._def.type) };
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return zodToOpenApiSchema((schema as any)._def.innerType);
  if (schema instanceof z.ZodRecord) return { type: 'object', additionalProperties: true };
  if (schema instanceof z.ZodObject) {
    const shape = (schema as any).shape;
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const field = shape[key];
      properties[key] = zodToOpenApiSchema(field);
      if (!(field instanceof z.ZodOptional) && !(field instanceof z.ZodNullable) && !(field._def?.typeName === 'ZodOptional')) {
        required.push(key);
      }
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }
  return { type: 'string' };
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
