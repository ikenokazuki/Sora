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
  getFromCache,
  runWithSingleFlight,
  setToCache,
  CACHE_TTL_TREND,
} from './cache.js';
import {
  calculateContentStats,
  chooseBestDescription,
  chunkMarkdownContent,
  dedupSearchResults,
  estimateTokens,
  extractCitationsFromMarkdown,
  extractQueryHighlights,
  extractQueryHighlightDetails,
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
import { hasSensitiveRequestCredentials } from './security/credential_scope.js';
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
  callYahooMcp,
  searchYahooWeb,
  normalizeRealtimeItem,
  searchYahooRealtime,
  fetchTweetsForUrlOrUser,
  extractOfficialXHandleFromWebResults,
  mergeRealtimeItemsWithDedup,
} from './services/yahoo.js';

// ==========================================
// 1. 各専門サブモジュールの re-export (完全な後方互換性の維持)
// ==========================================
export * from './types.js';
export * from './cache.js';
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
import { computeEvidenceCoverage, entityTermsForQuery, kindsForFacet } from './retrieval/answerability.js';
import {
  convertHtmlToMarkdown,
  matchUrlPattern,
} from './html_parser.js';
import {
  fetchWithStealthBrowser,
} from './browser_stealth.js';

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
    content: sessionRes.content,
    screenshot: sessionRes.screenshot,
    html: sessionRes.html,
    actionOutputs: sessionRes.actionLogs?.map((l: any, idx: number) => ({
      step: idx + 1,
      type: l.type,
      result: l.success ? 'ok' : undefined,
      error: !l.success ? l.message : undefined,
    })),
    actionLogs: sessionRes.actionLogs,
    renderedWithBrowser: true,
    source: 'browser',
  };
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
    if (options.snippet && options.snippet.trim()) {
      supplemental.push(options.snippet.trim());
    }
    if (result.description && result.description.trim() && result.description !== options.snippet) {
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
    options.extractHighlights ?? (Boolean(options.query && options.query.trim()));

  onProgress?.({ stage: 'start', message: `Starting scrape for ${url}` });

  if (options.fastOnly && options.renderJs) {
    throw new Error('fastOnly と renderJs は同時に指定できません');
  }

  const cacheKey = `scrape:v4:${url}:${maxChars}:${options.mode || 'auto'}:${onlyMainContent}:${formats.slice().sort().join(',')}:${(options.removeSelectors || []).join(',')}:${options.stripLinks || false}:${options.filterLinkDensity || false}:${options.query || ''}:${shouldExtractHighlights}:${options.onlyHighlights || false}:${options.highlightAlgorithm || 'rho-select-v2'}:${options.highlightOverheadTokens ?? 96}:${options.highlightMaxCount ?? 'auto'}:${options.evidenceMode || 'full'}:${options.includeDiagnostics !== false}:${options.includeDiscrepancies || false}:${options.safeNormalize || false}:${options.reorderUFlat || false}:${options.diversityWeight ?? 0.7}:${options.annotateTemporal || false}:${options.minimizeTables !== false}:${options.extractSummary || false}:${options.extractCitations || false}:${options.chunkMarkdown || false}:${options.chunkSize || 1000}:${options.validateLinks || false}:${options.maskPii || false}:${options.formatAsPrompt || false}:${options.highlightMatches || false}`;

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
      shouldExtractHighlights: shouldExtractHighlights ?? (options.onlyHighlights ? true : false),
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
            if (useSharedCache) setToCache(cacheKey, result);
            return result;
          }
        }

        const isForcedBrowser = options.mode === 'browser' || options.renderJs === true;
        const isFastMode = options.mode === 'fast' || options.fastOnly === true;

        if (!isForcedBrowser) {
          onProgress?.({ stage: 'fetch', message: 'Fetching via safe HTTP client' });
          const { finalUrl, response } = await fetchWithSafeRedirects(
            url,
            timeoutMs,
            5,
            options.headers,
            options.cookies,
            undefined,
            options.tenantId ?? 'legacy',
          );

          const contentType = (response.headers.get('Content-Type') || '').toLowerCase();

          if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
            const buf = await readBodyWithLimit(response, MAX_RESPONSE_BODY_BYTES);
            const pdfResult = await parsePdfToMarkdown(buf, finalUrl, maxChars);
            result = await finalizeScrapeResult(pdfResult, finalizeOpts);
            if (useSharedCache) setToCache(cacheKey, result);
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
            result = await finalizeScrapeResult(result, finalizeOpts);

            if (useSharedCache) setToCache(cacheKey, result);
            onProgress?.({ stage: 'done', message: 'Scraping completed successfully', data: result });
            return result;
          }

          // ブラウザレンダリングに進む場合でも、初期HTTPで取得できたコンテンツがあれば保持（フォールバック用）
          if (parsed.markdown && parsed.markdown.trim().length >= 50) {
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
        let browserRes: { html: string; title: string; screenshot?: string; finalUrl: string };

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
        } catch (browserErr: any) {
          // ブラウザレンダリングがタイムアウト等で失敗した場合、初期HTTPで取得できていたコンテンツがあれば救済
          if (initialHttpResult) {
            onProgress?.({ stage: 'enrich', message: 'Browser timed out; falling back to initial HTTP content' });
            result = await finalizeScrapeResult(initialHttpResult, finalizeOpts);
            if (useSharedCache) setToCache(cacheKey, result);
            return result;
          }
          throw browserErr;
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
        result = await finalizeScrapeResult(result, finalizeOpts);

        if (useSharedCache) setToCache(cacheKey, result);
        onProgress?.({ stage: 'done', message: 'Scraping completed successfully', data: result });
        return result;
      } catch (err: any) {
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
      } catch (e: any) {
        errors.push({ url: targetUrl, error: e?.message || 'Unknown error' });
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

    if (parsed.urlset && parsed.urlset.url) {
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

    if (parsed.sitemapindex && parsed.sitemapindex.sitemap && currentDepth < maxDepth) {
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
  });

  const baseHost = parsedUrl.hostname.toLowerCase();
  const internalLinks = (scraped.links || []).filter((link) => {
    try {
      const linkHost = new URL(link).hostname.toLowerCase();
      return options.includeSubdomains ? linkHost.endsWith(baseHost) : linkHost === baseHost;
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

  const targetLimit = Math.min(maxPages, 50);
  const baseHost = new URL(initialUrl).hostname.toLowerCase();

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: initialUrl, depth: 0 }];
  let pages: ScrapeResult[] = [];

  while (queue.length > 0 && pages.length < targetLimit) {
    const item = queue.shift();
    if (!item) break;

    const normalizedUrl = item.url.split('#')[0].replace(/\/+$/, '');
    if (visited.has(normalizedUrl)) continue;
    visited.add(normalizedUrl);

    if (excludePatterns && !matchUrlPattern(item.url, excludePatterns)) {
      continue;
    }
    if (includePatterns && !matchUrlPattern(item.url, includePatterns)) {
      continue;
    }

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
      });

      pages.push(scraped);
      if (onPageCrawled) onPageCrawled(scraped, pages.length);
      if (onPageScraped) onPageScraped(scraped);

      if (item.depth < maxDepth && scraped.links) {
        for (const link of scraped.links) {
          try {
            const linkHost = new URL(link).hostname.toLowerCase();
            if (linkHost === baseHost && !visited.has(link.split('#')[0].replace(/\/+$/, ''))) {
              queue.push({ url: link, depth: item.depth + 1 });
            }
          } catch {}
        }
      }
    } catch {}
  }

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
export async function fetchRealtimeTrends(limit = 20): Promise<{
  source: 'x';
  type: 'trend';
  count: number;
  items: { rank: number; keyword: string; tweetCount?: string; url: string }[];
  timestamp: string;
}> {
  const cacheKey = `trends:realtime`;
  const cached = getFromCache<any>(cacheKey);
  if (cached) return cached;

  const res = await fetchWithSafeRedirects('https://search.yahoo.co.jp/realtime', 10000);
  if (!res || !res.response.ok) {
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

  const finalItems = items.slice(0, limit);
  const result = {
    source: 'x' as const,
    type: 'trend' as const,
    count: finalItems.length,
    items: finalItems,
    timestamp: new Date().toISOString(),
  };

  setToCache(cacheKey, result, CACHE_TTL_TREND);
  return result;
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
 * 応答に付ける「根拠は足りているか」の信号。応答内容は変えず、判断は上位エージェントに任せる。
 * Web は本文取得に成功したページのみ（スニペット代替・取得失敗・締切超過は含めない）、X は投稿本文も証拠に数える。
 * 判定は adaptive scrape と同じ assessEvidenceSufficiency（few-success / missing-evidence / missing-answer）。
 * 語彙ベースの欠落検出なので、partial/insufficient は不足の根拠になるが、no_gap_detected は十分の保証ではない。
 */
export function summarizeContextSufficiency(
  webItems: any[],
  realtimeItems: any[],
  query: string,
): { level: 'no_gap_detected' | 'partial' | 'insufficient'; reasons: string[] } {
  const web = (webItems || []).map((it) => (it?.isSnippetFallback ? { ...it, markdown: undefined, highlights: undefined } : it));
  const posts = (realtimeItems || [])
    .filter((it) => typeof it?.text === 'string' && it.text.trim())
    .map((it) => ({ title: '', markdown: it.text }));
  const usable = [...web, ...posts].some((it) => !it?.scrapeError && (it?.markdown || it?.highlights));
  if (!usable) return { level: 'insufficient', reasons: ['no-usable-content'] };
  const { sufficient, reasons } = assessEvidenceSufficiency([...web, ...posts], query);
  return { level: sufficient ? 'no_gap_detected' : 'partial', reasons };
}

/**
 * 本文取得の既定の打ち切り上限。0 = 無効（既定）。
 * ponytail: 低速だが本文のあるページ（SPA 等は 9〜10s かかる）を落とすため opt-in。
 * 有効化の根拠は「修正後の」本文取得時間の実測が揃ってから決める。
 */
const DEFAULT_SCRAPE_DEADLINE_MS = 0;
/** 半数のページが揃ってから残りを待つ猶予。 */
const SCRAPE_DEADLINE_GRACE_MS = 5_000;

export async function integratedSearch(options: {
  query: string;
  limit?: number;
  scrapeContent?: boolean;
  includeRealtime?: boolean;
  realtimeSort?: 'recent' | 'popular';
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
  tenantId?: string;
}): Promise<Record<string, any>> {
  const query = options.query;
  const limit = Math.min(options.limit ?? 5, 20);
  const scrapeContent = options.scrapeContent !== false;
  const includeRealtime = options.includeRealtime !== false;
  const realtimeSort = options.realtimeSort || 'recent';
  const officialAccountId = options.officialAccountId?.trim()?.replace(/^@/, '');
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const noCache = options.noCache ?? false;
  const includeDomains = options.includeDomains;
  const excludeDomains = options.excludeDomains;
  const updated = options.updated;
  const extractHighlights = options.extractHighlights ?? (Boolean(query && query.trim()));
  const onlyMainContent = options.onlyMainContent !== false;
  const formats = options.formats ?? ['markdown'];
  const dedup = options.dedup ?? false;
  const reorderUFlat = options.reorderUFlat ?? false;
  const enablePrf = options.enablePrf ?? false;
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
  const requestTenantId = options.tenantId ?? 'legacy';
  const cacheKey = `search:integrated:v4:${query}:${limit}:${scrapeContent}:${includeRealtime}:${realtimeSort}:${officialAccountId || 'none'}:${(includeDomains || []).join(',')}:${(excludeDomains || []).join(',')}:${updated || 'all'}:${extractHighlights}:${onlyMainContent}:${formats.slice().sort().join(',')}:${dedup}:${reorderUFlat}:${enablePrf}:${diversityWeight ?? 'default'}:${annotateTemporal || false}:${minimizeTables !== false}:${highlightAlgorithm}:${highlightOverheadTokens}:${highlightMaxCount ?? 'auto'}:${options.verbose === true ? 'verbose' : 'compact'}:${xSourceIsolation ? 'xiso-on' : 'xiso-off'}:${webQueryUnion ? 'wqu-on' : 'wqu-off'}:${adaptiveScrape ? 'adapt-on' : 'adapt-off'}:${scrapeBudget}`;
  if (!noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return cached;
  }

  const webSearchPromise = searchYahooWeb({ query, includeDomains, excludeDomains, updated, noCache });
  const realtimeSearchPromise = includeRealtime
    ? searchYahooRealtime({ query, sort: realtimeSort, detailEnrichment: false }).catch(() => null)
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
  let effectiveQuery = query;
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
    officialRealtimePromise = searchYahooRealtime({
      accountId: targetOfficialHandle,
      limit: 5,
      sort: 'recent',
      detailEnrichment: false,
    }).catch(() => null);
  }

  const envDeadline = Number(process.env.SORA_SCRAPE_DEADLINE_MS);
  const scrapeDeadlineMs = options.scrapeDeadlineMs ?? (Number.isFinite(envDeadline) && process.env.SORA_SCRAPE_DEADLINE_MS ? envDeadline : DEFAULT_SCRAPE_DEADLINE_MS);
  let scrapeDeadlineHit = false;
  let enrichedResults = topItems;
  if (scrapeContent) {
    const settled = await settleWithDeadline(
      topItems.map(async (item: any, itemIndex: number) => {
        const itemUrl = item.url || item.link;
        if (!itemUrl) return item;
        const itemSnippet = item.snippet || item.description || '';

        if (xSourceIsolation) {
          const plan = xPlanByIndex.get(itemIndex);
          if (plan) {
            const isolatedBase = stripXWebDiscoveryText(item);

            // 指示書 第13条: Direct X status URL の場合、既知の statusId に対してまず FxTwitter detail 1回を試行
            let directEvidence: any = null;
            if (plan.seed.kind === 'status' && plan.seed.statusId) {
              try {
                const detail = await defaultXDetailProvider.fetchStatus(plan.seed.statusId);
                if (detail && detail.text) {
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
            contextTitle: item.title,
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
        } catch (e: any) {
          const fallbackMd = itemSnippet
            ? `# ${item.title || 'Web Search Result'}\n\nURL: ${itemUrl}\n\n${itemSnippet}`
            : undefined;
          return {
            ...item,
            scrapeError: e?.message,
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
      // 締切で打ち切った場合は待ち時間を優先し、補充の逐次取得は行わない
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
            continue;
          }
        }
      }
    } catch {
      // 補充失敗時は初回結果をそのまま返す
    }

    // P1-3: adaptive evidence 不足時の追加取得 (opt-in, 最大8件)
    try {
      if (adaptiveScrape && scrapeContent) {
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
              const enrichedSpare: Record<string, any> = { ...spareItem, ogImage: scrape.ogImage, description: scrape.description, publishedTime: scrape.publishedTime, author: scrape.author, siteName: scrape.siteName, twitterHandle: scrape.twitterHandle, socialLinks: scrape.socialLinks, pageType: scrape.pageType, highlights: scrape.highlights, highlightItems: scrape.highlightItems, highlightDiagnostics: scrape.highlightDiagnostics, temporalAnchors: scrape.temporalAnchors, textFragmentUrl: scrape.textFragmentUrl, cached: scrape.cached };
              Object.assign(enrichedSpare, projectRequestedScrapeFormats(scrape, formats, { minMarkdownChars: 50 }));
              enrichedSpare.selectionReason = 'scrape_refill';
              enrichedResults.push(enrichedSpare);
              ev = assessEvidenceSufficiency(enrichedResults, query);
              if (ev.sufficient) break;
            } catch { continue; }
          }
        }
      }
    } catch { }

    // Attempt order index for observability (RFC schema). Main wave keeps
    // pool order; refill and adaptive pushes append in attempt order.
    enrichedResults.forEach((it: any, scrapeAttemptIndex: number) => {
      if (it && typeof it === 'object' && it.scrapeAttemptIndex === undefined) {
        it.scrapeAttemptIndex = scrapeAttemptIndex;
      }
    });

    // 深層エビデンス駆動リランキング (スクレイピング本文・ハイライトの網羅性・エビデンススコアに基づく順位適正化)
    if (enrichedResults.length > 1) {
      enrichedResults = rerankByDeepEvidence(enrichedResults, query);
    }
  }

  // スクレイプ結果からのフォールバック公式Xアカウント検出
  if (!targetOfficialHandle && enrichedResults.length > 0) {
    for (const r of enrichedResults) {
      if (r.twitterHandle) {
        targetOfficialHandle = r.twitterHandle;
        break;
      }
    }
    if (includeRealtime && targetOfficialHandle && !officialRealtimePromise) {
      officialRealtimePromise = searchYahooRealtime({
        accountId: targetOfficialHandle,
        limit: 5,
        sort: 'recent',
        detailEnrichment: false,
      }).catch(() => null);
    }
  }

  // リアルタイム検索結果のマージ (公式枠 ＋ 一般枠の重複排除ハイブリッド)
  const realtimeMcpRes = await realtimeSearchPromise;
  let realtimeItems: any[] = [];
  let realtimeMeta: any = null;
  if (includeRealtime) {
    const rawPublicList = Array.isArray(realtimeMcpRes?.items) ? realtimeMcpRes.items : [];
    let publicMapped = rawPublicList.map((item: any) => normalizeRealtimeItem(item));

    let officialItems: any[] = [];
    if (officialRealtimePromise) {
      const officialRes = await officialRealtimePromise;
      if (officialRes && Array.isArray(officialRes.items)) {
        officialItems = officialRes.items.map((item: any) => normalizeRealtimeItem(item));
      }
    }

    if (officialItems.length > 0 || publicMapped.length > 0) {
      let merged = mergeRealtimeItemsWithDedup(officialItems, publicMapped);
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
        ...(realtimeMcpRes?.intent ? { intent: realtimeMcpRes.intent } : {}),
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
      items: [],
    };
  }

  if (scrapeContent) {
    finalResponse.contextSufficiency = summarizeContextSufficiency(
      enrichedResults,
      includeRealtime ? finalResponse.realtime?.items ?? [] : [],
      query,
    );
  }

  // Public boundary: verbose keeps full diagnostics, default returns compact.
  // Retrieval/rerank internals above are untouched. Cache the shaped
  // response (the cache key already separates verbose from compact).
  const publicResponse = formatCompactIntegratedSearchResponse(finalResponse, {
    verbose: options.verbose === true,
  });
  // 締切で欠けた結果は劣化応答なのでキャッシュしない
  if (!noCache && !scrapeDeadlineHit) setToCache(cacheKey, publicResponse);
  return publicResponse;
}

// 荷物追跡サービス (Package Tracking)
export * from './services/tracking.js';
