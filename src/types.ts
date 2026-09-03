import { z } from 'zod';

/**
 * サービスのバージョン。GET / のレスポンスと OpenAPI ドキュメントで共有する。
 * package.json の version と同じ値を保つこと（以前 OpenAPI 側だけ 2.0.0 のまま取り残されていた）。
 */
export const SORA_VERSION = '2.10.0';
export const DEFAULT_MAX_CHARS = 30_000;

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

export interface FieldEvidence {
  value: string | number | boolean;
  source: 'jsonld' | 'dom' | 'meta';
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
  textFragmentUrl?: string;
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
  availability?: 'InStock' | 'OutOfStock' | 'PreOrder' | string;
  price?: string;
  priceCurrency?: string;
  brand?: string;
  sku?: string;
  tables?: TableData[];
  extracted?: Record<string, string | null>;
  metadata?: Record<string, any>;
  estimatedTokens?: number;
  html?: string;
  rawHtml?: string;
  screenshot?: string; // base64 PNG
  quality?: number;
  completeness?: number;
  pageType?: 'article' | 'product' | 'qa' | 'generic';
  qualityReasons?: string[];
  missingFields?: string[];
  evidence?: Record<string, FieldEvidence>;
  qualityDistribution?: Record<string, number>;
  avgQuality?: number;
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
  maxChars: z.number().int().min(1).optional().describe('抽出する最大文字数 (デフォルト: 10000)'),
  mode: z.enum(['auto', 'fast', 'browser']).optional().describe('動作モード: "auto"(スマート自動判定, デフォルト), "fast"(最速静的HTTP), "browser"(Stealth Chromium)'),
  renderJs: z.boolean().optional().describe('常にブラウザ描画を強制するか (mode="browser" と同等)'),
  fastOnly: z.boolean().optional().describe('常に静的取得を強制するか (mode="fast" と同等)'),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional().describe('取得する出力フォーマット配列 (デフォルト: ["markdown"])'),
  fullPage: z.boolean().optional().default(true).describe('スクリーンショット撮影時にページ最下部までフルページ撮影するか (デフォルト: true)'),
  onlyMainContent: z.boolean().optional().describe('ヘッダー・フッター・サイドバー等のノイズを除外し、記事本文のみを抽出するか (デフォルト: true)'),
  selectors: z.record(z.string(), z.string()).optional().describe('ピンポイント抽出用 CSS セレクタ連想配列 (例: {"price": ".item-price", "title": "h1"})'),
  clipSelector: z.string().optional().describe('特定要素のみを切り抜いてスクリーンショット撮影する CSS セレクタ (例: "#chart")'),
  headers: z.record(z.string(), z.string()).optional().describe('リクエスト時に送信するカスタム HTTP ヘッダー連想配列'),
  cookies: z.array(CookieParamSchema).optional().describe('リクエスト時に送信するカスタム Cookie 配列'),
  removeSelectors: z.array(z.string()).optional().describe('Markdown 変換前に徹底パージする不要要素の CSS セレクタ配列 (例: [".ad", ".comments"])'),
  query: z.string().optional().describe('ハイライト抽出用キーワード'),
  extractHighlights: z.boolean().optional().describe('指定キーワードに関連する重要文（ハイライト）を自動抽出するか'),
  onlyHighlights: z.boolean().optional().describe('抽出されたハイライトのみを本文 content として返し、ノイズ全文を削除するか (デフォルト: false)'),
  extractSummary: z.boolean().optional().describe('超高速な抽出型自動要約 (TL;DR) を生成するか'),
  extractCitations: z.boolean().optional().describe('本文中の出典・外部引用リンク一覧を抽出するか'),
  chunkMarkdown: z.boolean().optional().describe('RAG 用セマンティック・チャンキングを行うか (見出し階層＆トークン数付き)'),
  chunkSize: z.number().int().min(1).optional().describe('チャンクあたりの文字数目安 (デフォルト: 1000)'),
  validateLinks: z.boolean().optional().describe('抽出されたページ内リンクの健全性・到達性を並行検証するか'),
  formatAsPrompt: z.boolean().optional().describe('LLM に最適化された標準 XML プロンプトラッパー形式を生成するか'),
  stripLinks: z.boolean().optional().describe('Markdown 内のリンク [テキスト](url) から URL を除去してプレーンテキスト化し、LLM トークンを削減するか (デフォルト: false)'),
  filterLinkDensity: z.boolean().optional().describe('リンク密度が極端に高いナビゲーション・タグ一覧・関連記事ブロックを自動パージするか (デフォルト: false)'),
  highlightMatches: z.boolean().optional().describe('本文中の検索一致語句を <mark> でハイライトするか'),
  maskPii: z.boolean().optional().describe('メールアドレス・電話番号・クレカ等の個人情報を自動マスキングするか'),
  webhookUrl: z.string().optional().describe('スクレイプ完了時に結果ペイロードを通知する Webhook URL (非同期)'),
  retries: z.number().int().min(0).max(3).optional().describe('接続失敗時の自動リトライ回数 (0〜3, デフォルト: 0)'),
  retryDelayMs: z.number().int().min(1).optional().describe('リトライ待機ディレイ (ミリ秒)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスして強制再取得するか'),
  timeoutMs: z.number().int().min(1).optional().describe('タイムアウト時間 (ミリ秒, デフォルト: 30000)'),
  verbose: z.boolean().optional().describe('デバッグ用: quality スコアや evidence 等の内部詳細メタデータを含めるか (デフォルト: false)'),
  keepDataImages: z.boolean().optional().describe('base64 インライン画像を Markdown 内で置換せず保持するか (デフォルト: false, [画像: alt] に軽量化)'),
});

export const BatchScrapeRequestSchema = z.object({
  urls: z.array(z.string()).min(1, 'urls は 1 件以上指定してください').describe('一括スクレイピング対象の URL 配列 (最大20件)'),
  concurrency: z.number().int().min(1).max(20).optional().describe('並行フェッチワーカー数 (デフォルト: 3, 最大: 5)'),
  maxChars: z.number().int().min(1).optional().describe('各ページの最大文字数 (デフォルト: 10000)'),
  mode: z.enum(['auto', 'fast', 'browser']).optional().describe('動作モード: "auto", "fast", "browser"'),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional().describe('取得する出力形式配列'),
  onlyMainContent: z.boolean().optional().describe('記事本文のみを抽出するか (デフォルト: true)'),
  selectors: z.record(z.string(), z.string()).optional().describe('ピンポイント抽出用 CSS セレクタ連想配列'),
  stripLinks: z.boolean().optional().describe('Markdown 内のリンク [テキスト](url) から URL を除去してプレーンテキスト化するか'),
  filterLinkDensity: z.boolean().optional().describe('リンク密度が極端に高いナビゲーション・タグ一覧ブロックを自動パージするか'),
  query: z.string().optional().describe('各ページからハイライトを抽出するキーワード'),
  extractHighlights: z.boolean().optional().describe('各ページからキーワードに関連する重要文（ハイライト）を自動抽出するか'),
  onlyHighlights: z.boolean().optional().describe('抽出されたハイライトのみを本文 content として返し、ノイズ全文を削除するか'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
  verbose: z.boolean().optional().describe('デバッグ用: quality スコアや evidence 等の内部詳細メタデータを含めるか (デフォルト: false)'),
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
});

export const CrawlRequestSchema = z.object({
  url: z.string().min(1, 'url は必須です').describe('クロール開始のベース URL (例: "https://example.com/docs")'),
  maxPages: z.number().int().min(1).max(50).optional().describe('巡回する最大ページ数 (デフォルト: 10, 最大: 50)'),
  maxDepth: z.number().int().min(1).optional().describe('リンク探索の最大深度 (デフォルト: 2)'),
  includePatterns: z.array(z.string()).optional().describe('対象を絞り込むワイルドカードパターン (例: ["/docs/**", "/guide/*"])'),
  excludePatterns: z.array(z.string()).optional().describe('クロールから除外するワイルドカードパターン (例: ["/tag/**", "*.pdf"])'),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'jsonLd', 'images', 'tables'])).optional().describe('取得する形式配列'),
  onlyMainContent: z.boolean().optional().describe('記事本文のみ抽出するか (デフォルト: true)'),
  query: z.string().optional().describe('巡回ページからハイライトを抽出するキーワード'),
  extractHighlights: z.boolean().optional().describe('巡回した各ページからキーワードに関連する重要文（ハイライト）を自動抽出するか'),
  onlyHighlights: z.boolean().optional().describe('抽出されたハイライトのみを各ページの本文 content として返し、ノイズ全文を削除するか'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const MapRequestSchema = z.object({
  url: z.string().min(1, 'url は必須です').describe('サイトマップ探索対象のベース URL (例: "https://example.com")'),
  limit: z.number().int().min(1).max(1000).optional().describe('取得する最大 URL 件数 (デフォルト: 200, 最大: 1000)'),
  includeSubdomains: z.boolean().optional().describe('サブドメインも含めるか (デフォルト: false)'),
  since: z.string().optional().describe('指定日時以降に更新された URL のみ抽出するフィルタ (例: "2026-08-01")'),
  until: z.string().optional().describe('指定日時以前に更新された URL のみ抽出するフィルタ'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const ImageSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('画像検索キーワード'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20, 最大: 50)'),
  page: z.number().int().min(1).optional().describe('ページ番号 (1-based)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const VideoSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('動画検索キーワード'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20, 最大: 50)'),
  page: z.number().int().min(1).optional().describe('ページ番号 (1-based)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const NewsSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('ニュース検索キーワード'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 10, 最大: 50)'),
  page: z.number().int().min(1).optional().describe('ページ番号 (1-based)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const ChiebukuroSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('知恵袋 Q&A 検索キーワード'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 10, 最大: 50)'),
  page: z.number().int().min(1).optional().describe('ページ番号 (1-based)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const TrendSearchRequestSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20, 最大: 50)'),
});

export const RealtimeSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('リアルタイム検索キーワード (X/Twitter の生の声)'),
  sort: z.enum(['recent', 'popular']).optional().describe('並び順: "recent"(新着順, デフォルト) または "popular"(話題順)'),
  limit: z.number().int().min(1).max(40).optional().describe('取得件数 (デフォルト: 20, 最大: 40)'),
  page: z.number().int().min(1).optional().describe('ページ番号 (1-based, デフォルト: 1)'),
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
  days: z.number().int().min(1).max(3).optional().describe('取得する予報日数 (1〜3日, デフォルト: 3)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const SearchWebQuerySchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('Web 検索キーワード'),
  includeDomains: z.array(z.string()).optional().describe('結果を絞り込むドメイン配列 (例: ["natalie.mu"])'),
  excludeDomains: z.array(z.string()).optional().describe('結果から除外するドメイン配列'),
  updated: z.enum(['day', 'week', 'month', 'year']).optional().describe('期間指定: "day"(24h以内), "week"(1週間以内), "month"(1ヶ月以内), "year"(1年以内)'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20, 最大: 50)'),
  page: z.number().int().min(1).optional().describe('ページ番号 (1-based)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const IntegratedSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('検索キーワード'),
  includeDomains: z.array(z.string()).optional().describe('結果を絞り込むドメイン配列'),
  excludeDomains: z.array(z.string()).optional().describe('結果から除外するドメイン配列'),
  limit: z.number().int().min(1).max(20).optional().describe('本文取得する上位結果件数 (デフォルト: 5, 最大: 20)'),
  fetchContent: z.boolean().optional().describe('上位サイトの Markdown 本文を並行取得するか (デフォルト: true)'),
  maxCharsPerResult: z.number().int().min(1).max(50_000).optional().describe('各ページの最大文字数 (デフォルト: 10000)'),
  includeRealtime: z.boolean().optional().describe('リアルタイム最新速報 (X) も併せて取得するか (デフォルト: true)'),
  dedup: z.boolean().optional().describe('重複・類似項目を自動排除するか (デフォルト: false)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
  verbose: z.boolean().optional().describe('デバッグ用: 内部詳細メタデータを含めるか (デフォルト: false)'),
});

export const SuggestRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('検索語句プレフィックス'),
  limit: z.number().int().min(1).max(20).optional().describe('取得するサジェスト候補件数 (デフォルト: 10)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const DisasterWarningsRequestSchema = z.object({
  city: z.string().optional().describe('市区町村名または都道府県名 (例: "東京", "新宿区", "大阪府", "福岡")'),
  areaCode: z.string().optional().describe('気象庁エリアコード (6桁または2桁, 例: "130000", "130010")'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const EarthquakeRequestSchema = z.object({
  limit: z.number().int().min(1).max(20).optional().describe('取得件数 (1〜20, デフォルト: 5)'),
  minIntensity: z.number().int().optional().describe('最小震度フィルター (10=震度1, 20=震度2, 30=震度3, 40=震度4, 45=震度5弱, 50=震度5強, 60=震度6強, 70=震度7)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const RoadTrafficRequestSchema = z.object({
  pref: z.union([z.string(), z.number()]).optional().describe('都道府県名または都道府県コード (例: "東京都", "愛知県", "大阪府", 13)'),
  road: z.string().optional().describe('道路名 (例: "東名高速", "首都高", "中央道", "名神高速")'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const WatchRegisterRequestSchema = z.object({
  url: z.string().url('有効な URL を指定してください').describe('監視対象の Web ページ URL'),
  title: z.string().optional().describe('監視ターゲットの識別用タイトル (例: "チケット当落発表ページ")'),
  selector: z.string().optional().describe('ピンポイントで差分監視する CSS セレクタ (例: "#status", ".news-list")'),
  webhookUrl: z.string().url().optional().describe('差分検知時に通知を送信する Webhook URL'),
  intervalSeconds: z.number().int().min(1).optional().describe('監視インターバル目安 (秒, デフォルト: 3600)'),
});

export const WatchCheckRequestSchema = z.object({
  id: z.string().optional().describe('特定の監視ターゲット ID (省略時は全ターゲットを一括スキャン)'),
});

export const SongSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('検索曲名・楽曲タイトル'),
  country: z.string().optional().describe('国コード (デフォルト: "jp")'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const ArtistSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('アーティスト名'),
  country: z.string().optional().describe('国コード (デフォルト: "jp")'),
  entity: z.enum(['song', 'album', 'musicArtist']).optional().describe('検索エンティティ: "song" (楽曲一覧), "album" (アルバム一覧), "musicArtist" (アーティスト情報) (デフォルト: "song")'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const MusicSearchRequestSchema = z.object({
  query: z.string().min(1, 'query は必須です').describe('検索キーワード (曲名、アーティスト名、アルバム名)'),
  country: z.string().optional().describe('国コード (デフォルト: "jp")'),
  entity: z.enum(['song', 'album', 'musicArtist']).optional().describe('検索エンティティ: "song", "album", "musicArtist" (デフォルト: "song")'),
  attribute: z.enum(['songTerm', 'artistTerm', 'albumTerm']).or(z.string()).optional().describe('属性絞り込み: "songTerm" (曲名), "artistTerm" (アーティスト名), "albumTerm" (アルバム名)'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const LawSearchRequestSchema = z.object({
  keyword: z.string().min(1, 'keyword は必須です').describe('法令検索キーワード (法令名、単語)'),
  limit: z.number().int().min(1).max(50).optional().describe('取得件数 (1〜50, デフォルト: 20)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const LawDataRequestSchema = z.object({
  lawId: z.string().min(1, 'lawId は必須です').describe('e-Gov 法令 ID (例: "129AC0000000089")'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const DietMinutesSearchRequestSchema = z.object({
  keyword: z.string().optional().describe('国会会議録の検索キーワード・質問内容 (例: "人工知能", "少子化対策")'),
  speaker: z.string().optional().describe('発言者名・議員名・閣僚名 (例: "総理大臣", "河野太郎")'),
  nameOfHouse: z.enum(['衆議院', '参議院']).optional().describe('院名 ("衆議院" または "参議院")'),
  nameOfMeeting: z.string().optional().describe('委員会名・本会議名 (例: "予算委員会", "本会議", "内閣委員会")'),
  from: z.string().optional().describe('開会日付範囲 開始 (YYYY-MM-DD)'),
  until: z.string().optional().describe('開会日付範囲 終了 (YYYY-MM-DD)'),
  limit: z.number().int().min(1).max(30).optional().describe('取得件数 (1〜30, デフォルト: 10)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});
export type DietMinutesSearchOptions = z.infer<typeof DietMinutesSearchRequestSchema>;

export const CpscCertificateCheckRequestSchema = z.object({
  htsCode: z.string().min(1, 'htsCode は必須です').describe('HTSコード（例: "9503.00.0073"）。判定の主軸キー'),
  targetAge: z.enum(['adult', 'child', 'unknown']).describe('対象年齢層（子供向け製品かどうかはCPSC判定の主要分岐点）'),
  material: z.string().optional().describe('主な素材（鉛・フタル酸エステル規制関連で重要）'),
  productCategory: z.string().optional().describe('製品カテゴリの補足（HTSコードのみで対応表がヒットしない場合の補助情報）'),
  description: z.string().optional().describe('自由記述の補足説明'),
});

export const FdaRegulatedCheckRequestSchema = z.object({
  htsCode: z.string().min(1, 'htsCode は必須です').describe('HTSコード（例: "3004.90.0000", "2106.90.9998"）'),
  productDescription: z.string().optional().describe('製品の自由記述説明（用途・素材等の補助情報）'),
  foodContact: z.boolean().optional().describe('食品・飲料接触用途か（true: 接触, false: 非接触）。食器・調理器具(Chapter 39/69/70/73等)のFD1適用分岐に使用'),
});

export const VerifyHtsCodeRequestSchema = z.object({
  htsCode: z.string().min(1, 'htsCode は必須です').describe('検証したいHTSコード（例: "9503.00.0073"）'),
  productDescription: z.string().min(1, 'productDescription は必須です').describe('製品の説明（素材・用途・機能・加工度合い等）。コード推論の根拠を明示するための必須項目'),
});

export const ProductComplianceRequestSchema = z.object({
  url: z.string().url('有効なURLを指定してください').optional().describe('商品ページのURL（Amazon、ECサイト、メーカー公式等。指定時は自動でスクレイピングして商品情報を取得）'),
  productName: z.string().optional().describe('商品名・タイトル（例: "Wooden Building Blocks for Toddlers", "薬用美白クリーム", "Bicycle Helmet"）'),
  description: z.string().optional().describe('商品の詳細説明・仕様・素材・用途など'),
  htsCode: z.string().optional().describe('既知または候補のHTSコード（指定時は最優先で検証）'),
  targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下の子供向け, adult: 一般/大人向け, unknown: 未指定/不明）。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
  material: z.string().optional().describe('主な素材（例: plastic, wood, metal, cotton）。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
  productCategory: z.string().optional().describe('製品カテゴリ（例: toy, apparel, cosmetics, food, electronics, helmet）'),
  foodContact: z.boolean().optional().describe('食品・飲料に接触する用途か（true: 飲み物や食べ物を入れる/口をつける等の食品接触用途, false: 装飾等の非食品接触用途）。Kitchenware等のカテゴリでFDA食品接触安全基準の判定要否に必要。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
  hasBattery: z.boolean().optional().describe('電池・バッテリーを使用する製品か（true: ボタン電池・コイン電池またはリチウムイオン電池等を内蔵/同梱, false: 電池不使用）。Electronics等のカテゴリでCPSC規制カテゴリ判定・DOT/PHMSA危険物表示要否に必要。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
  batteryType: z.enum(['button_coin', 'other']).optional().describe('電池の種類（button_coin: ボタン電池・コイン電池, other: リチウムイオン電池等その他の電池）。hasBattery=trueの場合のみ意味を持つ。不明な場合は省略しユーザーに確認すること。推測値を入れないこと'),
});
export type ProductComplianceRequestOptions = z.infer<typeof ProductComplianceRequestSchema>;

export const PredictHtsCodeRequestSchema = z.object({
  productName: z.string().min(1, 'productName は必須です').describe('商品名・タイトル（例: "Wooden Building Blocks for Toddlers"）'),
  description: z.string().optional().describe('商品の詳細説明・仕様・素材・用途など'),
  material: z.string().optional().describe('主な素材（例: wood, metal, ceramic, plastic, cotton, glass）'),
  productCategory: z.string().optional().describe('大まかな製品カテゴリ（例: toy, apparel, cosmetics, food, electronics, tableware）'),
  targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下の子供向け, adult: 一般/大人向け, unknown: 未指定/不明）'),
  foodContact: z.boolean().optional().describe('食品・飲料に接触する用途か（true: 飲食・調理用, false: 非食品用途）'),
  hasBattery: z.boolean().optional().describe('電池・バッテリーを使用する製品か'),
});
export type PredictHtsCodeRequestOptions = z.infer<typeof PredictHtsCodeRequestSchema>;

export const ElevationRequestSchema = z.object({
  address: z.string().optional().describe('住所・地名文字列 (例: "東京都千代田区永田町1-7-1", "富士山頂")'),
  lat: z.number().optional().describe('緯度 (住所未指定時に直接指定, 例: 35.681236)'),
  lon: z.number().optional().describe('経度 (住所未指定時に直接指定, 例: 139.767125)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});
export type ElevationOptions = z.infer<typeof ElevationRequestSchema>;

export const FlightStatusRequestSchema = z.object({
  airport: z.string().optional().describe('対象空港名または空港コード (例: "羽田", "成田", "伊丹", "関空", "中部", "新千歳", "福岡", "那覇", "HND", "NRT", "ITM", "KIX", "NGO", "CTS", "FUK", "OKA", デフォルト: "羽田")'),
  type: z.enum(['departure', 'arrival']).optional().describe('発着区分: "departure" (出発) または "arrival" (到着) (デフォルト: "departure")'),
  category: z.enum(['domestic', 'international']).optional().describe('路線区分: "domestic" (国内線) または "international" (国際線) (デフォルト: "domestic")'),
  flightNumber: z.string().optional().describe('特定の便名で絞り込む場合 (例: "ANA2421", "JAL505")'),
  keyword: z.string().optional().describe('目的地・出発地・航空会社名などのキーワード絞り込み (例: "那覇", "全日本空輸")'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});
export const InspectImageRequestSchema = z.object({
  url: z.string().url('有効な画像URLを指定してください').describe('読み取り対象の画像URL (https://...)'),
});
export type InspectImageOptions = z.infer<typeof InspectImageRequestSchema>;

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
      version: SORA_VERSION,
      description: 'Unified High-Performance Web Scraping, Realtime X Search, Transit & Public Open Data Service (Distroless & Zero-Middleware)',
    },
    paths: {
      '/health': {
        get: { summary: 'ヘルスチェック & コンポーネント稼働状態', responses: { '200': { description: 'OK' } } },
      },
      '/metrics': {
        get: { summary: 'Prometheus / JSON 運用メトリクス', responses: { '200': { description: 'OK' } } },
      },
      '/cache/clear': {
        post: { summary: 'キャッシュの全クリア', responses: { '200': { description: 'OK' } } },
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
      '/action': {
        post: {
          summary: 'ブラウザ自動操作 (POST /browser/action の別名)',
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
      '/search/image': {
        post: {
          summary: 'Yahoo! 画像検索',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ImageSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/search/video': {
        post: {
          summary: 'Yahoo! 動画検索',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(VideoSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/search/news': {
        post: {
          summary: 'Yahoo! ニュース検索',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(NewsSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/search/chiebukuro': {
        post: {
          summary: 'Yahoo! 知恵袋 Q&A 検索',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ChiebukuroSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/search/trend': {
        post: {
          summary: 'Yahoo! リアルタイム急上昇トレンド (X/Twitter)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(TrendSearchRequestSchema),
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
      '/disaster/warnings': {
        post: {
          summary: '気象庁公式 特別警報・気象警報・注意報 リアルタイム取得',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(DisasterWarningsRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'AreaWarnings' } },
        },
      },
      '/disaster/earthquake': {
        post: {
          summary: 'P2P地震情報 & 気象庁 リアルタイム地震速報・履歴取得',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(EarthquakeRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'EarthquakeSearchResult' } },
        },
      },
      '/traffic/road': {
        post: {
          summary: 'JARTIC 連携 リアルタイム道路交通情報取得 (事故・渋滞・通行止め・車線規制)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(RoadTrafficRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'RoadTrafficResult' } },
        },
      },
      '/watch/register': {
        post: {
          summary: 'Web ページ差分監視ターゲット登録 (初期ハッシュ作成)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(WatchRegisterRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'WatchTargetResult' } },
        },
      },
      '/watch/check': {
        post: {
          summary: 'Web ページ差分スキャン実行 (差分検知時 Webhook 自動発火)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(WatchCheckRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'WatchCheckResult' } },
        },
      },
      '/watch/list': {
        get: {
          summary: '登録済み差分監視ターゲット一覧取得 (SQLite 永続化)',
          responses: { '200': { description: 'WatchTargetList' } },
        },
      },
      '/watch/{id}': {
        delete: {
          summary: '差分監視ターゲット削除',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/search/song': {
        post: {
          summary: 'iTunes 公式 Search API 曲名指定 楽曲メタデータ検索',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(SongSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'MusicSearchResult' } },
        },
      },
      '/search/artist': {
        post: {
          summary: 'iTunes 公式 Search API アーティスト名指定 音楽・アルバム・アーティストメタデータ検索',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ArtistSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'MusicSearchResult' } },
        },
      },
      '/search/music': {
        post: {
          summary: 'iTunes 公式 Search API 楽曲・アルバム・アーティストメタデータ検索 (汎用)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(MusicSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'MusicSearchResult' } },
        },
      },
      '/search/music/song': {
        post: {
          summary: 'iTunes 公式 Search API 曲名指定 楽曲メタデータ検索 (エイリアス)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(SongSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'MusicSearchResult' } },
        },
      },
      '/search/music/artist': {
        post: {
          summary: 'iTunes 公式 Search API アーティスト名指定 音楽・アルバム・アーティストメタデータ検索 (エイリアス)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ArtistSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'MusicSearchResult' } },
        },
      },
      '/gov/laws': {
        post: {
          summary: 'e-Gov 法令 API v2 キーワード法令検索',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(LawSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'LawSearchResult' } },
        },
      },
      '/gov/law-text': {
        post: {
          summary: 'e-Gov 法令 API v2 法令条文・本文詳細取得 (Markdown 構造化)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(LawDataRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'LawDataResult' } },
        },
      },
      '/trade/cpsc-check': {
        post: {
          summary: '米国CPSC適合証明書 (GCC/CCC) eFiling完全義務化 & ACE免責判定',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(CpscCertificateCheckRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'CpscCertificateCheckResult' } },
        },
      },
      '/trade/fda-check': {
        post: {
          summary: '米国FDA規制対象 実務判定（PGAフラグ FD1〜FD4・Prior Notice・MoCRA要件）',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(FdaRegulatedCheckRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'CheckFdaRegulatedResult' } },
        },
      },
      '/trade/hts-verify': {
        post: {
          summary: 'HTS/HSコード実在確認・検証（USITC公式データ照合）',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(VerifyHtsCodeRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'VerifyHtsCodeResult' } },
        },
      },
      '/trade/compliance': {
        post: {
          summary: '商品統合コンプライアンス一括判定（HTS検証・FDA判定・CPSC証明書/eFiling義務）',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ProductComplianceRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'CheckProductComplianceResult' } },
        },
      },
      '/trade/hts-predict': {
        post: {
          summary: '商品情報からのHTS/HSコード推測（USITC公式API連動・候補提示・関税率取得）',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(PredictHtsCodeRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'PredictHtsCodeResult' } },
        },
      },
      '/gov/diet-minutes': {
        post: {
          summary: '国会会議録検索 API (衆参両院の本会議・委員会発言記録・議員答弁全文検索)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(DietMinutesSearchRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'DietMinutesSearchResult' } },
        },
      },
      '/geo/elevation': {
        post: {
          summary: '国土地理院 住所ジオコーディング & 標高（海抜）取得 API',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ElevationRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'ElevationResult' } },
        },
      },
      '/traffic/flight': {
        post: {
          summary: '主要空港フライト運航状況・欠航・遅延リアルタイム検索 API',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(FlightStatusRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'FlightStatusResult' } },
        },
      },
      '/media/inspect-image': {
        post: {
          summary: '画像取得 & MCP 視覚入力（Base64）変換 API',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(InspectImageRequestSchema),
              },
            },
          },
          responses: { '200': { description: 'InspectImageResult' } },
        },
      },
    },
  };
}
