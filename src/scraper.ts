import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { extractText, getMeta } from 'unpdf';
import { XMLParser } from 'fast-xml-parser';
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

export const PORT = parseInt(process.env.PORT || '8000', 10);
export const DEFAULT_MAX_CHARS = 30_000;
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function resolveChromiumPath(): string | undefined {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  if (existsSync('/usr/bin/chromium')) return '/usr/bin/chromium';
  if (existsSync('/usr/bin/google-chrome')) return '/usr/bin/google-chrome';
  if (existsSync('/usr/bin/chromium-browser')) return '/usr/bin/chromium-browser';
  try {
    const { execSync } = require('child_process');
    const path = execSync('which chromium 2>/dev/null || which google-chrome 2>/dev/null', { encoding: 'utf8' }).trim();
    if (path && existsSync(path)) return path;
  } catch {}
  return undefined;
}

// Chromium のパス判定 (コンテナ内 または ホスト環境)
export const CHROME_EXECUTABLE_PATH = resolveChromiumPath();

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
  source: 'web';
  renderedWithBrowser?: boolean;
  cached?: boolean;
  ogImage?: string;
  description?: string;
  highlights?: string[];
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
// ==========================================
// SPA / Bot チャレンジ / JS 必須ページのインテリジェント自動検知
// ==========================================
export function checkIfSpaFallbackNeeded(rawHtml: string, bodyMarkdown: string, isRendered: boolean): boolean {
  if (isRendered) return false;

  const lowerHtml = rawHtml.toLowerCase();
  const lowerBody = bodyMarkdown.toLowerCase();

  // 1. 本文が極端に短い
  if (bodyMarkdown.trim().length < 80) return true;

  // 2. JavaScript 無効化 / 必要の警告
  const jsWarningPatterns = [
    'javascript is disabled',
    'javascript を有効に',
    'you need to enable javascript',
    'enable javascript to continue',
    'javascript required',
    'please enable javascript',
    'javascript is required',
    'requires javascript',
  ];
  if (jsWarningPatterns.some((p) => lowerBody.includes(p) || lowerHtml.includes(p))) {
    return true;
  }

  // 3. Bot チャレンジ / WAF / Cloudflare / Turnstile 画面
  const botChallengePatterns = [
    'just a moment...',
    'checking your browser',
    'checking if the site connection is secure',
    'verify you are human',
    'verify that you are not a robot',
    'attention required! | cloudflare',
    'challenges.cloudflare.com',
    'cf-turnstile',
    'datadome',
    'perimeterx',
    'security check',
    'アクセスが制限されています',
  ];
  if (botChallengePatterns.some((p) => lowerHtml.includes(p) || lowerBody.includes(p))) {
    return true;
  }

  // 4. SPA ルート要素が存在し、かつ本文が希薄（DOM 未マウント状態）
  const hasSpaRoot =
    /<div[^>]+id=["'](root|__next|__nuxt|app|main-app|react-root)["'][^>]*>\s*<\/div>/i.test(rawHtml) ||
    /<app-root[^>]*>\s*<\/app-root>/i.test(rawHtml);
  if (hasSpaRoot && bodyMarkdown.length < 350) {
    return true;
  }

  // 5. ローディング・プレースホルダー状態
  const trimmedLines = bodyMarkdown.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (trimmedLines.length <= 4 && trimmedLines.some((l) => /^(loading|読み込み中|please wait)[\.…]*$/i.test(l))) {
    return true;
  }

  return false;
}

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

  // SPA かどうかの自動判定
  const isSpaFallbackNeeded = checkIfSpaFallbackNeeded(rawHtml, bodyMarkdown, isRendered);

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

    // Stealth 偽装 (bot.sannysoft.com, Cloudflare, Akamai, DataDome 回避)
    await page.evaluateOnNewDocument(() => {
      const g = globalThis as any;
      // 1. navigator.webdriver 完全隠蔽 (プロトタイプからの削除)
      try {
        delete (Object.getPrototypeOf(navigator) as any).webdriver;
      } catch {}
      try {
        delete (navigator as any).webdriver;
      } catch {}
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // 2. window.chrome オブジェクト完全模倣
      g.chrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
        runtime: {
          OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        },
        csi: function () {},
        loadTimes: function () {},
      };

      // 3. navigator.languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['ja-JP', 'ja', 'en-US', 'en'],
      });

      // 4. navigator.plugins & mimeTypes
      const fakePlugins = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];
      Object.defineProperty(navigator, 'plugins', {
        get: () => fakePlugins,
      });

      // 5. Permissions API 偽装
      if ((navigator as any).permissions && (navigator as any).permissions.query) {
        const origQuery = (navigator as any).permissions.query;
        (navigator as any).permissions.query = (parameters: any) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: (g.Notification?.permission === 'granted') ? 'granted' : 'prompt' })
            : origQuery(parameters);
      }

      // 6. WebGL Vendor & Renderer 偽装 (SwiftShader 隠蔽)
      if (g.WebGLRenderingContext) {
        const getParameter = g.WebGLRenderingContext.prototype.getParameter;
        g.WebGLRenderingContext.prototype.getParameter = function (parameter: any) {
          if (parameter === 37445) return 'Google Inc. (Intel)'; // UNMASKED_VENDOR_WEBGL
          if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'; // UNMASKED_RENDERER_WEBGL
          return getParameter.apply(this, [parameter]);
        };
      }
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
      source: 'web',
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
// 7. PDF ドキュメントの Markdown 変換 (unpdf)
// ==========================================
export async function parsePdfToMarkdown(
  pdfBuffer: ArrayBuffer | Uint8Array,
  targetUrl: string,
  maxChars: number,
): Promise<ScrapeResult> {
  const { text, totalPages } = await extractText(new Uint8Array(pdfBuffer));
  const fullText = Array.isArray(text) ? text.join('\n\n--- [Page Break] ---\n\n') : String(text || '');
  let title = new URL(targetUrl).pathname.split('/').pop() || 'PDF Document';
  try {
    const meta = await getMeta(new Uint8Array(pdfBuffer));
    if (meta?.info?.Title) {
      title = String(meta.info.Title);
    }
  } catch {}

  const isTruncated = fullText.length > maxChars;
  const slicedText = fullText.slice(0, maxChars);

  const frontmatter = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `url: "${targetUrl}"`,
    `totalPages: ${totalPages}`,
    'contentType: "application/pdf"',
    '---\n\n',
  ].join('\n');

  return {
    url: targetUrl,
    title,
    content: frontmatter + slicedText,
    isTruncated,
    contentType: 'application/pdf',
    source: 'web',
    renderedWithBrowser: false,
  };
}

// ==========================================
// 8. クエリ関連ハイライト抽出 (Tavily 互換)
// ==========================================
export function extractQueryHighlights(content: string, query: string, maxHighlights = 4): string[] {
  if (!query || !content) return [];
  const terms = query
    .split(/[\s　]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  const paragraphs = content
    .split(/\n{2,}|\n(?=[#*-])/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20 && !p.startsWith('---'));

  const scored: { text: string; score: number }[] = [];

  for (const para of paragraphs) {
    const lower = para.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const occurrences = (lower.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      score += occurrences * (term.length >= 4 ? 2 : 1);
    }
    if (score > 0) {
      const snippet = para.length > 300 ? para.slice(0, 300) + '...' : para;
      scored.push({ text: snippet, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxHighlights).map((s) => s.text);
}

// ==========================================
// 9. ドメインフィルタリング (includeDomains / excludeDomains)
// ==========================================
export function filterByDomains(
  items: any[],
  includeDomains?: string[],
  excludeDomains?: string[],
): any[] {
  let filtered = items;

  if (includeDomains && includeDomains.length > 0) {
    const normalizedInc = includeDomains.map((d) => d.toLowerCase().trim());
    filtered = filtered.filter((item) => {
      const itemUrl = item.url || item.link;
      if (!itemUrl) return false;
      try {
        const host = new URL(itemUrl).hostname.toLowerCase();
        return normalizedInc.some((inc) => host === inc || host.endsWith('.' + inc));
      } catch {
        return false;
      }
    });
  }

  if (excludeDomains && excludeDomains.length > 0) {
    const normalizedExc = excludeDomains.map((d) => d.toLowerCase().trim());
    filtered = filtered.filter((item) => {
      const itemUrl = item.url || item.link;
      if (!itemUrl) return true;
      try {
        const host = new URL(itemUrl).hostname.toLowerCase();
        return !normalizedExc.some((exc) => host === exc || host.endsWith('.' + exc));
      } catch {
        return true;
      }
    });
  }

  return filtered;
}

export async function scrapeUrl(options: {
  url: string;
  maxChars?: number;
  mode?: 'auto' | 'fast' | 'browser';
  fastOnly?: boolean;
  renderJs?: boolean;
  timeoutMs?: number;
  noCache?: boolean;
  query?: string;
  extractHighlights?: boolean;
}): Promise<ScrapeResult> {
  const targetUrl = options.url;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const timeoutMs = options.timeoutMs ?? 10000;
  const noCache = options.noCache ?? false;
  const query = options.query;
  const shouldExtractHighlights = options.extractHighlights ?? false;

  // 競合チェック & 動作モードの解決
  if (options.fastOnly && options.renderJs) {
    throw new Error('`fastOnly: true` と `renderJs: true` は同時に指定できません。`mode: "auto" | "fast" | "browser"` を指定してください。');
  }

  const effectiveMode: 'auto' | 'fast' | 'browser' =
    options.mode ?? (options.fastOnly ? 'fast' : options.renderJs ? 'browser' : 'auto');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new Error(`無効な URL です: ${targetUrl}`);
  }

  if (isBlockedHostname(parsedUrl.hostname)) {
    throw new Error(`セキュリティ上の理由からアクセスが拒否されました: "${parsedUrl.hostname}"`);
  }

  const cacheKey = `scrape:${targetUrl}:${maxChars}:${shouldExtractHighlights}:${query || ''}:${effectiveMode}`;
  if (!noCache) {
    const cached = getFromCache<ScrapeResult>(cacheKey);
    if (cached) return cached;
  }

  // mode: "browser" の場合は Level 1 をスキップして直接 Chromium 実行
  if (effectiveMode === 'browser') {
    const result = await fetchWithStealthBrowser(targetUrl, maxChars);
    if (shouldExtractHighlights && query) {
      result.highlights = extractQueryHighlights(result.content, query);
    }
    if (!noCache) setToCache(cacheKey, result);
    return result;
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

      // PDF の場合: unpdf でテキスト抽出
      if (contentType.includes('application/pdf') || fetchRes.finalUrl.toLowerCase().endsWith('.pdf')) {
        const arrayBuf = await response.arrayBuffer();
        const pdfResult = await parsePdfToMarkdown(arrayBuf, fetchRes.finalUrl, maxChars);
        if (shouldExtractHighlights && query) {
          pdfResult.highlights = extractQueryHighlights(pdfResult.content, query);
        }
        if (!noCache) setToCache(cacheKey, pdfResult);
        return pdfResult;
      }

      if (contentType.includes('text/plain') || contentType.includes('application/json')) {
        const rawText = await response.text();
        const trimmed = rawText.slice(0, maxChars);
        const result: ScrapeResult = {
          url: fetchRes.finalUrl,
          title: new URL(fetchRes.finalUrl).hostname,
          content: trimmed,
          isTruncated: rawText.length > maxChars,
          contentType,
          source: 'web',
          renderedWithBrowser: false,
        };
        if (shouldExtractHighlights && query) {
          result.highlights = extractQueryHighlights(trimmed, query);
        }
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

        if (!isSpaFallbackNeeded || effectiveMode === 'fast') {
          const isTruncated = markdown.length > maxChars;
          const result: ScrapeResult = {
            url: fetchRes.finalUrl,
            title,
            content: markdown.slice(0, maxChars),
            isTruncated,
            contentType,
            source: 'web',
            renderedWithBrowser: false,
            ogImage,
            description,
          };
          if (shouldExtractHighlights && query) {
            result.highlights = extractQueryHighlights(result.content, query);
          }
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
    if (effectiveMode !== 'fast') {
      console.warn(`[web-fetcher] Static fetch failed for "${targetUrl}", escalating to Browserless Chromium:`, err?.message);
    }
  }

  if (effectiveMode === 'fast') {
    if (staticResult && staticResult.markdown.trim().length > 0) {
      const isTruncated = staticResult.markdown.length > maxChars;
      const result: ScrapeResult = {
        url: targetUrl,
        title: staticResult.title,
        content: staticResult.markdown.slice(0, maxChars),
        isTruncated,
        contentType: staticResult.contentType,
        source: 'web',
        renderedWithBrowser: false,
        ogImage: staticResult.ogImage,
        description: staticResult.description,
      };
      if (shouldExtractHighlights && query) {
        result.highlights = extractQueryHighlights(result.content, query);
      }
      if (!noCache) setToCache(cacheKey, result);
      return result;
    }
    throw new Error(`ページの取得に失敗しました (fastOnly): ${targetUrl}`);
  }

  // Level 2: Headless Chromium (Puppeteer)
  try {
    const result = await fetchWithStealthBrowser(targetUrl, maxChars);
    if (shouldExtractHighlights && query) {
      result.highlights = extractQueryHighlights(result.content, query);
    }
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
        source: 'web',
        renderedWithBrowser: false,
        ogImage: staticResult.ogImage,
        description: staticResult.description,
      };
      if (shouldExtractHighlights && query) {
        result.highlights = extractQueryHighlights(result.content, query);
      }
      if (!noCache) setToCache(cacheKey, result);
      return result;
    }

    throw new Error(`ページの取得に失敗しました: ${targetUrl} (${browserErr?.message})`);
  }
}

// ==========================================
// 11. サイトマップ & URL マッピング (/map & map_site)
// ==========================================
export async function mapSiteUrl(options: {
  url: string;
  limit?: number;
  includeSubdomains?: boolean;
  timeoutMs?: number;
}): Promise<{ url: string; count: number; links: string[]; sitemapFound: boolean }> {
  const targetUrl = options.url;
  const limit = Math.min(options.limit ?? 100, 500);
  const includeSubdomains = options.includeSubdomains ?? false;
  const timeoutMs = options.timeoutMs ?? 10000;

  const parsed = new URL(targetUrl);
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(`セキュリティ上の理由からアクセスが拒否されました: "${parsed.hostname}"`);
  }

  const baseOrigin = parsed.origin;
  const baseHost = parsed.hostname.toLowerCase();
  const collectedUrls = new Set<string>();
  let sitemapFound = false;

  const sitemapCandidates = [
    `${baseOrigin}/sitemap.xml`,
    `${baseOrigin}/sitemap_index.xml`,
    `${baseOrigin}/sitemap-index.xml`,
  ];

  const parser = new XMLParser();

  for (const sitemapUrl of sitemapCandidates) {
    if (collectedUrls.size >= limit) break;
    try {
      const res = await fetchWithSafeRedirects(sitemapUrl, timeoutMs);
      if (res && res.response.ok) {
        const xmlText = await res.response.text();
        const parsedXml = parser.parse(xmlText);
        sitemapFound = true;

        if (parsedXml?.urlset?.url) {
          const rawUrls = Array.isArray(parsedXml.urlset.url) ? parsedXml.urlset.url : [parsedXml.urlset.url];
          for (const u of rawUrls) {
            const loc = typeof u === 'string' ? u : u?.loc;
            if (loc && typeof loc === 'string') {
              collectedUrls.add(loc.trim());
              if (collectedUrls.size >= limit) break;
            }
          }
        } else if (parsedXml?.sitemapindex?.sitemap) {
          const subSitemaps = Array.isArray(parsedXml.sitemapindex.sitemap)
            ? parsedXml.sitemapindex.sitemap
            : [parsedXml.sitemapindex.sitemap];
          for (const sub of subSitemaps.slice(0, 3)) {
            const subLoc = typeof sub === 'string' ? sub : sub?.loc;
            if (subLoc && typeof subLoc === 'string') {
              try {
                const subRes = await fetchWithSafeRedirects(subLoc, timeoutMs);
                if (subRes && subRes.response.ok) {
                  const subXml = parser.parse(await subRes.response.text());
                  const subUrlList = subXml?.urlset?.url
                    ? Array.isArray(subXml.urlset.url)
                      ? subXml.urlset.url
                      : [subXml.urlset.url]
                    : [];
                  for (const su of subUrlList) {
                    const loc = typeof su === 'string' ? su : su?.loc;
                    if (loc && typeof loc === 'string') {
                      collectedUrls.add(loc.trim());
                      if (collectedUrls.size >= limit) break;
                    }
                  }
                }
              } catch {}
            }
          }
        }
      }
    } catch {}
  }

  // サイトマップで見つからない、または件数が少ない場合は対象ページの内部リンクを抽出
  if (collectedUrls.size < limit) {
    try {
      const pageRes = await fetchWithSafeRedirects(targetUrl, timeoutMs);
      if (pageRes && pageRes.response.ok) {
        const html = await pageRes.response.text();
        const $ = cheerio.load(html);
        $('a[href]').each((_, el) => {
          if (collectedUrls.size >= limit) return false;
          const href = $(el).attr('href');
          if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
            return;
          }
          try {
            const abs = new URL(href, pageRes.finalUrl);
            const absHost = abs.hostname.toLowerCase();
            const isMatch = includeSubdomains
              ? absHost === baseHost || absHost.endsWith('.' + baseHost)
              : absHost === baseHost;
            if (isMatch && (abs.protocol === 'http:' || abs.protocol === 'https:')) {
              abs.hash = '';
              collectedUrls.add(abs.toString());
            }
          } catch {}
        });
      }
    } catch {}
  }

  const links = Array.from(collectedUrls).slice(0, limit);
  return {
    url: targetUrl,
    count: links.length,
    links,
    sitemapFound,
  };
}

// ==========================================
// 12. サブページ再帰的クロール (/crawl & crawl_site)
// ==========================================
export async function crawlSiteUrl(options: {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  scrapeContent?: boolean;
  maxChars?: number;
  timeoutMs?: number;
}): Promise<{
  url: string;
  count: number;
  results: ScrapeResult[];
}> {
  const rootUrl = options.url;
  const maxPages = Math.min(options.maxPages ?? 5, 20);
  const maxDepth = Math.min(options.maxDepth ?? 2, 5);
  const scrapeContent = options.scrapeContent !== false;
  const maxChars = options.maxChars ?? 15000;
  const timeoutMs = options.timeoutMs ?? 10000;

  const parsedRoot = new URL(rootUrl);
  if (isBlockedHostname(parsedRoot.hostname)) {
    throw new Error(`セキュリティ上の理由からアクセスが拒否されました: "${parsedRoot.hostname}"`);
  }
  const rootHost = parsedRoot.hostname.toLowerCase();

  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: rootUrl, depth: 0 }];
  const results: ScrapeResult[] = [];

  while (queue.length > 0 && results.length < maxPages) {
    const current = queue.shift()!;
    const normUrl = current.url.split('#')[0];
    if (visited.has(normUrl)) continue;
    visited.add(normUrl);

    try {
      const scraped = await scrapeUrl({
        url: normUrl,
        maxChars,
        timeoutMs,
        fastOnly: true,
      });
      results.push(scraped);

      if (current.depth < maxDepth && queue.length < maxPages * 3) {
        try {
          const fetchRes = await fetchWithSafeRedirects(normUrl, 5000);
          if (fetchRes && fetchRes.response.ok) {
            const html = await fetchRes.response.text();
            const $ = cheerio.load(html);
            $('a[href]').each((_, el) => {
              const href = $(el).attr('href');
              if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
              try {
                const abs = new URL(href, fetchRes.finalUrl);
                if (abs.hostname.toLowerCase() === rootHost && (abs.protocol === 'http:' || abs.protocol === 'https:')) {
                  abs.hash = '';
                  const nextUrl = abs.toString();
                  if (!visited.has(nextUrl) && !queue.some((q) => q.url === nextUrl)) {
                    queue.push({ url: nextUrl, depth: current.depth + 1 });
                  }
                }
              } catch {}
            });
          }
        } catch {}
      }
    } catch (err: any) {
      console.warn(`[web-fetcher/crawl] Error fetching ${normUrl}:`, err?.message);
    }
  }

  return {
    url: rootUrl,
    count: results.length,
    results,
  };
}

// ==========================================
// 13. Yahoo リアルタイム急上昇トレンド取得 (/search/trend & search_trend)
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

  setToCache(cacheKey, result);
  return result;
}

// ==========================================
// 14. Yahoo-Japan-Search-MCP 実行 (ステートレス 5ms 起動)
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
// 15. Yahoo Web 検索 (プレフィルタリング site: / -site: 対応)
// ==========================================
export async function searchYahooWeb(options: {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: 'all' | 'day' | 'week' | 'year';
}): Promise<any> {
  let effectiveWebQuery = options.query;
  let webSiteArg: string | undefined = undefined;

  if (options.includeDomains && options.includeDomains.length > 0) {
    if (options.includeDomains.length === 1) {
      webSiteArg = options.includeDomains[0];
    } else {
      effectiveWebQuery += ` (${options.includeDomains.map((d) => `site:${d}`).join(' OR ')})`;
    }
  }

  if (options.excludeDomains && options.excludeDomains.length > 0) {
    effectiveWebQuery += ` ${options.excludeDomains.map((d) => `-site:${d}`).join(' ')}`;
  }

  const mcpRes = await callYahooMcp('yahoo_web_search', {
    query: effectiveWebQuery,
    ...(webSiteArg ? { site: webSiteArg } : {}),
    ...(options.updated && options.updated !== 'all' ? { updated: options.updated } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '[]';
  let parsedData: any = content;
  try {
    const json = JSON.parse(content);
    if (json && Array.isArray(json.items)) {
      const filtered = filterByDomains(json.items, options.includeDomains, options.excludeDomains);
      json.items = filtered.map((item: any) => ({ source: 'web' as const, ...item }));
      json.count = json.items.length;
      json.source = 'web';
      parsedData = json;
    }
  } catch {}

  return parsedData;
}

// ==========================================
// 16. Firecrawl / Tavily 互換 統合深層検索 (search_deep)
// ==========================================
export async function integratedSearch(options: {
  query: string;
  limit?: number;
  scrapeContent?: boolean;
  includeRealtime?: boolean;
  maxChars?: number;
  noCache?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: 'all' | 'day' | 'week' | 'year';
  extractHighlights?: boolean;
}): Promise<Record<string, any>> {
  const query = options.query;
  const limit = Math.min(options.limit ?? 3, 10);
  const scrapeContent = options.scrapeContent !== false;
  const includeRealtime = options.includeRealtime !== false;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const noCache = options.noCache ?? false;
  const includeDomains = options.includeDomains;
  const excludeDomains = options.excludeDomains;
  const updated = options.updated;
  const extractHighlights = options.extractHighlights ?? false;
  const cacheKey = `search:integrated:${query}:${limit}:${scrapeContent}:${includeRealtime}:${(includeDomains || []).join(',')}:${(excludeDomains || []).join(',')}:${updated || 'all'}:${extractHighlights}`;
  if (!noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return cached;
  }

  // 1. Yahoo Web 検索 と リアルタイム検索を並行実行
  const [webParsedRes, realtimeMcpRes] = await Promise.all([
    searchYahooWeb({ query, includeDomains, excludeDomains, updated }),
    includeRealtime
      ? callYahooMcp('yahoo_realtime_search', { query }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const searchResults = Array.isArray(webParsedRes?.items)
    ? webParsedRes.items
    : Array.isArray(webParsedRes)
    ? webParsedRes
    : [];

  const topItems = searchResults.slice(0, limit);

  // リアルタイム検索結果のパース
  let realtimeItems: any[] = [];
  if (realtimeMcpRes) {
    const rtContent = realtimeMcpRes?.content?.[0]?.text || '[]';
    try {
      const parsed = JSON.parse(rtContent);
      const rawList = Array.isArray(parsed) ? parsed : (parsed?.items || parsed?.results || []);
      realtimeItems = rawList.map((item: any) => ({
        source: 'x' as const,
        ...item,
      }));
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
            query,
            extractHighlights,
          });
          return {
            ...item,
            markdown: scrape.content,
            ogImage: scrape.ogImage,
            description: scrape.description,
            highlights: scrape.highlights,
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
    source: 'integrated',
    results: enrichedResults,
    count: enrichedResults.length,
    cached: false,
  };

  if (includeRealtime && realtimeItems.length > 0) {
    finalResponse.realtime = {
      source: 'x',
      count: realtimeItems.length,
      items: realtimeItems,
    };
  }

  if (!noCache) setToCache(cacheKey, finalResponse);
  return finalResponse;
}
