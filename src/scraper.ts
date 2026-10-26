import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import type { CookieParam } from 'puppeteer-core';
import {
  type BatchScrapeResult,
  type BrowserActionOptions,
  type HighlightAlgorithm,
  type ScrapeFormat,
  type ScrapeResult,
  type SitemapEntry,
  DEFAULT_MAX_CHARS,
} from './types.js';
import {
  cacheKeyDigest,
  getFromCache,
  runWithSingleFlight,
  setToCache,
  CACHE_TTL_DEFAULT,
  CACHE_TTL_EMPTY,
  CACHE_TTL_TREND,
} from './cache.js';
import {
  calculateContentStats,
  chooseBestDescription,
  chunkMarkdownContent,
  dedupSearchResults,
  estimateTokens,
  extractCitationsFromMarkdown,
  normalizeSafeNumeric,
  rerankByDeepEvidence,
  reorderLostInTheMiddle,
  expandQueryWithPseudoRelevanceFeedback,
  generateExtractiveSummary,
  generatePromptContext,
  generateTextFragmentUrl,
  highlightQueryMatchesInMarkdown,
  maskPiiInText,
  safeTruncateMarkdown,
  sendWebhookNotification,
  validateExtractedLinks,
  extractTemporalAnchors,
  annotateTextWithTemporalAnchors,
  computeAnswerability,
} from './enrichment.js';
import { hasSensitiveRequestCredentials, isSensitiveHeaderName } from './security/credential_scope.js';
import { incrementSecurityCounter } from './security/metrics.js';
import { extractQueryHighlightsRhoSelect } from './rho_select.js';
import { extractQueryHighlightsRhoV2, extractWithEscalation } from './rho_select_v2_adapter.js';
import { stripHighlightInternals } from './highlight_surface.js';
import { buildSearchDiagnostics } from './search_diagnostics.js';
import { formatCompactIntegratedSearchResponse } from './search_compact.js';
import { projectRequestedScrapeFormats } from './search_format_projection.js';
import { hasMeaningfulPageContent } from './scrape_content_quality.js';
import {
  buildXIsolatedEvidence,
  buildXIsolatedEvidenceFromDirectStatus,
  buildXRetrievalPlan,
  stripXWebDiscoveryText,
} from './x_source_isolation.js';
import {
  defaultXDetailProvider,
  enrichRealtimeItemsWithXDetail,
  cleanRealtimeItem,
} from './services/x_detail.js';

import { resolveChromiumPath } from './browser_engine.js';
import { parsePdfToMarkdown } from './pdf.js';
import {
  searchYahooWeb,
  searchYahooVideo,
  normalizeDomainList,
  normalizeRealtimeItem,
  searchYahooRealtime,
  fetchTweetsForUrlOrUser,
  extractOfficialXHandleFromWebResults,
  findOfficialXHandle,
  mergeRealtimeItemsWithDedup,
  extractRealtimeIntentRequirements,
  DEFAULT_REALTIME_ITEM_CAP,
} from './services/yahoo.js';
import {
  anchorCandidates,
  detectRealtimeFocus,
  isPublicFocusTerm,
  officialAccountMatches,
  type RealtimeFocus,
} from './retrieval/realtime_anchor.js';

// ==========================================
// 1. 各専門サブモジュールの re-export (完全な後方互換性の維持)
// ==========================================
export * from './types.js';
export * from './cache.js';

/** 何も取れなかった統合検索（結果 0 件・no-usable-content）は、取り直せるように短くだけキャッシュする。 */
const integratedSearchCacheTtl = (response: unknown) => (isUnusableIntegratedSearch(response) ? CACHE_TTL_EMPTY : CACHE_TTL_DEFAULT);
/** 本文を読み取れなかった scrape（contentStatus が unavailable）も、短くだけキャッシュする。 */
const scrapeCacheTtl = (result: { contentStatus?: string } | null | undefined) => (result?.contentStatus === 'unavailable' ? CACHE_TTL_EMPTY : CACHE_TTL_DEFAULT);
export * from './db.js';
export * from './enrichment.js';
export * from './browser_engine.js';
export * from './pdf.js';
export * from './services/yahoo.js';
export * from './services/life.js';
export * from './services/disaster.js';
export * from './services/traffic.js';
export * from './services/watch.js';
export * from './services/music.js';
export * from './services/gov.js';
export * from './services/health.js';
export * from './services/trade.js';
export * from './services/image_inspect.js';
export * from './http_fetcher.js';
export * from './html_parser.js';
export * from './browser_stealth.js';

import {
  decodeHtmlBuffer,
  fetchWithSafeRedirects,
  MAX_RESPONSE_BODY_BYTES,
} from './http_fetcher.js';
import { readBodyWithLimit } from './net/safe_transport.js';
import { extractQueryRequirements } from './retrieval/requirements.js';
import { settleWithDeadline } from './scrape_deadline.js';
import { isUnusableIntegratedSearch, summarizeContextSufficiency } from './context_sufficiency.js';
import { computeEvidenceCoverage, entityTermsForQuery, kindsForFacet } from './retrieval/answerability.js';
import {
  convertHtmlToMarkdown,
  matchUrlPattern,
  parseYouTubeUrl,
  splitQueryUrls,
} from './html_parser.js';
import { isModuleActive } from './mcp/registry.js';
import { getTiktokPage, parseTikTokVideoUrl } from './services/tiktok.js';
import { getYoutubePage } from './services/youtube.js';
import {
  fetchWithStealthBrowser,
} from './browser_stealth.js';
import { errorMessage } from './errors.js';

// ==========================================
// 2. ブラウザ自動操作 (browser_action)
// ==========================================
export async function executeBrowserActions(options: BrowserActionOptions): Promise<any> {
  const { handleBrowserSessionAction } = await import('./browser_session.js');
  const sessionRes = await handleBrowserSessionAction({
    url: options.url,
    sessionId: options.sessionId,
    ownerToken: options.ownerToken,
    tenantId: (options as any).tenantId,
    createSession: options.createSession,
    closeSession: options.closeSession,
    actions: options.actions,
    extract: options.extract,
    timeout: options.timeout,
  });

  return {
    success: true,
    url: sessionRes.url,
    sessionId: sessionRes.sessionId,
    sessionClosed: sessionRes.sessionClosed,
    markdown: sessionRes.content,
    screenshot: sessionRes.screenshot,
    html: sessionRes.html,
    actionOutputs: sessionRes.actionLogs?.map((l: any, idx: number) => ({
      step: idx + 1,
      type: l.type,
      result: l.success ? 'ok' : undefined,
      error: !l.success ? l.message : undefined,
    })),
    renderedWithBrowser: true,
    source: 'browser',
  };
}

const MEDIA_CONTENT_TYPE = /^(?:image|audio|video)\//;

/** 動画（YouTube・TikTok）を字幕と説明文で本文にした結果。 */
function videoPageResult(
  url: string,
  page: { title: string; content: string; author?: string; publishedTime?: string; description?: string; contentStatus: ScrapeResult['contentStatus']; media?: ScrapeResult['media'] },
  siteName: string,
  maxChars: number,
): ScrapeResult {
  const stats = calculateContentStats(page.content);
  const content = safeTruncateMarkdown(page.content, maxChars);
  return {
    url,
    title: page.title,
    content,
    isTruncated: page.content.length > maxChars,
    contentType: 'text/markdown',
    source: 'web',
    links: [],
    characterCount: stats.characterCount,
    wordCount: stats.wordCount,
    readingTimeMin: stats.readingTimeMin,
    estimatedTokens: estimateTokens(content),
    author: page.author,
    publishedTime: page.publishedTime,
    siteName,
    description: page.description,
    contentStatus: page.contentStatus,
    ...(page.media ? { media: page.media } : {}),
  };
}

/** 画像・音声・動画のファイルの結果。中身は文字にできないので読まず、種類と大きさだけを書く（本文は無いので unavailable）。 */
function mediaFileResult(url: string, contentType: string, contentLength: string | null): ScrapeResult {
  const type = contentType.split(';')[0].trim();
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch {}
  const bytes = Number(contentLength);
  const content = [
    `# ${name || url}`,
    '',
    `- 種類: ${type}`,
    `- 大きさ: ${bytes > 0 ? `${bytes.toLocaleString('en-US')} バイト` : '不明'}`,
    `- URL: ${url}`,
    '',
    '画像・音声・動画のファイルです。Sora はファイルの中身を読めません。',
  ].join('\n');
  const stats = calculateContentStats(content);
  return {
    url,
    title: name || url,
    content,
    isTruncated: false,
    contentType: type,
    source: 'web',
    links: [],
    characterCount: stats.characterCount,
    wordCount: stats.wordCount,
    readingTimeMin: stats.readingTimeMin,
    estimatedTokens: estimateTokens(content),
    contentStatus: 'unavailable',
  };
}

/** 本文を読めなかったページにする（unavailable）。仕上げ（finalizeScrapeResult）の後に当て、その画面の文から作ったハイライトは外す。 */
function markUnreadable(result: ScrapeResult, note: string): ScrapeResult {
  const { highlights: _h, highlightItems: _i, highlightDiagnostics: _d, textFragmentUrl: _t, ...rest } = result;
  return { ...rest, contentStatus: 'unavailable', content: `${note}\n\n${result.content}` };
}

/** HTTP の状態が 400 以上のページは本文として扱わない（ブロックやエラーの画面。TikTok はブラウザでも 403 のことがある）。 */
function markHttpError(result: ScrapeResult, status: number | undefined): ScrapeResult {
  return !status || status < 400 ? result : markUnreadable(result, `HTTP ${status} が返ったため、本文として扱いません。`);
}

// ==========================================
// 3. スクレイピング完了処理 & オプション統合
// ==========================================
export async function finalizeScrapeResult(
  result: ScrapeResult,
  options: {
    query?: string;
    shouldExtractHighlights: boolean;
    shouldOnlyHighlights?: boolean;
    evidenceMode?: 'full' | 'highlights' | 'contextual_highlights';
    includeDiagnostics?: boolean;
    includeDiscrepancies?: boolean;
    safeNormalize?: boolean;
    reorderUFlat?: boolean;
    diversityWeight?: number;
    annotateTemporal?: boolean;
    highlightAlgorithm?: HighlightAlgorithm;
    highlightOverheadTokens?: number;
    highlightMaxCount?: number;
    verbose?: boolean;
    shouldExtractSummary: boolean;
    shouldExtractCitations: boolean;
    shouldChunkMarkdown: boolean;
    chunkSize: number;
    shouldValidateLinks: boolean;
    shouldFormatAsPrompt: boolean;
    shouldHighlightMatches: boolean;
    shouldMaskPii: boolean;
    webhookUrl?: string;
    snippet?: string;
  },
): Promise<ScrapeResult> {
  if (options.shouldMaskPii) {
    result.content = maskPiiInText(result.content);
  }

  // 決定論的安全正規化 (漢数字・全角数字・物理単位)
  if (options.safeNormalize) {
    const norm = normalizeSafeNumeric(result.content);
    result.content = norm.normalizedText;
    if (norm.derivations.length > 0) {
      result.derivations = norm.derivations;
    }
  }

  const stats = calculateContentStats(result.content);
  result.characterCount = stats.characterCount;
  result.wordCount = stats.wordCount;
  result.readingTimeMin = stats.readingTimeMin;

  if (options.shouldExtractHighlights && options.query) {
    const supplemental: string[] = [];
    if (options.snippet?.trim()) {
      supplemental.push(options.snippet.trim());
    }
    if (result.description?.trim() && result.description !== options.snippet) {
      supplemental.push(result.description.trim());
    }

    if (options.highlightAlgorithm === 'rho-select' || options.highlightAlgorithm === 'legacy') {
      const rho = extractQueryHighlightsRhoSelect(result.content, options.query, {
        maxHighlights: options.highlightMaxCount ?? 3,
        overheadTokens: options.highlightOverheadTokens ?? 96,
        supplementalEvidence: supplemental,
      });
      result.highlights = rho.highlights;
      result.highlightItems = rho.highlights.map((h: string, idx: number) => ({
        text: h,
        score: Number((1.0 - idx * 0.1).toFixed(4)),
      }));
      if (options.verbose) {
        result.highlightDiagnostics = rho.diagnostics;
      }
      if (result.highlights && result.highlights.length > 0) {
        result.textFragmentUrl = generateTextFragmentUrl(result.url, result.highlights[0]);
      }
    } else {
      // Default to rho-select-v2 (Canonical Engine) with recall escalation
      const v2 = extractWithEscalation(result.content, options.query, {
        tau: options.highlightOverheadTokens ?? 96,
        supplementalEvidence: supplemental,
        highlightMaxCount: options.highlightMaxCount,
        limits: { maxBlocks: 500, maxExtractionMs: 2000 },
      });
      result.highlights = v2.highlights;
      result.highlightItems = v2.highlightItems.map((item) => ({
        text: item.text,
        score: item.score,
      }));
      if (options.verbose) {
        result.highlightDiagnostics = v2.diagnostics;
      }
      if (result.highlights && result.highlights.length > 0) {
        result.textFragmentUrl = generateTextFragmentUrl(result.url, result.highlights[0]);
      }
    }
  }
  const isHighlightOnlyMode =
    options.shouldOnlyHighlights ||
    options.evidenceMode === 'highlights' ||
    options.evidenceMode === 'contextual_highlights';

  if (isHighlightOnlyMode && result.highlights && result.highlights.length > 0) {
    result.content = result.highlights.join('\n\n---\n\n');
    const updatedStats = calculateContentStats(result.content);
    result.characterCount = updatedStats.characterCount;
    result.wordCount = updatedStats.wordCount;
    result.readingTimeMin = updatedStats.readingTimeMin;
    result.estimatedTokens = estimateTokens(result.content);
  }

  if (options.annotateTemporal) {
    if (!result.temporalAnchors || result.temporalAnchors.length === 0) {
      const anchors = extractTemporalAnchors(result.content, result.publishedTime);
      if (anchors.length > 0) {
        result.temporalAnchors = anchors;
      }
    }
    if (!isHighlightOnlyMode) {
      result.content = annotateTextWithTemporalAnchors(result.content, result.publishedTime);
      const updatedStats = calculateContentStats(result.content);
      result.characterCount = updatedStats.characterCount;
      result.wordCount = updatedStats.wordCount;
      result.readingTimeMin = updatedStats.readingTimeMin;
      result.estimatedTokens = estimateTokens(result.content);
    }
  }
  if (options.query) {
    const topHighlight = result.highlights?.[0];
    result.description = chooseBestDescription(result.description, topHighlight, options.query);
  }
  if (options.shouldExtractSummary) {
    result.summary = generateExtractiveSummary(result.content, 4);
  }
  if (options.shouldExtractCitations) {
    result.citations = extractCitationsFromMarkdown(result.content, result.url);
  }
  if (options.shouldChunkMarkdown) {
    result.chunks = chunkMarkdownContent(result.content, options.chunkSize);
  }
  if (options.shouldValidateLinks && result.links && result.links.length > 0) {
    result.linksWithStatus = await validateExtractedLinks(result.links);
  }
  if (options.shouldHighlightMatches && options.query) {
    result.highlightedContent = highlightQueryMatchesInMarkdown(result.content, options.query);
  }
  if (options.shouldFormatAsPrompt) {
    result.promptContext = generatePromptContext(result);
  }
  if (options.webhookUrl) {
    sendWebhookNotification(options.webhookUrl, result);
  }
  return result;
}

// ==========================================
// 4. 単一 URL スクレイピング (scrapeUrl)
// ==========================================
const BOT_MITIGATION_STATUS_CODES = new Set([403, 429, 503]);

let botUpgradeCount = 0;
let botRetryCount = 0;

export function getBotDetectionMetrics(): { upgradeCount: number; retryCount: number } {
  return { upgradeCount: botUpgradeCount, retryCount: botRetryCount };
}

export function detectSpaOrBotPage(options: {
  html: string;
  bodyOnlyMarkdown: string;
  status?: number;
  headers?: Record<string, string>;
}): boolean {
  const { html, bodyOnlyMarkdown, status, headers } = options;
  const hasLittleContent = bodyOnlyMarkdown.length < 50;

  const isJsDisabledMessage =
    /javascript\s+(?:is\s+)?(?:disabled|required|needed|must be enabled)/i.test(bodyOnlyMarkdown) ||
    /please\s+enable\s+(?:your\s+)?javascript/i.test(bodyOnlyMarkdown) ||
    /javascript\s*を\s*(?:有効|オン)/i.test(bodyOnlyMarkdown) ||
    /javascript\s*が\s*無効/i.test(bodyOnlyMarkdown) ||
    /^(?:loading\.*|読み込み中\.*|now loading\.*)$/i.test(bodyOnlyMarkdown);

  const isBotChallengeStatus = status !== undefined && BOT_MITIGATION_STATUS_CODES.has(status);

  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalizedHeaders[key.toLowerCase()] = value.toLowerCase();
  }
  const isCloudflareMitigation =
    'cf-mitigated' in normalizedHeaders ||
    (status !== undefined && BOT_MITIGATION_STATUS_CODES.has(status) && (normalizedHeaders.server ?? '').includes('cloudflare'));

  const isBotChallengePage =
    html.includes('Please enable JavaScript') ||
    html.includes('Checking your browser') ||
    html.includes('Just a moment...') ||
    html.includes('cf-browser-verification') ||
    html.includes('cf-challenge');

  // Bot 遮断・チャレンジまたは JS 無効化メッセージはコンテンツ量に関わらずフラグ
  if (isJsDisabledMessage || isBotChallengeStatus || isCloudflareMitigation || isBotChallengePage) {
    return true;
  }

  // 極端にコンテンツが少ない（50文字未満）場合は SPA/空白ページとみなす
  if (hasLittleContent) {
    return true;
  }

  // SPA フレームワークのマウントマーカー
  const isSpaFrameworkMarker =
    html.includes('id="react-root"') ||
    html.includes('id="root"') ||
    html.includes('id="app"') ||
    html.includes('id="__next"') ||
    html.includes('id="__nuxt"') ||
    html.includes('id="svelte"') ||
    html.includes('__NEXT_DATA__') ||
    html.includes('react-data') ||
    html.includes('__NUXT_DATA__') ||
    html.includes('__INITIAL_STATE__') ||
    html.includes('__remixContext') ||
    html.includes('client-bootstrap') ||
    html.includes('data-build=') ||
    html.includes('data-reactroot');

  // SPA マーカーがあり、かつ本文が短文（300文字未満）の場合は
  // クライアントレンダリング待ちのSPAと判定してブラウザ描画へ移行
  // （300文字以上の十分な本文が既にHTML内にレンダリングされているSSR/SSGサイトはブラウザ不要）
  if (isSpaFrameworkMarker && bodyOnlyMarkdown.length < 300) {
    return true;
  }

  return false;
}

/**
 * Late browser escalation (spec section 52): static HTTP content exists but
 * an SPA/quality signal fired. Skip the browser only when recall extraction
 * demonstrates answers on the static body; otherwise preserve escalation.
 * Pure function for testability; the caller counts the outcome.
 */
export function shouldEscalateToBrowser(args: {
  spaDetected: boolean;
  staticMarkdown: string;
  query?: string;
}): { escalate: boolean; reason: string } {
  if (!args.spaDetected) return { escalate: false, reason: 'static-sufficient' };
  const body = (args.staticMarkdown || '').trim();
  if (body.length < 50) return { escalate: true, reason: 'no-static-content' };
  if (!args.query) return { escalate: true, reason: 'no-query' };
  try {
    const recall = extractWithEscalation(body, args.query, { tau: 96 });
    const coverage = recall.diagnostics.answerCoverage ?? 0;
    if (coverage >= 0.5) return { escalate: false, reason: `recall-answers:${coverage.toFixed(2)}` };
    return { escalate: true, reason: `weak-evidence:${coverage.toFixed(2)}` };
  } catch {
    return { escalate: true, reason: 'recall-failed' };
  }
}

export function isRenderStillBlockedOrBlank(options: {
  html: string;
  bodyOnlyMarkdown: string;
}): boolean {
  const { html, bodyOnlyMarkdown } = options;
  const hasLittleContent = bodyOnlyMarkdown.length < 50;
  const isJsDisabledMessage =
    /javascript\s+(?:is\s+)?(?:disabled|required|needed|must be enabled)/i.test(bodyOnlyMarkdown) ||
    /please\s+enable\s+(?:your\s+)?javascript/i.test(bodyOnlyMarkdown) ||
    /javascript\s*を\s*(?:有効|オン)/i.test(bodyOnlyMarkdown) ||
    /javascript\s*が\s*無効/i.test(bodyOnlyMarkdown) ||
    /^(?:loading\.*|読み込み中\.*|now loading\.*)$/i.test(bodyOnlyMarkdown);

  const isChallenge =
    html.includes('Checking your browser') ||
    html.includes('Just a moment...') ||
    html.includes('cf-browser-verification') ||
    html.includes('cf-challenge');

  return hasLittleContent || isJsDisabledMessage || isChallenge || !hasMeaningfulPageContent(bodyOnlyMarkdown);
}

type ScrapeUrlOptions = Parameters<typeof scrapeUrl>[0];

/**
 * scrapeUrl の結果の中身を変えない項目と、キャッシュキーとは別に扱う項目。ここに無い項目はすべてキーに入れる。
 * ScrapeUrlOptions に項目を足すと、キーに入れるかここに挙げるかを決めるまで型エラーになる。
 */
type ScrapeKeyIgnored =
  | 'url' // キーの先頭に別に置く
  | 'cookies' // 資格情報付きの要求は共有キャッシュを使わない
  | 'tenantId' // 公開ページの取得結果はテナントをまたいで共有する
  | 'noCache' | 'onProgress' | 'retries' | 'retryDelayMs' | 'timeoutMs' // 取得の進め方で、結果の中身は変えない
  | 'webhookUrl'; // 通知先で、結果の中身は変えない

/** キーに入れるヘッダー。資格情報を運ぶヘッダーを持つ要求は共有キャッシュを使わないので除く。名前は大文字小文字を区別しない。 */
function headersForCacheKey(headers: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(headers ?? {})
    .filter(([name]) => !isSensitiveHeaderName(name))
    .map(([name, value]): [string, string] => [name.toLowerCase(), String(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** scrapeUrl の共有キャッシュのキー。結果の中身を変える入力はすべて含める。 */
export function buildScrapeCacheKey(
  options: ScrapeUrlOptions,
  resolved: { maxChars: number; formats: ScrapeFormat[]; onlyMainContent: boolean; shouldExtractHighlights: boolean },
): string {
  const digest = cacheKeyDigest<ScrapeUrlOptions, ScrapeKeyIgnored>({
    maxChars: resolved.maxChars,
    mode: options.mode ?? 'auto',
    renderJs: options.renderJs === true,
    fastOnly: options.fastOnly === true,
    formats: resolved.formats.slice().sort(),
    fullPage: options.fullPage ?? true,
    onlyMainContent: resolved.onlyMainContent,
    selectors: options.selectors ?? null,
    clipSelector: options.clipSelector ?? '',
    headers: headersForCacheKey(options.headers),
    removeSelectors: options.removeSelectors ?? [],
    stripLinks: options.stripLinks === true,
    filterLinkDensity: options.filterLinkDensity === true,
    query: options.query ?? '',
    extractHighlights: resolved.shouldExtractHighlights,
    onlyHighlights: options.onlyHighlights === true,
    highlightAlgorithm: options.highlightAlgorithm ?? 'rho-select-v2',
    highlightOverheadTokens: options.highlightOverheadTokens ?? 96,
    highlightMaxCount: options.highlightMaxCount ?? 'auto',
    evidenceMode: options.evidenceMode ?? 'full',
    includeDiagnostics: options.includeDiagnostics !== false,
    includeDiscrepancies: options.includeDiscrepancies === true,
    safeNormalize: options.safeNormalize === true,
    reorderUFlat: options.reorderUFlat === true,
    diversityWeight: options.diversityWeight ?? 0.7,
    annotateTemporal: options.annotateTemporal === true,
    minimizeTables: options.minimizeTables !== false,
    extractSummary: options.extractSummary === true,
    extractCitations: options.extractCitations === true,
    chunkMarkdown: options.chunkMarkdown === true,
    chunkSize: options.chunkSize || 1000,
    validateLinks: options.validateLinks === true,
    formatAsPrompt: options.formatAsPrompt === true,
    highlightMatches: options.highlightMatches === true,
    maskPii: options.maskPii === true,
    verbose: options.verbose === true,
    keepDataImages: options.keepDataImages === true,
    contextTitle: options.contextTitle ?? '',
    snippet: options.snippet ?? '',
  });
  return `scrape:v7:${options.url}:${digest}`;
}

export async function scrapeUrl(options: {
  url: string;
  maxChars?: number;
  mode?: 'auto' | 'fast' | 'browser';
  renderJs?: boolean;
  fastOnly?: boolean;
  formats?: ScrapeFormat[];
  fullPage?: boolean;
  onlyMainContent?: boolean;
  selectors?: Record<string, string>;
  clipSelector?: string;
  headers?: Record<string, string>;
  cookies?: CookieParam[];
  removeSelectors?: string[];
  stripLinks?: boolean;
  filterLinkDensity?: boolean;
  query?: string;
  extractHighlights?: boolean;
  onlyHighlights?: boolean;
  highlightAlgorithm?: HighlightAlgorithm;
  highlightOverheadTokens?: number;
  highlightMaxCount?: number;
  evidenceMode?: 'full' | 'highlights' | 'contextual_highlights';
  includeDiagnostics?: boolean;
  includeDiscrepancies?: boolean;
  safeNormalize?: boolean;
  reorderUFlat?: boolean;
  diversityWeight?: number;
  annotateTemporal?: boolean;
  minimizeTables?: boolean;
  extractSummary?: boolean;
  extractCitations?: boolean;
  chunkMarkdown?: boolean;
  chunkSize?: number;
  validateLinks?: boolean;
  formatAsPrompt?: boolean;
  highlightMatches?: boolean;
  maskPii?: boolean;
  webhookUrl?: string;
  retries?: number;
  retryDelayMs?: number;
  noCache?: boolean;
  timeoutMs?: number;
  tenantId?: string;
  verbose?: boolean;
  keepDataImages?: boolean;
  contextTitle?: string;
  snippet?: string;
  onProgress?: (event: { stage: 'start' | 'fetch' | 'render' | 'enrich' | 'done'; message: string; data?: any }) => void;
}): Promise<ScrapeResult> {
  const url = options.url;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const formats = options.formats ?? ['markdown'];
  const onlyMainContent = options.onlyMainContent !== false;
  const timeoutMs = options.timeoutMs ?? 15000;
  const retries = Math.min(Math.max(options.retries ?? 0, 0), 3);
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const onProgress = options.onProgress;
  const shouldExtractHighlights =
    options.extractHighlights ?? (Boolean(options.query?.trim()));

  onProgress?.({ stage: 'start', message: `Starting scrape for ${url}` });

  if (options.fastOnly && options.renderJs) {
    throw new Error('fastOnly と renderJs は同時に指定できません');
  }

  const cacheKey = buildScrapeCacheKey(options, { maxChars, formats, onlyMainContent, shouldExtractHighlights });

  // Never place credential-scoped content in public cache.
  // This invariant is required for multi-tenant safety.
  // Authenticated scrapes bypass shared cache on both read and write.
  const useSharedCache =
    !options.noCache &&
    !hasSensitiveRequestCredentials({ headers: options.headers, cookies: options.cookies });
  if (!useSharedCache && !options.noCache) incrementSecurityCounter('sora_private_cache_bypass_total');

  if (useSharedCache) {
    const cached = getFromCache<ScrapeResult>(cacheKey);
    if (cached) {
      onProgress?.({ stage: 'done', message: 'Cache hit', data: cached });
      return cached;
    }
  }

  const scrapeTask = async () => {
    let attempt = 0;
    let lastError: any = null;

    const finalizeOpts = {
      query: options.query,
      shouldExtractHighlights: shouldExtractHighlights ?? (!!options.onlyHighlights),
      shouldOnlyHighlights: options.onlyHighlights ?? false,
      highlightAlgorithm: options.highlightAlgorithm,
      highlightOverheadTokens: options.highlightOverheadTokens,
      highlightMaxCount: options.highlightMaxCount,
      verbose: options.verbose,
      evidenceMode: options.evidenceMode,
      includeDiagnostics: options.includeDiagnostics,
      includeDiscrepancies: options.includeDiscrepancies,
      safeNormalize: options.safeNormalize,
      reorderUFlat: options.reorderUFlat,
      diversityWeight: options.diversityWeight,
      annotateTemporal: options.annotateTemporal,
      shouldExtractSummary: options.extractSummary ?? false,
      shouldExtractCitations: options.extractCitations ?? false,
      shouldChunkMarkdown: options.chunkMarkdown ?? false,
      chunkSize: options.chunkSize ?? 1000,
      shouldValidateLinks: options.validateLinks ?? false,
      shouldFormatAsPrompt: options.formatAsPrompt ?? false,
      shouldHighlightMatches: options.highlightMatches ?? false,
      shouldMaskPii: options.maskPii ?? false,
      webhookUrl: options.webhookUrl,
      snippet: options.snippet,
    };

    while (attempt <= retries) {
      try {
        let result: ScrapeResult;
        let initialHttpResult: ScrapeResult | null = null;
        let initialHttpStatus: number | undefined;

        // YouTube の動画 URL は、動画のページ（おすすめ動画の一覧しか読めない）ではなく、字幕と説明文から本文を作る。
        // ページそのもの（HTML・リンク・スクリーンショット）やブラウザでの描画を求められたときは、通常の取得に任せる
        const wantsPage = formats.some((f) => f === 'html' || f === 'rawHtml' || f === 'links' || f === 'screenshot') || options.mode === 'browser' || options.renderJs === true;
        if (!wantsPage && isModuleActive('youtube') && parseYouTubeUrl(url)) {
          const page = await getYoutubePage(url, { noCache: options.noCache, query: options.query, maxChars });
          result = await finalizeScrapeResult(videoPageResult(url, page, 'YouTube', maxChars), finalizeOpts);
          if (useSharedCache) setToCache(cacheKey, result, scrapeCacheTtl(result));
          return result;
        }

        // X (Twitter) アカウントURL/ポストURLのインテリジェント・バイパス (未ログイン遮断回避)
        if (/https?:\/\/(?:x\.com|twitter\.com|mobile\.twitter\.com)\/[a-zA-Z0-9_]+/i.test(url)) {
          const tweetRes = await fetchTweetsForUrlOrUser(url, { contextTitle: options.contextTitle, snippet: options.snippet });
          if (tweetRes) {
            const stats = calculateContentStats(tweetRes.content);
            const truncatedContent = safeTruncateMarkdown(tweetRes.content, maxChars);
            const baseResult: ScrapeResult = {
              url,
              title: tweetRes.title,
              content: truncatedContent,
              isTruncated: tweetRes.content.length > maxChars,
              contentType: 'text/markdown',
              source: 'web',
              links: [],
              characterCount: stats.characterCount,
              wordCount: stats.wordCount,
              readingTimeMin: stats.readingTimeMin,
              estimatedTokens: estimateTokens(tweetRes.content),
              author: tweetRes.author,
              publishedTime: tweetRes.publishedTime,
              siteName: tweetRes.siteName,
            };
            result = await finalizeScrapeResult(baseResult, finalizeOpts);
            if (useSharedCache) setToCache(cacheKey, result, scrapeCacheTtl(result));
            return result;
          }
        }

        const isFastMode = options.mode === 'fast' || options.fastOnly === true;
        // TikTok の動画は、静的な取得では WAF の確認画面しか返らないので、最初からブラウザで開く（ページそのものを求められたときは除く）
        const tiktokVideo = !wantsPage && parseTikTokVideoUrl(url) !== undefined;
        const isForcedBrowser = options.mode === 'browser' || options.renderJs === true || (tiktokVideo && !isFastMode && Boolean(resolveChromiumPath()));

        if (!isForcedBrowser) {
          onProgress?.({ stage: 'fetch', message: 'Fetching via safe HTTP client' });
          let fetched: Awaited<ReturnType<typeof fetchWithSafeRedirects>>;
          try {
            fetched = await fetchWithSafeRedirects(
              url,
              timeoutMs,
              5,
              options.headers,
              options.cookies,
              undefined,
              options.tenantId ?? 'legacy',
            );
          } catch (err: any) {
            // 上限を超える動画・音声のファイルも、読めないファイルとして返す（取得の失敗にしない）
            if (err?.code !== 'RESPONSE_TOO_LARGE' || !MEDIA_CONTENT_TYPE.test(String(err.contentType).toLowerCase())) throw err;
            result = await finalizeScrapeResult(mediaFileResult(err.finalUrl || url, err.contentType, err.contentLength), finalizeOpts);
            if (useSharedCache) setToCache(cacheKey, result, scrapeCacheTtl(result));
            return result;
          }
          const { finalUrl, response } = fetched;

          const contentType = (response.headers.get('Content-Type') || '').toLowerCase();

          if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
            const buf = await readBodyWithLimit(response, MAX_RESPONSE_BODY_BYTES);
            const pdfResult = await parsePdfToMarkdown(buf, finalUrl, maxChars);
            result = await finalizeScrapeResult(pdfResult, finalizeOpts);
            if (useSharedCache) setToCache(cacheKey, result, scrapeCacheTtl(result));
            return result;
          }

          if (MEDIA_CONTENT_TYPE.test(contentType)) {
            await response.body?.cancel().catch(() => {});
            result = markHttpError(await finalizeScrapeResult(mediaFileResult(finalUrl, contentType, response.headers.get('Content-Length')), finalizeOpts), response.status);
            if (useSharedCache) setToCache(cacheKey, result, scrapeCacheTtl(result));
            return result;
          }

          const buf = await readBodyWithLimit(response, MAX_RESPONSE_BODY_BYTES);
          const html = decodeHtmlBuffer(buf, contentType);

          const parsed = convertHtmlToMarkdown(
            html,
            finalUrl,
            maxChars,
            false,
            onlyMainContent,
            options.selectors,
            options.removeSelectors,
            options.stripLinks,
            options.filterLinkDensity,
            options.keepDataImages,
          );

          const bodyOnlyMarkdown = parsed.markdown.replace(/^---[\s\S]*?---\n*/, '').trim();

          const chromePath = resolveChromiumPath();
          const isSpaOrBlank =
            !isFastMode &&
            chromePath &&
            (detectSpaOrBotPage({
              html,
              bodyOnlyMarkdown,
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
            }) || (parsed.quality !== undefined && parsed.quality < 45));
          if (isSpaOrBlank) botUpgradeCount++;

          // Late escalation (spec section 52): recall extraction on the static
          // body can demonstrate answers and skip the browser launch.
          let recallSaved = false;
          if (isSpaOrBlank && options.query) {
            try {
              const decision = shouldEscalateToBrowser({
                spaDetected: true,
                staticMarkdown: bodyOnlyMarkdown,
                query: options.query,
              });
              recallSaved = !decision.escalate;
            } catch { recallSaved = false; }
          }
          if (recallSaved) {
            try { incrementSecurityCounter('sora_browser_recall_saved_total'); } catch {}
          }

          if (!isSpaOrBlank || recallSaved) {
            result = {
              url: finalUrl,
              title: parsed.title,
              content: parsed.markdown,
              contentStatus: parsed.contentStatus,
              isTruncated: parsed.isTruncated,
              contentType: 'text/html',
              source: 'web',
              renderedWithBrowser: false,
              ogImage: parsed.ogImage,
              description: parsed.description,
              publishedTime: parsed.publishedTime,
              author: parsed.author,
              siteName: parsed.siteName,
              twitterHandle: parsed.twitterHandle,
              socialLinks: parsed.socialLinks,
              availability: parsed.availability,
              price: parsed.price,
              priceCurrency: parsed.priceCurrency,
              brand: parsed.brand,
              sku: parsed.sku,
              links: formats.includes('links') ? parsed.links : undefined,
              images: formats.includes('images') ? parsed.images : undefined,
              jsonLd: formats.includes('jsonLd') ? parsed.jsonLd : undefined,
              tables: formats.includes('tables') ? parsed.tables : undefined,
              events: parsed.events,
              breadcrumb: parsed.breadcrumb,
              extracted: parsed.extracted,
              media: parsed.media,
              html: formats.includes('html') ? parsed.html : undefined,
              rawHtml: formats.includes('rawHtml') ? html : undefined,
              estimatedTokens: parsed.estimatedTokens,
              quality: parsed.quality,
              completeness: parsed.completeness,
              pageType: parsed.pageType,
              qualityReasons: parsed.qualityReasons,
              missingFields: parsed.missingFields,
              evidence: parsed.evidence,
            };

            onProgress?.({ stage: 'enrich', message: 'Enriching content with metadata and summaries' });
            result = markHttpError(await finalizeScrapeResult(result, finalizeOpts), response.status);

            if (useSharedCache) setToCache(cacheKey, result, scrapeCacheTtl(result));
            onProgress?.({ stage: 'done', message: 'Scraping completed successfully', data: result });
            return result;
          }

          // ブラウザレンダリングに進む場合でも、初期HTTPで取得できたコンテンツがあれば保持（フォールバック用）
          if (parsed.markdown && parsed.markdown.trim().length >= 50) {
            initialHttpStatus = response.status;
            initialHttpResult = {
              url: finalUrl,
              title: parsed.title,
              content: parsed.markdown,
              contentStatus: parsed.contentStatus,
              isTruncated: parsed.isTruncated,
              contentType: 'text/html',
              source: 'web',
              renderedWithBrowser: false,
              ogImage: parsed.ogImage,
              description: parsed.description,
              publishedTime: parsed.publishedTime,
              author: parsed.author,
              siteName: parsed.siteName,
              twitterHandle: parsed.twitterHandle,
              socialLinks: parsed.socialLinks,
              availability: parsed.availability,
              price: parsed.price,
              priceCurrency: parsed.priceCurrency,
              brand: parsed.brand,
              sku: parsed.sku,
              links: formats.includes('links') ? parsed.links : undefined,
              images: formats.includes('images') ? parsed.images : undefined,
              jsonLd: formats.includes('jsonLd') ? parsed.jsonLd : undefined,
              tables: formats.includes('tables') ? parsed.tables : undefined,
              events: parsed.events,
              breadcrumb: parsed.breadcrumb,
              extracted: parsed.extracted,
              media: parsed.media,
              html: formats.includes('html') ? parsed.html : undefined,
              rawHtml: formats.includes('rawHtml') ? html : undefined,
              estimatedTokens: parsed.estimatedTokens,
              quality: parsed.quality,
              completeness: parsed.completeness,
              pageType: parsed.pageType,
              qualityReasons: parsed.qualityReasons,
              missingFields: parsed.missingFields,
              evidence: parsed.evidence,
            };
          }
        }

        try { incrementSecurityCounter('sora_browser_launch_total'); } catch {}
        onProgress?.({ stage: 'render', message: 'Rendering SPA via Stealth Chromium' });
        const needScreenshot = formats.includes('screenshot');
        const fullPage = options.fullPage ?? true;
        let browserRes: { html: string; title: string; screenshot?: string; finalUrl: string; status?: number };

        try {
          browserRes = await fetchWithStealthBrowser(
            url,
            timeoutMs,
            options.clipSelector,
            options.cookies,
            'networkidle2',
            needScreenshot,
            fullPage,
            options.tenantId ?? 'legacy',
            {
              isContentReady: (html, finalUrl) => {
                const content = convertHtmlToMarkdown(html, finalUrl, maxChars, true, onlyMainContent,
                  options.selectors, options.removeSelectors, options.stripLinks, options.filterLinkDensity, options.keepDataImages);
                return !isRenderStillBlockedOrBlank({
                  html, bodyOnlyMarkdown: content.markdown.replace(/^---[\s\S]*?---\n*/, '').trim(),
                });
              },
              onWait: () => {
                botRetryCount++;
                onProgress?.({ stage: 'render', message: 'Waiting for content on the current browser page' });
              },
            },
          );
        } catch (browserErr) {
          // ブラウザレンダリングがタイムアウト等で失敗した場合、初期HTTPで取得できていたコンテンツがあれば救済
          if (initialHttpResult) {
            onProgress?.({ stage: 'enrich', message: 'Browser timed out; falling back to initial HTTP content' });
            result = markHttpError(await finalizeScrapeResult(initialHttpResult, finalizeOpts), initialHttpStatus);
            if (useSharedCache) setToCache(cacheKey, result, scrapeCacheTtl(result));
            return result;
          }
          throw browserErr;
        }

        // TikTok の動画は、ページの埋め込みデータから説明文と自動字幕を本文にする（403 のときや、データが無いときは、ふつうのページとして読む）
        if (tiktokVideo && !((browserRes.status ?? 0) >= 400)) {
          const page = await getTiktokPage(browserRes.html, url, { title: browserRes.title });
          if (page) {
            result = await finalizeScrapeResult(videoPageResult(url, page, 'TikTok', maxChars), finalizeOpts);
            if (useSharedCache) setToCache(cacheKey, result, scrapeCacheTtl(result));
            return result;
          }
        }

        const parsed = convertHtmlToMarkdown(
          browserRes.html,
          browserRes.finalUrl,
          maxChars,
          true,
          onlyMainContent,
          options.selectors,
          options.removeSelectors,
          options.stripLinks,
          options.filterLinkDensity,
          options.keepDataImages,
        );

        result = {
          url: browserRes.finalUrl,
          title: browserRes.title || parsed.title,
          content: parsed.markdown,
          contentStatus: parsed.contentStatus,
          isTruncated: parsed.isTruncated,
          contentType: 'text/html',
          source: 'web',
          renderedWithBrowser: true,
          ogImage: parsed.ogImage,
          description: parsed.description,
          publishedTime: parsed.publishedTime,
          author: parsed.author,
          siteName: parsed.siteName,
          twitterHandle: parsed.twitterHandle,
          socialLinks: parsed.socialLinks,
          availability: parsed.availability,
          price: parsed.price,
          priceCurrency: parsed.priceCurrency,
          brand: parsed.brand,
          sku: parsed.sku,
          screenshot: formats.includes('screenshot') ? browserRes.screenshot : undefined,
          links: formats.includes('links') ? parsed.links : undefined,
          images: formats.includes('images') ? parsed.images : undefined,
          jsonLd: formats.includes('jsonLd') ? parsed.jsonLd : undefined,
          tables: formats.includes('tables') ? parsed.tables : undefined,
          events: parsed.events,
          breadcrumb: parsed.breadcrumb,
          extracted: parsed.extracted,
          media: parsed.media,
          html: formats.includes('html') ? parsed.html : undefined,
          rawHtml: formats.includes('rawHtml') ? browserRes.html : undefined,
          estimatedTokens: parsed.estimatedTokens,
          quality: parsed.quality,
          completeness: parsed.completeness,
          pageType: parsed.pageType,
          qualityReasons: parsed.qualityReasons,
          missingFields: parsed.missingFields,
          evidence: parsed.evidence,
        };

        onProgress?.({ stage: 'enrich', message: 'Enriching rendered content with metadata and summaries' });
        result = markHttpError(await finalizeScrapeResult(result, finalizeOpts), browserRes.status);
        // TikTok の動画でページのデータが無いのは、確認の画面（"Please wait..."）のままのとき。その文を本文にしない
        if (tiktokVideo && result.contentStatus !== 'unavailable') {
          result = markUnreadable(result, 'TikTok の確認の画面のまま、動画のデータを読めませんでした。時間をおいて再試行してください。');
        }

        if (useSharedCache) setToCache(cacheKey, result, scrapeCacheTtl(result));
        onProgress?.({ stage: 'done', message: 'Scraping completed successfully', data: result });
        return result;
      } catch (err) {
        lastError = err;
        attempt++;
        if (attempt <= retries) {
          const backoff = retryDelayMs * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    throw lastError || new Error(`スクレイピングに失敗しました: ${url}`);
  };
  // Credential-scoped requests must not share in-flight results either.
  if (!useSharedCache) return scrapeTask();
  return runWithSingleFlight(cacheKey, scrapeTask);
}

// ==========================================
// 5. 一括並行スクレイピング (scrapeBatchUrls)
// ==========================================
export async function scrapeBatchUrls(options: {
  urls: string[];
  concurrency?: number;
  maxChars?: number;
  mode?: 'auto' | 'fast' | 'browser';
  formats?: ScrapeFormat[];
  onlyMainContent?: boolean;
  selectors?: Record<string, string>;
  clipSelector?: string;
  fastOnly?: boolean;
  renderJs?: boolean;
  headers?: Record<string, string>;
  cookies?: CookieParam[];
  removeSelectors?: string[];
  stripLinks?: boolean;
  filterLinkDensity?: boolean;
  query?: string;
  extractHighlights?: boolean;
  onlyHighlights?: boolean;
  highlightAlgorithm?: HighlightAlgorithm;
  highlightOverheadTokens?: number;
  highlightMaxCount?: number;
  evidenceMode?: 'full' | 'highlights' | 'contextual_highlights';
  includeDiagnostics?: boolean;
  includeDiscrepancies?: boolean;
  safeNormalize?: boolean;
  reorderUFlat?: boolean;
  diversityWeight?: number;
  annotateTemporal?: boolean;
  minimizeTables?: boolean;
  extractSummary?: boolean;
  extractCitations?: boolean;
  chunkMarkdown?: boolean;
  chunkSize?: number;
  validateLinks?: boolean;
  formatAsPrompt?: boolean;
  highlightMatches?: boolean;
  maskPii?: boolean;
  webhookUrl?: string;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  noCache?: boolean;
  tenantId?: string;
}): Promise<BatchScrapeResult> {
  const { urls, concurrency = 3, ...scrapeOpts } = options;
  const limitWorkers = Math.min(Math.max(concurrency, 1), 5);

  const results: ScrapeResult[] = [];
  const errors: Array<{ url: string; error: string }> = [];

  let index = 0;
  async function worker() {
    while (index < urls.length) {
      const currentIdx = index++;
      const targetUrl = urls[currentIdx];
      try {
        const res = await scrapeUrl({
          url: targetUrl,
          ...scrapeOpts,
        });
        results.push(res);
      } catch (e) {
        errors.push({ url: targetUrl, error: errorMessage(e) || 'Unknown error' });
      }
    }
  }

  const workers = Array.from({ length: Math.min(limitWorkers, urls.length) }, () => worker());
  await Promise.all(workers);

  const batchResult: BatchScrapeResult = {
    total: urls.length,
    successful: results.length,
    failed: errors.length,
    results,
    errors,
  };

  if (options.webhookUrl) {
    sendWebhookNotification(options.webhookUrl, batchResult);
  }

  return batchResult;
}

// ==========================================
// 6. sitemap.xml の探索 & 再帰パース
// ==========================================
export async function fetchSitemapEntries(
  sitemapUrl: string,
  limit = 200,
  maxDepth = 2,
  currentDepth = 0,
): Promise<SitemapEntry[]> {
  if (currentDepth > maxDepth || limit <= 0) return [];

  try {
    const { response } = await fetchWithSafeRedirects(sitemapUrl, 10000);
    if (!response.ok) return [];

    const xml = await response.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    const parsed = parser.parse(xml);

    const entries: SitemapEntry[] = [];

    if (parsed.urlset?.url) {
      const urlList = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
      for (const item of urlList) {
        if (item.loc) {
          entries.push({
            url: String(item.loc).trim(),
            lastmod: item.lastmod ? String(item.lastmod).trim() : undefined,
          });
          if (entries.length >= limit) return entries;
        }
      }
    }

    if (parsed.sitemapindex?.sitemap && currentDepth < maxDepth) {
      const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
        ? parsed.sitemapindex.sitemap
        : [parsed.sitemapindex.sitemap];

      for (const sm of sitemaps) {
        if (sm.loc) {
          const subEntries = await fetchSitemapEntries(
            String(sm.loc).trim(),
            limit - entries.length,
            maxDepth,
            currentDepth + 1,
          );
          entries.push(...subEntries);
          if (entries.length >= limit) return entries.slice(0, limit);
        }
      }
    }

    return entries;
  } catch {
    return [];
  }
}

// ==========================================
// 7. サイトマップ探索 (mapSiteUrl)
// ==========================================
export function filterSitemapEntriesByDate<T extends { lastmod?: string }>(entries: T[], since?: string, until?: string): T[] {
  const sinceTime = since ? new Date(since).getTime() : NaN;
  const untilTime = until ? new Date(until).getTime() : NaN;
  return entries.filter((e) => {
    if (!e.lastmod) return true;
    const t = new Date(e.lastmod).getTime();
    if (!Number.isNaN(sinceTime) && t < sinceTime) return false;
    if (!Number.isNaN(untilTime) && t > untilTime) return false;
    return true;
  });
}

/** 同一サイト判定用のホストキー。`www.` の有無だけが違うホストは同じサイトとして扱う。 */
function siteKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * リンクのホストが、基準サイト群（siteKey 済み）のどれかに属するか。
 * includeSubdomains 時はサブドメインも含める。'evilexample.com' を 'example.com' の一部とみなさないよう、ドット区切りで比較する。
 */
export function isHostInSites(linkHost: string, sites: Iterable<string>, includeSubdomains = false): boolean {
  const host = linkHost.toLowerCase();
  for (const site of sites) {
    if (includeSubdomains) {
      if (host === site || host.endsWith('.' + site)) return true;
    } else if (siteKey(host) === site) {
      return true;
    }
  }
  return false;
}

export async function mapSiteUrl(options: {
  url: string;
  limit?: number;
  includeSubdomains?: boolean;
  since?: string;
  until?: string;
  timeoutMs?: number;
  noCache?: boolean;
}): Promise<{
  url: string;
  links: string[];
  count: number;
  source: 'sitemap' | 'links';
  cached?: boolean;
}> {
  const url = options.url;
  const limit = Math.min(options.limit ?? 200, 1000);
  const cacheKey = `map:${url}:${limit}:${options.includeSubdomains || false}:${options.since || ''}:${options.until || ''}`;

  if (!options.noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return cached;
  }

  const parsedUrl = new URL(url);
  const origin = parsedUrl.origin;

  const candidateSitemaps = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap/sitemap.xml`,
  ];

  try {
    const robotsRes = await fetchWithSafeRedirects(`${origin}/robots.txt`, 5000);
    if (robotsRes.response.ok) {
      const robotsText = await robotsRes.response.text();
      const sitemapMatches = robotsText.match(/^Sitemap:\s*(https?:\/\/[^\r\n]+)/gim);
      if (sitemapMatches) {
        for (const match of sitemapMatches) {
          const smUrl = match.replace(/^Sitemap:\s*/i, '').trim();
          if (!candidateSitemaps.includes(smUrl)) {
            candidateSitemaps.unshift(smUrl);
          }
        }
      }
    }
  } catch {}

  for (const sitemapUrl of candidateSitemaps) {
    const entries = await fetchSitemapEntries(sitemapUrl, limit);
    if (entries.length > 0) {
      const filteredEntries = filterSitemapEntriesByDate(entries, options.since, options.until);
      const links = filteredEntries.map((e) => e.url);
      const result = {
        url,
        links,
        count: links.length,
        source: 'sitemap' as const,
      };
      if (!options.noCache) setToCache(cacheKey, result);
      return result;
    }
  }

  const scraped = await scrapeUrl({
    url,
    maxChars: 5000,
    formats: ['links'],
    noCache: options.noCache,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  // 指定 URL のホストに加え、リダイレクト後のホスト（example.com → www.example.com など）も同じサイトとして扱う
  const baseSites = new Set<string>([siteKey(parsedUrl.hostname)]);
  try {
    baseSites.add(siteKey(new URL(scraped.url).hostname));
  } catch {}
  const internalLinks = (scraped.links || []).filter((link) => {
    try {
      return isHostInSites(new URL(link).hostname, baseSites, options.includeSubdomains);
    } catch {
      return false;
    }
  });

  const result = {
    url,
    links: internalLinks.slice(0, limit),
    count: Math.min(internalLinks.length, limit),
    source: 'links' as const,
  };

  if (!options.noCache) setToCache(cacheKey, result);
  return result;
}

// ==========================================
// 8. 再帰クロール (crawlSiteUrl)
// ==========================================
export async function crawlSiteUrl(options: {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  maxChars?: number;
  timeoutMs?: number;
  concurrency?: number;
  onlyMainContent?: boolean;
  formats?: ScrapeFormat[];
  includePatterns?: string[];
  excludePatterns?: string[];
  query?: string;
  extractHighlights?: boolean;
  onlyHighlights?: boolean;
  highlightAlgorithm?: HighlightAlgorithm;
  highlightOverheadTokens?: number;
  highlightMaxCount?: number;
  reorderUFlat?: boolean;
  diversityWeight?: number;
  annotateTemporal?: boolean;
  minimizeTables?: boolean;
  noCache?: boolean;
  webhookUrl?: string;
  tenantId?: string;
  onPageScraped?: (page: ScrapeResult) => void;
  onPageCrawled?: (page: ScrapeResult, count: number) => void;
}): Promise<{
  url: string;
  baseUrl: string;
  count: number;
  totalPages: number;
  pages: ScrapeResult[];
}> {
  const {
    url: initialUrl,
    maxPages = 10,
    maxDepth = 2,
    maxChars = 15000,
    formats = ['markdown'],
    includePatterns,
    excludePatterns,
    query,
    extractHighlights,
    onlyHighlights,
    highlightAlgorithm,
    highlightOverheadTokens,
    highlightMaxCount,
    reorderUFlat,
    diversityWeight,
    annotateTemporal,
    minimizeTables,
    noCache,
    webhookUrl,
    onPageScraped,
    onPageCrawled,
  } = options;

  const targetLimit = Number.isFinite(maxPages) ? Math.max(0, Math.min(Math.floor(maxPages), 50)) : 10;
  // 並行度は OpenAPI（CrawlRequestSchema）の記載どおり 1〜10、既定 3。
  const workers = Number.isFinite(options.concurrency) ? Math.max(1, Math.min(Math.floor(options.concurrency as number), 10)) : 3;

  // 同一サイトの判定に使うホスト。起点のホストに加え、起点がリダイレクトされた先のホスト
  // （example.com → www.example.com など）も同じサイトとして扱う。後者は起点の取得後に足す。
  const sites = new Set<string>([siteKey(new URL(initialUrl).hostname)]);

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: initialUrl, depth: 0 }];
  let pages: ScrapeResult[] = [];
  let seedError: unknown;

  const visitKey = (u: string) => u.split('#')[0].replace(/\/+$/, '');
  /** include/exclude は、リンクをたどって見つけた URL にだけ適用する。起点 URL は常に取得する。 */
  const passesPatterns = (item: { url: string; depth: number }): boolean => {
    if (item.depth === 0) return true;
    if (excludePatterns && excludePatterns.length > 0 && matchUrlPattern(item.url, excludePatterns)) return false;
    if (includePatterns && includePatterns.length > 0 && !matchUrlPattern(item.url, includePatterns)) return false;
    return true;
  };

  while (queue.length > 0 && pages.length < targetLimit) {
    // 幅優先の順序を保ったまま、残りページ枠を超えない範囲で最大 workers 件ずつ並行取得する
    const batch: Array<{ url: string; depth: number }> = [];
    const room = Math.min(workers, targetLimit - pages.length);
    while (batch.length < room && queue.length > 0) {
      const item = queue.shift()!;
      const key = visitKey(item.url);
      if (visited.has(key)) continue;
      visited.add(key);
      if (!passesPatterns(item)) continue;
      batch.push(item);
    }
    if (batch.length === 0) break;

    const settled = await Promise.all(
      batch.map(async (item) => {
        try {
          const scraped = await scrapeUrl({
            url: item.url,
            tenantId: (options as any).tenantId ?? 'legacy',
            maxChars,
            formats: Array.from(new Set([...formats, 'links'])),
            query,
            extractHighlights,
            onlyHighlights,
            highlightAlgorithm,
            highlightOverheadTokens,
            highlightMaxCount,
            reorderUFlat,
            diversityWeight,
            annotateTemporal,
            minimizeTables,
            noCache,
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.onlyMainContent !== undefined ? { onlyMainContent: options.onlyMainContent } : {}),
          });
          return { item, scraped };
        } catch (error) {
          return { item, error };
        }
      }),
    );

    for (const r of settled) {
      if (pages.length >= targetLimit) break;
      if ('error' in r) {
        if (r.item.depth === 0) seedError = r.error;
        continue;
      }
      const { item, scraped } = r;
      pages.push(scraped);
      try {
        if (onPageCrawled) onPageCrawled(scraped, pages.length);
        if (onPageScraped) onPageScraped(scraped);
      } catch {}

      if (item.depth === 0) {
        try {
          sites.add(siteKey(new URL(scraped.url).hostname));
        } catch {}
      }
      if (item.depth < maxDepth && scraped.links) {
        for (const link of scraped.links) {
          try {
            if (isHostInSites(new URL(link).hostname, sites) && !visited.has(visitKey(link))) {
              queue.push({ url: link, depth: item.depth + 1 });
            }
          } catch {}
        }
      }
    }
  }

  // 起点そのものが取得できなかった（SSRF 遮断・接続失敗など）場合は、0 件の成功として返さずエラーを伝える
  if (pages.length === 0 && seedError !== undefined) throw seedError;

  if (reorderUFlat && pages.length > 2) {
    pages = reorderLostInTheMiddle(pages);
  }

  const result = {
    url: initialUrl,
    baseUrl: initialUrl,
    count: pages.length,
    totalPages: pages.length,
    pages,
  };

  if (webhookUrl) {
    sendWebhookNotification(webhookUrl, result);
  }

  return result;
}

// ==========================================
// 9. リアルタイムトレンド取得 (fetchRealtimeTrends)
// ==========================================
const DEFAULT_TREND_LIMIT = 20;
const MAX_TREND_LIMIT = 50;

interface RealtimeTrends {
  source: 'x';
  type: 'trend';
  count: number;
  items: { rank: number; keyword: string; tweetCount?: string; url: string }[];
  timestamp: string;
}

/** 件数の指定を 1〜50 に収める。数として読めない・1 未満（0 や負数）は既定の 20 件。 */
export function resolveTrendLimit(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TREND_LIMIT;
  return Math.min(n, MAX_TREND_LIMIT);
}

export async function fetchRealtimeTrends(limit: number = DEFAULT_TREND_LIMIT): Promise<RealtimeTrends> {
  const take = resolveTrendLimit(limit);
  // キャッシュには件数で切る前の全件を入れ、返すときに切る。切った後を入れると、少ない件数で呼ばれた直後は多い件数を返せない
  const cacheKey = 'trends:realtime:v2';
  const cached = getFromCache<RealtimeTrends>(cacheKey);
  if (cached) return { ...cached, count: Math.min(cached.items.length, take), items: cached.items.slice(0, take) };

  const res = await fetchWithSafeRedirects('https://search.yahoo.co.jp/realtime', 10000);
  if (!res?.response.ok) {
    throw new Error('Yahoo リアルタイムトレンドの取得に失敗しました');
  }

  const html = await res.response.text();
  const $ = cheerio.load(html);
  const items: { rank: number; keyword: string; tweetCount?: string; url: string }[] = [];

  $('section, div').each((_, section) => {
    $(section).find('a[href*="/realtime/search"]').each((_, el) => {
      const link = $(el);
      const text = link.text().trim();
      const href = link.attr('href') || '';
      if (!text || text.length > 50) return;
      if (items.some((i) => i.keyword === text)) return;

      const rankMatch = link.closest('li, div').text().match(/^(\d+)/);
      const rank = rankMatch ? parseInt(rankMatch[1], 10) : items.length + 1;
      items.push({
        rank,
        keyword: text,
        url: href.startsWith('http') ? href : `https://search.yahoo.co.jp${href}`,
      });
    });
  });

  const result: RealtimeTrends = {
    source: 'x',
    type: 'trend',
    count: items.length,
    items,
    timestamp: new Date().toISOString(),
  };

  setToCache(cacheKey, result, CACHE_TTL_TREND);
  return { ...result, count: Math.min(items.length, take), items: items.slice(0, take) };
}

// ==========================================
// 10. Firecrawl / Tavily 互換 統合深層検索 (integratedSearch)
// ==========================================

/** Selection reason for observability (RFC selection reasons). */
export type SelectionReason =
  | 'provider_top_rank'
  | 'rrf_top_rank'
  | 'missing_requirement'
  | 'source_diversity'
  | 'official_source'
  | 'scrape_refill';

/** P1-4: Scrape対象選択 (上位3件はRRF/provider順保証 + 残りはcoverage/diversity) */
export function selectScrapeTargets(pool: any[], limit: number, query: string, rankKind: SelectionReason = 'provider_top_rank'): { targets: any[]; spares: any[] } {
  if (!pool || pool.length === 0 || limit <= 0) return { targets: [], spares: [] };
  if (pool.length <= limit || limit < 5) {
    return { targets: pool.slice(0, limit).map((it: any) => ({ ...it, selectionReason: rankKind as SelectionReason })), spares: pool.slice(limit) };
  }
  const guaranteed = pool.slice(0, 3).map((it: any) => ({ ...it, selectionReason: rankKind as SelectionReason }));
  const rest = pool.slice(3);
  const needed = limit - guaranteed.length;
  if (needed <= 0) {
    return { targets: guaranteed.slice(0, limit), spares: pool.slice(limit) };
  }
  try {
    const requirements = extractQueryRequirements(query);
    const requiredTerms = [...requirements.entityTerms, ...requirements.intentTerms];
    const guaranteedCorpus = guaranteed
      .map((it: any) => `${it.title || ''} \n ${it.snippet || it.description || ''}`.toLowerCase())
      .join('\n');
    const missingTerms = requiredTerms.filter((w) => !guaranteedCorpus.includes(w));
    const guaranteedHosts = new Set<string>();
    const guaranteedHostCounts = new Map<string, number>();
    for (const it of guaranteed) {
      try {
        const h = new URL((it as any).url || (it as any).link).hostname.toLowerCase();
        if (!h) continue;
        guaranteedHosts.add(h);
        guaranteedHostCounts.set(h, (guaranteedHostCounts.get(h) ?? 0) + 1);
      } catch {}
    }
    const scoredRest = rest.map((it: any, idx: number) => {
      const text = `${it.title || ''} \n ${it.snippet || it.description || ''}`.toLowerCase();
      let gain = 0;
      // lexical (diagnostic) をベースにし、順位を大きく崩さない
      gain += typeof it.lexicalScore === 'number' ? it.lexicalScore * 0.1 : 0;
      // RRF上位の寄与を残す (元の順位が上の候補を優遇)
      gain += (rest.length - idx) * 0.01;
      // 不足要求語の補完
      for (const t of missingTerms) {
        if (text.includes(t)) gain += 2.0;
      }
      try { const ab = computeAnswerability(it, query); gain += Math.min(1.0, ab.score * 0.25); } catch {}
      // 多様性: 新規ホスト優遇、同一ホスト飽和には軽い減点
      try {
        const h = new URL(it.url || it.link).hostname.toLowerCase();
        if (!h) {} else if (!guaranteedHosts.has(h)) gain += 1.0;
        else gain -= 0.5 * (guaranteedHostCounts.get(h) ?? 1);
      } catch {
        // ホスト不明時は加算なし
      }
      return { it, gain, idx };
    });
    scoredRest.sort((a, b) => {
      if (b.gain !== a.gain) return b.gain - a.gain;
      return a.idx - b.idx;
    });
    const picked = scoredRest.slice(0, needed).map((s) => {
      const coversMissing = missingTerms.some((t) => `${s.it.title || ''} ${s.it.snippet || s.it.description || ''}`.toLowerCase().includes(t));
      return { ...s.it, selectionReason: (coversMissing ? 'missing_requirement' : 'source_diversity') as SelectionReason };
    });
    const pickedSet = new Set(picked);
    const unpicked = rest.filter((it) => !pickedSet.has(it));
    return { targets: [...guaranteed, ...picked], spares: unpicked };
  } catch {
    return { targets: pool.slice(0, limit).map((it: any) => ({ ...it, selectionReason: rankKind as SelectionReason })), spares: pool.slice(limit) };
  }
}

/** RFC P0-WEB-03: usable scrape = full content, not snippet fallback. */
export function isUsableScrape(item: any): boolean {
  if (!item || item.scrapeError) return false;
  if (item.isSnippetFallback) return false;
  if (item.contentStatus === 'metadata_only' || item.contentStatus === 'unavailable') return false;
  const md = item.markdown || '';
  return typeof md === 'string' && md.length >= 50 && hasMeaningfulPageContent(md);
}

/** P1-3: Evidence充足判定 (adaptive scrape用) */
export function assessEvidenceSufficiency(items: any[], query: string): { sufficient: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!items || items.length === 0) return { sufficient: false, reasons: ['empty'] };
  const success = items.filter((it: any) => !it?.scrapeError && (it?.markdown || it?.highlights || it?.highlightItems));
  if (success.length < Math.min(3, items.length)) {
    reasons.push('few-success');
  }
  try {
    const words = query.toLowerCase().trim().split(/[\s　]+/).map((w) => w.trim()).filter((w) => w.length >= 2);
    if (words.length >= 2) {
      const corpus = success
        .map((it: any) => {
          const hl = Array.isArray(it?.highlights) ? it.highlights.join('\n') : '';
          return `${it.title || ''} \n ${it.markdown || ''} \n ${hl}`.toLowerCase();
        })
        .join('\n');
      const missing = words.filter((w) => !corpus.includes(w));
      if (missing.length > 0) reasons.push(`missing-evidence:${missing.join(',')}`);
    }
  } catch {
    // 判定失敗時は不足扱いにしない
  }
  // spec section 43: answer-seeking queries stop on answers, not mentions.
  try {
    const answerWords = query.toLowerCase().trim().split(/[\s　]+/).map((w) => w.trim()).filter((w) => w.length >= 2);
    const wantsAnswer = answerWords.some((w) => (kindsForFacet(w) || []).length > 0);
    if (wantsAnswer && answerWords.length > 0 && success.length > 0) {
      const blocks = success.map((it: any) => {
        const hl = Array.isArray(it?.highlights) ? it.highlights.join('\n') : '';
        return `${it.title || ''}\n${it.markdown || ''}\n${hl}`;
      });
      const coverage = computeEvidenceCoverage(blocks, entityTermsForQuery(query), answerWords);
      if (coverage.answerCoverage < 0.5) reasons.push(`missing-answer:${coverage.answerCoverage.toFixed(2)}`);
    }
  } catch {
    // 判定失敗時は不足扱いにしない
  }
  return { sufficient: reasons.length === 0, reasons };
}
/**
 * 本文取得の既定の打ち切り上限。0 = 無効（既定）。
 * ponytail: 低速だが本文のあるページ（SPA 等は 9〜10s かかる）を落とすため opt-in。
 * 有効化の根拠は「修正後の」本文取得時間の実測が揃ってから決める。
 */
const DEFAULT_SCRAPE_DEADLINE_MS = 0;
/** 半数のページが揃ってから残りを待つ猶予。 */
const SCRAPE_DEADLINE_GRACE_MS = 5_000;

type IntegratedSearchOptions = Parameters<typeof integratedSearch>[0];

/**
 * integratedSearch の結果の中身を変えない項目。ここに無い項目はすべてキャッシュキーに入れる。
 * IntegratedSearchOptions に項目を足すと、キーに入れるかここに挙げるかを決めるまで型エラーになる。
 */
type IntegratedSearchKeyIgnored =
  | 'query' // キーの先頭に別に置く
  | 'noCache'
  | 'tenantId' // 公開情報の検索なので、テナントをまたいで共有する
  | 'scrapeDeadlineMs'; // 締切で欠けた結果は保存しないので、保存される結果は締切の値に依らない

export async function integratedSearch(options: {
  query: string;
  limit?: number;
  scrapeContent?: boolean;
  includeRealtime?: boolean;
  realtimeSort?: 'recent' | 'popular';
  realtimeFocus?: RealtimeFocus;
  /** X 検索で守る固有名詞（呼び出し側が分かる場合） */
  realtimeAnchor?: string;
  realtimeLimit?: number;
  officialAccountId?: string;
  maxChars?: number;
  noCache?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: 'all' | 'day' | 'week' | 'year';
  extractHighlights?: boolean;
  onlyMainContent?: boolean;
  formats?: ScrapeFormat[];
  dedup?: boolean;
  verbose?: boolean;
  reorderUFlat?: boolean;
  enablePrf?: boolean;
  diversityWeight?: number;
  annotateTemporal?: boolean;
  minimizeTables?: boolean;
  highlightAlgorithm?: HighlightAlgorithm;
  highlightOverheadTokens?: number;
  highlightMaxCount?: number;
  adaptiveScrape?: boolean;
  scrapeBudget?: number;
  /** 本文取得の締切 (ms)。半数が終わったら SCRAPE_DEADLINE_GRACE_MS だけ待ち、全体では本値で打ち切る。0 で無効。 */
  scrapeDeadlineMs?: number;
  /** Yahoo の動画検索の上位の YouTube 動画を、字幕から何本読んで results に足すか（0〜5。既定 0 で、動画は検索しない）。 */
  videos?: number;
  tenantId?: string;
}): Promise<Record<string, any>> {
  const query = options.query;
  // 検索語に URL があれば、検索せずにその URL を読む（URL を検索語にすると、Web・X・動画のどの検索でも関係ない結果になる）。
  // URL 以外の語は、ハイライトの選択と十分さの判定に使う
  const { urls: queryUrls, text: queryText } = splitQueryUrls(query);
  const readQueryUrls = queryUrls.length > 0;
  const evidenceQuery = readQueryUrls ? queryText : query;
  const limit = Math.min(options.limit ?? 5, 20);
  const scrapeContent = options.scrapeContent !== false;
  const includeRealtime = !readQueryUrls && options.includeRealtime !== false;
  const realtimeSort = options.realtimeSort || 'recent';
  const realtimeFocus: RealtimeFocus = options.realtimeFocus ?? detectRealtimeFocus(query);
  const realtimeAnchor = options.realtimeAnchor?.trim() || undefined;
  const realtimeLimit = options.realtimeLimit ?? DEFAULT_REALTIME_ITEM_CAP;
  const officialAccountId = options.officialAccountId?.trim()?.replace(/^@/, '');
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const noCache = options.noCache ?? false;
  const includeDomains = normalizeDomainList(options.includeDomains);
  const excludeDomains = normalizeDomainList(options.excludeDomains);
  const updated = options.updated;
  const extractHighlights = options.extractHighlights ?? Boolean(evidenceQuery.trim());
  const onlyMainContent = options.onlyMainContent !== false;
  const formats = options.formats ?? ['markdown'];
  const dedup = options.dedup ?? false;
  const reorderUFlat = options.reorderUFlat ?? false;
  const enablePrf = !readQueryUrls && (options.enablePrf ?? false);
  const diversityWeight = options.diversityWeight;
  const annotateTemporal = options.annotateTemporal;
  const minimizeTables = options.minimizeTables;
  const highlightAlgorithm = options.highlightAlgorithm || 'rho-select-v2';
  const highlightOverheadTokens = options.highlightOverheadTokens ?? 96;
  const highlightMaxCount = options.highlightMaxCount;
  const xSourceIsolation = process.env.SORA_X_SOURCE_ISOLATION === 'true';
  const webQueryUnion = process.env.SORA_WEB_QUERY_UNION === 'true';
  const adaptiveScrape = options.adaptiveScrape ?? false;
  const scrapeBudget = Math.min(Math.max(options.scrapeBudget ?? 8, limit), 20);
  const videos = isModuleActive('youtube') && !readQueryUrls ? Math.min(Math.max(Math.floor(options.videos ?? 0), 0), 5) : 0;
  const requestTenantId = options.tenantId ?? 'legacy';
  // 題名は検索結果のものを使う。ただし検索語の URL と YouTube の動画は、読んだページの題名にする
  // （Yahoo は YouTube の題名を英語に訳して返すことがある。2026-10-26 に確認）
  const pageTitle = (scrape: ScrapeResult) => (scrape.title && (readQueryUrls || scrape.media?.type === 'youtube') ? { title: scrape.title } : {});
  const digest = cacheKeyDigest<IntegratedSearchOptions, IntegratedSearchKeyIgnored>({
    limit,
    scrapeContent,
    includeRealtime,
    realtimeSort,
    realtimeFocus,
    realtimeAnchor: realtimeAnchor ?? 'auto',
    realtimeLimit,
    officialAccountId: officialAccountId || 'none',
    maxChars,
    includeDomains: includeDomains ?? [],
    excludeDomains: excludeDomains ?? [],
    updated: updated ?? 'all',
    extractHighlights,
    onlyMainContent,
    formats: formats.slice().sort(),
    dedup,
    verbose: options.verbose === true,
    reorderUFlat,
    enablePrf,
    diversityWeight: diversityWeight ?? 'default',
    annotateTemporal: annotateTemporal === true,
    minimizeTables: minimizeTables !== false,
    highlightAlgorithm,
    highlightOverheadTokens,
    highlightMaxCount: highlightMaxCount ?? 'auto',
    adaptiveScrape,
    scrapeBudget,
    videos,
  });
  const cacheKey = `search:integrated:v10:${query}:${digest}:${xSourceIsolation ? 'xiso-on' : 'xiso-off'}:${webQueryUnion ? 'wqu-on' : 'wqu-off'}:${process.env.SORA_REALTIME_ANCHOR === 'off' ? 'rta-off' : 'rta-on'}`;
  if (!noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return cached;
  }

  const webSearchPromise = readQueryUrls
    ? Promise.resolve({ items: queryUrls.slice(0, limit).map((url) => ({ title: url, url, source: 'web' })) })
    : searchYahooWeb({ query, includeDomains, excludeDomains, updated, noCache });
  // 動画（videos）は Web 検索と並行して探し、字幕を読む（Web のページを読む間に終わる。実測 0.6〜2.3 秒）。
  // 字幕を読めるのは YouTube だけなので YouTube に絞り、期間（updated）も Web 検索と同じにする
  const videoResultsPromise: Promise<Record<string, any>[]> = videos > 0 && scrapeContent
    ? searchYahooVideo({ query, limit: 10, platform: 'youtube', ...(updated && updated !== 'all' ? { updated } : {}) })
        .then(async (found: any) => {
          const seen = new Set<string>();
          const picked = (Array.isArray(found?.items) ? found.items : []).filter((item: any) => {
            const id = typeof item?.url === 'string' ? parseYouTubeUrl(item.url)?.videoId : undefined;
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
          }).slice(0, videos);
          const read = await Promise.all(picked.map(async (item: any) => {
            const scrape = await scrapeUrl({
              url: item.url, tenantId: requestTenantId, contextTitle: item.title, snippet: item.summary, maxChars, timeoutMs: 12000,
              query, extractHighlights, onlyMainContent, formats, reorderUFlat, diversityWeight, annotateTemporal, minimizeTables,
              highlightAlgorithm, highlightOverheadTokens, highlightMaxCount,
            }).catch(() => null);
            // 取得できなかった動画は根拠に入れない（字幕の無い動画は、説明文だけの結果として入れる）
            if (!scrape || scrape.contentStatus === 'unavailable') return null;
            return {
              title: scrape.title, url: item.url, snippet: item.summary, source: 'youtube',
              description: scrape.description, publishedTime: scrape.publishedTime, author: scrape.author, siteName: scrape.siteName,
              highlights: scrape.highlights, highlightItems: scrape.highlightItems, highlightDiagnostics: scrape.highlightDiagnostics,
              temporalAnchors: scrape.temporalAnchors, cached: scrape.cached, ...(scrape.isTruncated ? { isTruncated: true } : {}),
              ...projectRequestedScrapeFormats(scrape, formats, { minMarkdownChars: 50 }),
            };
          }));
          return read.filter((r): r is NonNullable<typeof r> => r !== null);
        })
        .catch(() => [])
    : Promise.resolve([]);
  // 公式アカウントの投稿は、公式枠（先頭5件）と X 検索の別名検出（20件）で1回の取得を共有する
  const officialPostsByHandle = new Map<string, Promise<any[]>>();
  const fetchOfficialPosts = (handle: string): Promise<any[]> => {
    let posts = officialPostsByHandle.get(handle);
    if (!posts) {
      posts = searchYahooRealtime({ accountId: handle, limit: 20, sort: 'recent', detailEnrichment: false })
        .then((r) => r.items)
        .catch(() => []);
      officialPostsByHandle.set(handle, posts);
    }
    return posts;
  };
  const webItemsForAnchor = () =>
    webSearchPromise.then((r: any) => (Array.isArray(r?.items) ? r.items : [])).catch(() => []);
  let anchorOfficialHandle: string | undefined;
  const realtimeSearchPromise = includeRealtime
    ? searchYahooRealtime({
        query,
        sort: realtimeSort,
        detailEnrichment: false,
        focus: realtimeFocus,
        ...(realtimeAnchor ? { anchor: realtimeAnchor } : {}),
        maxItems: realtimeLimit,
        // 上限を既定より上げた時は、取得（Yahoo の1回の最大は40件）も増やす
        ...(realtimeLimit > DEFAULT_REALTIME_ITEM_CAP ? { limit: Math.min(realtimeLimit, 40) } : {}),
        anchorHints: {
          webTitles: async () => (await webItemsForAnchor()).map((i: any) => String(i?.title || '')),
          officialPosts: async (anchor) => {
            const handle = officialAccountId || await findOfficialXHandle(anchor, await webItemsForAnchor());
            anchorOfficialHandle = handle;
            return handle ? fetchOfficialPosts(handle) : [];
          },
        },
      }).catch(() => null)
    : Promise.resolve(null);
  const webParsedRes = await webSearchPromise;

  let searchResults = Array.isArray(webParsedRes?.items)
    ? webParsedRes.items
    : Array.isArray(webParsedRes)
    ? webParsedRes
    : [];

  if (dedup && searchResults.length > 0) {
    searchResults = dedupSearchResults(searchResults, (i: any) => `${i.title || ''} ${i.snippet || ''}`);
  }

  // P2: PRF retrieval (opt-in, retrieval-only, final eval binds to original query)
  if (enablePrf && searchResults.length > 0) {
    try {
      const topDocs = searchResults.slice(0, 3).map((i: any) => `${i.title || ""} ${i.snippet || i.description || ""}`);
      const allDocs = searchResults.slice(0, 10).map((i: any) => `${i.title || ""} ${i.snippet || i.description || ""}`);
      const prfQ = expandQueryWithPseudoRelevanceFeedback(query, topDocs, allDocs);
      if (prfQ.expansionTerms.length > 0) {
        const prfQuery = `${query} ${prfQ.expansionTerms.slice(0, 2).join(" ")}`.slice(0, 380);
        if (prfQuery !== query) {
          const prfRes = await searchYahooWeb({ query: prfQuery, includeDomains, excludeDomains, updated, disableFallback: true, noCache }).catch(() => null);
          const prfItems = Array.isArray(prfRes?.items) ? prfRes.items : [];
          if (prfItems.length > 0) {
            const seen = new Set(searchResults.map((it: any) => it.url || it.link));
            for (const it of prfItems) {
              const key = it.url || it.link;
              if (!key || seen.has(key)) continue;
              seen.add(key);
              searchResults.push({ ...it, retrievalQuery: prfQuery, prfRetrieval: true });
            }
          }
        }
      }
    } catch {}
  }

  // P0-3 + P1-4: 候補プール確保とScrape対象選択
  // 上位3件はRRF/provider順保証、残り枠はcoverage/diversityで選択する
  const candidatePoolSize = adaptiveScrape ? Math.max(scrapeBudget, limit * 2, 10) : Math.max(limit * 2, 10);
  const candidatePool = searchResults.slice(0, candidatePoolSize);
  const selected = selectScrapeTargets(candidatePool, limit, query, webParsedRes?.queryUnion || webParsedRes?.adaptiveUnion ? 'rrf_top_rank' : 'provider_top_rank');
  const topItems = selected.targets;
  const sparePool = selected.spares;
  const xRetrievalPlan = xSourceIsolation ? buildXRetrievalPlan(topItems, 2) : [];
  const xPlanByIndex = new Map<number, (typeof xRetrievalPlan)[number]>();
  for (const plan of xRetrievalPlan) {
    for (const index of plan.itemIndexes) xPlanByIndex.set(index, plan);
  }
  const xRetrievalCache = new Map<string, Promise<any>>();

  // 擬似適合フィードバック (PRF) によるクエリ拡張
  let effectiveQuery = evidenceQuery;
  let prfInfo: { expandedQuery: string; expansionTerms: string[] } | null = null;
  if (enablePrf && searchResults.length > 0) {
    const topDocs = topItems.map((i: any) => `${i.title || ''} ${i.snippet || ''}`);
    const allDocs = searchResults.map((i: any) => `${i.title || ''} ${i.snippet || ''}`);
    const prfResult = expandQueryWithPseudoRelevanceFeedback(query, topDocs, allDocs);
    if (prfResult.expansionTerms.length > 0) {
      prfInfo = prfResult;
      effectiveQuery = prfResult.expandedQuery;
    }
  }

  // 公式Xアカウントの特定 (明示指定 or Web検索結果URLからの自動抽出)
  let targetOfficialHandle = officialAccountId;
  if (!targetOfficialHandle && searchResults.length > 0) {
    targetOfficialHandle = extractOfficialXHandleFromWebResults(searchResults);
  }

  // 公式枠の並行フェッチ（すでに公式IDが判明している場合）
  let officialRealtimePromise: Promise<any> | null = null;
  if (includeRealtime && targetOfficialHandle) {
    officialRealtimePromise = fetchOfficialPosts(targetOfficialHandle);
  }

  const envDeadline = Number(process.env.SORA_SCRAPE_DEADLINE_MS);
  const scrapeDeadlineMs = options.scrapeDeadlineMs ?? (Number.isFinite(envDeadline) && process.env.SORA_SCRAPE_DEADLINE_MS ? envDeadline : DEFAULT_SCRAPE_DEADLINE_MS);
  let scrapeDeadlineHit = false;
  const videoDeadlineAt = Date.now() + scrapeDeadlineMs;
  let enrichedResults = topItems;
  if (scrapeContent) {
    const settled = await settleWithDeadline(
      topItems.map(async (item: any, itemIndex: number) => {
        const itemUrl = item.url || item.link;
        if (!itemUrl) return item;
        const itemSnippet = item.snippet || item.description || '';

        if (xSourceIsolation && !readQueryUrls) {
          const plan = xPlanByIndex.get(itemIndex);
          if (plan) {
            const isolatedBase = stripXWebDiscoveryText(item);

            // 指示書 第13条: Direct X status URL の場合、既知の statusId に対してまず FxTwitter detail 1回を試行
            let directEvidence: any = null;
            if (plan.seed.kind === 'status' && plan.seed.statusId) {
              try {
                const detail = await defaultXDetailProvider.fetchStatus(plan.seed.statusId);
                if (detail?.text) {
                  directEvidence = buildXIsolatedEvidenceFromDirectStatus(plan.seed, detail);
                }
              } catch {}
            }

            let retrievalPromise = xRetrievalCache.get(plan.key);
            if (!directEvidence && !retrievalPromise) {
              retrievalPromise = searchYahooRealtime({
                query,
                ...(plan.seed.handle ? { accountId: plan.seed.handle } : {}),
                sort: 'recent',
                limit: 5,
                disableFallback: true,
                detailEnrichment: false,
              }).catch(() => null);
              xRetrievalCache.set(plan.key, retrievalPromise);
            }

            const realtimeForSeed = directEvidence ? null : await retrievalPromise;
            const isolatedEvidence = directEvidence || buildXIsolatedEvidence(
              plan.seed,
              Array.isArray(realtimeForSeed?.items)
                ? realtimeForSeed.items
                : [],
            );

            const rho =
              isolatedEvidence.eligibleForPrimaryEvidence &&
              isolatedEvidence.markdown
                ? extractQueryHighlightsRhoV2(
                    isolatedEvidence.markdown,
                    query,
                    {
                      overheadTokens: highlightOverheadTokens,
                      highlightMaxCount,
                    },
                  )
                : null;

            const isolatedItem: Record<string, any> = {
              ...isolatedBase,
              source: 'x',
              xSourceIsolation: {
                mode: 'bounded_discovery_seed',
                kind: plan.seed.kind,
                ...(plan.seed.handle
                  ? { handle: plan.seed.handle }
                  : {}),
                ...(plan.seed.statusId
                  ? { statusId: plan.seed.statusId }
                  : {}),
                evidenceRelation: isolatedEvidence.relation,
                exactStatusMatched:
                  isolatedEvidence.exactStatusMatched,
                eligibleForPrimaryEvidence:
                  isolatedEvidence.eligibleForPrimaryEvidence,
                webSnippetUsedAsBody: false,
                retrievedPrimaryCount:
                  isolatedEvidence.selectedItems.length,
                relatedDiagnosticCount:
                  isolatedEvidence.relatedItems.length,
                retrievalKey: plan.key,
              },
              highlights: rho?.highlights,
              highlightItems: rho?.highlightItems,
              highlightDiagnostics: rho?.diagnostics,
            };

            if (
              formats.includes('markdown') &&
              isolatedEvidence.markdown
            ) {
              isolatedItem.markdown = isolatedEvidence.markdown;
            }

            return isolatedItem;
          }
        }

        try {
          const scrape = await scrapeUrl({
            url: itemUrl,
            tenantId: requestTenantId,
            // 検索語の URL には検索結果の題名が無い（X の読み取りは、渡した題名をそのまま題名にする）
            contextTitle: readQueryUrls ? undefined : item.title,
            snippet: itemSnippet,
            maxChars,
            timeoutMs: 12000,
            query: effectiveQuery,
            extractHighlights,
            onlyMainContent,
            formats,
            reorderUFlat,
            diversityWeight,
            annotateTemporal,
            minimizeTables,
            highlightAlgorithm,
            highlightOverheadTokens,
            highlightMaxCount,
          });

          const enrichedItem: Record<string, any> = {
            ...item,
            ...pageTitle(scrape),
            ogImage: scrape.ogImage,
            description: scrape.description,
            publishedTime: scrape.publishedTime,
            author: scrape.author,
            siteName: scrape.siteName,
            twitterHandle: scrape.twitterHandle,
            socialLinks: scrape.socialLinks,
            pageType: scrape.pageType,
            highlights: scrape.highlights,
            highlightItems: scrape.highlightItems,
            highlightDiagnostics: scrape.highlightDiagnostics,
            temporalAnchors: scrape.temporalAnchors,
            textFragmentUrl: scrape.textFragmentUrl,
            cached: scrape.cached,
          };

          if (scrape.isTruncated) {
            enrichedItem.isTruncated = true;
          }
          if (options.verbose) {
            enrichedItem.quality = scrape.quality;
            enrichedItem.completeness = scrape.completeness;
            enrichedItem.evidence = scrape.evidence;
          }

          Object.assign(
            enrichedItem,
            projectRequestedScrapeFormats(scrape, formats, {
              minMarkdownChars: 50,
              markdownFallback: itemSnippet
                ? `# ${item.title || 'Web Search Result'}\n\nURL: ${itemUrl}\n\n${itemSnippet}`
                : undefined,
            }),
          );

          return enrichedItem;
        } catch (e) {
          const fallbackMd = itemSnippet
            ? `# ${item.title || 'Web Search Result'}\n\nURL: ${itemUrl}\n\n${itemSnippet}`
            : undefined;
          return {
            ...item,
            scrapeError: errorMessage(e),
            ...(formats.includes('markdown') && fallbackMd ? { markdown: fallbackMd, isSnippetFallback: true } : {}),
          };
        }
      }),
      { graceMs: SCRAPE_DEADLINE_GRACE_MS, capMs: scrapeDeadlineMs },
      (i) => {
        const item: any = topItems[i];
        const snippet = item?.snippet || item?.description || '';
        return {
          ...item,
          scrapeError: 'scrape_deadline_exceeded',
          deadlineExceeded: true,
          ...(formats.includes('markdown') && snippet
            ? { markdown: `# ${item?.title || 'Web Search Result'}\n\nURL: ${item?.url || item?.link}\n\n${snippet}`, isSnippetFallback: true }
            : {}),
        };
      },
    );
    enrichedResults = settled.values;
    if (settled.lateCount > 0) {
      scrapeDeadlineHit = true;
      incrementSecurityCounter('sora_scrape_deadline_total', settled.lateCount);
    }

    // P0-3: 失敗分補充 (有効結果数が limit 未満かつ予備がある場合のみ1波補充)
    try {
      const isSuccess = (it: any) => isUsableScrape(it);
      let successCount = enrichedResults.filter(isSuccess).length;
      // 締切で打ち切った場合は待ち時間を優先し、補充の逐次取得は行わない（adaptiveScrape の追加取得も同様）
      if (successCount < limit && sparePool.length > 0 && !scrapeDeadlineHit) {
        for (const spare of sparePool) {
          if (successCount >= limit) break;
          const spareItem: any = spare;
          const spareUrl = spareItem?.url || spareItem?.link;
          if (!spareUrl) continue;
          const spareSnippet = spareItem?.snippet || spareItem?.description || '';
          incrementSecurityCounter('sora_scrape_refill_total');
          try {
            const scrape = await scrapeUrl({
              url: spareUrl,
              tenantId: requestTenantId,
              contextTitle: spareItem?.title,
              snippet: spareSnippet,
              maxChars,
              timeoutMs: 12000,
              query: effectiveQuery,
              extractHighlights,
              onlyMainContent,
              formats,
              reorderUFlat,
              diversityWeight,
              annotateTemporal,
              minimizeTables,
              highlightAlgorithm,
              highlightOverheadTokens,
              highlightMaxCount,
            });
            const enrichedSpare: Record<string, any> = {
              ...spareItem,
              ...pageTitle(scrape),
              ogImage: scrape.ogImage,
              description: scrape.description,
              publishedTime: scrape.publishedTime,
              author: scrape.author,
              siteName: scrape.siteName,
              twitterHandle: scrape.twitterHandle,
              socialLinks: scrape.socialLinks,
              pageType: scrape.pageType,
              highlights: scrape.highlights,
              highlightItems: scrape.highlightItems,
              highlightDiagnostics: scrape.highlightDiagnostics,
              temporalAnchors: scrape.temporalAnchors,
              textFragmentUrl: scrape.textFragmentUrl,
              cached: scrape.cached,
            };
            if (scrape.isTruncated) {
              enrichedSpare.isTruncated = true;
            }
            if (options.verbose) {
              enrichedSpare.quality = scrape.quality;
              enrichedSpare.completeness = scrape.completeness;
              enrichedSpare.evidence = scrape.evidence;
            }
            Object.assign(
              enrichedSpare,
              projectRequestedScrapeFormats(scrape, formats, {
                minMarkdownChars: 50,
                markdownFallback: spareSnippet
                  ? `# ${spareItem?.title || 'Web Search Result'}\n\nURL: ${spareUrl}\n\n${spareSnippet}`
                  : undefined,
              }),
            );
            enrichedSpare.selectionReason = 'scrape_refill';
            enrichedResults.push(enrichedSpare);
            if (isUsableScrape(enrichedSpare)) successCount++;
          } catch {
          }
        }
      }
    } catch {
      // 補充失敗時は初回結果をそのまま返す
    }

    // P1-3: adaptive evidence 不足時の追加取得 (opt-in, 最大8件)
    try {
      // 締切で打ち切った場合は、待ち時間の上限を守るため追加取得の波も行わない
      if (adaptiveScrape && scrapeContent && !scrapeDeadlineHit) {
        let ev = assessEvidenceSufficiency(enrichedResults, query);
        if (!ev.sufficient) {
          incrementSecurityCounter('sora_deep_search_wave_total');
          const usedSpares = Math.max(0, enrichedResults.length - topItems.length);
          const remaining = sparePool.slice(usedSpares);
          for (const spare of remaining) {
            if (enrichedResults.length >= scrapeBudget) break;
            const spareItem = spare as any;
            const spareUrl = spareItem?.url || spareItem?.link;
            if (!spareUrl) continue;
            const spareSnippet = spareItem?.snippet || spareItem?.description || '';
            try {
              const scrape = await scrapeUrl({ url: spareUrl, tenantId: requestTenantId, contextTitle: spareItem?.title, snippet: spareSnippet, maxChars, timeoutMs: 12000, query: effectiveQuery, extractHighlights, onlyMainContent, formats, reorderUFlat, diversityWeight, annotateTemporal, minimizeTables, highlightAlgorithm, highlightOverheadTokens, highlightMaxCount });
              const enrichedSpare: Record<string, any> = { ...spareItem, ...pageTitle(scrape), ogImage: scrape.ogImage, description: scrape.description, publishedTime: scrape.publishedTime, author: scrape.author, siteName: scrape.siteName, twitterHandle: scrape.twitterHandle, socialLinks: scrape.socialLinks, pageType: scrape.pageType, highlights: scrape.highlights, highlightItems: scrape.highlightItems, highlightDiagnostics: scrape.highlightDiagnostics, temporalAnchors: scrape.temporalAnchors, textFragmentUrl: scrape.textFragmentUrl, cached: scrape.cached };
              Object.assign(enrichedSpare, projectRequestedScrapeFormats(scrape, formats, { minMarkdownChars: 50 }));
              enrichedSpare.selectionReason = 'scrape_refill';
              enrichedResults.push(enrichedSpare);
              ev = assessEvidenceSufficiency(enrichedResults, query);
              if (ev.sufficient) break;
            } catch { }
          }
        }
      }
    } catch { }

    // 動画は Web のページの後に足す（補充の計算を崩さない）。同じ動画が Web の結果にあれば足さない
    const webVideoIds = new Set(enrichedResults.map((r: any) => parseYouTubeUrl(String(r?.url || r?.link || ''))?.videoId).filter(Boolean));
    // 締切（scrapeDeadlineMs）があれば、そこまでだけ待つ。間に合わなかったら動画は足さず、欠けた結果として保存しない
    let videoTimer: ReturnType<typeof setTimeout> | undefined;
    const videoItems = await Promise.race([
      videoResultsPromise,
      ...(scrapeDeadlineMs > 0 ? [new Promise<null>((resolve) => { videoTimer = setTimeout(() => resolve(null), Math.max(0, videoDeadlineAt - Date.now())); })] : []),
    ]);
    if (videoTimer) clearTimeout(videoTimer);
    if (videoItems === null) scrapeDeadlineHit = true;
    for (const video of videoItems ?? []) {
      if (!webVideoIds.has(parseYouTubeUrl(video.url)?.videoId)) enrichedResults.push(video);
    }

    // Attempt order index for observability (RFC schema). Main wave keeps
    // pool order; refill and adaptive pushes append in attempt order.
    enrichedResults.forEach((it: any, scrapeAttemptIndex: number) => {
      if (it && typeof it === 'object' && it.scrapeAttemptIndex === undefined) {
        it.scrapeAttemptIndex = scrapeAttemptIndex;
      }
    });

    // 深層エビデンス駆動リランキング (スクレイピング本文・ハイライトの網羅性・エビデンススコアに基づく順位適正化)。検索語の URL は渡された順のまま
    if (enrichedResults.length > 1 && !readQueryUrls) {
      enrichedResults = rerankByDeepEvidence(enrichedResults, query);
      // 本文を読めなかったページ（エラーの画面・読めないファイル）は、検索語によく合っていても、読めたページの後ろに回す
      const unreadable = (r: any) => r?.contentStatus === 'unavailable';
      enrichedResults = [...enrichedResults.filter((r: any) => !unreadable(r)), ...enrichedResults.filter(unreadable)];
    }
  }

  // スクレイプ結果からのフォールバック公式Xアカウント検出（ページのメタタグで宣言されたアカウントだけ）
  if (!targetOfficialHandle && enrichedResults.length > 0) {
    for (const r of enrichedResults) {
      if (r.twitterHandle) {
        targetOfficialHandle = r.twitterHandle;
        break;
      }
    }
    if (includeRealtime && targetOfficialHandle && !officialRealtimePromise) {
      officialRealtimePromise = fetchOfficialPosts(targetOfficialHandle);
    }
  }

  // リアルタイム検索結果のマージ (公式枠 ＋ 一般枠の重複排除ハイブリッド)
  const realtimeMcpRes = await realtimeSearchPromise;
  // 固有名詞が分かれば、公式枠も固有名詞の公式にそろえる（「ライブ 予定 =LOVE」で @LoveLive_staff を公式枠にしない）。
  // 別名の検出で公式を探していればそれを使い（取得済み）、そうでなければ自動抽出した公式だけを確かめる
  if (includeRealtime && !officialAccountId && realtimeMcpRes?.anchorTerm) {
    const anchoredHandle = anchorOfficialHandle
      ?? (targetOfficialHandle ? await findOfficialXHandle(realtimeMcpRes.anchorTerm, searchResults) : undefined);
    if (anchoredHandle && anchoredHandle !== targetOfficialHandle) {
      targetOfficialHandle = anchoredHandle;
      officialRealtimePromise = fetchOfficialPosts(anchoredHandle);
    }
  }
  // 1件の投稿に揃わなかった語と、検索に使った別名は通常応答にも出す（固有名詞の判定語・除外件数は verbose のみ）
  const realtimeGap = {
    focus: realtimeMcpRes?.focus ?? realtimeFocus,
    ...(realtimeMcpRes?.missingTerms?.length ? { missingTerms: realtimeMcpRes.missingTerms } : {}),
    ...(realtimeMcpRes?.aliasTerms?.length ? { aliasTerms: realtimeMcpRes.aliasTerms } : {}),
    ...(realtimeMcpRes?.omittedCount ? { omittedCount: realtimeMcpRes.omittedCount } : {}),
    ...(realtimeMcpRes?.anchorTerm ? { anchorTerm: realtimeMcpRes.anchorTerm } : {}),
    ...(realtimeMcpRes?.anchorFiltered !== undefined ? { anchorFiltered: realtimeMcpRes.anchorFiltered } : {}),
  };
  let realtimeItems: any[] = [];
  let realtimeMeta: any = null;
  if (includeRealtime) {
    const rawPublicList = Array.isArray(realtimeMcpRes?.items) ? realtimeMcpRes.items : [];
    const publicMapped = rawPublicList.map((item: any) => normalizeRealtimeItem(item));

    let officialItems: any[] = [];
    if (officialRealtimePromise) {
      const officialPosts: any[] = await officialRealtimePromise;
      // 自動で見つけた公式は、表示名か投稿にクエリの語がある時だけ公式として扱う
      // （TimeTree のページから TimeTree 自身のアカウントを拾う、等を防ぐ）
      const checkTerms = [
        ...anchorCandidates(extractRealtimeIntentRequirements(query).semanticRequirements.filter((t) => !isPublicFocusTerm(t))),
        ...(realtimeMcpRes?.aliasTerms ?? []),
      ];
      if (officialAccountId || checkTerms.length === 0 || officialAccountMatches(officialPosts, checkTerms)) {
        // 公式の投稿は別枠: 公式優先は先頭に最大5件、第三者優先は後ろに最大2件
        officialItems = officialPosts.slice(0, realtimeFocus === 'public' ? 2 : 5).map((item: any) => normalizeRealtimeItem(item));
      } else {
        targetOfficialHandle = undefined;
      }
    }

    if (officialItems.length > 0 || publicMapped.length > 0) {
      let merged = mergeRealtimeItemsWithDedup(officialItems, publicMapped);
      if (realtimeFocus === 'public') {
        merged = [...merged.filter((i: any) => !i.isOfficial), ...merged.filter((i: any) => i.isOfficial)];
      }
      if (dedup && merged.length > 0) {
        merged = dedupSearchResults(merged, (i: any) => `${i.text || i.content || ''}`);
      }
      const enriched = await enrichRealtimeItemsWithXDetail(
        merged,
        query,
        defaultXDetailProvider,
        { verbose: options.verbose === true },
      );
      merged = enriched.items.map((it: any) => cleanRealtimeItem(it, options.verbose === true));
      realtimeItems = merged;
      realtimeMeta = {
        source: 'x',
        sort: realtimeSort,
        count: realtimeItems.length,
        effectiveQuery: realtimeMcpRes?.effectiveQuery || (targetOfficialHandle ? `id:${targetOfficialHandle}` : query),
        isFallback: realtimeMcpRes?.isFallback || false,
        ...(Array.isArray(realtimeMcpRes?.retrievalQueries) ? { retrievalQueries: realtimeMcpRes.retrievalQueries } : {}),
        ...(Array.isArray(realtimeMcpRes?.contributingQueries) ? { contributingQueries: realtimeMcpRes.contributingQueries } : {}),
        ...(realtimeMcpRes?.resultsMerged !== undefined ? { resultsMerged: realtimeMcpRes.resultsMerged } : {}),
        ...(targetOfficialHandle ? { officialAccountId: targetOfficialHandle } : {}),
        ...realtimeGap,
        items: realtimeItems,
      };
    }
  }

  // Lost in the Middle 対策: 検索結果全体の U字型リオーダリング
  if (reorderUFlat && enrichedResults.length > 2) {
    enrichedResults = reorderLostInTheMiddle(enrichedResults);
  }

  // Host-facing output boundary only. Keep highlightItems internally until
  // deep evidence reranking has completed, then canonicalize the public surface.
  if (!options.verbose) {
    enrichedResults = enrichedResults.map((item: any) => stripHighlightInternals(item));
  }

  const finalResponse: Record<string, any> = {
    query,
    source: 'integrated',
    results: enrichedResults,
    count: enrichedResults.length,
    cached: false,
  };

  if (prfInfo) {
    finalResponse.prf = {
      originalQuery: query,
      expandedQuery: prfInfo.expandedQuery,
      expansionTerms: prfInfo.expansionTerms,
    };
  }

  if (options.verbose) {
    const diagRequirements = extractQueryRequirements(query);
    finalResponse.searchDiagnostics = buildSearchDiagnostics({
      originalQuery: query,
      effectiveQuery,
      webEffectiveQuery: webParsedRes?.effectiveQuery,
      webBindingQuery: webParsedRes?.bindingQuery,
      webRetrievalQueries: webParsedRes?.retrievalQueries,
      webIsFallback: webParsedRes?.isFallback,
      webResultCount: searchResults.length,
      includeRealtime,
      realtimeOriginalQuery: realtimeMcpRes?.originalQuery,
      realtimeEffectiveQuery: realtimeMcpRes?.effectiveQuery,
      realtimeIsFallback: realtimeMcpRes?.isFallback,
      realtimeRetrievalQueries: realtimeMcpRes?.retrievalQueries,
      realtimeContributingQueries: realtimeMcpRes?.contributingQueries,
      realtimeResultsMerged: realtimeMcpRes?.resultsMerged,
      realtimeExecutedWaves: realtimeMcpRes?.executedWaves,
      realtimeStopReason: realtimeMcpRes?.stopReason,
      realtimeRequiredTerms: realtimeMcpRes?.requiredTerms,
      realtimeCoveredTerms: realtimeMcpRes?.coveredTerms,
      realtimeMissingTerms: realtimeMcpRes?.missingTerms,
      webRequirements: [...diagRequirements.entityTerms, ...diagRequirements.intentTerms],
      realtimeCount: Array.isArray(realtimeMcpRes?.items) ? realtimeMcpRes.items.length : 0,
      officialAccountId: targetOfficialHandle,
      results: enrichedResults,
    });
  }

  if (includeRealtime) {
    finalResponse.realtime = realtimeMeta || {
      source: 'x',
      sort: realtimeSort,
      count: 0,
      effectiveQuery: query,
      isFallback: false,
      ...realtimeGap,
      items: [],
    };
  }

  // 判定材料（本文かハイライト）を要求した場合だけ付ける。どちらも無いのに insufficient と出さないため
  if (scrapeContent && (formats.includes('markdown') || extractHighlights)) {
    finalResponse.contextSufficiency = summarizeContextSufficiency(
      enrichedResults,
      includeRealtime ? finalResponse.realtime?.items ?? [] : [],
      evidenceQuery,
    );
  }

  // Public boundary: verbose keeps full diagnostics, default returns compact.
  // Retrieval/rerank internals above are untouched. Cache the shaped
  // response (the cache key already separates verbose from compact).
  // verbose が真のときは schedule を足さず、results[].events のまま返す（MCP の入力スキーマと OpenAPI の説明どおり）。
  if (options.verbose === true) {
    if (!noCache && !scrapeDeadlineHit) setToCache(cacheKey, finalResponse, integratedSearchCacheTtl(finalResponse));
    return finalResponse;
  }
  const publicResponse = formatCompactIntegratedSearchResponse(finalResponse, {});
  // 締切で欠けた結果は劣化応答なのでキャッシュしない
  if (!noCache && !scrapeDeadlineHit) setToCache(cacheKey, publicResponse, integratedSearchCacheTtl(finalResponse));
  return publicResponse;
}

// 荷物追跡サービス (Package Tracking)
export * from './services/tracking.js';
