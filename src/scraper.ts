import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

export const PORT = parseInt(process.env.PORT || '8000', 10);
export const DEFAULT_MAX_CHARS = 30_000;
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Chromium のパス判定 (コンテナ内 または ホスト環境)
export const CHROME_EXECUTABLE_PATH =
  process.env.CHROME_PATH ||
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
   existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
   existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : undefined);

// Yahoo MCP バイナリのパス
export const YAHOO_MCP_PATH =
  process.env.YAHOO_MCP_PATH ||
  (existsSync('/usr/local/bin/yahoo-search-mcp') ? '/usr/local/bin/yahoo-search-mcp' :
   existsSync(join(import.meta.dir, '../bin/yahoo-search-mcp')) ? join(import.meta.dir, '../bin/yahoo-search-mcp') :
   existsSync('/home/ikeno/app/oshiframe/backend/bin/Yahoo-Japan-Search-MCP-v0.1.0-linux-x64/yahoo-search-mcp')
     ? '/home/ikeno/app/oshiframe/backend/bin/Yahoo-Japan-Search-MCP-v0.1.0-linux-x64/yahoo-search-mcp'
     : 'yahoo-search-mcp');

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

// ==========================================
// 1. In-Memory LRU Cache (TTL 15分, 最大2000件)
// ==========================================
export interface ScrapeResult {
  url: string;
  title: string;
  content: string;
  isTruncated: boolean;
  contentType: string;
  renderedWithBrowser?: boolean;
  cached?: boolean;
  ogImage?: string;
  description?: string;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15分
const MAX_CACHE_SIZE = 2000;
const memoryCache = new Map<string, CacheEntry<any>>();

export function getCacheSize(): number {
  return memoryCache.size;
}

export function clearCache(): number {
  const count = memoryCache.size;
  memoryCache.clear();
  return count;
}

export function getFromCache<T>(key: string): T | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return { ...entry.data, cached: true };
}

export function setToCache<T>(key: string, data: T): void {
  if (memoryCache.size >= MAX_CACHE_SIZE) {
    const keysToDelete = Array.from(memoryCache.keys()).slice(0, Math.floor(MAX_CACHE_SIZE * 0.1));
    for (const k of keysToDelete) memoryCache.delete(k);
  }
  memoryCache.set(key, {
    data: { ...data, cached: false },
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ==========================================
// 2. ドメイン別スロットリング & Jitter (IP BAN 防止)
// ==========================================
const lastRequestByDomain = new Map<string, number>();

export async function throttleDomain(hostname: string, minIntervalMs = 150): Promise<void> {
  const lastTime = lastRequestByDomain.get(hostname) || 0;
  const now = Date.now();
  const elapsed = now - lastTime;
  const jitter = Math.floor(Math.random() * 100); // 0〜100ms のランダムな揺らぎ
  const requiredWait = minIntervalMs + jitter;

  if (elapsed < requiredWait) {
    const delay = requiredWait - elapsed;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  lastRequestByDomain.set(hostname, Date.now());
}

// ==========================================
// 3. SSRF 防御 (内部 IP 遮断)
// ==========================================
export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true;
  }
  const ipv4Match = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    const [a, b] = octets;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  if (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fe80:') ||
    lower.startsWith('fc00:') ||
    lower.startsWith('fd00:')
  ) {
    return true;
  }
  return false;
}

// ==========================================
// 4. HTML クリーニング & Markdown 化 (Readability + Turndown)
// ==========================================
export function convertHtmlToMarkdown(
  rawHtml: string,
  targetUrl: string,
  maxChars: number,
  isRendered = false,
): { title: string; markdown: string; ogImage?: string; description?: string; isSpaFallbackNeeded: boolean } {
  const parsedUrl = new URL(targetUrl);
  const $ = cheerio.load(rawHtml);

  const title =
    $('title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    parsedUrl.hostname;
  const ogImage = $('meta[property="og:image"]').attr('content')?.trim();
  const description =
    $('meta[property="og:description"]').attr('content')?.trim() ||
    $('meta[name="description"]').attr('content')?.trim();

  // 不要タグの削除
  $(
    'script, style, noscript, svg, iframe, nav, footer, header, aside, form, ' +
      '[role="navigation"], [role="banner"], [role="dialog"], ' +
      '#cookieyes, .cookie-banner, .onetrust-pc-dark-filter, #onetrust-consent-sdk, ' +
      '#no-js-banner, .loading__no-js, .modal-backdrop, .ad, .advertisement',
  ).remove();

  const cleanedHtml = $.html();

  // Readability による記事抽出の試行
  let bodyMarkdown = '';
  try {
    const { document } = parseHTML(cleanedHtml);
    const reader = new Readability(document as any);
    const article = reader.parse();
    if (article && article.content && article.content.length > 100) {
      bodyMarkdown = turndown.turndown(article.content);
    }
  } catch {
    // Readability 失敗時は Cheerio フォールバック
  }

  if (!bodyMarkdown || bodyMarkdown.length < 50) {
    let mainElement = $(
      'article, main, [role="main"], .content, .main-content, .post-content, .entry-content, #main, #content, #root, #__next, #react-root',
    );
    if (mainElement.length === 0) mainElement = $('body');
    const mainHtml = mainElement.html() || '';
    bodyMarkdown = turndown.turndown(mainHtml);
  }

  bodyMarkdown = bodyMarkdown
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // SPA かどうかの判定
  const hasJsDisabledNotice =
    bodyMarkdown.includes('JavaScript is disabled') ||
    bodyMarkdown.includes('JavaScript を有効に') ||
    bodyMarkdown.includes('You need to enable JavaScript');
  const isSpaFallbackNeeded = !isRendered && (bodyMarkdown.length < 50 || hasJsDisabledNotice);

  // YAML Frontmatter の構築
  const frontmatterLines: string[] = ['---'];
  frontmatterLines.push(`title: "${title.replace(/"/g, '\\"')}"`);
  frontmatterLines.push(`url: "${targetUrl}"`);
  if (ogImage) frontmatterLines.push(`ogImage: "${ogImage}"`);
  if (description) frontmatterLines.push(`description: "${description.replace(/"/g, '\\"')}"`);
  frontmatterLines.push('---\n\n');

  const fullMarkdown = frontmatterLines.join('\n') + bodyMarkdown;

  return {
    title,
    markdown: fullMarkdown,
    ogImage,
    description,
    isSpaFallbackNeeded,
  };
}

// ==========================================
// 5. Headless Chromium (Puppeteer + Stealth + Turnstile 突破)
// ==========================================
let sharedBrowser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.connected) {
    return sharedBrowser;
  }

  const browserlessUrl = process.env.BROWSERLESS_URL;
  if (browserlessUrl) {
    const wsUrl = browserlessUrl.replace(/^http/, 'ws');
    try {
      sharedBrowser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
      return sharedBrowser;
    } catch (e: any) {
      console.warn(`[web-fetcher] Failed to connect to BROWSERLESS_URL (${wsUrl}), falling back to local launch:`, e?.message);
    }
  }

  sharedBrowser = await puppeteer.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
    ],
  });

  return sharedBrowser;
}

export async function fetchWithStealthBrowser(targetUrl: string, maxChars: number): Promise<ScrapeResult> {
  const browser = await getBrowser();
  const page: Page = await browser.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    });

    // Stealth 偽装
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      (globalThis as any).chrome = { runtime: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    // 画像・フォントの遮断 (高速化)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ページ遷移
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Cloudflare Turnstile 自動突破 (絶対座標マウスインジェクション)
    try {
      const turnstileIframe = await page.$('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
      if (turnstileIframe) {
        const box = await turnstileIframe.boundingBox();
        if (box) {
          const clickX = box.x + 28;
          const clickY = box.y + box.height / 2;
          await page.mouse.move(clickX, clickY, { steps: 20 });
          await new Promise((r) => setTimeout(r, 150));
          await page.mouse.click(clickX, clickY);

          await Promise.race([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }),
            new Promise((r) => setTimeout(r, 4000)),
          ]).catch(() => {});
        }
      }
    } catch {
      // Turnstile がない場合はスルー
    }

    // 描画待機
    await new Promise((r) => setTimeout(r, 1000));
    const rawHtml = await page.content();

    const { title, markdown, ogImage, description } = convertHtmlToMarkdown(
      rawHtml,
      targetUrl,
      maxChars,
      true,
    );

    const isTruncated = markdown.length > maxChars;
    const finalContent = markdown.slice(0, maxChars);

    return {
      url: targetUrl,
      title,
      content: finalContent,
      isTruncated,
      contentType: 'text/html',
      renderedWithBrowser: true,
      ogImage,
      description,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ==========================================
// 6. 安全なリダイレクト追従付き静的 HTTP Fetch
// ==========================================
export async function fetchWithSafeRedirects(
  initialUrl: string,
  timeoutMs: number,
  maxRedirects = 5,
): Promise<{ response: Response; finalUrl: string } | null> {
  let currentUrl = initialUrl;

  for (let i = 0; i <= maxRedirects; i++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    if (isBlockedHostname(parsed.hostname)) {
      throw new Error(`セキュリティ上の理由からアクセスが拒否されました: "${parsed.hostname}"`);
    }

    await throttleDomain(parsed.hostname);

    const res = await fetch(currentUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) return null;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { response: res, finalUrl: currentUrl };
  }

  throw new Error(`リダイレクト回数が上限 (${maxRedirects}) を超えました: ${initialUrl}`);
}

// ==========================================
// 7. コア Scrape 処理 (Level 1 静的 -> Level 2 Browser 自動エスカレーション)
// ==========================================
export async function scrapeUrl(options: {
  url: string;
  maxChars?: number;
  fastOnly?: boolean;
  timeoutMs?: number;
  noCache?: boolean;
}): Promise<ScrapeResult> {
  const targetUrl = options.url;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const fastOnly = options.fastOnly ?? false;
  const timeoutMs = options.timeoutMs ?? 10000;
  const noCache = options.noCache ?? false;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new Error(`無効な URL です: ${targetUrl}`);
  }

  if (isBlockedHostname(parsedUrl.hostname)) {
    throw new Error(`セキュリティ上の理由からアクセスが拒否されました: "${parsedUrl.hostname}"`);
  }

  const cacheKey = `scrape:${targetUrl}:${maxChars}`;
  if (!noCache) {
    const cached = getFromCache<ScrapeResult>(cacheKey);
    if (cached) return cached;
  }

  let staticResult: {
    title: string;
    markdown: string;
    isSpaFallbackNeeded: boolean;
    contentType: string;
    ogImage?: string;
    description?: string;
  } | null = null;

  try {
    const fetchRes = await fetchWithSafeRedirects(targetUrl, timeoutMs);

    if (fetchRes && fetchRes.response.ok) {
      const response = fetchRes.response;
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/plain') || contentType.includes('application/json')) {
        const rawText = await response.text();
        const trimmed = rawText.slice(0, maxChars);
        const result: ScrapeResult = {
          url: fetchRes.finalUrl,
          title: new URL(fetchRes.finalUrl).hostname,
          content: trimmed,
          isTruncated: rawText.length > maxChars,
          contentType,
          renderedWithBrowser: false,
        };
        if (!noCache) setToCache(cacheKey, result);
        return result;
      }

      if (contentType.includes('text/html') || !contentType) {
        const rawHtml = await response.text();
        const { title, markdown, ogImage, description, isSpaFallbackNeeded } = convertHtmlToMarkdown(
          rawHtml,
          fetchRes.finalUrl,
          maxChars,
          false,
        );
        staticResult = { title, markdown, isSpaFallbackNeeded, contentType, ogImage, description };

        if (!isSpaFallbackNeeded || fastOnly) {
          const isTruncated = markdown.length > maxChars;
          const result: ScrapeResult = {
            url: fetchRes.finalUrl,
            title,
            content: markdown.slice(0, maxChars),
            isTruncated,
            contentType,
            renderedWithBrowser: false,
            ogImage,
            description,
          };
          if (!noCache) setToCache(cacheKey, result);
          return result;
        }
      }
    } else if (fetchRes && [403, 429, 503].includes(fetchRes.response.status)) {
      console.warn(`[web-fetcher] HTTP ${fetchRes.response.status} detected for "${targetUrl}", escalating to Browserless Chromium`);
    }
  } catch (err: any) {
    if (err.message?.includes('セキュリティ上の理由')) {
      throw err;
    }
    if (!fastOnly) {
      console.warn(`[web-fetcher] Static fetch failed for "${targetUrl}", escalating to Browserless Chromium:`, err?.message);
    }
  }

  if (fastOnly) {
    if (staticResult && staticResult.markdown.trim().length > 0) {
      const isTruncated = staticResult.markdown.length > maxChars;
      const result: ScrapeResult = {
        url: targetUrl,
        title: staticResult.title,
        content: staticResult.markdown.slice(0, maxChars),
        isTruncated,
        contentType: staticResult.contentType,
        renderedWithBrowser: false,
        ogImage: staticResult.ogImage,
        description: staticResult.description,
      };
      if (!noCache) setToCache(cacheKey, result);
      return result;
    }
    throw new Error(`ページの取得に失敗しました (fastOnly): ${targetUrl}`);
  }

  // Level 2: Headless Chromium (Puppeteer)
  try {
    const result = await fetchWithStealthBrowser(targetUrl, maxChars);
    if (!noCache) setToCache(cacheKey, result);
    return result;
  } catch (browserErr: any) {
    console.warn(`[web-fetcher] Browserless render failed for "${targetUrl}":`, browserErr?.message);

    if (staticResult) {
      const isTruncated = staticResult.markdown.length > maxChars;
      const result: ScrapeResult = {
        url: targetUrl,
        title: staticResult.title,
        content: staticResult.markdown.slice(0, maxChars),
        isTruncated,
        contentType: staticResult.contentType,
        renderedWithBrowser: false,
        ogImage: staticResult.ogImage,
        description: staticResult.description,
      };
      if (!noCache) setToCache(cacheKey, result);
      return result;
    }

    throw new Error(`ページの取得に失敗しました: ${targetUrl} (${browserErr?.message})`);
  }
}

// ==========================================
// 8. Yahoo-Japan-Search-MCP 実行 (ステートレス 5ms 起動)
// ==========================================
export async function callYahooMcp(toolName: string, args: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(YAHOO_MCP_PATH, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn Yahoo MCP (${YAHOO_MCP_PATH}): ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0 && !stdout) {
        return reject(new Error(`Yahoo MCP exited with code ${code}: ${stderr}`));
      }

      // JSON-RPC のレスポンス行を探索
      const lines = stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const json = JSON.parse(lines[i]);
          if (json.id === 1 && json.result) {
            return resolve(json.result);
          }
        } catch {}
      }

      reject(new Error(`Invalid JSON-RPC response from Yahoo MCP: ${stdout}`));
    });

    // JSON-RPC 2.0 リクエストを送信
    const rpcPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }) + '\n';

    child.stdin.write(rpcPayload);
    child.stdin.end();
  });
}

// ==========================================
// 9. Firecrawl 互換 統合深層検索 (search_deep)
// ==========================================
export async function integratedSearch(options: {
  query: string;
  limit?: number;
  scrapeContent?: boolean;
  includeRealtime?: boolean;
  maxChars?: number;
  noCache?: boolean;
}): Promise<Record<string, any>> {
  const query = options.query;
  const limit = Math.min(options.limit ?? 3, 10);
  const scrapeContent = options.scrapeContent !== false; // default: true
  const includeRealtime = options.includeRealtime !== false; // default: true
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const noCache = options.noCache ?? false;

  const cacheKey = `search:integrated:${query}:${limit}:${scrapeContent}:${includeRealtime}`;
  if (!noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return cached;
  }

  // 1. Yahoo Web 検索 と リアルタイム検索を並行実行
  const [webMcpRes, realtimeMcpRes] = await Promise.all([
    callYahooMcp('yahoo_web_search', { query }),
    includeRealtime
      ? callYahooMcp('yahoo_realtime_search', { query }).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Web 検索結果のパース
  const webContent = webMcpRes?.content?.[0]?.text || '[]';
  let searchResults: any[] = [];
  try {
    searchResults = JSON.parse(webContent);
  } catch {
    searchResults = [];
  }

  if (!Array.isArray(searchResults)) {
    searchResults = (searchResults as any).results || (searchResults as any).items || [];
  }

  const topItems = searchResults.slice(0, limit);

  // リアルタイム検索結果のパース
  let realtimeItems: any[] = [];
  if (realtimeMcpRes) {
    const rtContent = realtimeMcpRes?.content?.[0]?.text || '[]';
    try {
      const parsed = JSON.parse(rtContent);
      realtimeItems = Array.isArray(parsed) ? parsed : (parsed?.items || parsed?.results || []);
    } catch {
      realtimeItems = [];
    }
  }

  // 2. 上位サイトの並行スクレイプ
  let enrichedResults = topItems;
  if (scrapeContent) {
    enrichedResults = await Promise.all(
      topItems.map(async (item: any) => {
        const itemUrl = item.url || item.link;
        if (!itemUrl) return item;
        try {
          const scrape = await scrapeUrl({
            url: itemUrl,
            maxChars,
            timeoutMs: 12000,
          });
          return {
            ...item,
            markdown: scrape.content,
            ogImage: scrape.ogImage,
            description: scrape.description,
            cached: scrape.cached,
          };
        } catch (e: any) {
          return {
            ...item,
            scrapeError: e?.message,
          };
        }
      }),
    );
  }

  const finalResponse: Record<string, any> = {
    query,
    results: enrichedResults,
    count: enrichedResults.length,
    cached: false,
  };

  if (includeRealtime && realtimeItems.length > 0) {
    finalResponse.realtime = {
      count: realtimeItems.length,
      items: realtimeItems,
    };
  }

  if (!noCache) setToCache(cacheKey, finalResponse);
  return finalResponse;
}
