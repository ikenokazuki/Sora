import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import type { CookieParam } from 'puppeteer-core';
import {
  type BatchScrapeResult,
  type BrowserActionOptions,
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
  generateExtractiveSummary,
  generatePromptContext,
  generateTextFragmentUrl,
  highlightQueryMatchesInMarkdown,
  maskPiiInText,
  safeTruncateMarkdown,
  sendWebhookNotification,
  validateExtractedLinks,
} from './enrichment.js';
import { resolveChromiumPath } from './browser_engine.js';
import { parsePdfToMarkdown } from './pdf.js';
import {
  callYahooMcp,
  searchYahooWeb,
  normalizeRealtimeItem,
  searchYahooRealtime,
  fetchTweetsForUrlOrUser,
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
} from './http_fetcher.js';
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
async function finalizeScrapeResult(
  result: ScrapeResult,
  options: {
    query?: string;
    shouldExtractHighlights: boolean;
    shouldOnlyHighlights?: boolean;
    shouldExtractSummary: boolean;
    shouldExtractCitations: boolean;
    shouldChunkMarkdown: boolean;
    chunkSize: number;
    shouldValidateLinks: boolean;
    shouldFormatAsPrompt: boolean;
    shouldHighlightMatches: boolean;
    shouldMaskPii: boolean;
    webhookUrl?: string;
  },
): Promise<ScrapeResult> {
  if (options.shouldMaskPii) {
    result.content = maskPiiInText(result.content);
  }
  const stats = calculateContentStats(result.content);
  result.characterCount = stats.characterCount;
  result.wordCount = stats.wordCount;
  result.readingTimeMin = stats.readingTimeMin;

  if (options.shouldExtractHighlights && options.query) {
    result.highlights = extractQueryHighlights(result.content, options.query);
    if (result.highlights.length > 0) {
      result.textFragmentUrl = generateTextFragmentUrl(result.url, result.highlights[0]);
    }
  }
  if (options.shouldOnlyHighlights && result.highlights && result.highlights.length > 0) {
    result.content = result.highlights.join('\n\n---\n\n');
    const updatedStats = calculateContentStats(result.content);
    result.characterCount = updatedStats.characterCount;
    result.wordCount = updatedStats.wordCount;
    result.readingTimeMin = updatedStats.readingTimeMin;
    result.estimatedTokens = estimateTokens(result.content);
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

  return (
    hasLittleContent ||
    isJsDisabledMessage ||
    isBotChallengeStatus ||
    isCloudflareMitigation ||
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
    html.includes('data-reactroot') ||
    html.includes('Please enable JavaScript') ||
    html.includes('Checking your browser') ||
    html.includes('Just a moment...')
  );
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

  return (hasLittleContent && isJsDisabledMessage) || isChallenge;
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
    options.extractHighlights ?? (Boolean(options.query) && options.extractHighlights !== false);

  onProgress?.({ stage: 'start', message: `Starting scrape for ${url}` });

  if (options.fastOnly && options.renderJs) {
    throw new Error('fastOnly と renderJs は同時に指定できません');
  }

  const cacheKey = `scrape:${url}:${maxChars}:${options.mode || 'auto'}:${onlyMainContent}:${formats.slice().sort().join(',')}:${(options.removeSelectors || []).join(',')}:${options.stripLinks || false}:${options.filterLinkDensity || false}:${options.query || ''}:${shouldExtractHighlights}:${options.onlyHighlights || false}:${options.extractSummary || false}:${options.extractCitations || false}:${options.chunkMarkdown || false}:${options.chunkSize || 1000}:${options.validateLinks || false}:${options.maskPii || false}:${options.formatAsPrompt || false}:${options.highlightMatches || false}`;

  if (!options.noCache) {
    const cached = getFromCache<ScrapeResult>(cacheKey);
    if (cached) {
      onProgress?.({ stage: 'done', message: 'Cache hit', data: cached });
      return cached;
    }
  }

  return runWithSingleFlight(cacheKey, async () => {
    let attempt = 0;
    let lastError: any = null;

    while (attempt <= retries) {
      try {
        let result: ScrapeResult;

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
            result = await finalizeScrapeResult(baseResult, {
              query: options.query,
              shouldExtractHighlights: shouldExtractHighlights ?? (options.onlyHighlights ? true : false),
              shouldOnlyHighlights: options.onlyHighlights ?? false,
              shouldExtractSummary: options.extractSummary ?? false,
              shouldExtractCitations: options.extractCitations ?? false,
              shouldChunkMarkdown: options.chunkMarkdown ?? false,
              chunkSize: options.chunkSize ?? 1000,
              shouldValidateLinks: options.validateLinks ?? false,
              shouldFormatAsPrompt: options.formatAsPrompt ?? false,
              shouldHighlightMatches: options.highlightMatches ?? false,
              shouldMaskPii: options.maskPii ?? false,
              webhookUrl: options.webhookUrl,
            });
            if (!options.noCache) setToCache(cacheKey, result);
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
          );

          const contentType = (response.headers.get('Content-Type') || '').toLowerCase();

          if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
            const buf = await response.arrayBuffer();
            const pdfResult = await parsePdfToMarkdown(buf, finalUrl, maxChars);
            result = await finalizeScrapeResult(pdfResult, {
              query: options.query,
              shouldExtractHighlights: shouldExtractHighlights ?? (options.onlyHighlights ? true : false),
              shouldOnlyHighlights: options.onlyHighlights ?? false,
              shouldExtractSummary: options.extractSummary ?? false,
              shouldExtractCitations: options.extractCitations ?? false,
              shouldChunkMarkdown: options.chunkMarkdown ?? false,
              chunkSize: options.chunkSize ?? 1000,
              shouldValidateLinks: options.validateLinks ?? false,
              shouldFormatAsPrompt: options.formatAsPrompt ?? false,
              shouldHighlightMatches: options.highlightMatches ?? false,
              shouldMaskPii: options.maskPii ?? false,
              webhookUrl: options.webhookUrl,
            });
            if (!options.noCache) setToCache(cacheKey, result);
            return result;
          }

          const buf = await response.arrayBuffer();
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

          if (!isSpaOrBlank) {
            result = {
              url: finalUrl,
              title: parsed.title,
              content: parsed.markdown,
              isTruncated: parsed.isTruncated,
              contentType: 'text/html',
              source: 'web',
              renderedWithBrowser: false,
              ogImage: parsed.ogImage,
              description: parsed.description,
              publishedTime: parsed.publishedTime,
              author: parsed.author,
              siteName: parsed.siteName,
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
            result = await finalizeScrapeResult(result, {
              query: options.query,
              shouldExtractHighlights: shouldExtractHighlights ?? (options.onlyHighlights ? true : false),
              shouldOnlyHighlights: options.onlyHighlights ?? false,
              shouldExtractSummary: options.extractSummary ?? false,
              shouldExtractCitations: options.extractCitations ?? false,
              shouldChunkMarkdown: options.chunkMarkdown ?? false,
              chunkSize: options.chunkSize ?? 1000,
              shouldValidateLinks: options.validateLinks ?? false,
              shouldFormatAsPrompt: options.formatAsPrompt ?? false,
              shouldHighlightMatches: options.highlightMatches ?? false,
              shouldMaskPii: options.maskPii ?? false,
              webhookUrl: options.webhookUrl,
            });

            if (!options.noCache) setToCache(cacheKey, result);
            onProgress?.({ stage: 'done', message: 'Scraping completed successfully', data: result });
            return result;
          }
        }

        onProgress?.({ stage: 'render', message: 'Rendering SPA via Stealth Chromium' });
        const needScreenshot = formats.includes('screenshot');
        const fullPage = options.fullPage ?? true;
        let browserRes = await fetchWithStealthBrowser(
          url,
          timeoutMs,
          options.clipSelector,
          options.cookies,
          'networkidle2',
          needScreenshot,
          fullPage,
        );

        let parsed = convertHtmlToMarkdown(
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

        const renderedBodyOnly = parsed.markdown.replace(/^---[\s\S]*?---\n*/, '').trim();
        if (isRenderStillBlockedOrBlank({ html: browserRes.html, bodyOnlyMarkdown: renderedBodyOnly })) {
          botRetryCount++;
          onProgress?.({ stage: 'render', message: 'Content still blank after render, retrying with networkidle0' });
          browserRes = await fetchWithStealthBrowser(
            url,
            timeoutMs,
            options.clipSelector,
            options.cookies,
            'networkidle0',
            needScreenshot,
            fullPage,
          );
          parsed = convertHtmlToMarkdown(
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
        }

        result = {
          url: browserRes.finalUrl,
          title: browserRes.title || parsed.title,
          content: parsed.markdown,
          isTruncated: parsed.isTruncated,
          contentType: 'text/html',
          source: 'web',
          renderedWithBrowser: true,
          ogImage: parsed.ogImage,
          description: parsed.description,
          publishedTime: parsed.publishedTime,
          author: parsed.author,
          siteName: parsed.siteName,
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
        result = await finalizeScrapeResult(result, {
          query: options.query,
          shouldExtractHighlights: shouldExtractHighlights ?? (options.onlyHighlights ? true : false),
          shouldOnlyHighlights: options.onlyHighlights ?? false,
          shouldExtractSummary: options.extractSummary ?? false,
          shouldExtractCitations: options.extractCitations ?? false,
          shouldChunkMarkdown: options.chunkMarkdown ?? false,
          chunkSize: options.chunkSize ?? 1000,
          shouldValidateLinks: options.validateLinks ?? false,
          shouldFormatAsPrompt: options.formatAsPrompt ?? false,
          shouldHighlightMatches: options.highlightMatches ?? false,
          shouldMaskPii: options.maskPii ?? false,
          webhookUrl: options.webhookUrl,
        });

        if (!options.noCache) setToCache(cacheKey, result);
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
  });
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
export async function mapSiteUrl(options: {
  url: string;
  limit?: number;
  includeSubdomains?: boolean;
  since?: string;
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
  const cacheKey = `map:${url}:${limit}:${options.includeSubdomains || false}:${options.since || ''}`;

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
      let filteredEntries = entries;
      if (options.since) {
        const sinceTime = new Date(options.since).getTime();
        if (!isNaN(sinceTime)) {
          filteredEntries = entries.filter((e) => !e.lastmod || new Date(e.lastmod).getTime() >= sinceTime);
        }
      }
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
  noCache?: boolean;
  webhookUrl?: string;
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
    noCache,
    webhookUrl,
    onPageScraped,
    onPageCrawled,
  } = options;

  const targetLimit = Math.min(maxPages, 50);
  const baseHost = new URL(initialUrl).hostname.toLowerCase();

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: initialUrl, depth: 0 }];
  const pages: ScrapeResult[] = [];

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
        maxChars,
        formats: Array.from(new Set([...formats, 'links'])),
        query,
        extractHighlights,
        onlyHighlights,
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
export async function integratedSearch(options: {
  query: string;
  limit?: number;
  scrapeContent?: boolean;
  includeRealtime?: boolean;
  realtimeSort?: 'recent' | 'popular';
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
}): Promise<Record<string, any>> {
  const query = options.query;
  const limit = Math.min(options.limit ?? 5, 20);
  const scrapeContent = options.scrapeContent !== false;
  const includeRealtime = options.includeRealtime !== false;
  const realtimeSort = options.realtimeSort || 'recent';
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const noCache = options.noCache ?? false;
  const includeDomains = options.includeDomains;
  const excludeDomains = options.excludeDomains;
  const updated = options.updated;
  const extractHighlights = options.extractHighlights ?? false;
  const onlyMainContent = options.onlyMainContent !== false;
  const formats = options.formats ?? ['markdown'];
  const dedup = options.dedup ?? false;
  const cacheKey = `search:integrated:${query}:${limit}:${scrapeContent}:${includeRealtime}:${realtimeSort}:${(includeDomains || []).join(',')}:${(excludeDomains || []).join(',')}:${updated || 'all'}:${extractHighlights}:${onlyMainContent}:${formats.slice().sort().join(',')}:${dedup}`;
  if (!noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return cached;
  }

  const [webParsedRes, realtimeMcpRes] = await Promise.all([
    searchYahooWeb({ query, includeDomains, excludeDomains, updated }),
    includeRealtime
      ? searchYahooRealtime({ query, sort: realtimeSort }).catch(() => null)
      : Promise.resolve(null),
  ]);

  let searchResults = Array.isArray(webParsedRes?.items)
    ? webParsedRes.items
    : Array.isArray(webParsedRes)
    ? webParsedRes
    : [];

  if (dedup && searchResults.length > 0) {
    searchResults = dedupSearchResults(searchResults, (i: any) => `${i.title || ''} ${i.snippet || ''}`);
  }

  const topItems = searchResults.slice(0, limit);

  let realtimeItems: any[] = [];
  let realtimeMeta: any = null;
  if (realtimeMcpRes) {
    const rawList = Array.isArray(realtimeMcpRes.items) ? realtimeMcpRes.items : [];
    let mapped = rawList.map((item: any) => normalizeRealtimeItem(item));
    if (dedup && mapped.length > 0) {
      mapped = dedupSearchResults(mapped, (i: any) => `${i.text || i.content || ''}`);
    }
    realtimeItems = mapped;
    realtimeMeta = {
      source: 'x',
      sort: realtimeSort,
      count: realtimeItems.length,
      effectiveQuery: realtimeMcpRes.effectiveQuery || query,
      isFallback: realtimeMcpRes.isFallback || false,
      items: realtimeItems,
    };
  }

  let enrichedResults = topItems;
  if (scrapeContent) {
    enrichedResults = await Promise.all(
      topItems.map(async (item: any) => {
        const itemUrl = item.url || item.link;
        if (!itemUrl) return item;
        const itemSnippet = item.snippet || item.description || '';
        try {
          const scrape = await scrapeUrl({
            url: itemUrl,
            contextTitle: item.title,
            snippet: itemSnippet,
            maxChars,
            timeoutMs: 12000,
            query,
            extractHighlights,
            onlyMainContent,
            formats,
          });

          const enrichedItem: Record<string, any> = {
            ...item,
            ogImage: scrape.ogImage,
            description: scrape.description,
            publishedTime: scrape.publishedTime,
            author: scrape.author,
            siteName: scrape.siteName,
            pageType: scrape.pageType,
            highlights: scrape.highlights,
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

          if (formats.includes('markdown')) {
            if (scrape.content && scrape.content.trim().length >= 50) {
              enrichedItem.markdown = scrape.content;
            } else if (itemSnippet) {
              enrichedItem.markdown = `# ${item.title || 'Web Search Result'}\n\nURL: ${itemUrl}\n\n${itemSnippet}`;
              enrichedItem.isSnippetFallback = true;
            } else {
              enrichedItem.markdown = scrape.content || '';
            }
          }
          if (formats.includes('html')) {
            enrichedItem.html = scrape.html ?? scrape.rawHtml;
          }
          if (formats.includes('rawHtml')) {
            enrichedItem.rawHtml = scrape.rawHtml;
          }
          if (formats.includes('links')) {
            enrichedItem.links = scrape.links;
          }
          if (formats.includes('jsonLd') && scrape.jsonLd) {
            enrichedItem.jsonLd = scrape.jsonLd;
          }
          if (formats.includes('images') && scrape.images) {
            enrichedItem.images = scrape.images;
          }
          if (formats.includes('screenshot')) {
            enrichedItem.screenshot = scrape.screenshot;
          }

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
    );
  }

  const finalResponse: Record<string, any> = {
    query,
    source: 'integrated',
    results: enrichedResults,
    count: enrichedResults.length,
    cached: false,
  };

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

  if (!noCache) setToCache(cacheKey, finalResponse);
  return finalResponse;
}
