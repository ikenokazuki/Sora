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

export async function getBrowser(proxyUrl?: string): Promise<{ browser: Browser; isDedicated: boolean }> {
  // プロキシ指定がある場合は専用の Chromium インスタンスを起動
  if (proxyUrl) {
    let proxyServerArg = proxyUrl;
    try {
      const parsedProxy = new URL(proxyUrl);
      proxyServerArg = `${parsedProxy.protocol}//${parsedProxy.host}`;
    } catch {}

    const dedicatedBrowser = await puppeteer.launch({
      executablePath: CHROME_EXECUTABLE_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
        `--proxy-server=${proxyServerArg}`,
      ],
    });
    return { browser: dedicatedBrowser, isDedicated: true };
  }

  if (sharedBrowser && sharedBrowser.connected) {
    return { browser: sharedBrowser, isDedicated: false };
  }

  const browserlessUrl = process.env.BROWSERLESS_URL;
  if (browserlessUrl) {
    const wsUrl = browserlessUrl.replace(/^http/, 'ws');
    try {
      sharedBrowser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
      return { browser: sharedBrowser, isDedicated: false };
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

  return { browser: sharedBrowser, isDedicated: false };
}

export async function fetchWithStealthBrowser(
  targetUrl: string,
  maxChars: number,
  proxyUrl?: string,
): Promise<ScrapeResult> {
  const { browser, isDedicated } = await getBrowser(proxyUrl);
  const page: Page = await browser.newPage();

  try {
    // プロキシ認証の設定 (ユーザー名・パスワードが含まれる場合)
    if (proxyUrl) {
      try {
        const parsedProxy = new URL(proxyUrl);
        if (parsedProxy.username || parsedProxy.password) {
          await page.authenticate({
            username: decodeURIComponent(parsedProxy.username),
            password: decodeURIComponent(parsedProxy.password),
          });
        }
      } catch {}
    }

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
    if (isDedicated) {
      await browser.close().catch(() => {});
    }
  }
}

// ==========================================
// 6. 安全なリダイレクト追従付き静的 HTTP Fetch (プロキシ対応)
// ==========================================
export async function fetchWithSafeRedirects(
  initialUrl: string,
  timeoutMs: number,
  maxRedirects = 5,
  proxyUrl?: string,
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

    const effectiveProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;

    const res = await (fetch as any)(currentUrl, {
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
      ...(effectiveProxy ? { proxy: effectiveProxy } : {}),
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
// 8. クエリ関連ハイライト抽出 (検索語句に関連する重要文を自動抽出)
// ==========================================
export function extractQueryHighlights(content: string, query: string, maxHighlights = 3): string[] {
  if (!query || !content) return [];
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  const paragraphs = content.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length >= 20 && !p.startsWith('---'));
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
  proxyUrl?: string;
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
  const proxyUrl = options.proxyUrl;

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

  const cacheKey = `scrape:${targetUrl}:${maxChars}:${shouldExtractHighlights}:${query || ''}:${effectiveMode}:${proxyUrl || ''}`;
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
    const result = await fetchWithStealthBrowser(targetUrl, maxChars, proxyUrl);
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
  proxyUrl?: string;
}): Promise<{ url: string; count: number; links: string[]; sitemapFound: boolean }> {
  const targetUrl = options.url;
  const limit = Math.min(options.limit ?? 100, 500);
  const includeSubdomains = options.includeSubdomains ?? false;
  const timeoutMs = options.timeoutMs ?? 10000;
  const proxyUrl = options.proxyUrl;

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
      const res = await fetchWithSafeRedirects(sitemapUrl, timeoutMs, 5, proxyUrl);
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
                const subRes = await fetchWithSafeRedirects(subLoc, timeoutMs, 5, proxyUrl);
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
      const pageRes = await fetchWithSafeRedirects(targetUrl, timeoutMs, 5, proxyUrl);
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
  proxyUrl?: string;
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
  const proxyUrl = options.proxyUrl;

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
        proxyUrl,
      });
      results.push(scraped);

      if (current.depth < maxDepth && queue.length < maxPages * 3) {
        try {
          const fetchRes = await fetchWithSafeRedirects(normUrl, 5000, 5, proxyUrl);
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
  proxyUrl?: string;
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
  const proxyUrl = options.proxyUrl;
  const extractHighlights = options.extractHighlights ?? false;
  const cacheKey = `search:integrated:${query}:${limit}:${scrapeContent}:${includeRealtime}:${(includeDomains || []).join(',')}:${(excludeDomains || []).join(',')}:${updated || 'all'}:${extractHighlights}:${proxyUrl || ''}`;
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
            proxyUrl,
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

// ==========================================
// 17. Yahoo 画像検索
// ==========================================
export async function searchYahooImage(options: {
  query: string;
  limit?: number;
  page?: number;
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_image_search', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.page ? { page: options.page } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'image';
    if (Array.isArray(json.items)) {
      json.items = json.items.map((item: any) => ({ source: 'image' as const, ...item }));
    }
    return json;
  } catch {
    return { source: 'image', raw: content };
  }
}

// ==========================================
// 18. Yahoo 動画検索
// ==========================================
export async function searchYahooVideo(options: {
  query: string;
  limit?: number;
  page?: number;
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_video_search', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.page ? { page: options.page } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'video';
    if (Array.isArray(json.items)) {
      json.items = json.items.map((item: any) => ({ source: 'video' as const, ...item }));
    }
    return json;
  } catch {
    return { source: 'video', raw: content };
  }
}

// ==========================================
// 19. Yahoo ニュース検索
// ==========================================
export async function searchYahooNews(options: {
  query: string;
  limit?: number;
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_news_search', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'news';
    if (Array.isArray(json.items)) {
      json.items = json.items.map((item: any) => ({ source: 'news' as const, ...item }));
    }
    return json;
  } catch {
    return { source: 'news', raw: content };
  }
}

// ==========================================
// 20. Yahoo 知恵袋検索
// ==========================================
export async function searchYahooChiebukuro(options: {
  query: string;
  limit?: number;
  page?: number;
  status?: 'all' | 'open' | 'vote' | 'solved';
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_chiebukuro_search', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.page ? { page: options.page } : {}),
    ...(options.status && options.status !== 'all' ? { status: options.status } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'chiebukuro';
    if (Array.isArray(json.items)) {
      json.items = json.items.map((item: any) => ({ source: 'chiebukuro' as const, ...item }));
    }
    return json;
  } catch {
    return { source: 'chiebukuro', raw: content };
  }
}

// ==========================================
// 21. Yahoo サジェスト（キーワード補完）
// ==========================================
export async function getSuggestedKeywords(options: {
  query: string;
  limit?: number;
}): Promise<any> {
  const mcpRes = await callYahooMcp('yahoo_suggest_keywords', {
    query: options.query,
    ...(options.limit ? { limit: options.limit } : {}),
  });

  const content = mcpRes?.content?.[0]?.text || '{}';
  try {
    const json = JSON.parse(content);
    json.source = 'suggest';
    return json;
  } catch {
    return { source: 'suggest', raw: content };
  }
}

// ==========================================
// 22. 乗換案内（Yahoo! 路線情報スクレイピング）
// ==========================================

/** 乗り換えルート検索のパラメータ */
export interface TransitSearchOptions {
  from: string;
  to: string;
  via?: string[];
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  timeType?: 'departure' | 'arrival' | 'first_train' | 'last_train' | 'unspecified';
  ticket?: 'ic' | 'cash';
  seatPreference?: 'non_reserved' | 'reserved' | 'green';
  walkSpeed?: 'fast' | 'slightly_fast' | 'slightly_slow' | 'slow';
  sortBy?: 'time' | 'transfer' | 'fare';
  useAirline?: boolean;
  useShinkansen?: boolean;
  useExpress?: boolean;
  useHighwayBus?: boolean;
  useLocalBus?: boolean;
  useFerry?: boolean;
}

/** 乗換案内の URL パラメータを組み立てる */
function buildTransitUrl(opts: TransitSearchOptions): string {
  const base = 'https://transit.yahoo.co.jp/search/result';
  const params = new URLSearchParams();

  params.set('from', opts.from);
  params.set('to', opts.to);
  params.set('flatlon', '');
  params.set('tlatlon', '');

  // 経由駅（最大3駅）
  const via = opts.via || [];
  for (let i = 0; i < 3; i++) {
    params.set(`via${i + 1}`, via[i] || '');
    params.set(`viacode${i + 1}`, '');
  }

  // 日時
  const now = new Date();
  params.set('y', String(opts.year || now.getFullYear()));
  params.set('m', String(opts.month || now.getMonth() + 1).padStart(2, '0'));
  params.set('d', String(opts.day || now.getDate()).padStart(2, '0'));
  params.set('hh', String(opts.hour ?? now.getHours()).padStart(2, '0'));
  params.set('m1', String(Math.floor((opts.minute ?? now.getMinutes()) / 10)));
  params.set('m2', String((opts.minute ?? now.getMinutes()) % 10));

  // 時刻タイプ
  const timeTypeMap: Record<string, string> = {
    departure: '1',
    arrival: '4',
    first_train: '3',
    last_train: '2',
    unspecified: '1',
  };
  params.set('type', timeTypeMap[opts.timeType || 'departure'] || '1');

  // 運賃タイプ
  params.set('ticket', opts.ticket === 'cash' ? 'normal' : 'ic');

  // 座席指定
  const seatMap: Record<string, string> = { non_reserved: '0', reserved: '1', green: '2' };
  params.set('shin', seatMap[opts.seatPreference || 'non_reserved'] || '0');

  // 歩く速度
  const walkMap: Record<string, string> = { fast: '1', slightly_fast: '2', slightly_slow: '3', slow: '4' };
  params.set('ws', walkMap[opts.walkSpeed || 'slightly_slow'] || '3');

  // 並び順
  const sortMap: Record<string, string> = { time: '0', transfer: '1', fare: '2' };
  params.set('s', sortMap[opts.sortBy || 'time'] || '0');

  // 交通手段フラグ
  params.set('al', opts.useAirline !== false ? '1' : '0');
  params.set('shin', opts.useShinkansen !== false ? '1' : '0');
  params.set('ex', opts.useExpress !== false ? '1' : '0');
  params.set('hb', opts.useHighwayBus !== false ? '1' : '0');
  params.set('lb', opts.useLocalBus !== false ? '1' : '0');
  params.set('sr', opts.useFerry !== false ? '1' : '0');

  params.set('kw', opts.from);

  return `${base}?${params.toString()}`;
}

/** HTML からルート情報をパースする */
function parseTransitHtml(html: string, opts: TransitSearchOptions): any {
  const $ = cheerio.load(html);
  const routes: any[] = [];

  // 各ルートブロックを解析
  $('.routeList .route, .routeDetail, #route01, #route02, #route03, #route04, #route05, .routeCand').each((i, el) => {
    const routeEl = $(el);

    // ルートサマリー情報
    const summary = routeEl.find('.summary, .routeSummary').first();
    const timeText = summary.find('.time, .reqTime').text().trim() || routeEl.find('.time').first().text().trim();
    const transferText = summary.find('.transfer, .transfer-num').text().trim() || routeEl.find('.transfer').first().text().trim();
    const fareText = summary.find('.fare, .fare-num').text().trim() || routeEl.find('.fare').first().text().trim();

    // 区間詳細
    const sections: any[] = [];
    routeEl.find('.section, li.routeDetail, .access, .routeStep').each((j, sec) => {
      const secEl = $(sec);
      const lineName = secEl.find('.lineName, .transport, .name').text().trim();
      const fromStation = secEl.find('.staName .from, .dep .name, .startName').text().trim();
      const toStation = secEl.find('.staName .to, .arr .name, .endName').text().trim();
      const depTime = secEl.find('.dep .time, .depTime, .startTime').text().trim();
      const arrTime = secEl.find('.arr .time, .arrTime, .endTime').text().trim();

      if (lineName || fromStation || toStation) {
        sections.push({
          line: lineName || undefined,
          from: fromStation || undefined,
          to: toStation || undefined,
          departureTime: depTime || undefined,
          arrivalTime: arrTime || undefined,
        });
      }
    });

    if (timeText || fareText || sections.length > 0) {
      routes.push({
        index: i + 1,
        totalTime: timeText || undefined,
        transfers: transferText || undefined,
        fare: fareText || undefined,
        sections: sections.length > 0 ? sections : undefined,
      });
    }
  });

  // フォールバック: routeList 形式でなかった場合、より汎用的にパース
  if (routes.length === 0) {
    // .navResult 内のテキストを抽出
    const resultSummaries: any[] = [];
    $('#srline, .elmRouteDetail, #rsltlst li').each((i, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > 10) {
        resultSummaries.push({
          index: i + 1,
          summary: text.substring(0, 500),
        });
      }
    });
    if (resultSummaries.length > 0) {
      return {
        source: 'transit',
        from: opts.from,
        to: opts.to,
        via: opts.via,
        routes: resultSummaries,
        note: 'Summary mode: structured parsing did not match, providing raw summaries.',
      };
    }

    // 最終フォールバック: ページ全体のテキストから関連部分を抽出
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const transitSection = bodyText.substring(0, 2000);
    return {
      source: 'transit',
      from: opts.from,
      to: opts.to,
      via: opts.via,
      rawText: transitSection,
      note: 'Could not parse structured route data. Providing raw text.',
    };
  }

  return {
    source: 'transit',
    from: opts.from,
    to: opts.to,
    via: opts.via,
    routeCount: routes.length,
    routes,
  };
}

/** 乗換案内のメイン関数 */
export async function searchTransitRoute(opts: TransitSearchOptions): Promise<any> {
  const cacheKey = `transit:${opts.from}:${opts.to}:${(opts.via || []).join(',')}:${opts.year || ''}:${opts.month || ''}:${opts.day || ''}:${opts.hour ?? ''}:${opts.minute ?? ''}:${opts.timeType || 'departure'}`;
  const cached = getFromCache<any>(cacheKey);
  if (cached) return cached;

  const url = buildTransitUrl(opts);

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.5',
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Transit returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const result = parseTransitHtml(html, opts);

  setToCache(cacheKey, result);
  return result;
}

// ==========================================
// 23. 天気予報 API (weather.tsukumijima.net / livedoor 天気互換)
// ==========================================

export const JAPAN_CITY_MAP: Record<string, string> = {
  // 北海道
  '稚内': '011000', '旭川': '012010', '留萌': '012020', '網走': '013010', '北見': '013020', '紋別': '013030',
  '根室': '014010', '釧路': '014020', '帯広': '014030', '室蘭': '015010', '浦河': '015020', '札幌': '016010',
  '岩見沢': '016020', '倶知安': '016030', '函館': '017010', '江差': '017020', '北海道': '016010',
  // 東北
  '青森': '020010', 'むつ': '020020', '八戸': '020030', '青森県': '020010',
  '盛岡': '030010', '宮古': '030020', '大船渡': '030030', '岩手県': '030010', '岩手': '030010',
  '仙台': '040010', '白石': '040020', '宮城県': '040010', '宮城': '040010',
  '秋田': '050010', '横手': '050020', '秋田県': '050010',
  '山形': '060010', '米沢': '060020', '酒田': '060030', '新庄': '060040', '山形県': '060010',
  '福島': '070010', '小名浜': '070020', '若松': '070030', '福島県': '070010', '会津若松': '070030', 'いわき': '070020',
  // 関東
  '水戸': '080010', '土浦': '080020', '茨城県': '080010', '茨城': '080010',
  '宇都宮': '090010', '大田原': '090020', '栃木県': '090010', '栃木': '090010',
  '前橋': '100010', 'みなかみ': '100020', '群馬県': '100010', '群馬': '100010',
  'さいたま': '110010', '熊谷': '110020', '秩父': '110030', '埼玉県': '110010', '埼玉': '110010',
  '千葉': '120010', '銚子': '120020', '館山': '120030', '千葉県': '120010',
  '東京': '130010', '東京都': '130010', '大島': '130020', '八丈島': '130030', '父島': '130040', '小笠原': '130040',
  '横浜': '140010', '小田原': '140020', '神奈川県': '140010', '神奈川': '140010',
  // 甲信越・北陸
  '新潟': '150010', '長岡': '150020', '高田': '150030', '相川': '150040', '新潟県': '150010', '佐渡': '150040', '上越': '150030',
  '富山': '160010', '伏木': '160020', '富山県': '160010', '高岡': '160020',
  '金沢': '170010', '輪島': '170020', '石川県': '170010', '石川': '170010', '能登': '170020',
  '福井': '180010', '敦賀': '180020', '福井県': '180010',
  '甲府': '190010', '富士河口湖': '190020', '河口湖': '190020', '山梨県': '190010', '山梨': '190010',
  '長野': '200010', '松本': '200020', '飯田': '200030', '長野県': '200010',
  // 東海
  '岐阜': '210010', '高山': '210020', '岐阜県': '210010', '飛騨': '210020',
  '静岡': '220010', '網代': '220020', '三島': '220030', '浜松': '220040', '静岡県': '220010', '熱海': '220020',
  '名古屋': '230010', '豊橋': '230020', '愛知県': '230010', '愛知': '230010',
  '津': '240010', '尾鷲': '240020', '三重県': '240010', '三重': '240010', '伊勢': '240010',
  // 近畿
  '大津': '250010', '彦根': '250020', '滋賀県': '250010', '滋賀': '250010',
  '京都': '260010', '舞鶴': '260020', '京都府': '260010',
  '大阪': '270000', '大阪府': '270000',
  '神戸': '280010', '豊岡': '280020', '兵庫県': '280010', '兵庫': '280010', '姫路': '280010',
  '奈良': '290010', '風屋': '290020', '奈良県': '290010',
  '和歌山': '300010', '潮岬': '300020', '和歌山県': '300010', '白浜': '300020',
  // 中国
  '鳥取': '310010', '米子': '310020', '鳥取県': '310010',
  '松江': '320010', '浜田': '320020', '西郷': '320030', '島根県': '320010', '島根': '320010', '出雲': '320010', '隠岐': '320030',
  '岡山': '330010', '津山': '330020', '岡山県': '330010', '倉敷': '330010',
  '広島': '340010', '庄原': '340020', '広島県': '340010', '福山': '340010',
  '下関': '350010', '山口': '350020', '柳井': '350030', '萩': '350040', '山口県': '350020',
  // 四国
  '徳島': '360010', '日和佐': '360020', '徳島県': '360010',
  '高松': '370010', '香川県': '370010', '香川': '370010',
  '松山': '380010', '新居浜': '380020', '宇和島': '380030', '愛媛県': '380010', '愛媛': '380010',
  '高知': '390010', '室戸岬': '390020', '清水': '390030', '高知県': '390010',
  // 九州・沖縄
  '福岡': '400010', '八幡': '400020', '飯塚': '400030', '久留米': '400040', '福岡県': '400010', '北九州': '400020', '博多': '400010',
  '佐賀': '410010', '伊万里': '410020', '佐賀県': '410010', '唐津': '410020',
  '長崎': '420010', '佐世保': '420020', '厳原': '420030', '福江': '420040', '長崎県': '420010', '対馬': '420030', '五島': '420040',
  '熊本': '430010', '阿蘇乙姫': '430020', '牛深': '430030', '熊本県': '430010', '阿蘇': '430020', '天草': '430030',
  '大分': '440010', '中津': '440020', '日田': '440030', '佐伯': '440040', '大分県': '440010', '別府': '440010',
  '宮崎': '450010', '延岡': '450020', '都城': '450030', '高千穂': '450040', '宮崎県': '450010',
  '鹿児島': '460010', '鹿屋': '460020', '種子島': '460030', '名瀬': '460040', '鹿児島県': '460010', '奄美': '460040', '屋久島': '460030',
  '那覇': '471010', '名護': '471020', '久米島': '471030', '宮古島': '472000', '石垣島': '473000', '与那国島': '474000', '沖縄県': '471010', '沖縄': '471010',
};

/** 都市名または都道府県名から 6 桁の地点 ID を解決 */
export function resolveCityId(query: string): string {
  const clean = query.trim();
  if (/^\d{6}$/.test(clean)) {
    return clean;
  }

  // 完全一致
  if (JAPAN_CITY_MAP[clean]) {
    return JAPAN_CITY_MAP[clean];
  }

  // 接尾辞を除去して再試行（例: "東京都" -> "東京", "大阪市" -> "大阪"）
  const stripped = clean.replace(/(?:都|府|県|市|区|町|村)$/, '');
  if (JAPAN_CITY_MAP[stripped]) {
    return JAPAN_CITY_MAP[stripped];
  }

  // 部分一致
  for (const [key, id] of Object.entries(JAPAN_CITY_MAP)) {
    if (key.includes(clean) || clean.includes(key)) {
      return id;
    }
  }

  // 見つからない場合はデフォルトで東京 (130010)
  return '130010';
}

export interface WeatherForecastOptions {
  city: string;
  days?: number;
  noCache?: boolean;
}

/** 天気予報を取得 (tsukumijima weather API) */
export async function fetchWeatherForecast(options: WeatherForecastOptions): Promise<any> {
  const cityId = resolveCityId(options.city);
  const days = Math.min(Math.max(options.days ?? 3, 1), 3);
  const cacheKey = `weather:${cityId}:${days}`;

  if (!options.noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return cached;
  }

  const url = `https://weather.tsukumijima.net/api/forecast?city=${cityId}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'GhostFetch/2.0 (+https://github.com/ikenokazuki/GhostFetch)',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Weather API returned HTTP ${res.status}`);
  }

  const raw: any = await res.json();
  const forecasts = Array.isArray(raw.forecasts) ? raw.forecasts.slice(0, days) : [];

  const formattedResult = {
    source: 'weather',
    cityId,
    title: raw.title,
    publicTime: raw.publicTime,
    publicTimeFormatted: raw.publicTimeFormatted,
    publishingOffice: raw.publishingOffice,
    location: raw.location,
    description: {
      headline: raw.description?.headlineText || '',
      body: raw.description?.bodyText || '',
      text: raw.description?.text || '',
      publicTime: raw.description?.publicTimeFormatted || '',
    },
    forecasts: forecasts.map((f: any) => ({
      date: f.date,
      dateLabel: f.dateLabel,
      telop: f.telop,
      detail: f.detail,
      temperature: {
        min: f.temperature?.min?.celsius ? `${f.temperature.min.celsius}℃` : null,
        max: f.temperature?.max?.celsius ? `${f.temperature.max.celsius}℃` : null,
      },
      chanceOfRain: f.chanceOfRain,
      image: f.image?.url || null,
    })),
    link: raw.link,
    cached: false,
  };

  if (!options.noCache) setToCache(cacheKey, formattedResult);
  return formattedResult;
}

