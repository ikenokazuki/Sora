import { z } from 'zod';

/**
 * サービスのバージョン。GET / のレスポンスと OpenAPI ドキュメントで共有する。
 * package.json の version と同じ値を保つこと（以前 OpenAPI 側だけ 2.0.0 のまま取り残されていた）。
 */
export const SORA_VERSION = '2.23.1';
export const DEFAULT_MAX_CHARS = 30_000;

export const SCRAPE_FORMATS = [
  'markdown',
  'html',
  'rawHtml',
  'links',
  'screenshot',
  'jsonLd',
  'images',
  'tables',
] as const;

export type ScrapeFormat = (typeof SCRAPE_FORMATS)[number];
export const ScrapeFormatSchema = z.enum(SCRAPE_FORMATS);

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
  isImportant?: boolean;
  imageType?: 'flyer' | 'timetable' | 'diagram' | 'chart' | 'photo' | 'general';
  width?: number;
  height?: number;
}

export interface EventItem {
  name: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  performer?: string;
  description?: string;
  url?: string;
  eventStatus?: string;
  eventAttendanceMode?: string;
  offers?: {
    price?: string;
    priceCurrency?: string;
    url?: string;
    availability?: string;
  };
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

/** ブロック単位の出所識別メタデータ (Block Provenance) */
export interface EvidenceBlockRef {
  sourceId: string; // 例: "S1"
  blockId: string;  // 例: "P4"
  url?: string;
  publishedTime?: string;
  updatedTime?: string;
  nearestHeading?: string;
  headingPath?: string[];
}

/** 時間的文脈アンカー (Temporal Context Anchor) */
export interface TemporalAnchor {
  expression: string;         // 例: "明日", "来週金曜日", "3日前"
  referenceDate: string;      // 例: "2026-09-01"
  resolvedDate: string;       // 例: "2026-09-02"
  resolvedDayOfWeek?: string; // 例: "水曜日"
  confidence: 'high' | 'medium';
}

/** 出所情報・スコア付きハイライトアイテム */
export interface HighlightItem {
  text: string;
  score: number;
  ref?: EvidenceBlockRef;
  anchor?: string; // 例: "> [S1:P4 | 2026-09-01]"
  textFragmentUrl?: string;
  temporalAnchors?: TemporalAnchor[];
}

/** ρSelect (rho-select) 実行時診断メタデータ */
export interface RhoSelectDiagnostics {
  candidateCount: number;
  compactCandidateCount: number;
  termCount: number;
  evidenceLevels: number;
  featureCount: number;
  stateCount: number;
  frontierCount: number;
  selectedCount: number;
  selectedTokens: number;
  utility: number;
  density: number;
  lambda: number;
  dinkelbachIterations: number;
  directOptimumDensity: number;
  exactAgreement: boolean;
}

/** 後方互換用エイリアス */
export type RhoBm25Diagnostics = RhoSelectDiagnostics;

/** ハイライト選択アルゴリズム種別 */
export const HIGHLIGHT_ALGORITHMS = [
  'rho-select',
  'rho-select-v2',
  'rho-bm25',
  'legacy',
] as const;

export type HighlightAlgorithm = (typeof HIGHLIGHT_ALGORITHMS)[number];

export const HighlightAlgorithmSchema = z.enum(HIGHLIGHT_ALGORITHMS);

export const DEFAULT_HIGHLIGHT_ALGORITHM: HighlightAlgorithm = 'rho-select-v2';

export interface RhoOptimizerCertificate {
  scope: 'score_defined_objective_only';
  valid: boolean;
  solver: 'exact' | 'ar';
  lowerBound: number;
  upperBound: number;
  relativeGap: number;
  epsilon: number;
  exact: boolean;
  iterations: number;
  postProcessed: boolean;
}

export interface RhoSelectV2Diagnostics {
  engine: 'rho-select-v2';
  requirementsSource: 'explicit' | 'query_terms';
  requirements: string[];
  requirementWeights: number[];
  scoreReliability: { status: 'not_calibrated' };
  candidateCount: number;
  keptCandidateCount: number;
  selectedCount: number;
  selectedTokens: number;
  utility: number;
  cost: number;
  rho: number;
  witnessSubsetBound: string;
  certificate: RhoOptimizerCertificate;
  warning?: string;
  history?: Array<{
    iteration: number;
    stateCount: number;
    lowerBound: number;
    upperBound: number;
    relativeGap: number;
    partitionSizes: number[];
  }>;
}

/** 決定論的証拠充足性観測量 (Evidence Diagnostics) - Soraは意味判定を行わず客観的観測値のみ返却 */
export interface EvidenceDiagnostics {
  queryCoverage: number;       // クエリ語句のうち本文または見出しに出現した割合 (0.0〜1.0)
  matchedTerms: string[];      // マッチした語句
  missingTerms: string[];      // マッチしなかった語句
  candidateCount: number;      // スコア > 0 の候補ブロック数
  topScore: number;            // 最高スコア
  weakEvidenceSignal: boolean; // coverage < 0.35 または candidateCount === 0 の場合の客観的フラグ
  reasons: string[];           // weak判定の客観的理由 (例: ["low_query_coverage", "no_matching_blocks"])
}

/** 不一致候補 (Candidate Discrepancy) - 勝手に解消せず上位エージェントに対比提示 */
export interface CandidateDiscrepancy {
  kind: 'date' | 'money' | 'version' | 'number';
  values: Array<{
    original: string;
    normalized: string;
    sourceId?: string;
    blockId?: string;
    context?: string;
  }>;
  status: 'needs_agent_resolution';
}

/** 決定論的導出メタデータ (Derivation Trace) */
export interface DerivationTrace {
  operation: string; // 例: "kanji_num_to_digits", "km_to_m", "fullwidth_to_halfwidth"
  input: string;
  output: string;
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
  twitterHandle?: string;
  socialLinks?: Record<string, string>;
  highlights?: string[];
  highlightItems?: HighlightItem[];
  evidenceDiagnostics?: EvidenceDiagnostics;
  discrepancies?: CandidateDiscrepancy[];
  derivations?: DerivationTrace[];
  temporalAnchors?: TemporalAnchor[];
  highlightDiagnostics?: RhoSelectDiagnostics | RhoSelectV2Diagnostics;
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
  events?: EventItem[];
  breadcrumb?: string[];
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
  formats: z.array(ScrapeFormatSchema).optional().describe('取得する出力フォーマット配列 (デフォルト: ["markdown"])'),
  fullPage: z.boolean().optional().default(true).describe('スクリーンショット撮影時にページ最下部までフルページ撮影するか (デフォルト: true)'),
  onlyMainContent: z.boolean().optional().describe('ヘッダー・フッター・サイドバー等のノイズを除外し、記事本文のみを抽出するか (デフォルト: true)'),
  selectors: z.record(z.string(), z.string()).optional().describe('ピンポイント抽出用 CSS セレクタ連想配列 (例: {"price": ".item-price", "title": "h1"})'),
  clipSelector: z.string().optional().describe('特定要素のみを切り抜いてスクリーンショット撮影する CSS セレクタ (例: "#chart")'),
  headers: z.record(z.string(), z.string()).optional().describe('リクエスト時に送信するカスタム HTTP ヘッダー連想配列'),
  cookies: z.array(CookieParamSchema).optional().describe('リクエスト時に送信するカスタム Cookie 配列'),
  removeSelectors: z.array(z.string()).optional().describe('Markdown 変換前に徹底パージする不要要素の CSS セレクタ配列 (例: [".ad", ".comments"])'),
  query: z.string().optional().describe('ハイライト抽出用キーワード'),
  extractHighlights: z.boolean().optional().describe('指定キーワードに関連する重要文（ハイライト）を自動抽出するか (デフォルト: query指定時はtrue, query未指定時はfalse)'),
  onlyHighlights: z.boolean().optional().describe('抽出されたハイライトのみを本文 content として返し、ノイズ全文を削除するか (デフォルト: false)'),
  highlightAlgorithm: z.enum(['rho-select', 'rho-select-v2', 'rho-bm25', 'legacy']).optional().default('rho-select-v2').describe('ハイライト選択アルゴリズム: "rho-select-v2"(デフォルト: 論文版クエリ証明書付き最適化), "rho-select"(旧レガシー版), "rho-bm25", "legacy"'),
  highlightOverheadTokens: z.number().int().min(1).max(4096).optional().describe('ρSelect の固定コンテキストオーバーヘッドトークン数 τ (デフォルト: 96)'),
  highlightMaxCount: z.number().int().min(1).max(10).optional().describe('ハイライト最大選択件数 (デフォルト: 3)'),
  evidenceMode: z.enum(['full', 'highlights', 'contextual_highlights']).optional().describe('証拠提示モード: "full"(デフォルト全文), "highlights"(抽出文のみ), "contextual_highlights"(前後文脈・見出し・表ヘッダーを保持したパッセージ)'),
  includeDiagnostics: z.boolean().optional().describe('決定論的な証拠充足性観測量 (queryCoverage, weakEvidenceSignal 等) を含めるか'),
  includeDiscrepancies: z.boolean().optional().describe('日付・金額等の不一致候補 (Candidate Discrepancies) を検出して含めるか'),
  safeNormalize: z.boolean().optional().describe('漢数字や物理単位の安全な決定論的正規化 (1万2000円->12000円, km->m等) を適用し導出履歴を残すか'),
  reorderUFlat: z.boolean().optional().describe('Lost in the Middle 対策: 抽出パッセージを LLM の注意が集中する先頭と末尾に最重要情報を配置する U字型で並べ替えるか (デフォルト: false)'),
  diversityWeight: z.number().min(0).max(1).optional().describe('MMR によるパッセージ多様性比率 (0.0〜1.0, デフォルト: 0.7)。類似する言い換え文の重複を排除'),
  minimizeTables: z.boolean().optional().describe('HTML テーブルの空欄列・冗長列を自動パージしてトークン消費を圧縮するか (デフォルト: true)'),
  annotateTemporal: z.boolean().optional().describe('相対時間表現（明日、来週等）に決定論的な絶対日時注記 [YYYY-MM-DD] を付与するか (デフォルト: false)'),
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
  formats: z.array(ScrapeFormatSchema).optional().describe('取得する出力形式配列'),
  onlyMainContent: z.boolean().optional().describe('記事本文のみを抽出するか (デフォルト: true)'),
  selectors: z.record(z.string(), z.string()).optional().describe('ピンポイント抽出用 CSS セレクタ連想配列'),
  stripLinks: z.boolean().optional().describe('Markdown 内のリンク [テキスト](url) から URL を除去してプレーンテキスト化するか'),
  filterLinkDensity: z.boolean().optional().describe('リンク密度が極端に高いナビゲーション・タグ一覧ブロックを自動パージするか'),
  query: z.string().optional().describe('各ページからハイライトを抽出するキーワード'),
  extractHighlights: z.boolean().optional().describe('各ページからキーワードに関連する重要文（ハイライト）を自動抽出するか (デフォルト: query指定時はtrue, query未指定時はfalse)'),
  onlyHighlights: z.boolean().optional().describe('抽出されたハイライトのみを本文 content として返し、ノイズ全文を削除するか'),
  highlightAlgorithm: z.enum(['rho-select', 'rho-select-v2', 'rho-bm25', 'legacy']).optional().default('rho-select-v2').describe('ハイライト選択アルゴリズム: "rho-select-v2"(デフォルト: 論文版クエリ証明書付き最適化), "rho-select"(旧レガシー版), "rho-bm25", "legacy"'),
  highlightOverheadTokens: z.number().int().min(1).max(4096).optional().describe('ρSelect の固定コンテキストオーバーヘッドトークン数 τ (デフォルト: 96)'),
  highlightMaxCount: z.number().int().min(1).max(10).optional().describe('ハイライト最大選択件数 (デフォルト: 3)'),
  evidenceMode: z.enum(['full', 'highlights', 'contextual_highlights']).optional().describe('証拠提示モード: "full"(デフォルト全文), "highlights"(抽出文のみ), "contextual_highlights"(前後文脈・見出し・表ヘッダーを保持したパッセージ)'),
  includeDiagnostics: z.boolean().optional().describe('クエリ網羅率や証拠シグナル等の客観的観測量（Evidence Diagnostics）を付与するか (デフォルト: false)'),
  includeDiscrepancies: z.boolean().optional().describe('日付・金額・バージョンの不一致候補を検出して対比提示するか (デフォルト: false)'),
  safeNormalize: z.boolean().optional().describe('漢数字（万）や単位（km/ms）等の決定論的正規化と導出履歴（derivations）を付与するか (デフォルト: false)'),
  reorderUFlat: z.boolean().optional().describe('Lost in the Middle 対策: 各ページの抽出パッセージを U字型で並べ替えるか (デフォルト: false)'),
  diversityWeight: z.number().min(0).max(1).optional().describe('MMR によるパッセージ多様性比率 (0.0〜1.0, デフォルト: 0.7)'),
  minimizeTables: z.boolean().optional().describe('HTML テーブルの空欄列・冗長列を自動パージしてトークン消費を圧縮するか (デフォルト: true)'),
  annotateTemporal: z.boolean().optional().describe('相対時間表現（明日、来週等）に決定論的な絶対日時注記 [YYYY-MM-DD] を付与するか (デフォルト: false)'),
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
  formats: z.array(ScrapeFormatSchema).optional().describe('取得する形式配列'),
  onlyMainContent: z.boolean().optional().describe('記事本文のみ抽出するか (デフォルト: true)'),
  query: z.string().optional().describe('巡回ページからハイライトを抽出するキーワード'),
  extractHighlights: z.boolean().optional().describe('巡回した各ページからキーワードに関連する重要文（ハイライト）を自動抽出するか'),
  onlyHighlights: z.boolean().optional().describe('抽出されたハイライトのみを各ページの本文 content として返し、ノイズ全文を削除するか'),
  highlightAlgorithm: z.enum(['rho-select', 'rho-select-v2', 'rho-bm25', 'legacy']).optional().default('rho-select-v2').describe('ハイライト選択アルゴリズム: "rho-select-v2"(デフォルト: 論文版クエリ証明書付き最適化), "rho-select"(旧レガシー版), "rho-bm25", "legacy"'),
  highlightOverheadTokens: z.number().int().min(1).max(4096).optional().describe('ρSelect の固定コンテキストオーバーヘッドトークン数 τ (デフォルト: 96)'),
  highlightMaxCount: z.number().int().min(1).max(10).optional().describe('ハイライト最大選択件数 (デフォルト: 3)'),
  reorderUFlat: z.boolean().optional().describe('Lost in the Middle 対策: 各ページの抽出パッセージを U字型で並べ替えるか (デフォルト: false)'),
  diversityWeight: z.number().min(0).max(1).optional().describe('MMR によるパッセージ多様性比率 (0.0〜1.0, デフォルト: 0.7)'),
  minimizeTables: z.boolean().optional().describe('HTML テーブルの空欄列・冗長列を自動パージしてトークン消費を圧縮するか (デフォルト: true)'),
  annotateTemporal: z.boolean().optional().describe('相対時間表現（明日、来週等）に決定論的な絶対日時注記 [YYYY-MM-DD] を付与するか (デフォルト: false)'),
  maxChars: z.number().int().min(1).optional().describe('各ページの最大文字数 (デフォルト: 15000)'),
  timeoutMs: z.number().int().min(1).optional().describe('タイムアウト時間 (ミリ秒, デフォルト: 30000)'),
  concurrency: z.number().int().min(1).max(10).optional().describe('並行クロールワーカー数 (デフォルト: 3)'),
  webhookUrl: z.string().url().optional().describe('クロール完了通知用 Webhook URL'),
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
  query: z.string().optional().describe('リアルタイム検索キーワード (例: "地震", "タイテ", "告知")。※accountId や hashtags を指定する場合は省略可能'),
  accountId: z.string().optional().describe('【特定アカウントの投稿絞り込み】Xアカウント名（例: "Yahoo_JAPAN_PR", "kimisora_JPN"）。@の有無問わず自動で id:xxx に変換します。'),
  fromUser: z.string().optional().describe('accountId のエイリアス (LLM 互換用)'),
  toAccount: z.string().optional().describe('【特定アカウント宛ての投稿】宛先アカウント名（@xxx に変換）'),
  hashtags: z.union([z.string(), z.array(z.string())]).optional().describe('【特定ハッシュタグ絞り込み】ハッシュタグ名（例: "#君と見るそら", "地震"）。#の有無問わず付与します。'),
  excludeWords: z.union([z.string(), z.array(z.string())]).optional().describe('【除外キーワード】除外したい単語（-単語 に変換）'),
  orWords: z.array(z.string()).optional().describe('【OR検索】いずれかを含む単語の配列 (単語A 単語B) に変換'),
  url: z.string().optional().describe('【URL/ドメイン絞り込み】含まれるURLまたはドメイン名'),
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
  days: z.number().int().min(1).max(8).optional().describe('取得する予報日数 (1〜8日, デフォルト: 7)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか'),
});

export const IntegratedSearchResponseModeSchema = z.enum(['full', 'evidence']);
export type IntegratedSearchResponseMode = z.infer<
  typeof IntegratedSearchResponseModeSchema
>;
export const DEFAULT_INTEGRATED_SEARCH_RESPONSE_MODE: IntegratedSearchResponseMode = 'full';

export const SEARCH_WEB_INPUT_SHAPE = {
  query: z.string().min(1, 'query は必須です').describe('Web 検索キーワード'),
  includeDomains: z.array(z.string()).optional().describe('結果を絞り込むドメイン配列 (例: ["natalie.mu"])'),
  excludeDomains: z.array(z.string()).optional().describe('結果から除外するドメイン配列'),
  updated: z.enum(['all', 'day', 'week', 'year']).optional().describe('期間指定: "all"(全期間), "day"(24h以内), "week"(1週間以内), "year"(1年以内)'),
  formats: z.array(ScrapeFormatSchema).optional().describe('指定時のみ上位検索結果をスクレイプし、要求形式を付与する'),
  limit: z.number().int().min(1).max(20).optional().describe('取得件数 (最大: 20。formats指定時に省略した場合は5。formats未指定かつlimit省略時は軽量provider searchの既定結果件数を維持)'),
  maxChars: z.number().int().min(1).max(50_000).optional().describe('formats指定時の各ページ最大文字数 (デフォルト: 30000)'),
  onlyMainContent: z.boolean().optional().describe('formats指定時に本文領域のみ抽出するか (デフォルト: true)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか (デフォルト: false)'),
};
export const SearchWebQuerySchema = z.object(SEARCH_WEB_INPUT_SHAPE);
export const SearchWebRequestSchema = SearchWebQuerySchema;
export type SearchWebRequest = z.infer<typeof SearchWebRequestSchema>;

export const INTEGRATED_SEARCH_INPUT_SHAPE = {
  query: z.string().min(1, 'query は必須です').describe('検索キーワード (例: "TypeScript 5.5 新機能", "最新AI動向")'),
  limit: z.number().int().min(1).max(20).optional().describe('本文取得する上位結果件数 (デフォルト: 5, 最大: 20)'),
  scrapeContent: z.boolean().optional().describe('上位結果のページ本文を取得するか (デフォルト: true)'),
  includeRealtime: z.boolean().optional().describe('リアルタイム最新速報 (X) も併せて取得するか (デフォルト: true)'),
  realtimeSort: z.enum(['recent', 'popular']).optional().describe('リアルタイム速報のソート順: "recent"(新着順, デフォルト), "popular"(人気順)'),
  officialAccountId: z.string().optional().describe('公式XアカウントID (例: "kimisora_JPN")。指定時は公式アカウントの最新告知を優先取得して先頭に配置します'),
  maxChars: z.number().int().min(1).max(50_000).optional().describe('各ページの最大文字数 (デフォルト: 30000)'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか (デフォルト: false)'),
  includeDomains: z.array(z.string()).optional().describe('結果を絞り込むドメイン配列'),
  excludeDomains: z.array(z.string()).optional().describe('結果から除外するドメイン配列'),
  updated: z.enum(['all', 'day', 'week', 'year']).optional().describe('期間指定: "all"(全期間), "day"(24h以内), "week"(1週間以内), "year"(1年以内)'),
  extractHighlights: z.boolean().optional().describe('重要文（ハイライト）を自動抽出するか (デフォルト: true)'),
  onlyMainContent: z.boolean().optional().describe('記事本文のみを抽出するか (デフォルト: true)'),
  formats: z.array(ScrapeFormatSchema).optional().describe('指定フォーマット配列 (例: ["markdown", "tables"])。指定時は要求形式のみを抽出し、evidenceモードでも明示要求された形式を保持します'),
  dedup: z.boolean().optional().describe('重複・類似項目を自動排除するか (デフォルト: false)'),
  reorderUFlat: z.boolean().optional().describe('Lost in the Middle 対策: 検索結果アイテムを LLM の注意が集中する先頭と末尾に重要情報を配置する U字型で並べ替えるか (デフォルト: false)'),
  enablePrf: z.boolean().optional().describe('インメモリ擬似適合フィードバック (PRF) による共起語自動クエリ拡張を有効化するか (デフォルト: false)'),
  diversityWeight: z.number().min(0).max(1).optional().describe('MMR によるパッセージ多様性比率 (0.0〜1.0, デフォルト: 0.7)'),
  minimizeTables: z.boolean().optional().describe('HTML テーブルの空欄列・冗長列を自動パージしてトークン消費を圧縮するか (デフォルト: true)'),
  annotateTemporal: z.boolean().optional().describe('相対時間表現（明日、来週等）に決定論的な絶対日時注記 [YYYY-MM-DD] を付与するか (デフォルト: false)'),
  highlightAlgorithm: HighlightAlgorithmSchema.optional().default(DEFAULT_HIGHLIGHT_ALGORITHM).describe('ハイライト選択アルゴリズム: "rho-select-v2"(デフォルト: 論文版クエリ証明書付き最適化), "rho-select"(旧レガシー版), "rho-bm25", "legacy"'),
  highlightOverheadTokens: z.number().int().min(1).max(4096).optional().describe('ρSelect の固定コンテキストオーバーヘッドトークン数 τ (デフォルト: 96)'),
  highlightMaxCount: z.number().int().min(1).max(10).optional().describe('ハイライト最大選択件数 (デフォルト: 3)'),
  verbose: z.boolean().optional().describe('デバッグ用: 内部詳細メタデータを含めるか (デフォルト: false)'),
  responseMode: IntegratedSearchResponseModeSchema.optional().default('full').describe('返却モード: "full" はデフォルト・従来互換で全文および周辺文脈を保持。"evidence" は query-selected highlights を保持し、安全条件を満たす結果だけ全文 Markdown の重複返却を省略する明示opt-in。質問への回答に必要な情報が局所的で highlights だけで十分な場合は evidence を使用する。全文要約、網羅的な列挙・調査、複数観点の比較、ページ全体の文脈が必要な場合は full を使用する。evidence は全文同等ではないため、返却後に必要項目が欠ける・根拠が曖昧・ソース間で矛盾する場合は full または formats:["markdown"] で再取得する。formats:["markdown"] を明示した場合は evidence でも全文 Markdown を保持する。'),
};
export const IntegratedSearchRequestSchema = z.object(INTEGRATED_SEARCH_INPUT_SHAPE);
export type IntegratedSearchRequest = z.infer<typeof IntegratedSearchRequestSchema>;

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
  targetAge: z.enum(['adult', 'child', 'unknown']).describe('対象年齢層（child: 12歳以下の子供向け, adult: 一般/大人向け, unknown: 未指定/不明）。【推測値のでっち上げ厳禁】不明な場合は"unknown"を指定すること。ツール側が不足項目としてユーザーへの確認質問を返却します'),
  material: z.string().optional().describe('主な素材（鉛・フタル酸エステル規制関連で重要）。【推測値の入力厳禁】不明な場合は省略すること'),
  productCategory: z.string().optional().describe('製品カテゴリの補足（HTSコードのみで対応表がヒットしない場合の補助情報）。【推測値の入力厳禁】不明な場合は省略すること'),
  description: z.string().optional().describe('自由記述の補足説明'),
});

export const FdaRegulatedCheckRequestSchema = z.object({
  htsCode: z.string().min(1, 'htsCode は必須です').describe('HTSコード（例: "3004.90.0000", "2106.90.9998"）'),
  productDescription: z.string().optional().describe('製品の自由記述説明（用途・素材等の補助情報）'),
  foodContact: z.boolean().optional().describe('食品・飲料接触用途か（true: 接触, false: 非接触）。食器・調理器具(Chapter 39/69/70/73等)のFD1適用分岐に使用。【推測値のでっち上げ厳禁】不明な場合は省略すること。ツール側が判定影響と確認質問を返却します'),
});

export const VerifyHtsCodeRequestSchema = z.object({
  htsCode: z.string().min(1, 'htsCode は必須です').describe('検証したいHTSコード（例: "9503.00.0073"）。推測ではなく既知・候補のコードを指定すること'),
  productDescription: z.string().min(1, 'productDescription は必須です').describe('製品の説明（素材・用途・機能・加工度合い等）。コード推論の根拠を明示するための必須項目'),
});

export const ProductComplianceRequestSchema = z.object({
  url: z.string().url('有効なURLを指定してください').optional().describe('商品ページのURL（Amazon、ECサイト、メーカー公式等。指定時は自動でスクレイピングして商品情報を取得）'),
  productName: z.string().optional().describe('商品名・タイトル（例: "Wooden Building Blocks for Toddlers", "薬用美白クリーム", "Bicycle Helmet"）'),
  description: z.string().optional().describe('商品の詳細説明・仕様・素材・用途など'),
  htsCode: z.string().optional().describe('既知または候補のHTSコード（指定時は最優先で検証）'),
  targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下の子供向け, adult: 一般/大人向け, unknown: 未指定/不明）。【推測値のでっち上げ厳禁】不明な場合は省略しユーザーに確認すること'),
  material: z.string().optional().describe('主な素材（例: plastic, wood, metal, cotton）。【推測値のでっち上げ厳禁】不明な場合は省略しユーザーに確認すること'),
  productCategory: z.string().optional().describe('製品カテゴリ（例: toy, apparel, cosmetics, food, electronics, helmet）。【推測値の入力厳禁】不明な場合は省略すること'),
  foodContact: z.boolean().optional().describe('食品・飲料に接触する用途か（true: 飲み物や食べ物を入れる/口をつける等の食品接触用途, false: 装飾等の非食品接触用途）。【推測値のでっち上げ厳禁】Kitchenware等のカテゴリでFDA食品接触安全基準の判定要否に必要。不明な場合は省略しユーザーに確認すること'),
  hasBattery: z.boolean().optional().describe('電池・バッテリーを使用する製品か（true: ボタン電池・コイン電池またはリチウムイオン電池等を内蔵/同梱, false: 電池不使用）。【推測値のでっち上げ厳禁】Electronics等のカテゴリでCPSC規制カテゴリ判定・DOT/PHMSA危険物表示要否に必要。不明な場合は省略しユーザーに確認すること'),
  batteryType: z.enum(['button_coin', 'other']).optional().describe('電池の種類（button_coin: ボタン電池・コイン電池, other: リチウムイオン電池等その他の電池）。hasBattery=trueの場合のみ意味を持つ。【推測値のでっち上げ厳禁】不明な場合は省略しユーザーに確認すること'),
});
export type ProductComplianceRequestOptions = z.infer<typeof ProductComplianceRequestSchema>;

export const PredictHtsCodeRequestSchema = z.object({
  productName: z.string().min(1, 'productName は必須です').describe('商品名・タイトル（例: "Wooden Building Blocks for Toddlers"）'),
  description: z.string().optional().describe('商品の詳細説明・仕様・素材・用途など'),
  material: z.string().optional().describe('主な素材（例: wood, metal, ceramic, plastic, cotton, glass）。【推測値のでっち上げ厳禁】素材によりHTSコード・関税率が大きく分岐するため、不明な場合は省略すること。ツール側がユーザー確認質問を返却します'),
  productCategory: z.string().optional().describe('大まかな製品カテゴリ（例: toy, apparel, cosmetics, food, electronics, tableware）。【推測値の入力厳禁】不明な場合は省略すること'),
  targetAge: z.enum(['adult', 'child', 'unknown']).optional().describe('対象年齢層（child: 12歳以下の子供向け, adult: 一般/大人向け, unknown: 未指定/不明）。【推測値のでっち上げ厳禁】CPSC証明書およびeFiling要件が分岐するため、不明な場合は省略すること'),
  foodContact: z.boolean().optional().describe('食品・飲料に接触する用途か（true: 飲食・調理用, false: 非食品用途）。【推測値のでっち上げ厳禁】FDA規制・Prior Notice要否が分岐するため、不明な場合は省略すること'),
  hasBattery: z.boolean().optional().describe('電池・バッテリーを使用する製品か。【推測値のでっち上げ厳禁】CPSC規格や危険物表示義務が分岐するため、不明な場合は省略すること'),
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
// 荷物追跡 (Package Tracking)
// ==========================================
export type CarrierCode = 'yamato' | 'sagawa' | 'japanpost' | 'seino' | 'fukutsu' | 'ups';
export type TrackingStatus = 'delivered' | 'in_transit' | 'registered' | 'returned' | 'error' | 'not_found' | 'unknown';

export interface TrackingEvent {
  date?: string;
  status: string;
  location?: string;
  description?: string;
}

export interface TrackingResult {
  carrier: CarrierCode;
  carrierName: string;
  trackingNumber: string;
  status: TrackingStatus;
  statusText: string;
  events: TrackingEvent[];
  trackingUrl: string;
  details?: {
    origin?: string;
    destination?: string;
    deliveryDate?: string;
    serviceType?: string;
  };
  error?: string;
  cached?: boolean;
  fetchedAt?: string;
}

export const TrackingRequestSchema = z.object({
  trackingNumber: z.string().min(1, '追跡番号は必須です').describe('荷物の追跡番号・送り状番号・お問い合わせ番号（ハイフン有無問わず）'),
  carrier: z.enum(['yamato', 'sagawa', 'japanpost', 'seino', 'fukutsu', 'ups', 'auto']).optional().describe('運送会社コード (yamato, sagawa, japanpost, seino, fukutsu, ups, auto)。未指定または "auto" の場合は自動判別'),
  noCache: z.boolean().optional().describe('キャッシュをバイパスして最新情報を強制取得するか'),
});
export interface TrackingRequest {
  trackingNumber: string;
  carrier?: CarrierCode | 'auto';
  noCache?: boolean;
}




// ==========================================
// レスポンス用 Zod スキーマ (OpenAPI 3.0 自動展開用)
// ==========================================

// --- サブコンポーネント スキーマ ---
export const TableDataSchema = z.object({
  id: z.string().optional().describe('テーブル識別子'),
  caption: z.string().optional().describe('テーブルのキャプション・見出し'),
  headers: z.array(z.string()).describe('表ヘッダー列名一覧'),
  rows: z.array(z.record(z.string(), z.string())).describe('行データ配列 (キー: ヘッダー名, 値: セル文字列)'),
});

export const MediaInfoSchema = z.object({
  type: z.enum(['youtube', 'video', 'audio']).describe('メディア種別'),
  videoId: z.string().optional().describe('YouTube等の動画ID'),
  duration: z.string().optional().describe('再生時間'),
  thumbnail: z.string().optional().describe('サムネイル画像URL'),
  chapters: z.array(z.object({
    title: z.string().describe('チャプター名'),
    time: z.string().describe('表示時間文字列 (例: 01:23)'),
    seconds: z.number().describe('再生秒数'),
  })).optional().describe('動画チャプター情報'),
});

export const CitationSchema = z.object({
  text: z.string().describe('引用テキスト'),
  url: z.string().describe('引用元URL'),
  context: z.string().optional().describe('周辺コンテキスト'),
});

export const ImageItemSchema = z.object({
  url: z.string().describe('画像URL'),
  alt: z.string().optional().describe('代替テキスト (alt)'),
  title: z.string().optional().describe('画像タイトル'),
  caption: z.string().optional().describe('キャプション'),
  isMainImage: z.boolean().optional().describe('ページのメイン画像・アイキャッチか'),
  isImportant: z.boolean().optional().describe('重要画像フラグ'),
  imageType: z.enum(['flyer', 'timetable', 'diagram', 'chart', 'photo', 'general']).optional().describe('画像分類'),
  width: z.number().optional().describe('画像幅 (px)'),
  height: z.number().optional().describe('画像高さ (px)'),
});

export const EventItemSchema = z.object({
  name: z.string().describe('イベント名称'),
  startDate: z.string().optional().describe('開催開始日時 (ISO 8601)'),
  endDate: z.string().optional().describe('開催終了日時 (ISO 8601)'),
  location: z.string().optional().describe('開催場所・会場名'),
  performer: z.string().optional().describe('出演者・主催者'),
  description: z.string().optional().describe('イベント説明'),
  url: z.string().optional().describe('イベント詳細URL'),
  eventStatus: z.string().optional().describe('開催ステータス (開催予定、延期、中止等)'),
  eventAttendanceMode: z.string().optional().describe('参加形態 (オンライン、現地等)'),
  offers: z.object({
    price: z.string().optional().describe('チケット料金'),
    priceCurrency: z.string().optional().describe('通貨単位 (例: JPY)'),
    url: z.string().optional().describe('購入URL'),
    availability: z.string().optional().describe('販売状況 (販売中、完売等)'),
  }).optional().describe('チケット・料金情報'),
});

export const MarkdownChunkSchema = z.object({
  index: z.number().describe('チャンク番号 (0-based)'),
  heading: z.string().optional().describe('所属する直近の見出し'),
  content: z.string().describe('チャンク本文 Markdown'),
  estimatedTokens: z.number().describe('推定トークン数'),
});

export const LinkStatusSchema = z.object({
  url: z.string().describe('リンク先URL'),
  status: z.number().describe('HTTPステータスコード'),
  ok: z.boolean().describe('到達成功フラグ (2xx/3xx)'),
});

export const FieldEvidenceSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]).describe('抽出された値'),
  source: z.enum(['jsonld', 'dom', 'meta']).describe('抽出ソース'),
});

export const EvidenceBlockRefSchema = z.object({
  sourceId: z.string().describe('ソース識別子 (例: "S1")'),
  blockId: z.string().describe('ブロック識別子 (例: "P4")'),
  url: z.string().optional().describe('参照元URL'),
  publishedTime: z.string().optional().describe('公開日時'),
  updatedTime: z.string().optional().describe('更新日時'),
  nearestHeading: z.string().optional().describe('直近の見出し'),
  headingPath: z.array(z.string()).optional().describe('見出し階層リスト'),
});

export const TemporalAnchorSchema = z.object({
  expression: z.string().describe('検出された相対時間表現 (例: "明日", "来週金曜日")'),
  referenceDate: z.string().describe('基準日時 (例: "2026-09-01")'),
  resolvedDate: z.string().describe('絶対日時解決結果 (例: "2026-09-02")'),
  resolvedDayOfWeek: z.string().optional().describe('解決された曜日 (例: "水曜日")'),
  confidence: z.enum(['high', 'medium']).describe('信頼度'),
});

export const HighlightItemSchema = z.object({
  text: z.string().describe('抽出された重要文（ハイライト）本文'),
  score: z.number().describe('関連性・重要度スコア'),
  ref: EvidenceBlockRefSchema.optional().describe('出所ブロック情報'),
  anchor: z.string().optional().describe('出所アンカー表示文字列 (例: "> [S1:P4 | 2026-09-01]")'),
  textFragmentUrl: z.string().optional().describe('Chrome Text Fragment URL (該当箇所へ直接スクロール)'),
  temporalAnchors: z.array(TemporalAnchorSchema).optional().describe('時間的文脈注記'),
});

export const RhoSelectDiagnosticsSchema = z.object({
  candidateCount: z.number().describe('候補文総数'),
  compactCandidateCount: z.number().describe('重複除去後の候補文数'),
  termCount: z.number().describe('検索語句数'),
  evidenceLevels: z.number().describe('証拠レベル数'),
  featureCount: z.number().describe('特徴量数'),
  stateCount: z.number().describe('探索状態数'),
  frontierCount: z.number().describe('フロンティア数'),
  selectedCount: z.number().describe('最終選択ハイライト件数'),
  selectedTokens: z.number().describe('選択トークン合計数'),
  utility: z.number().describe('ユーティリティ（有用性合計値）'),
  density: z.number().describe('トークン密度 (utility / tokens)'),
  lambda: z.number().describe('Dinkelbach パラメータ λ'),
  dinkelbachIterations: z.number().describe('収束までの反復回数'),
  directOptimumDensity: z.number().describe('理論最適密度'),
  exactAgreement: z.boolean().describe('完全一致判定フラグ'),
});

export const EvidenceDiagnosticsSchema = z.object({
  queryCoverage: z.number().describe('クエリ語句網羅率 (0.0〜1.0)'),
  matchedTerms: z.array(z.string()).describe('本文中にマッチした検索語句リスト'),
  missingTerms: z.array(z.string()).describe('マッチしなかった未充足語句リスト'),
  candidateCount: z.number().describe('スコア > 0 の候補ブロック数'),
  topScore: z.number().describe('最高関連スコア'),
  weakEvidenceSignal: z.boolean().describe('根拠薄弱フラグ (coverage < 0.35 または candidateCount === 0)'),
  reasons: z.array(z.string()).describe('判定理由 (例: ["low_query_coverage", "no_matching_blocks"])'),
});

export const CandidateDiscrepancySchema = z.object({
  kind: z.enum(['date', 'money', 'version', 'number']).describe('不一致種別 (日付、金額、バージョン、数値)'),
  values: z.array(z.object({
    original: z.string().describe('原文の表記'),
    normalized: z.string().describe('正規化後の値'),
    sourceId: z.string().optional().describe('出所ソースID'),
    blockId: z.string().optional().describe('ブロックID'),
    context: z.string().optional().describe('文脈スニペット'),
  })).describe('競合している値のリスト'),
  status: z.literal('needs_agent_resolution').describe('解決ステータス'),
});

export const DerivationTraceSchema = z.object({
  operation: z.string().describe('適用された決定論的変換操作 (例: "kanji_num_to_digits", "km_to_m")'),
  input: z.string().describe('変換前文字列'),
  output: z.string().describe('変換後文字列'),
});

// --- 1. システム系 レスポンススキーマ ---
export const SystemInfoResponseSchema = z.object({
  service: z.string().describe('サービス識別名 ("sora")'),
  description: z.string().describe('サービス概要説明'),
  version: z.string().describe('現在の API バージョン'),
  endpoints: z.record(z.string(), z.string()).describe('公開エンドポイント一覧マッピング'),
});

export const HealthResponseSchema = z.object({
  status: z.string().describe('稼働ステータス ("ok")'),
  service: z.string().describe('サービス名 ("sora")'),
  cachedEntries: z.number().optional().describe('キャッシュエントリ数'),
  chromiumAvailable: z.boolean().optional().describe('Chromium ブラウザの利用可否'),
  yahooMcpAvailable: z.boolean().optional().describe('Yahoo MCP バイナリの利用可否'),
  mcpConnected: z.boolean().optional().describe('MCP セッションマネージャー接続状態'),
  activeMcpSessions: z.number().optional().describe('アクティブな MCP セッション数'),
  timestamp: z.string().describe('ヘルスチェック実行日時 (ISO 8601)'),
});

export const MetricsResponseSchema = z.object({
  status: z.string().describe('ステータス ("ok")'),
  service: z.string().describe('サービス名 ("sora")'),
  uptimeSeconds: z.number().describe('プロセス稼働時間 (秒)'),
  cache: z.object({
    size: z.number().describe('現在のキャッシュ件数'),
    hits: z.number().describe('キャッシュヒット累計回数'),
    misses: z.number().describe('キャッシュミス累計回数'),
    hitRatio: z.number().describe('キャッシュヒット率 (0.0〜1.0)'),
  }).describe('メモリキャッシュ統計'),
  botDetection: z.object({
    upgradeCount: z.number().describe('Bot遮断/SPA検知によりブラウザへ自動昇格した回数'),
    retryCount: z.number().describe('ブラウザ描画後の再試行回数'),
  }).describe('Bot検知・ブラウザ昇格統計'),
  activeSessions: z.number().describe('アクティブな対話型ブラウザセッション数'),
  chromium: z.object({
    available: z.boolean().describe('Chromium 実行ファイルの有無'),
    sharedConnected: z.boolean().describe('常駐共有ブラウザインスタンスの接続状態'),
  }).describe('Chromium 状態'),
  memory: z.object({
    rssMb: z.number().describe('常駐セットサイズ (MB)'),
    heapUsedMb: z.number().describe('使用中ヒープメモリ (MB)'),
    heapTotalMb: z.number().describe('確保済みヒープメモリ (MB)'),
  }).describe('メモリ使用量'),
  timestamp: z.string().describe('メトリクス取得日時 (ISO 8601)'),
});

export const CacheClearResponseSchema = z.object({
  status: z.string().describe('ステータス ("ok")'),
  cleared: z.number().describe('削除されたキャッシュエントリ総数'),
});

// --- 2. スクレイピング & クロール系 レスポンススキーマ ---
export const ScrapeResponseSchema = z.object({
  url: z.string().describe('取得した完全な URL'),
  title: z.string().describe('Web ページのタイトル'),
  content: z.string().describe('抽出・整形された本文 (Markdown またはプレーンテキスト)'),
  isTruncated: z.boolean().describe('文字数上限 (maxChars) により切り詰められたか'),
  contentType: z.string().describe('コンテンツの MIME タイプ (例: "text/html", "application/pdf")'),
  source: z.literal('web').describe('取得ソース種別'),
  renderedWithBrowser: z.boolean().optional().describe('Stealth Chromium ブラウザで JS 描画されたか'),
  cached: z.boolean().optional().describe('メモリキャッシュから返却されたか'),
  ogImage: z.string().optional().describe('OGP アイキャッチ画像 URL'),
  description: z.string().optional().describe('メタディスクリプション'),
  publishedTime: z.string().optional().describe('記事公開日時 (ISO 8601)'),
  author: z.string().optional().describe('著者・発信者名'),
  siteName: z.string().optional().describe('Web サイト名'),
  twitterHandle: z.string().optional().describe('検出された公式Xアカウント (@handle)'),
  socialLinks: z.record(z.string(), z.string()).optional().describe('ページ内公式SNSリンク連想配列'),
  highlights: z.array(z.string()).optional().describe('キーワードに関連する重要文（ハイライト）一覧'),
  highlightItems: z.array(HighlightItemSchema).optional().describe('出所情報・スコア付きハイライト詳細配列'),
  evidenceDiagnostics: EvidenceDiagnosticsSchema.optional().describe('客観的な証拠充足性観測量'),
  discrepancies: z.array(CandidateDiscrepancySchema).optional().describe('日付・金額・バージョンの不一致候補'),
  derivations: z.array(DerivationTraceSchema).optional().describe('決定論的な単位・漢数字変換導出履歴'),
  temporalAnchors: z.array(TemporalAnchorSchema).optional().describe('相対日付表現の絶対日時解決結果一覧'),
  highlightDiagnostics: RhoSelectDiagnosticsSchema.optional().describe('ρSelect アルゴリズム実行時診断情報'),
  textFragmentUrl: z.string().optional().describe('ハイライト該当箇所へジャンプする Chrome URL'),
  summary: z.array(z.string()).optional().describe('抽出型自動要約 (TL;DR) 箇条書きリスト'),
  citations: z.array(CitationSchema).optional().describe('本文中の引用・出典リンク一覧'),
  chunks: z.array(MarkdownChunkSchema).optional().describe('RAG 用セマンティック・チャンク配列'),
  characterCount: z.number().optional().describe('本文の総文字数'),
  wordCount: z.number().optional().describe('単語数'),
  readingTimeMin: z.number().optional().describe('想定読了時間 (分)'),
  promptContext: z.string().optional().describe('LLM 最適化済み XML プロンプト文字列'),
  highlightedContent: z.string().optional().describe('<mark> で一致語句をハイライトした本文'),
  media: MediaInfoSchema.optional().describe('YouTube・動画・音声等のリッチメディア情報'),
  links: z.array(z.string()).optional().describe('ページ内抽出リンク URL 一覧'),
  linksWithStatus: z.array(LinkStatusSchema).optional().describe('リンク健全性検証結果'),
  images: z.array(ImageItemSchema).optional().describe('抽出された重要画像一覧'),
  jsonLd: z.array(z.record(z.string(), z.any())).optional().describe('構造化データ (Schema.org JSON-LD)'),
  availability: z.string().optional().describe('EC 在庫状況 (InStock, OutOfStock 等)'),
  price: z.string().optional().describe('商品価格文字列'),
  priceCurrency: z.string().optional().describe('価格通貨単位 (例: JPY)'),
  brand: z.string().optional().describe('ブランド・メーカー名'),
  sku: z.string().optional().describe('商品 SKU コード'),
  tables: z.array(TableDataSchema).optional().describe('ページ内構造化テーブル配列'),
  events: z.array(EventItemSchema).optional().describe('イベント・チケット情報'),
  breadcrumb: z.array(z.string()).optional().describe('パンくずリスト階層'),
  extracted: z.record(z.string(), z.union([z.string(), z.null()])).optional().describe('CSS セレクタ指定抽出結果'),
  metadata: z.record(z.string(), z.any()).optional().describe('メタタグ生データ連想配列'),
  estimatedTokens: z.number().optional().describe('推定トークン消費量'),
  html: z.string().optional().describe('クリーン整形済み HTML 本文'),
  rawHtml: z.string().optional().describe('取得時の完全な生 HTML'),
  screenshot: z.string().optional().describe('スクリーンショット画像 (Base64 PNG)'),
  quality: z.number().optional().describe('ページ品質スコア (0〜100)'),
  completeness: z.number().optional().describe('必須フィールド充足度 (0〜100)'),
  pageType: z.enum(['article', 'product', 'qa', 'generic']).optional().describe('自動判定されたページ種別'),
  qualityReasons: z.array(z.string()).optional().describe('品質評価理由リスト'),
  missingFields: z.array(z.string()).optional().describe('未検出のメタデータ項目'),
  evidence: z.record(z.string(), FieldEvidenceSchema).optional().describe('各フィールドの抽出出所情報'),
  qualityDistribution: z.record(z.string(), z.number()).optional().describe('品質スコア内訳'),
  avgQuality: z.number().optional().describe('平均品質'),
});

export const BatchScrapeResponseSchema = z.object({
  total: z.number().describe('一括リクエスト URL 総数'),
  successful: z.number().describe('スクレイピング成功件数'),
  failed: z.number().describe('失敗件数'),
  results: z.array(ScrapeResponseSchema).describe('成功したページのスクレイピング結果一覧'),
  errors: z.array(z.object({
    url: z.string().describe('失敗した URL'),
    error: z.string().describe('エラー原因説明'),
  })).describe('失敗した URL とエラー内容一覧'),
});

export const MapResponseSchema = z.object({
  url: z.string().describe('対象サイトのベース URL'),
  links: z.array(z.string()).describe('発見されたサイトマップまたは巡回 URL リスト'),
  count: z.number().describe('取得 URL 総件数'),
  source: z.enum(['sitemap', 'links']).describe('検出ソース (sitemap.xml または HTML リンク解析)'),
  cached: z.boolean().optional().describe('キャッシュから返却されたか'),
});

export const CrawlResponseSchema = z.object({
  url: z.string().describe('クロール開始 URL'),
  baseUrl: z.string().describe('基準ドメイン URL'),
  count: z.number().describe('クロール成功ページ数'),
  totalPages: z.number().describe('探索対象総ページ数'),
  pages: z.array(ScrapeResponseSchema).describe('クロールされた各ページのスクレイプ結果配列'),
});

// --- 3. ブラウザ自動操作 レスポンススキーマ ---
export const BrowserActionResponseSchema = z.object({
  success: z.boolean().describe('アクション実行が正常完了したか'),
  url: z.string().describe('操作完了後の最終到達 URL'),
  sessionId: z.string().optional().describe('対話セッション ID (セッション継続時)'),
  sessionClosed: z.boolean().optional().describe('セッションが終了・破棄されたか'),
  markdown: z.string().optional().describe('操作後のページ本文 Markdown'),
  screenshot: z.string().optional().describe('操作後の画面スクリーンショット (Base64 PNG)'),
  html: z.string().optional().describe('操作後の HTML 本文'),
  actionOutputs: z.array(z.object({
    step: z.number().describe('アクション実行ステップ番号 (0-based)'),
    type: z.string().describe('実行されたアクション種別'),
    result: z.any().optional().describe('評価結果・抽出値 (evaluate 等)'),
    error: z.string().optional().describe('ステップ実行時エラー (発生時)'),
  })).optional().describe('各ステップの実行結果トレース'),
  error: z.string().optional().describe('全体の失敗エラーメッセージ'),
  renderedWithBrowser: z.boolean().optional().describe('ブラウザ描画フラグ'),
  source: z.literal('browser').describe('実行ソース ("browser")'),
});

// --- 4. 検索系 レスポンススキーマ ---
export const SearchWebItemSchema = z.object({
  title: z.string().describe('検索結果タイトル'),
  url: z.string().describe('リンク先 URL'),
  snippet: z.string().optional().describe('スニペット・要約文'),
  siteName: z.string().optional().describe('サイト名・メディア名'),
  publishedTime: z.string().optional().describe('公開日時'),
  author: z.string().optional().describe('著者名'),
  source: z.string().optional().describe('ソース識別子'),
});

export const SearchWebResponseSchema = z.object({
  query: z.string().describe('実行された検索キーワード'),
  source: z.string().describe('検索ソース ("web")'),
  type: z.string().describe('検索タイプ ("web")'),
  data: z.object({
    count: z.number().optional().describe('検索結果総数'),
    items: z.array(SearchWebItemSchema).describe('検索ヒット一覧'),
  }).describe('Web 検索結果データ'),
  cached: z.boolean().describe('キャッシュから返却されたか'),
});

export const RealtimeItemSchema = z.object({
  text: z.string().describe('ツイート・投稿本文'),
  url: z.string().describe('ポスト URL'),
  created_at: z.union([z.number(), z.string()]).optional().describe('投稿タイムスタンプ (Unix秒または文字列)'),
  publishedTime: z.string().optional().describe('正規化された投稿日時 (ISO 8601)'),
  author_name: z.string().optional().describe('投稿者名'),
  author_handle: z.string().optional().describe('アカウント名 (@handle)'),
  author: z.string().optional().describe('正規化された著者表示名'),
  siteName: z.string().optional().describe('プラットフォーム名 ("X (Twitter)")'),
  source: z.literal('x').optional().describe('ソース ("x")'),
  isOfficial: z.boolean().optional().describe('公式アカウントの発言・一次告知であるか'),
  images: z.array(z.string()).optional().describe('投稿に添付された画像 URL 配列'),
});

export const RealtimeSearchResponseSchema = z.object({
  query: z.string().describe('指定された検索キーワード'),
  effectiveQuery: z.string().describe('実際に使用された有効クエリ (フォールバック適用後)'),
  isFallback: z.boolean().describe('スマートフォールバック（日付・語句抽出）が適用されたか'),
  sort: z.enum(['recent', 'popular']).describe('ソート順 ("recent" または "popular")'),
  source: z.literal('x').describe('ソース ("x")'),
  type: z.literal('realtime').describe('タイプ ("realtime")'),
  data: z.object({
    count: z.number().describe('取得件数'),
    items: z.array(RealtimeItemSchema).describe('リアルタイムポスト一覧'),
  }).describe('ポストデータ'),
  cached: z.boolean().describe('キャッシュから返却されたか'),
});

export const TrendItemSchema = z.object({
  rank: z.number().describe('トレンドランキング順位 (1-based)'),
  keyword: z.string().describe('急上昇キーワード・ハッシュタグ'),
  tweetCount: z.string().optional().describe('ポスト件数 (例: "1.2万件")'),
  url: z.string().describe('Yahoo リアルタイム検索 URL'),
});

export const TrendSearchResponseSchema = z.object({
  source: z.literal('x').describe('ソース ("x")'),
  type: z.literal('trend').describe('タイプ ("trend")'),
  count: z.number().describe('トレンド件数'),
  items: z.array(TrendItemSchema).describe('急上昇トレンド一覧'),
  timestamp: z.string().describe('取得日時 (ISO 8601)'),
});

export const IntegratedSearchResponseSchema = z.object({
  query: z.string().describe('検索キーワード'),
  source: z.string().describe('ソース ("integrated")'),
  count: z.number().describe('上位取得件数'),
  results: z.array(ScrapeResponseSchema).describe('本文スクレイピング・整形済みの深層検索結果配列'),
  realtime: z.array(RealtimeItemSchema).optional().describe('併せて取得された X リアルタイム最新速報'),
  expandedQueries: z.array(z.string()).optional().describe('擬似適合フィードバック (PRF) による自動拡張キーワード一覧'),
  cached: z.boolean().optional().describe('キャッシュから返却されたか'),
});

export const ImageSearchItemSchema = z.object({
  title: z.string().describe('画像タイトル・周辺テキスト'),
  url: z.string().describe('画像掲載元の Web ページ URL'),
  imageUrl: z.string().describe('画像ファイルの直接 URL'),
  thumbnailUrl: z.string().optional().describe('サムネイル画像 URL'),
  width: z.number().optional().describe('画像幅 (px)'),
  height: z.number().optional().describe('画像高さ (px)'),
  source: z.literal('image').optional().describe('ソース ("image")'),
});

export const ImageSearchResponseSchema = z.object({
  source: z.literal('image').describe('ソース ("image")'),
  query: z.string().optional().describe('検索クエリ'),
  count: z.number().optional().describe('取得件数'),
  items: z.array(ImageSearchItemSchema).describe('画像検索結果一覧'),
});

export const VideoSearchItemSchema = z.object({
  title: z.string().describe('動画タイトル'),
  url: z.string().describe('動画ページ URL'),
  videoUrl: z.string().optional().describe('動画ストリーム URL または埋め込み URL'),
  thumbnailUrl: z.string().optional().describe('サムネイル画像 URL'),
  duration: z.string().optional().describe('動画の長さ (例: "10:30")'),
  publisher: z.string().optional().describe('投稿元・配信者 (例: "YouTube")'),
  publishedAt: z.string().optional().describe('公開日時'),
  source: z.literal('video').optional().describe('ソース ("video")'),
});

export const VideoSearchResponseSchema = z.object({
  source: z.literal('video').describe('ソース ("video")'),
  query: z.string().optional().describe('検索クエリ'),
  count: z.number().optional().describe('取得件数'),
  items: z.array(VideoSearchItemSchema).describe('動画検索結果一覧'),
});

export const NewsSearchItemSchema = z.object({
  title: z.string().describe('ニュース見出し・記事タイトル'),
  url: z.string().describe('ニュース記事 URL'),
  publisher: z.string().optional().describe('配信元メディア名 (例: "朝日新聞デジタル")'),
  author: z.string().optional().describe('著者・配信元'),
  publishedTime: z.string().optional().describe('記事配信日時'),
  snippet: z.string().optional().describe('記事リード文・スニペット'),
  siteName: z.string().optional().describe('掲載サイト名 ("Yahoo!ニュース")'),
  source: z.literal('news').optional().describe('ソース ("news")'),
});

export const NewsSearchResponseSchema = z.object({
  source: z.literal('news').describe('ソース ("news")'),
  query: z.string().optional().describe('検索クエリ'),
  count: z.number().optional().describe('取得件数'),
  items: z.array(NewsSearchItemSchema).describe('ニュース記事一覧'),
});

export const ChiebukuroSearchItemSchema = z.object({
  title: z.string().describe('質問タイトル'),
  url: z.string().describe('知恵袋質問ページ URL'),
  postedAt: z.string().optional().describe('投稿日時'),
  updatedAt: z.string().optional().describe('更新日時'),
  status: z.string().optional().describe('解決ステータス (解決済み、投票受付中など)'),
  bestAnswer: z.string().optional().describe('ベストアンサー本文'),
  snippet: z.string().optional().describe('回答または質問のスニペット要約'),
  siteName: z.string().optional().describe('サイト名 ("Yahoo!知恵袋")'),
  source: z.literal('chiebukuro').optional().describe('ソース ("chiebukuro")'),
});

export const ChiebukuroSearchResponseSchema = z.object({
  source: z.literal('chiebukuro').describe('ソース ("chiebukuro")'),
  query: z.string().optional().describe('検索クエリ'),
  count: z.number().optional().describe('ヒット件数'),
  items: z.array(ChiebukuroSearchItemSchema).describe('Q&A 検索結果一覧'),
});

export const SuggestResponseSchema = z.object({
  source: z.literal('suggest').describe('ソース ("suggest")'),
  query: z.string().optional().describe('入力キーワード'),
  suggestions: z.array(z.string()).optional().describe('キーワード補完サジェスト候補リスト'),
  items: z.array(z.string()).optional().describe('サジェスト候補一覧'),
});

// --- 5. 交通・気象・防災系 レスポンススキーマ ---
export const TransitSectionSchema = z.object({
  line: z.string().optional().describe('利用路線・列車名 (例: "ＪＲ山手線外回り")'),
  from: z.string().optional().describe('乗車駅名 (例: "新宿")'),
  to: z.string().optional().describe('降車駅名 (例: "品川")'),
  departureTime: z.string().optional().describe('発車時刻 (例: "14:35")'),
  arrivalTime: z.string().optional().describe('到着時刻 (例: "14:54")'),
});

export const TransitRouteDetailSchema = z.object({
  index: z.number().describe('ルート候補番号 (1-based)'),
  totalTime: z.string().optional().describe('所要時間 (例: "19分")'),
  transfers: z.string().optional().describe('乗換回数 (例: "乗換0回")'),
  fare: z.string().optional().describe('運賃 (例: "210円")'),
  sections: z.array(TransitSectionSchema).optional().describe('区間ごとの乗換詳細'),
  summary: z.string().optional().describe('フォールバック時のルート要約'),
});

export const TransitRouteResponseSchema = z.object({
  source: z.literal('transit').describe('ソース ("transit")'),
  from: z.string().describe('出発駅・出発地'),
  to: z.string().describe('到着駅・目的地'),
  via: z.array(z.string()).optional().describe('経由駅リスト'),
  routeCount: z.number().optional().describe('検索されたルート数'),
  routes: z.array(TransitRouteDetailSchema).describe('乗換案内ルート候補配列'),
  note: z.string().optional().describe('パース補足メモ'),
  rawText: z.string().optional().describe('フォールバック時の生テキスト'),
});

export const WeatherDayForecastSchema = z.object({
  date: z.string().describe('予報対象日 (YYYY-MM-DD)'),
  dateLabel: z.string().describe('日付ラベル ("今日", "明日", "明後日" 等)'),
  telop: z.string().describe('天気テロップ (例: "晴れ", "曇時々雨")'),
  detail: z.object({
    weather: z.string().describe('天候詳細説明'),
    wind: z.string().nullable().optional().describe('風の状況 (例: "北の風 やや強く")'),
    wave: z.string().nullable().optional().describe('波の高さ (例: "1.5メートル")'),
  }).describe('天候詳細情報'),
  temperature: z.object({
    min: z.string().nullable().describe('最低気温 (例: "18℃")'),
    max: z.string().nullable().describe('最高気温 (例: "28℃")'),
  }).describe('予想気温'),
  chanceOfRain: z.object({
    T00_06: z.string().describe('00-06時の降水確率 (例: "10%")'),
    T06_12: z.string().describe('06-12時の降水確率'),
    T12_18: z.string().describe('12-18時の降水確率'),
    T18_24: z.string().describe('18-24時の降水確率'),
  }).describe('時間帯別降水確率'),
  image: z.string().describe('気象庁公式天気アイコン SVG URL'),
});

export const WeatherResponseSchema = z.object({
  source: z.literal('weather').describe('ソース ("weather")'),
  cityId: z.string().describe('気象庁 6桁地点ID (例: "130010")'),
  title: z.string().describe('予報対象地域タイトル (例: "東京 の天気")'),
  publishedTime: z.string().optional().describe('気象庁発表日時 (ISO 8601)'),
  overview: z.string().optional().describe('気象概況テキスト'),
  forecasts: z.array(WeatherDayForecastSchema).describe('日別天気予報配列 (1〜8日分)'),
});

export const WarningItemSchema = z.object({
  code: z.string().describe('警報・注意報コード (例: "03")'),
  name: z.string().describe('警報・注意報名称 (例: "大雨警報", "雷注意報")'),
  level: z.enum(['special', 'warning', 'advisory']).describe('警報レベル: "special"(特別警報), "warning"(警報), "advisory"(注意報)'),
  status: z.string().optional().describe('発令ステータス (発表、継続、解除等)'),
});

export const AreaWarningsResponseSchema = z.object({
  areaCode: z.string().describe('気象庁エリアコード (6桁)'),
  areaName: z.string().describe('対象地域名 (例: "東京都")'),
  prefecture: z.string().describe('都道府県名'),
  reportTime: z.string().describe('発表日時 (ISO 8601)'),
  specialWarnings: z.array(WarningItemSchema).describe('発表中の特別警報一覧'),
  warnings: z.array(WarningItemSchema).describe('発表中の警報一覧'),
  advisories: z.array(WarningItemSchema).describe('発表中の注意報一覧'),
  hasActiveAlerts: z.boolean().describe('現在発令中の特別警報または警報が存在するか'),
});

export const EarthquakeHypocenterSchema = z.object({
  name: z.string().describe('震央地名 (例: "茨城県南部", "能登半島沖")'),
  magnitude: z.number().describe('マグニチュード (M)'),
  depthKm: z.number().optional().describe('震源の深さ (km)'),
  latitude: z.number().optional().describe('震源の緯度'),
  longitude: z.number().optional().describe('震源の経度'),
});

export const EarthquakeItemSchema = z.object({
  id: z.string().describe('地震情報 ID'),
  time: z.string().describe('発生日時 (例: "2026/09/10 12:00:00")'),
  hypocenter: EarthquakeHypocenterSchema.describe('震源情報'),
  maxScale: z.string().describe('最大震度表示名 (例: "震度3", "震度5弱")'),
  maxScaleRaw: z.number().describe('最大震度コード (10=震度1, 45=震度5弱, 70=震度7等)'),
  tsunami: z.string().describe('津波の有無・影響 (例: "この地震による津波の心配はありません。")'),
  source: z.enum(['p2pquake', 'jma']).describe('情報ソース'),
  points: z.array(z.object({
    pref: z.string().describe('都道府県'),
    addr: z.string().describe('観測地点名'),
    scale: z.string().describe('観測震度'),
  })).optional().describe('各地の観測震度一覧'),
});

export const EarthquakeSearchResultSchema = z.object({
  count: z.number().describe('取得件数'),
  items: z.array(EarthquakeItemSchema).describe('地震情報履歴配列 (新着順)'),
  source: z.enum(['p2pquake', 'jma']).describe('データソース'),
});

export const TrafficItemSchema = z.object({
  roadName: z.string().describe('道路名 (例: "東名高速", "首都高C1")'),
  direction: z.string().describe('進行方向 (例: "上り", "下り", "内回り")'),
  status: z.string().describe('規制・混雑状況 (例: "順調", "渋滞 5km", "通行止")'),
  section: z.string().optional().describe('対象区間・IC間'),
  cause: z.string().optional().describe('原因 (事故、工事、故障車等)'),
  detail: z.string().optional().describe('詳細説明テキスト'),
});

export const RoadTrafficResponseSchema = z.object({
  pref: z.string().optional().describe('対象都道府県名'),
  prefCode: z.number().optional().describe('都道府県コード (1〜47)'),
  road: z.string().optional().describe('指定道路名'),
  updatedAt: z.string().describe('情報更新日時'),
  hasIssues: z.boolean().describe('事故・通行止等の規制情報が存在するか'),
  summary: z.string().describe('道路交通サマリーテキスト'),
  items: z.array(TrafficItemSchema).describe('路線別交通情報配列'),
  source: z.literal('jartic').describe('情報提供元 ("jartic")'),
});

export const FlightItemSchema = z.object({
  scheduledTime: z.string().describe('定刻時刻 (例: "14:20")'),
  estimatedTime: z.string().optional().describe('変更後・見込み時刻 (例: "14:45")'),
  airline: z.string().describe('運航航空会社名 (例: "全日本空輸", "日本航空")'),
  flightNumber: z.string().describe('便名 (例: "ANA241", "JAL513")'),
  isCodeshare: z.boolean().optional().describe('共同運航便 (コードシェア) か'),
  destinationOrOrigin: z.string().describe('目的地 (出発時) または 出発地 (到着時)'),
  status: z.string().describe('運航ステータス (例: "定刻", "遅延", "欠航", "搭乗手続き中")'),
  detail: z.string().optional().describe('遅延理由・搭乗口・備考'),
});

export const FlightStatusResultSchema = z.object({
  airportName: z.string().describe('対象空港名 (例: "羽田空港", "成田国際空港")'),
  airportCode: z.string().describe('3レター空港コード (例: "HND", "NRT")'),
  type: z.enum(['departure', 'arrival']).describe('発着区分: "departure"(出発) または "arrival"(到着)'),
  category: z.enum(['domestic', 'international']).describe('路線区分: "domestic"(国内線) または "international"(国際線)'),
  updatedAt: z.string().describe('運航情報更新日時'),
  count: z.number().describe('運航便数'),
  hasDelaysOrCancellations: z.boolean().describe('遅延便または欠航便が存在するか'),
  summary: z.string().describe('運航状況の日本語要約サマリー'),
  flights: z.array(FlightItemSchema).describe('各フライトの運航明細配列'),
  source: z.enum(['airport_official', 'flight_radar']).describe('運航情報ソース'),
});

// --- 6. 公共データ・法令系 レスポンススキーマ ---
export const LawSearchResultItemSchema = z.object({
  id: z.string().describe('e-Gov 法令 ID (例: "129AC0000000089")'),
  title: z.string().describe('法令名 (例: "民法", "日本国憲法")'),
  lawNum: z.string().describe('法令番号 (例: "明治二十九年法律第八十九号")'),
  promulgationDate: z.string().optional().describe('公布年月日 (例: "明治29年4月27日")'),
  category: z.string().optional().describe('法令種別 (法律, 政令, 府省令等)'),
});

export const LawSearchResultSchema = z.object({
  count: z.number().describe('検索ヒット法令件数'),
  items: z.array(LawSearchResultItemSchema).describe('ヒットした法令一覧'),
  source: z.literal('e-gov').describe('ソース ("e-gov")'),
});

export const LawDataResultSchema = z.object({
  id: z.string().describe('e-Gov 法令 ID'),
  title: z.string().describe('正式法令名称'),
  lawNum: z.string().describe('法令番号'),
  era: z.string().optional().describe('制定元号 (明治、大正、昭和、平成、令和)'),
  lawType: z.string().optional().describe('法令種別'),
  enforcementDate: z.string().optional().describe('施行期日・施行年月日'),
  markdown: z.string().describe('法令条文全文 Markdown (章・条・項・号階層化)'),
  articleCount: z.number().optional().describe('収録条文数'),
  source: z.literal('e-gov').describe('ソース ("e-gov")'),
});

export const DietSpeechRecordSchema = z.object({
  speechId: z.string().describe('発言 ID (NDL 会議録固有識別子)'),
  issueId: z.string().optional().describe('会議録号 ID'),
  session: z.number().optional().describe('国会回次 (例: 213)'),
  house: z.string().describe('院名 ("衆議院" または "参議院")'),
  meeting: z.string().describe('委員会・本会議名 (例: "予算委員会")'),
  issue: z.string().optional().describe('号数 (例: "第1号")'),
  date: z.string().describe('開会日付 (YYYY-MM-DD)'),
  speaker: z.string().describe('発言者氏名 (例: "岸田文雄", "河野太郎")'),
  speakerPosition: z.string().optional().describe('発言者の役職・肩書 (例: "内閣総理大臣")'),
  speakerGroup: z.string().optional().describe('所属会派・政党名'),
  speakerRole: z.string().optional().describe('発言時の役割 (委員長、政府参考人、証人等)'),
  speech: z.string().describe('発言録本文テキスト'),
  speechUrl: z.string().describe('国会会議録公式 Web ページ URL'),
  meetingUrl: z.string().optional().describe('該当会議全体の議事録 URL'),
  pdfUrl: z.string().optional().describe('会議録原本 PDF URL'),
});

export const DietMinutesSearchResultSchema = z.object({
  count: z.number().describe('今回返却された発言件数'),
  totalHits: z.number().describe('検索条件にマッチした全発言総件数'),
  items: z.array(DietSpeechRecordSchema).describe('国会議事録発言レコード配列'),
  source: z.literal('kokkai-ndl').describe('情報提供元 ("kokkai-ndl")'),
});

export const ElevationResultSchema = z.object({
  query: z.string().optional().describe('指定された検索クエリ文字列'),
  address: z.string().optional().describe('住所文字列'),
  matchedTitle: z.string().optional().describe('国土地理院住所検索でヒットした正規化地名'),
  lat: z.number().describe('緯度 (10進数)'),
  lon: z.number().describe('経度 (10進数)'),
  elevationMeters: z.number().nullable().describe('海抜標高 (メートル単位、水面等で計測不可時は null)'),
  dataAccuracy: z.string().optional().describe('標高データの計測精度区分'),
  formatted: z.string().describe('読みやすい日本語フォーマット済み文字列 (例: "富士山頂 (緯度: 35.3606, 経度: 138.7274): 標高 3776m")'),
  source: z.literal('gsi').describe('データ提供元 ("gsi": 国土地理院)'),
});

// --- 7. 音楽・メディア系 レスポンススキーマ ---
export const MusicItemSchema = z.object({
  id: z.string().describe('楽曲・アルバム・アーティストの固有 ID'),
  type: z.enum(['song', 'album', 'artist']).describe('種別: "song"(曲), "album"(アルバム), "artist"(アーティスト)'),
  title: z.string().describe('楽曲名またはアルバム名・アーティスト名'),
  artist: z.string().describe('アーティスト名'),
  album: z.string().optional().describe('収録アルバム名'),
  artwork: z.object({
    thumbnail: z.string().optional().describe('サムネイル画像 URL (100x100)'),
    highRes: z.string().optional().describe('高解像度ジャケット画像 URL (600x600)'),
  }).optional().describe('ジャケット・アートワーク画像'),
  previewUrl: z.string().optional().describe('30秒無料試聴音源 AAC オーディオ URL'),
  releaseDate: z.string().optional().describe('リリース日 (ISO 8601)'),
  genre: z.string().optional().describe('音楽ジャンル (例: "J-Pop", "Rock")'),
  trackNumber: z.number().optional().describe('アルバム内のトラック番号'),
  trackTimeMillis: z.number().optional().describe('楽曲再生時間 (ミリ秒)'),
  url: z.string().optional().describe('Apple Music / iTunes 公式リンク URL'),
});

export const MusicSearchResultSchema = z.object({
  query: z.string().describe('検索キーワード'),
  country: z.string().describe('検索対象ストア国コード (例: "jp")'),
  entity: z.string().describe('検索エンティティ種別'),
  attribute: z.string().optional().describe('絞り込み属性'),
  count: z.number().describe('ヒット件数'),
  items: z.array(MusicItemSchema).describe('音楽メタデータ配列'),
  source: z.literal('itunes').describe('データソース ("itunes")'),
});

export const InspectImageResultSchema = z.object({
  success: z.boolean().describe('画像解析・Base64変換が成功したか'),
  url: z.string().describe('取得元画像 URL'),
  mimeType: z.string().describe('判定された画像 MIME タイプ (image/jpeg, image/png, image/webp 等)'),
  sizeBytes: z.number().describe('画像ファイルサイズ (バイト)'),
  base64: z.string().describe('Base64 エンコードされた画像生データ'),
  markdown: z.string().optional().describe('マルチモーダル LLM 用埋め込み Markdown タグ'),
  imageContent: z.object({
    type: z.literal('image').describe('コンテンツタイプ ("image")'),
    data: z.string().describe('Base64 データ文字列'),
    mimeType: z.string().describe('画像 MIME タイプ'),
  }).describe('Anthropic Claude / OpenAI 互換画像ペイロード'),
  cached: z.boolean().optional().describe('キャッシュから返却されたか'),
});

// --- 8. 差分監視系 レスポンススキーマ ---
export const WatchTargetRecordSchema = z.object({
  id: z.string().describe('監視ターゲット一意 ID (UUID)'),
  url: z.string().describe('監視対象 Web ページ URL'),
  title: z.string().optional().describe('ターゲット識別用タイトル'),
  selector: z.string().optional().describe('監視対象 CSS セレクタ'),
  last_hash: z.string().optional().describe('直前チェック時のコンテンツ SHA-256 ハッシュ'),
  last_content: z.string().optional().describe('直前チェック時の本文スニペット'),
  webhook_url: z.string().optional().describe('差分検知通知先 Webhook URL'),
  interval_seconds: z.number().describe('監視間隔 (秒)'),
  last_checked_at: z.number().optional().describe('最終チェック日時 (Unixミリ秒)'),
  created_at: z.number().describe('ターゲット登録日時 (Unixミリ秒)'),
});

export const WatchCheckResultSchema = z.object({
  targetId: z.string().describe('監視ターゲット ID'),
  url: z.string().describe('対象 URL'),
  changed: z.boolean().describe('前回チェック時からコンテンツに差分（変更）があったか'),
  previousHash: z.string().optional().describe('変更前の SHA-256 ハッシュ'),
  currentHash: z.string().describe('最新の SHA-256 ハッシュ'),
  diffSummary: z.string().optional().describe('差分検出内容のサマリー説明'),
  snapshotSnippet: z.string().optional().describe('最新コンテンツの冒頭スニペット'),
  checkedAt: z.string().describe('チェック実行日時 (ISO 8601)'),
  webhookSent: z.boolean().optional().describe('Webhook 通知が送信されたか'),
});

export const WatchRegisterResponseSchema = z.object({
  target: WatchTargetRecordSchema.describe('登録・保存された監視ターゲットレコード'),
  initialResult: WatchCheckResultSchema.optional().describe('初回ベースライン作成スキャンの結果'),
});

export const WatchTargetListSchema = z.object({
  count: z.number().describe('登録済み監視ターゲット総件数'),
  targets: z.array(WatchTargetRecordSchema).describe('監視ターゲット一覧配列'),
});

export const WatchDeleteResponseSchema = z.object({
  success: z.boolean().describe('ターゲット削除が成功したか'),
  id: z.string().describe('削除されたターゲット ID'),
});

// --- 9. 貿易コンプライアンス系 レスポンススキーマ ---
export const CpscApplicableRegulationSchema = z.object({
  cfr: z.string().describe('適用される米国連邦規則集 (CFR) 条項 (例: "16 CFR 1610")'),
  summary: z.string().describe('規制概要の日本語説明'),
  excerpt: z.string().describe('CPSC 公式ガイダンス抜粋英文'),
  sourceUrl: z.string().describe('規制条項の公式参照先 URL'),
});

export const CpscCertificateCheckResultSchema = z.object({
  certificateRequired: z.union([z.boolean(), z.literal('unknown')]).describe('適合証明書 (GCCまたはCPC) が必要か'),
  certificateType: z.enum(['GCC', 'CCC', 'none', 'unknown']).describe('要求される証明書種別: "GCC"(一般品), "CCC"(子供向け品 CPC), "none"(不要), "unknown"(要確認)'),
  eFilingRequired: z.boolean().describe('2026年7月よりCBP ACEでの電子的提出(eFiling)が必須となる品目か'),
  applicableRegulations: z.array(CpscApplicableRegulationSchema).describe('適用される CPSC 安全基準・規制規格リスト'),
  disclaimerCodeHint: z.string().optional().describe('eFiling 非対象品申告時に使用する ACE Disclaimer コード目安 (例: "A")'),
  missingInfo: z.array(z.string()).describe('判定に必要な不足情報項目'),
  nextActions: z.array(z.string()).describe('輸入者・輸出者が次に取るべき実務アクションリスト'),
  disclaimer: z.string().describe('免責事項文'),
  inputCompleteness: z.enum(['complete', 'partial']).optional().describe('入力情報の充足度'),
  missingInputs: z.array(z.string()).optional().describe('未指定のパラメータ一覧'),
  clarifyingQuestions: z.array(z.string()).optional().describe('LLM がユーザーに尋ねるべき確認質問リスト'),
  impactExplanation: z.string().optional().describe('不足情報が判定に与える影響の解説'),
});

export const CheckFdaRegulatedResultSchema = z.object({
  fdaRegulatedLikely: z.union([z.boolean(), z.literal('unknown')]).describe('米国 FDA 規制対象の可能性が高いか'),
  fdFlag: z.enum(['FD1', 'FD2', 'FD3', 'FD4', 'none']).describe('CBP ACE FDA 申告フラグ: "FD1"(条件付き要事前届出/Prior Notice不要), "FD2"(要FDA申告), "FD3"(事前届出・FDA申告双方必要), "FD4"(必須), "none"(非対象)'),
  possiblePrograms: z.array(z.string()).describe('該当する FDA 監視プログラムコード一覧 (FOO=食品, COS=化粧品, DEV=医療機器, DRU=医薬品等)'),
  priorNoticeMayApply: z.boolean().describe('輸入前の事前通知 (Prior Notice) 義務が発生する可能性があるか'),
  priorNoticeRequired: z.boolean().optional().describe('Prior Notice が明確に必須か'),
  matchedSubheading: z.string().optional().describe('合致した HTS 6桁コードプレフィックス'),
  matchedChapter: z.string().describe('合致した HTS 類 (Chapter 01〜97)'),
  confidence: z.enum(['hts-flag-match', 'chapter-level-estimate']).describe('判定信頼度区分'),
  requiredActions: z.array(z.string()).optional().describe('必須となる手続要件一覧 (DUNS番号登録、製造所登録、事前届出等)'),
  missingInfo: z.array(z.string()).describe('判定精度向上のための不足情報'),
  nextActions: z.array(z.string()).describe('輸入手続き上の推奨アクション一覧'),
  disclaimer: z.string().describe('免責事項文'),
  inputCompleteness: z.enum(['complete', 'partial']).optional().describe('入力充足度'),
  missingInputs: z.array(z.string()).optional().describe('未指定項目一覧'),
  clarifyingQuestions: z.array(z.string()).optional().describe('ユーザーへの確認質問リスト'),
  impactExplanation: z.string().optional().describe('判定分岐の影響説明'),
});

export const HtsCandidateSchema = z.object({
  htsCode: z.string().describe('HTS 10桁コード (XXXX.XX.XXXX)'),
  description: z.string().describe('USITC 公式品目解説 (英語)'),
  generalRate: z.string().describe('基本関税率 (General Rate of Duty)'),
  otherRate: z.string().optional().describe('特別税率・第2欄税率'),
});

export const VerifyHtsCodeResultSchema = z.object({
  htsCode: z.string().describe('検証対象の HTS コード'),
  productDescription: z.string().describe('指定された製品説明'),
  verified: z.boolean().describe('USITC 公式データベースに実在するコードか'),
  matchLevel: z.enum(['exact', '6-digit-category', 'unmatched']).describe('一致レベル: "exact"(10桁完全一致), "6-digit-category"(6桁類一致), "unmatched"(不一致)'),
  hsCode: z.string().optional().describe('国際共通 6桁 HS コード'),
  officialDescription: z.string().optional().describe('USITC 公式品名解説'),
  generalRate: z.string().optional().describe('基本関税率 (General Rate of Duty)'),
  otherRate: z.string().optional().describe('第2欄税率 (Column 2 Rate)'),
  specialRate: z.string().optional().describe('特恵関税・特定協定税率 (Special Rate)'),
  nearbyCandidates: z.array(HtsCandidateSchema).describe('近隣・関連する候補 HTS コード一覧'),
  disclaimer: z.string().describe('法的免責事項文'),
  source: z.literal('usitc-hts').describe('情報提供元 ("usitc-hts")'),
  inputCompleteness: z.enum(['complete', 'partial']).optional().describe('入力充足度'),
  missingInputs: z.array(z.string()).optional().describe('不足項目一覧'),
  clarifyingQuestions: z.array(z.string()).optional().describe('確認質問'),
  impactExplanation: z.string().optional().describe('関税・規制への影響説明'),
});

export const PredictHtsCandidateSchema = z.object({
  htsCode: z.string().describe('候補 HTS コード'),
  description: z.string().describe('候補品目の公式説明'),
  generalRate: z.string().describe('関税率'),
  score: z.number().describe('マッチング適合スコア'),
});

export const PredictHtsCodeResultSchema = z.object({
  detectedSubheading: z.string().describe('推定された 6桁 HS 号 (例: "9503.00")'),
  category: z.string().describe('判定された製品カテゴリ (Toys, Apparel, Electronics 等)'),
  bestMatch: z.object({
    htsCode: z.string().describe('最有力候補 HTS 10桁コード'),
    description: z.string().describe('最有力品目の説明'),
    parentDescription: z.string().optional().describe('親階層品目解説'),
    generalRate: z.string().describe('推定関税率'),
    score: z.number().describe('適合度スコア'),
    confidence: z.enum(['high', 'medium', 'low']).describe('推定信頼度'),
    reason: z.string().describe('推論理由・分類根拠'),
    cpsc: CpscCertificateCheckResultSchema.optional().describe('該当品目の CPSC 規制判定結果'),
    fda: CheckFdaRegulatedResultSchema.optional().describe('該当品目の FDA 規制判定結果'),
  }).describe('最適マッチ品目'),
  candidates: z.array(PredictHtsCandidateSchema).describe('上位候補 HTS コード一覧'),
  disclaimer: z.string().describe('法的免責事項文'),
  inputCompleteness: z.enum(['complete', 'partial']).optional().describe('入力充足度'),
  missingInputs: z.array(z.string()).optional().describe('未指定項目一覧'),
  clarifyingQuestions: z.array(z.string()).optional().describe('ユーザーへの確認質問リスト'),
  impactExplanation: z.string().optional().describe('関税・規制への影響説明'),
});

export const CheckProductComplianceResultSchema = z.object({
  product: z.object({
    name: z.string().optional().describe('商品名'),
    description: z.string().optional().describe('商品説明'),
    url: z.string().optional().describe('商品ページ URL'),
    detectedCategory: z.string().optional().describe('検出カテゴリ'),
    targetAge: z.enum(['adult', 'child', 'unknown']).describe('対象年齢層'),
    material: z.string().optional().describe('主な素材'),
    htsCode: z.string().optional().describe('判定に使用した HTS コード'),
  }).describe('判定対象商品プロファイル'),
  overallStatus: z.enum(['action_required', 'potential_action_required', 'likely_exempt', 'needs_more_info']).describe('総合コンプライアンス判定: "action_required"(要手続/証明書必須), "potential_action_required"(条件付き要確認), "likely_exempt"(規制対象外の可能性高), "needs_more_info"(情報不足)'),
  summary: z.string().describe('コンプライアンス診断結果の日本語総括サマリー'),
  inputCompleteness: z.enum(['complete', 'partial']).optional().describe('入力情報の充足度'),
  missingInputs: z.array(z.string()).optional().describe('不足情報項目'),
  clarifyingQuestions: z.array(z.string()).optional().describe('LLM がユーザーに尋ねるべき確認質問リスト'),
  impactExplanation: z.string().optional().describe('不足項目が判定に与える影響解説'),
  htsVerification: VerifyHtsCodeResultSchema.optional().describe('HTS コード実在検証結果'),
  htsPrediction: PredictHtsCodeResultSchema.optional().describe('HTS コード推論結果'),
  fda: CheckFdaRegulatedResultSchema.optional().describe('FDA 規制フラグ・Prior Notice 判定'),
  cpsc: CpscCertificateCheckResultSchema.optional().describe('CPSC 証明書・eFiling 義務化判定'),
  actionPlan: z.array(z.string()).describe('米国輸出・通関に向けた具体的な実務ToDoチェックリスト'),
  disclaimer: z.string().describe('法的免責事項文'),
});

// --- 10. 荷物追跡系 レスポンススキーマ ---
export const TrackingEventSchema = z.object({
  date: z.string().optional().describe('イベント発生日時 (例: "2026/09/10 09:30")'),
  status: z.string().describe('配送ステータス名 (例: "配達完了", "輸送中", "荷物受付", "持ち出し中")'),
  location: z.string().optional().describe('担当営業所・郵便局・取扱拠点名 (例: "銀座支店", "東京国際郵便局")'),
  description: z.string().optional().describe('ステータス詳細・備考説明'),
});

export const TrackingDetailsSchema = z.object({
  origin: z.string().optional().describe('発送元地域・引受営業所'),
  destination: z.string().optional().describe('配達先地域・お届け先営業所'),
  deliveryDate: z.string().optional().describe('お届け予定日時または配達完了日時'),
  serviceType: z.string().optional().describe('配送サービス種別 (例: "宅急便", "飛脚宅配便", "ゆうパック/ゆうパケット/EMS/国際郵便", "カンガルー便")'),
});

export const TrackingResultSchema = z.object({
  carrier: z.enum(['yamato', 'sagawa', 'japanpost', 'seino', 'fukutsu', 'ups']).describe('運送会社識別コード'),
  carrierName: z.string().describe('運送会社表示名 (例: "ヤマト運輸", "佐川急便", "日本郵便", "西濃運輸", "福山通運", "UPS")'),
  trackingNumber: z.string().describe('追跡番号・送り状お問い合わせ番号'),
  status: z.enum(['delivered', 'in_transit', 'registered', 'returned', 'error', 'not_found', 'unknown']).describe('統一配送ステータスコード: "delivered"(配達完了), "in_transit"(輸送中), "registered"(荷物受付), "returned"(返送), "error"(エラー), "not_found"(未登録), "unknown"(不明)'),
  statusText: z.string().describe('配送ステータスの日本語表示テキスト (例: "配達完了", "配達中", "輸送中")'),
  events: z.array(TrackingEventSchema).describe('荷物の追跡履歴イベント配列 (時系列)'),
  trackingUrl: z.string().describe('各運送会社の公式追跡 Web ページ URL'),
  details: TrackingDetailsSchema.optional().describe('荷物詳細情報 (発送元、お届け先、配達日、サービス種別等)'),
  error: z.string().optional().describe('追跡失敗時のエラーメッセージ'),
  cached: z.boolean().optional().describe('キャッシュから返却されたか'),
  fetchedAt: z.string().optional().describe('追跡情報取得日時 (ISO 8601)'),
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
    const min = (schema as any).minValue ?? (schema as any)._def?.checks?.find((c: any) => c.kind === 'min' || c.check === 'min')?.value;
    const max = (schema as any).maxValue ?? (schema as any)._def?.checks?.find((c: any) => c.kind === 'max' || c.check === 'max')?.value;
    if (min !== undefined) res.minimum = min;
    if (max !== undefined) res.maximum = max;
  } else if (schema instanceof z.ZodBoolean) {
    res = { type: 'boolean' };
  } else if (schema instanceof z.ZodEnum) {
    const enumValues = (schema as any).options ?? (schema as any)._def.values ?? Object.keys((schema as any)._def.entries ?? {});
    res = { type: 'string', enum: enumValues };
  } else if (schema instanceof z.ZodLiteral) {
    res = { type: typeof (schema as any)._def.value, enum: [(schema as any)._def.value] };
  } else if (schema instanceof z.ZodArray) {
    res = { type: 'array', items: zodToOpenApiSchema((schema as any)._def.type) };
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    const inner = zodToOpenApiSchema((schema as any)._def.innerType);
    if (!description) description = inner.description;
    res = { ...inner };
  } else if (schema instanceof z.ZodDefault) {
    const inner = zodToOpenApiSchema((schema as any)._def.innerType);
    if (!description) description = inner.description;
    const defVal = typeof (schema as any)._def.defaultValue === 'function'
      ? (schema as any)._def.defaultValue()
      : (schema as any)._def.defaultValue;
    res = { ...inner, default: defVal };
  } else if (schema instanceof z.ZodUnion) {
    const options = (schema as any)._def.options.map((opt: any) => zodToOpenApiSchema(opt));
    res = { anyOf: options };
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
        !(field._def?.typeName === 'ZodOptional') &&
        !(field instanceof z.ZodDefault)
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
      '/': {
        get: {
          summary: 'Sora サービス情報・利用可能エンドポイント一覧',
          responses: {
            '200': {
              description: 'サービスメタデータおよび利用可能な全エンドポイント一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(SystemInfoResponseSchema),
                },
              },
            },
          },
        },
      },
      '/health': {
        get: {
          summary: 'ヘルスチェック & コンポーネント稼働状態',
          responses: {
            '200': {
              description: 'ヘルスチェック結果および各コンポーネント稼働状態',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(HealthResponseSchema),
                },
              },
            },
          },
        },
      },
      '/metrics': {
        get: {
          summary: 'Prometheus / JSON 運用メトリクス',
          responses: {
            '200': {
              description: 'プロセス稼働時間、キャッシュ統計、メモリ使用量などの運用メトリクス',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(MetricsResponseSchema),
                },
              },
            },
          },
        },
      },
      '/cache/clear': {
        post: {
          summary: 'キャッシュの全クリア',
          responses: {
            '200': {
              description: 'キャッシュクリア結果',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(CacheClearResponseSchema),
                },
              },
            },
          },
        },
      },
      '/scrape': {
        post: {
          summary: '単一 Web ページ / PDF スクレイピング (アセット高速遮断・DOM静止検知・イベント/パンくず/表構造化・RAGチャンキング・出典抽出・読了時間・PII保護対応)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ScrapeRequestSchema),
              },
            },
          },
          responses: {
            '200': {
              description: 'スクレイピング・本文抽出・メタデータ解析結果',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(ScrapeResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'Server-Sent Events (start, fetch, render, enrich, done)',
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    description: 'SSE ストリームイベント (data: JSON)',
                  },
                },
              },
            },
          },
        },
      },
      '/scrape/batch': {
        post: {
          summary: '複数 URL 一括並行スクレイピング (最大20件・ドメインスロットリング・イベント/パンくず構造化抽出)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(BatchScrapeRequestSchema),
              },
            },
          },
          responses: {
            '200': {
              description: '一括並行スクレイピング結果一覧およびエラー情報',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(BatchScrapeResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '再帰クロール結果および巡回ページ一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(CrawlResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '再帰クロール進行状況 Server-Sent Events',
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    description: 'SSE ストリームイベント (data: JSON)',
                  },
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'サイトマップまたはリンク解析による発見 URL 一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(MapResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'ブラウザアクション実行結果・抽出本文・スクリーンショット',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(BrowserActionResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'ブラウザアクション実行結果・抽出本文・スクリーンショット',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(BrowserActionResponseSchema),
                },
              },
            },
          },
        },
      },
      '/search': {
        post: {
          summary: '万能深層Web検索 (Web + X/Twitter + Clean Markdown 本文一括スクレイプ・重複排除・最新事実/スケジュール調査)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(IntegratedSearchRequestSchema),
              },
            },
          },
          responses: {
            '200': {
              description: '深層Web検索およびリアルタイムポスト統合結果',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(IntegratedSearchResponseSchema),
                },
              },
            },
          },
        },
      },
      '/search/web': {
        post: {
          summary: '万能Web検索・候補探索 (タイトル・URL・概要スニペット取得)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(SearchWebQuerySchema),
              },
            },
          },
          responses: {
            '200': {
              description: 'Web 検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(SearchWebResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '画像検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(ImageSearchResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '動画検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(VideoSearchResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'ニュース記事検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(NewsSearchResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '知恵袋 Q&A 検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(ChiebukuroSearchResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '急上昇トレンドキーワード一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(TrendSearchResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'リアルタイムポスト検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(RealtimeSearchResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'キーワード自動補完サジェスト候補一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(SuggestResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '乗換案内ルート候補・運賃・所要時間・乗換駅詳細',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(TransitRouteResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '気象庁公式天気予報・気温・降水確率・概況文',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(WeatherResponseSchema),
                },
              },
            },
          },
        },
        get: {
          summary: '気象庁公式オープンデータ 天気予報・概況文 (GET クエリ指定)',
          parameters: [
            { name: 'city', in: 'query', schema: { type: 'string' }, description: '市区町村名または都道府県名 (例: "東京", "大阪", "天童市")' },
            { name: 'days', in: 'query', schema: { type: 'integer' }, description: '取得日数 (デフォルト: 3)' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: '気象庁公式天気予報・気温・降水確率・概況文',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(WeatherResponseSchema),
                },
              },
            },
          },
        },
      },
      '/weather/{city}': {
        get: {
          summary: '気象庁公式オープンデータ 天気予報・概況文 (パス指定)',
          parameters: [
            { name: 'city', in: 'path', required: true, schema: { type: 'string' }, description: '市区町村名または都道府県名 (例: "天童市", "箱根")' },
            { name: 'days', in: 'query', schema: { type: 'integer' }, description: '取得日数 (デフォルト: 3)' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: '気象庁公式天気予報・気温・降水確率・概況文',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(WeatherResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '発令中の気象警報・特別警報・注意報一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(AreaWarningsResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'リアルタイム地震速報・震源地・最大震度・津波情報一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(EarthquakeSearchResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'リアルタイム道路交通規制・渋滞情報サマリーおよび路線別詳細',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(RoadTrafficResponseSchema),
                },
              },
            },
          },
        },
        get: {
          summary: 'JARTIC 連携 リアルタイム道路交通情報取得 (GET クエリ指定)',
          parameters: [
            { name: 'pref', in: 'query', schema: { type: 'string' }, description: '都道府県名 (例: "東京都", "神奈川県")' },
            { name: 'road', in: 'query', schema: { type: 'string' }, description: '路線名絞り込み (例: "東名", "首都高")' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: 'リアルタイム道路交通規制・渋滞情報サマリーおよび路線別詳細',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(RoadTrafficResponseSchema),
                },
              },
            },
          },
        },
      },
      '/traffic/road/{pref}': {
        get: {
          summary: 'JARTIC 連携 リアルタイム道路交通情報取得 (都道府県パス指定)',
          parameters: [
            { name: 'pref', in: 'path', required: true, schema: { type: 'string' }, description: '都道府県名 (例: "東京", "神奈川")' },
            { name: 'road', in: 'query', schema: { type: 'string' }, description: '路線名絞り込み (例: "東名", "首都高")' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: 'リアルタイム道路交通規制・渋滞情報サマリーおよび路線別詳細',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(RoadTrafficResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '登録された監視ターゲット情報および初回スキャン結果',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(WatchRegisterResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '差分スキャン実行結果・変更検知ステータス・ハッシュ比較',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(WatchCheckResultSchema),
                },
              },
            },
          },
        },
      },
      '/watch/list': {
        get: {
          summary: '登録済み差分監視ターゲット一覧取得 (SQLite 永続化)',
          responses: {
            '200': {
              description: '登録済み監視ターゲット一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(WatchTargetListSchema),
                },
              },
            },
          },
        },
      },
      '/watch/{id}': {
        delete: {
          summary: '差分監視ターゲット削除',
          responses: {
            '200': {
              description: '監視ターゲット削除結果',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(WatchDeleteResponseSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '楽曲メタデータ検索結果一覧 (ジャケット・試聴音源付き)',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(MusicSearchResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'アーティスト指定 音楽メタデータ検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(MusicSearchResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '汎用音楽メタデータ検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(MusicSearchResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '楽曲メタデータ検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(MusicSearchResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'アーティスト指定 音楽メタデータ検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(MusicSearchResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'e-Gov 法令キーワード検索結果一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(LawSearchResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '法令条文本文 (階層構造化 Markdown) およびメタデータ',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(LawDataResultSchema),
                },
              },
            },
          },
        },
      },
      '/trade/cpsc-check': {
        post: {
          summary: '米国CPSC適合証明書 (GCC/CCC) eFiling完全義務化 & ACE免責判定 (動的ヒアリング誘導対応)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(CpscCertificateCheckRequestSchema),
              },
            },
          },
          responses: {
            '200': {
              description: 'CPSC 証明書要否・eFiling 義務化判定・適用安全規格一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(CpscCertificateCheckResultSchema),
                },
              },
            },
          },
        },
      },
      '/trade/fda-check': {
        post: {
          summary: '米国FDA規制対象 実務判定（PGAフラグ FD1〜FD4・Prior Notice・MoCRA要件・動的ヒアリング誘導対応）',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(FdaRegulatedCheckRequestSchema),
              },
            },
          },
          responses: {
            '200': {
              description: 'FDA 規制フラグ・事前届出 Prior Notice 要否・該当プログラムコード',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(CheckFdaRegulatedResultSchema),
                },
              },
            },
          },
        },
      },
      '/trade/hts-verify': {
        post: {
          summary: 'HTS/HSコード実在確認・検証（USITC公式データ照合・10桁特定ヒアリング誘導対応）',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(VerifyHtsCodeRequestSchema),
              },
            },
          },
          responses: {
            '200': {
              description: 'HTS 実在検証結果・公式品目解説・基本関税率・近隣候補',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(VerifyHtsCodeResultSchema),
                },
              },
            },
          },
        },
      },
      '/trade/compliance': {
        post: {
          summary: '商品統合コンプライアンス一括判定（HTS検証・FDA判定・CPSC証明書/eFiling義務・総合ヒアリング誘導）',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(ProductComplianceRequestSchema),
              },
            },
          },
          responses: {
            '200': {
              description: '商品統合コンプライアンス判定・実務アクション計画・不足確認事項',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(CheckProductComplianceResultSchema),
                },
              },
            },
          },
        },
      },
      '/trade/hts-predict': {
        post: {
          summary: '商品情報からのHTS/HSコード推測（USITC公式API連動・候補提示・関税率取得・先回り推測抑止&動的質問生成）',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(PredictHtsCodeRequestSchema),
              },
            },
          },
          responses: {
            '200': {
              description: 'HTS コード推論結果・最適マッチ品目・上位候補リスト',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(PredictHtsCodeResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '国会会議録発言検索結果一覧および該当号情報',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(DietMinutesSearchResultSchema),
                },
              },
            },
          },
        },
        get: {
          summary: '国会会議録検索 API (GET クエリ指定)',
          parameters: [
            { name: 'keyword', in: 'query', schema: { type: 'string' }, description: '検索キーワード' },
            { name: 'speaker', in: 'query', schema: { type: 'string' }, description: '発言者名 (例: "総理大臣", "大臣")' },
            { name: 'nameOfHouse', in: 'query', schema: { type: 'string', enum: ['衆議院', '参議院'] }, description: '議院区分' },
            { name: 'nameOfMeeting', in: 'query', schema: { type: 'string' }, description: '会議・委員会名' },
            { name: 'from', in: 'query', schema: { type: 'string' }, description: '期間開始日 (YYYY-MM-DD)' },
            { name: 'until', in: 'query', schema: { type: 'string' }, description: '期間終了日 (YYYY-MM-DD)' },
            { name: 'limit', in: 'query', schema: { type: 'integer' }, description: '取得件数 (1〜30, デフォルト: 10)' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: '国会会議録発言検索結果一覧および該当号情報',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(DietMinutesSearchResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '国土地理院 ジオコーディング座標および海抜標高',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(ElevationResultSchema),
                },
              },
            },
          },
        },
        get: {
          summary: '国土地理院 住所ジオコーディング & 標高（海抜）取得 API (GET クエリ指定)',
          parameters: [
            { name: 'address', in: 'query', schema: { type: 'string' }, description: '住所地名 (例: "東京都千代田区永田町1-7-1", "天童市")' },
            { name: 'lat', in: 'query', schema: { type: 'number' }, description: '緯度 (address 省略時の直接指定)' },
            { name: 'lon', in: 'query', schema: { type: 'number' }, description: '経度 (address 省略時の直接指定)' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: '国土地理院 ジオコーディング座標および海抜標高',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(ElevationResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: '主要空港フライト運航状況サマリーおよび便別詳細一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(FlightStatusResultSchema),
                },
              },
            },
          },
        },
        get: {
          summary: '主要空港フライト運航状況・欠航・遅延リアルタイム検索 API (GET クエリ指定)',
          parameters: [
            { name: 'airport', in: 'query', schema: { type: 'string' }, description: '空港名またはコード (例: "HND", "羽田", "NRT", "成田", "KIX", "関空", "FUK", "福岡")' },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['departure', 'arrival'] }, description: '出発/到着' },
            { name: 'category', in: 'query', schema: { type: 'string', enum: ['domestic', 'international'] }, description: '国内線/国際線' },
            { name: 'flightNumber', in: 'query', schema: { type: 'string' }, description: '便名絞り込み (例: "NH241", "JL516")' },
            { name: 'keyword', in: 'query', schema: { type: 'string' }, description: '航空会社名または行先キーワード' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: '主要空港フライト運航状況サマリーおよび便別詳細一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(FlightStatusResultSchema),
                },
              },
            },
          },
        },
      },
      '/traffic/flight/{airport}': {
        get: {
          summary: '主要空港フライト運航状況・欠航・遅延リアルタイム検索 API (空港パス指定)',
          parameters: [
            { name: 'airport', in: 'path', required: true, schema: { type: 'string' }, description: '空港名またはコード (例: "HND", "羽田", "成田")' },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['departure', 'arrival'] }, description: '出発/到着' },
            { name: 'category', in: 'query', schema: { type: 'string', enum: ['domestic', 'international'] }, description: '国内線/国際線' },
            { name: 'flightNumber', in: 'query', schema: { type: 'string' }, description: '便名絞り込み' },
            { name: 'keyword', in: 'query', schema: { type: 'string' }, description: '航空会社名または行先キーワード' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: '主要空港フライト運航状況サマリーおよび便別詳細一覧',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(FlightStatusResultSchema),
                },
              },
            },
          },
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
          responses: {
            '200': {
              description: 'Base64 エンコード画像データおよびマルチモーダル連携ペイロード',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(InspectImageResultSchema),
                },
              },
            },
          },
        },
      },
      '/tracking': {
        post: {
          summary: '主要運送会社・UPS 荷物追跡 API (POST JSON指定)',
          requestBody: {
            content: {
              'application/json': {
                schema: zodToOpenApiSchema(TrackingRequestSchema),
              },
            },
          },
          responses: {
            '200': {
              description: '統一荷物追跡ステータス・時系列追跡イベント・発送/お届け先詳細',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(TrackingResultSchema),
                },
              },
            },
          },
        },
      },
      '/tracking/{carrier}/{number}': {
        get: {
          summary: '主要運送会社・UPS 荷物追跡 API (運送会社 & 伝票番号指定)',
          parameters: [
            { name: 'carrier', in: 'path', required: true, schema: { type: 'string', enum: ['yamato', 'sagawa', 'japanpost', 'seino', 'fukutsu', 'ups'] }, description: '運送会社コード' },
            { name: 'number', in: 'path', required: true, schema: { type: 'string' }, description: '追跡番号・送り状番号' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: '統一荷物追跡ステータス・時系列追跡イベント・発送/お届け先詳細',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(TrackingResultSchema),
                },
              },
            },
          },
        },
      },
      '/tracking/{number}': {
        get: {
          summary: '主要運送会社・UPS 荷物追跡 API (伝票番号から自動判別)',
          parameters: [
            { name: 'number', in: 'path', required: true, schema: { type: 'string' }, description: '追跡番号・送り状番号' },
            { name: 'noCache', in: 'query', schema: { type: 'boolean' }, description: 'キャッシュをバイパスするか' },
          ],
          responses: {
            '200': {
              description: '統一荷物追跡ステータス・時系列追跡イベント・発送/お届け先詳細',
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(TrackingResultSchema),
                },
              },
            },
          },
        },
      },
    },
  };
}

