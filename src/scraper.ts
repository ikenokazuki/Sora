import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { extractText, getMeta } from 'unpdf';
import { XMLParser } from 'fast-xml-parser';
import { join } from 'path';
import { existsSync } from 'fs';
import { promises as dnsPromises } from 'dns';

// 分割モジュールの型・関数をすべて re-export
export * from './types.js';
export * from './cache.js';
export * from './enrichment.js';
export * from './services/yahoo.js';
export * from './services/life.js';

import type {
  ScrapeFormat,
  TableData,
  MediaInfo,
  Citation,
  ImageItem,
  MarkdownChunk,
  LinkStatus,
  CookieParam,
  ScrapeResult,
  BrowserActionStep,
  BrowserActionOptions,
  BrowserActionResult,
  BatchScrapeResult,
  SitemapEntry,
} from './types.js';

import {
  getFromCache,
  setToCache,
  runWithSingleFlight,
  CACHE_TTL_DEFAULT,
  CACHE_TTL_TREND,
} from './cache.js';

import {
  estimateTokens,
  safeTruncateMarkdown,
  cleanMarkdownTokens,
  generateExtractiveSummary,
  dedupSearchResults,
  maskPiiInText,
  generatePromptContext,
  highlightQueryMatchesInMarkdown,
  calculateContentStats,
  extractCitationsFromMarkdown,
  sendWebhookNotification,
  chunkMarkdownContent,
  validateExtractedLinks,
  extractQueryHighlights,
  filterByDomains,
} from './enrichment.js';

import {
  callYahooMcp,
  searchYahooWeb,
  normalizeRealtimeItem,
} from './services/yahoo.js';

export const PORT = parseInt(process.env.PORT || '8000', 10);
export const DEFAULT_MAX_CHARS = 30_000;
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function resolveChromiumPath(): string | undefined {
  const envPaths = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ];
  for (const p of envPaths) {
    if (p && existsSync(p)) return p;
  }

  const standardPaths = [
    '/usr/lib/chromium/chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of standardPaths) {
    if (existsSync(p)) return p;
  }

  // PATH 環境変数の走査 (NixOS / Custom distros)
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(':');
  const binaries = ['chromium', 'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chrome'];
  for (const dir of pathDirs) {
    for (const bin of binaries) {
      const fullPath = `${dir}/${bin}`;
      if (existsSync(fullPath)) return fullPath;
    }
  }

  try {
    const { execSync } = require('child_process');
    const path = execSync('which chromium 2>/dev/null || which google-chrome 2>/dev/null || which chrome 2>/dev/null', { encoding: 'utf8' }).trim();
    if (path && existsSync(path)) return path;
  } catch {}
  return undefined;
}

// Chromium のパス判定 (コンテナ内 または ホスト環境)
export const CHROME_EXECUTABLE_PATH = resolveChromiumPath();

let sharedBrowserInstance: Browser | null = null;

export async function getBrowser(proxyUrl?: string): Promise<{ browser: Browser; isDedicated: boolean }> {
  if (proxyUrl) {
    if (!CHROME_EXECUTABLE_PATH) {
      throw new Error('Chromium/Chrome が見つからないためブラウザを起動できません');
    }
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      `--proxy-server=${proxyUrl}`,
    ];
    const dedicated = await puppeteer.launch({
      executablePath: CHROME_EXECUTABLE_PATH,
      headless: true,
      args,
    });
    return { browser: dedicated, isDedicated: true };
  }

  if (sharedBrowserInstance && sharedBrowserInstance.connected) {
    try {
      await sharedBrowserInstance.version();
      return { browser: sharedBrowserInstance, isDedicated: false };
    } catch {
      sharedBrowserInstance = null;
    }
  }

  if (!CHROME_EXECUTABLE_PATH) {
    throw new Error('Chromium/Chrome が見つからないためブラウザを起動できません');
  }

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
  ];

  sharedBrowserInstance = await puppeteer.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args,
  });

  return { browser: sharedBrowserInstance, isDedicated: false };
}

export function isSharedBrowserConnected(): boolean {
  return sharedBrowserInstance !== null && sharedBrowserInstance.connected;
}

export async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowserInstance) {
    try {
      await sharedBrowserInstance.close();
    } catch {}
    sharedBrowserInstance = null;
  }
}

export async function applyStealthEvasions(page: Page): Promise<void> {
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1920, height: 1080 });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    (globalThis as any).chrome = {
      runtime: {},
      app: {},
      csi: () => {},
      loadTimes: () => {},
    };
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ja-JP', 'ja', 'en-US', 'en'],
    });
  });
}

export async function bypassCloudflareTurnstile(page: Page, timeoutMs = 10000): Promise<boolean> {
  try {
    const turnstileIframe = await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', {
      timeout: Math.min(timeoutMs, 5000),
    });
    if (turnstileIframe) {
      const frame = await turnstileIframe.contentFrame();
      if (frame) {
        const checkbox = await frame.$('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage');
        if (checkbox) {
          await checkbox.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
          return true;
        }
      }
    }
  } catch {}
  return false;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

// GFM Table サポート (HTML table -> Markdown table)
turndown.addRule('gfmTable', {
  filter: 'table',
  replacement: function (_content, node: any) {
    const rows = Array.from((node as any).querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const matrix: string[][] = [];
    for (const row of rows as any[]) {
      const cells = Array.from((row as any).querySelectorAll('th, td')).map((c: any) =>
        (c.textContent || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim(),
      );
      if (cells.length > 0) matrix.push(cells);
    }
    if (matrix.length === 0) return '';

    const maxCols = Math.max(...matrix.map((r) => r.length));
    const normalizedMatrix = matrix.map((r) => {
      while (r.length < maxCols) r.push('');
      return r;
    });

    const header = '| ' + normalizedMatrix[0].join(' | ') + ' |';
    const separator = '| ' + normalizedMatrix[0].map(() => '---').join(' | ') + ' |';
    const body = normalizedMatrix
      .slice(1)
      .map((r) => '| ' + r.join(' | ') + ' |')
      .join('\n');

    return `\n\n${header}\n${separator}${body ? '\n' + body : ''}\n\n`;
  },
});

// GFM Codeblock 言語指定保持 (<pre><code class="language-python">)
turndown.addRule('fencedCodeBlock', {
  filter: function (node: any, options: any) {
    if (node.nodeName !== 'PRE') return false;
    const hasCode = Boolean(
      (node.querySelector && node.querySelector('code')) ||
      (node.firstChild && node.firstChild.nodeName === 'CODE')
    );
    return options.codeBlockStyle === 'fenced' && hasCode;
  },
  replacement: function (_content, node: any) {
    const codeEl = (node.querySelector && node.querySelector('code')) || node.firstChild || node;
    const lang =
      codeEl?.getAttribute?.('data-language') ||
      node.getAttribute?.('data-language') ||
      (codeEl?.getAttribute?.('class') || '').match(/(?:language|lang|highlight)-([a-zA-Z0-9_+-]+)/i)?.[1] ||
      (node.getAttribute?.('class') || '').match(/(?:language|lang|highlight)-([a-zA-Z0-9_+-]+)/i)?.[1] ||
      '';
    const code = (codeEl?.textContent || node.textContent || '').replace(/\r\n/g, '\n');
    return `\n\n\`\`\`${lang.toLowerCase()}\n${code.replace(/\n+$/, '')}\n\`\`\`\n\n`;
  },
});

// ==========================================
// 2. ドメイン単位の適応型レート制限 & Jitter
// ==========================================
const domainLastAccess = new Map<string, number>();
const DOMAIN_MIN_INTERVAL_MS = 150; // 同一ドメインへの最小待機間隔

export async function throttleDomain(urlStr: string): Promise<void> {
  try {
    const hostname = new URL(urlStr).hostname.toLowerCase();
    const now = Date.now();
    const last = domainLastAccess.get(hostname) || 0;
    const elapsed = now - last;

    if (elapsed < DOMAIN_MIN_INTERVAL_MS) {
      const waitTime = DOMAIN_MIN_INTERVAL_MS - elapsed + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, waitTime));
    }
    domainLastAccess.set(hostname, Date.now());
  } catch {}
}

// ==========================================
// 3. SSRF 防御 (ローカル・プライベートIP遮断)
// ==========================================
export const MAX_RESPONSE_BODY_BYTES = 30 * 1024 * 1024; // 最大 30MB

export function isPrivateIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  if (trimmed === '127.0.0.1' || trimmed === '::1' || trimmed === '0.0.0.0' || trimmed === '::') return true;
  if (trimmed.startsWith('10.') || trimmed.startsWith('192.168.') || trimmed.startsWith('0.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(trimmed)) return true;
  if (trimmed.startsWith('169.254.')) return true; // リンクローカル / クラウドメタデータ (AWS/GCP)
  // CGNAT (Carrier-Grade NAT / RFC 6598: 100.64.0.0/10)
  if (/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(trimmed)) return true;
  // TEST-NET & Benchmark (RFC 5737 / RFC 2544)
  if (/^198\.(1[8-9])\./.test(trimmed)) return true;
  if (trimmed.startsWith('192.0.2.') || trimmed.startsWith('198.51.100.') || trimmed.startsWith('203.0.113.')) return true;
  // Multicast & Reserved
  if (/^(22[4-9]|23[0-9]|24[0-9]|25[0-5])\./.test(trimmed)) return true;
  // IPv6 ULA, Link-local, Multicast, Doc
  if (trimmed.startsWith('fc') || trimmed.startsWith('fd') || trimmed.startsWith('fe80:') || trimmed.startsWith('ff')) return true;
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().trim();
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '::' ||
    h === '0.0.0.0' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }
  if (h.startsWith('::ffff:')) {
    const mapped = h.replace(/^::ffff:/, '');
    return isPrivateIp(mapped);
  }
  if (
    h === '169.254.169.254' ||
    h === 'metadata.google.internal' ||
    h === 'metadata.internal' ||
    h === 'instance-data'
  ) {
    return true;
  }
  if (/^\d+$/.test(h)) {
    try {
      const num = parseInt(h, 10);
      const ip = `${(num >> 24) & 255}.${(num >> 16) & 255}.${(num >> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ip)) return true;
    } catch {}
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return isPrivateIp(h);
  }
  return false;
}

/** DNS 解決後の実 IP アドレスを検証（DNS Rebinding 攻撃対策） */
export async function validateHostIpDns(hostname: string): Promise<void> {
  if (process.env.ALLOW_LOCAL_FETCH === 'true') return;

  if (isBlockedHostname(hostname)) {
    throw new Error(`プライベートネットワークまたは安全でないホストへのアクセスは遮断されています: ${hostname}`);
  }

  try {
    const addresses = await dnsPromises.lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (isBlockedHostname(addr.address) || isPrivateIp(addr.address)) {
        throw new Error(`DNS Rebinding 攻撃（プライベート IP への解決）が検知されたため遮断されました: ${hostname} -> ${addr.address}`);
      }
    }
  } catch (err: any) {
    if (err.message && (err.message.includes('DNS Rebinding') || err.message.includes('プライベートネットワーク'))) {
      throw err;
    }
    // DNS解決失敗等は後続の fetch に任せる
  }
}

// ==========================================
// 簡易セマフォ（ブラウザ同時実行数制限）
// ==========================================
export class SimpleSemaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(public readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    this.current++;
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  get activeCount(): number {
    return this.current;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

const MAX_CONCURRENT_BROWSERS = parseInt(process.env.MAX_CONCURRENT_BROWSERS || '5', 10);
export const browserSemaphore = new SimpleSemaphore(Math.max(1, Math.min(MAX_CONCURRENT_BROWSERS, 50)));

// ==========================================
// 4. 安全な HTTP フェッチ (リダイレクト追跡 & SSRF/DNS Rebinding 再検証)
// ==========================================
export async function fetchWithSafeRedirects(
  initialUrl: string,
  timeoutMs = 15000,
  maxRedirects = 5,
  customHeaders?: Record<string, string>,
  customCookies?: CookieParam[],
): Promise<{ finalUrl: string; response: Response }> {
  let currentUrl = initialUrl;
  let redirects = 0;

  const cookieHeader = customCookies && customCookies.length > 0
    ? customCookies.map((c) => `${c.name}=${c.value}`).join('; ')
    : undefined;

  while (redirects <= maxRedirects) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new Error(`無効な URL です: ${currentUrl}`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`許可されていないプロトコルです: ${parsed.protocol}`);
    }

    await validateHostIpDns(parsed.hostname);

    await throttleDomain(currentUrl);

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(customHeaders || {}),
    };

    const res = await fetch(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Content-Length による大容量ファイルガード (Zip Bomb / 大容量ビデオ等)
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BODY_BYTES) {
      throw new Error(`レスポンスサイズが上限 (${MAX_RESPONSE_BODY_BYTES / (1024 * 1024)}MB) を超過しています: ${contentLength} bytes`);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('Location');
      if (!location) return { finalUrl: currentUrl, response: res };

      currentUrl = new URL(location, currentUrl).href;
      redirects++;
      continue;
    }

    return { finalUrl: currentUrl, response: res };
  }

  throw new Error(`リダイレクト回数が上限（${maxRedirects}回）を超えました`);
}

/** HTML/テキストのバッファから文字コード（Shift_JIS / EUC-JP / UTF-8 等）を自動判定してデコード */
export function decodeHtmlBuffer(buffer: ArrayBuffer | Uint8Array, contentTypeHeader = ''): string {
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  const headerMatch = contentTypeHeader.match(/charset=([a-zA-Z0-9_\-]+)/i);
  let charset = headerMatch ? headerMatch[1].toLowerCase().trim() : '';

  if (!charset) {
    const headChunk = new (TextDecoder as any)('latin1').decode(uint8.slice(0, 2048));
    const metaCharsetMatch = headChunk.match(/<meta[^>]+charset=["']?\s*([a-zA-Z0-9_\-]+)/i);
    if (metaCharsetMatch) {
      charset = metaCharsetMatch[1].toLowerCase().trim();
    } else {
      const metaHttpEquivMatch = headChunk.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["'][^"']*charset=([a-zA-Z0-9_\-]+)/i);
      if (metaHttpEquivMatch) {
        charset = metaHttpEquivMatch[1].toLowerCase().trim();
      }
    }
  }

  if (['sjis', 'shift-jis', 'shift_jis', 'cp932', 'windows-31j', 'ms932', 'x-sjis'].includes(charset)) {
    try {
      return new (TextDecoder as any)('shift_jis').decode(uint8);
    } catch {}
  } else if (['euc-jp', 'eucjp', 'x-euc-jp'].includes(charset)) {
    try {
      return new (TextDecoder as any)('euc-jp').decode(uint8);
    } catch {}
  } else if (['iso-2022-jp'].includes(charset)) {
    try {
      return new (TextDecoder as any)('iso-2022-jp').decode(uint8);
    } catch {}
  }

  try {
    return new TextDecoder('utf-8').decode(uint8);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(uint8);
  }
}

/** CSS セレクタまたは属性指定によるキーバリュー抽出 */
export function extractWithSelectors(
  $: cheerio.CheerioAPI,
  selectors?: Record<string, string>,
  baseUrl?: string,
): Record<string, string | null> | undefined {
  if (!selectors || Object.keys(selectors).length === 0) return undefined;
  const result: Record<string, string | null> = {};

  for (const [key, selectorExpr] of Object.entries(selectors)) {
    try {
      if (!selectorExpr || typeof selectorExpr !== 'string') continue;

      const attrMatch = selectorExpr.match(/^(.*?)@([a-zA-Z0-9_\-]+)$/);
      if (attrMatch) {
        const cssSel = attrMatch[1].trim();
        const attrName = attrMatch[2].trim();
        const el = cssSel ? $(cssSel).first() : $('*').first();
        let val = el.attr(attrName) || null;
        if (val && baseUrl && ['href', 'src', 'data-src'].includes(attrName.toLowerCase())) {
          try {
            val = new URL(val, baseUrl).href;
          } catch {}
        }
        result[key] = val;
      } else {
        const el = $(selectorExpr).first();
        if (el.length > 0) {
          result[key] = el.text().replace(/\s+/g, ' ').trim();
        } else {
          result[key] = null;
        }
      }
    } catch {
      result[key] = null;
    }
  }

  return result;
}

/** HTML から <table> データを抽出して構造化 JSON に変換 */
export function extractTablesFromHtml($: cheerio.CheerioAPI): TableData[] {
  const tables: TableData[] = [];
  $('table').each((_, tableEl) => {
    const $t = $(tableEl);
    const id = $t.attr('id') || undefined;
    const caption = $t.find('caption').first().text().trim() || undefined;

    const headers: string[] = [];
    $t.find('tr').first().find('th, td').each((_, cell) => {
      headers.push($(cell).text().replace(/\s+/g, ' ').trim());
    });

    if (headers.length === 0) return;

    const rows: Record<string, string>[] = [];
    $t.find('tr').slice(1).each((_, tr) => {
      const rowObj: Record<string, string> = {};
      let hasData = false;
      $(tr).find('td, th').each((cIdx, cell) => {
        const colName = headers[cIdx] || `col_${cIdx + 1}`;
        const cellText = $(cell).text().replace(/\s+/g, ' ').trim();
        if (cellText) hasData = true;
        rowObj[colName] = cellText;
      });
      if (hasData) rows.push(rowObj);
    });

    if (rows.length > 0) {
      tables.push({ id, caption, headers, rows });
    }
  });
  return tables;
}

/** YouTube / 動画メディアメタデータ & チャプター抽出 */
export function extractMediaInfo(
  $: cheerio.CheerioAPI,
  targetUrl: string,
  rawHtml?: string,
): MediaInfo | undefined {
  try {
    const urlObj = new URL(targetUrl);
    const host = urlObj.hostname.toLowerCase();

    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      let videoId: string | undefined;
      if (host.includes('youtu.be')) {
        videoId = urlObj.pathname.slice(1).split('?')[0];
      } else {
        videoId = urlObj.searchParams.get('v') || undefined;
      }

      if (videoId) {
        const thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
        const duration = $('meta[itemprop="duration"]').attr('content') || undefined;

        const chapters: Array<{ title: string; time: string; seconds: number }> = [];
        const fullText = (rawHtml || '') + '\n' + $('body').text();
        const timestampRegex = /(?:^|\n)[ \t]*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[ \t]+([^\r\n]+)/g;
        let match;
        const seenTimes = new Set<string>();

        while ((match = timestampRegex.exec(fullText)) !== null) {
          const hours = match[1] ? parseInt(match[1], 10) : 0;
          const mins = parseInt(match[2], 10);
          const secs = parseInt(match[3], 10);
          const title = match[4].replace(/\s+/g, ' ').trim();
          const timeStr = match[1] ? `${match[1]}:${match[2]}:${match[3]}` : `${match[2]}:${match[3]}`;

          if (!seenTimes.has(timeStr) && title.length >= 2 && title.length <= 80) {
            seenTimes.add(timeStr);
            const totalSeconds = hours * 3600 + mins * 60 + secs;
            chapters.push({ title, time: timeStr, seconds: totalSeconds });
          }
        }

        return {
          type: 'youtube',
          videoId,
          thumbnail,
          duration,
          chapters: chapters.length > 0 ? chapters.sort((a, b) => a.seconds - b.seconds) : undefined,
        };
      }
    }

    const videoSrc = $('video source, video').attr('src');
    const ogVideo = $('meta[property="og:video"]').attr('content');
    if (videoSrc || ogVideo) {
      return {
        type: 'video',
        thumbnail: $('meta[property="og:image"]').attr('content') || undefined,
      };
    }
  } catch {}

  return undefined;
}

// URL パターンマッチング (includePatterns / excludePatterns 用ワイルドカード対応)
export function matchUrlPattern(targetUrl: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  let pathname = '';
  let filename = '';
  try {
    const u = new URL(targetUrl);
    pathname = u.pathname;
    filename = pathname.split('/').pop() || '';
  } catch {
    pathname = targetUrl;
    filename = targetUrl;
  }

  return patterns.some((pattern) => {
    let esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    esc = esc.replace(/\*\*/g, '___DOUBLE_STAR___');
    esc = esc.replace(/\*/g, '[^/]*');
    esc = esc.replace(/___DOUBLE_STAR___/g, '.*');
    const regexStr = '^' + esc + '$';
    try {
      const reg = new RegExp(regexStr);
      return reg.test(pathname) || reg.test(targetUrl) || reg.test(filename);
    } catch {
      return pathname.includes(pattern) || targetUrl.includes(pattern) || filename.includes(pattern);
    }
  });
}

export function extractMetadataFromJsonLd(items: any[]): {
  publishedTime?: string;
  author?: string;
  siteName?: string;
  description?: string;
  ogImage?: string;
} {
  const result: {
    publishedTime?: string;
    author?: string;
    siteName?: string;
    description?: string;
    ogImage?: string;
  } = {};

  const flatObjects: any[] = [];
  function flatten(obj: any) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(flatten);
    } else {
      flatObjects.push(obj);
      if (obj['@graph'] && Array.isArray(obj['@graph'])) {
        obj['@graph'].forEach(flatten);
      }
    }
  }
  items.forEach(flatten);

  for (const item of flatObjects) {
    if (!result.publishedTime) {
      if (typeof item.datePublished === 'string') result.publishedTime = item.datePublished;
      else if (typeof item.dateCreated === 'string') result.publishedTime = item.dateCreated;
      else if (typeof item.dateModified === 'string') result.publishedTime = item.dateModified;
    }

    if (!result.author) {
      if (typeof item.author === 'string') {
        result.author = item.author;
      } else if (item.author && typeof item.author === 'object') {
        if (typeof item.author.name === 'string') result.author = item.author.name;
        else if (Array.isArray(item.author) && typeof item.author[0]?.name === 'string') {
          result.author = item.author[0].name;
        }
      } else if (typeof item.creator === 'string') {
        result.author = item.creator;
      } else if (item.creator && typeof item.creator.name === 'string') {
        result.author = item.creator.name;
      }
    }

    if (!result.siteName) {
      if (item.publisher && typeof item.publisher.name === 'string') {
        result.siteName = item.publisher.name;
      } else if (item.isPartOf && typeof item.isPartOf.name === 'string') {
        result.siteName = item.isPartOf.name;
      }
    }

    if (!result.description && typeof item.description === 'string') {
      result.description = item.description;
    }

    if (!result.ogImage) {
      if (typeof item.image === 'string') {
        result.ogImage = item.image;
      } else if (item.image && typeof item.image === 'object') {
        if (typeof item.image.url === 'string') result.ogImage = item.image.url;
        else if (Array.isArray(item.image) && typeof item.image[0] === 'string') {
          result.ogImage = item.image[0];
        } else if (Array.isArray(item.image) && typeof item.image[0]?.url === 'string') {
          result.ogImage = item.image[0].url;
        }
      }
    }
  }

  return result;
}

export function convertHtmlToMarkdown(
  rawHtml: string,
  targetUrl: string,
  maxChars: number,
  isRendered = false,
  onlyMainContent = true,
  selectors?: Record<string, string>,
  removeSelectors?: string[],
): {
  title: string;
  markdown: string;
  ogImage?: string;
  description?: string;
  publishedTime?: string;
  author?: string;
  siteName?: string;
  isTruncated: boolean;
  links: string[];
  images?: ImageItem[];
  jsonLd?: any[];
  tables?: TableData[];
  extracted?: Record<string, string | null>;
  media?: MediaInfo;
  html?: string;
  estimatedTokens: number;
} {
  const $ = cheerio.load(rawHtml);

  // 1. JSON-LD の先行抽出 (script タグ削除前)
  const jsonLd: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      if (parsed) jsonLd.push(parsed);
    } catch {}
  });

  // JSON-LD からのメタデータ（Schema.org）抽出
  const jsonLdMeta = extractMetadataFromJsonLd(jsonLd);

  // 2. メタデータの抽出 (OGP / JSON-LD / Standard Meta)
  const title =
    $('title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    targetUrl;

  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    jsonLdMeta.description ||
    undefined;

  const ogImage =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    jsonLdMeta.ogImage ||
    undefined;

  const publishedTime =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="pubdate"]').attr('content') ||
    $('meta[name="publish-date"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    jsonLdMeta.publishedTime ||
    undefined;

  const author =
    $('meta[name="author"]').attr('content') ||
    $('meta[property="article:author"]').attr('content') ||
    jsonLdMeta.author ||
    undefined;

  const siteName =
    $('meta[property="og:site_name"]').attr('content') ||
    jsonLdMeta.siteName ||
    undefined;

  // 3. リンク一覧の抽出
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      try {
        const absUrl = new URL(href, targetUrl).href;
        if (absUrl.startsWith('http') && !links.includes(absUrl)) {
          links.push(absUrl);
        }
      } catch {}
    }
  });

  // 4. 画像一覧 & キャプション・メタデータの抽出
  const images: ImageItem[] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) {
      try {
        const absUrl = new URL(src, targetUrl).href;
        if (absUrl.startsWith('http') && !images.some((img) => img.url === absUrl)) {
          const $img = $(el);
          const alt = $img.attr('alt')?.trim() || undefined;
          const imgTitle = $img.attr('title')?.trim() || undefined;
          const widthStr = $img.attr('width');
          const heightStr = $img.attr('height');
          const width = widthStr ? parseInt(widthStr, 10) : undefined;
          const height = heightStr ? parseInt(heightStr, 10) : undefined;

          let caption: string | undefined = undefined;
          const figure = $img.closest('figure');
          if (figure.length > 0) {
            const figcaption = figure.find('figcaption').first().text().trim();
            if (figcaption) caption = figcaption;
          }

          const isMainImage = (ogImage && absUrl === ogImage) || images.length === 0;

          images.push({
            url: absUrl,
            alt,
            title: imgTitle,
            caption,
            isMainImage: isMainImage ? true : undefined,
            width: !isNaN(width as number) ? width : undefined,
            height: !isNaN(height as number) ? height : undefined,
          });
        }
      } catch {}
    }
  });

  // 5. 構造化テーブルの抽出
  const tables = extractTablesFromHtml($);

  // 6. YouTube / 動画メディアの抽出
  const media = extractMediaInfo($, targetUrl, rawHtml);

  // 7. ピンポイント セレクタ抽出
  const extracted = extractWithSelectors($, selectors, targetUrl);

  // 8. ノイズ要素 & Cookie 同意バナー等のパージ
  const noiseSelectors = [
    'script',
    'style',
    'noscript',
    'iframe',
    'svg',
    '.ads',
    '.advertisement',
    '#cookie-banner',
    '.cookie-consent',
    '.onetrust-pc-dark-filter',
    '#onetrust-consent-sdk',
    '#CybotCookiebotDialog',
  ];
  if (removeSelectors && removeSelectors.length > 0) {
    noiseSelectors.push(...removeSelectors);
  }
  $(noiseSelectors.join(', ')).remove();

  // 8.5 コードブロックの言語情報保持 (Readability パージ対策)
  $('pre code, pre').each((_, el) => {
    const cls = $(el).attr('class') || '';
    const match = cls.match(/(?:language|lang|highlight)-([a-zA-Z0-9_+-]+)/i);
    if (match) {
      $(el).attr('data-language', match[1]);
    }
  });

  // 9. Mozilla Readability による本文抽出
  let contentHtml = '';
  if (onlyMainContent) {
    try {
      const { document } = parseHTML($.html());
      const reader = new Readability(document);
      const article = reader.parse();
      if (article && article.content) {
        contentHtml = article.content;
      }
    } catch {}
    if (!contentHtml) {
      contentHtml = $('main').html() || $('article').html() || $('#content').html() || $('body').html() || '';
    }
  } else {
    contentHtml = $('body').html() || $.html() || '';
  }

  // 10. Frontmatter の組み立て
  const frontmatterLines: string[] = [];
  if (publishedTime) frontmatterLines.push(`publishedTime: "${publishedTime}"`);
  if (author) frontmatterLines.push(`author: "${author}"`);
  if (siteName) frontmatterLines.push(`siteName: "${siteName}"`);
  const header = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : '';

  // 11. HTML -> Markdown 変換 & クレンジング
  let markdown = header + turndown.turndown(contentHtml);
  markdown = cleanMarkdownTokens(markdown);

  const isTruncated = markdown.length > maxChars;
  const truncatedMarkdown = safeTruncateMarkdown(markdown, maxChars);
  const estimatedTokens = estimateTokens(truncatedMarkdown);

  return {
    title,
    markdown: truncatedMarkdown,
    ogImage,
    description,
    publishedTime,
    author,
    siteName,
    isTruncated,
    links,
    images: images.length > 0 ? images : undefined,
    jsonLd: jsonLd.length > 0 ? jsonLd : undefined,
    tables: tables.length > 0 ? tables : undefined,
    extracted,
    media,
    html: contentHtml,
    estimatedTokens,
  };
}

// ==========================================
// 6. Stealth Chromium レンダリング
// ==========================================
export async function fetchWithStealthBrowser(
  url: string,
  timeoutMs = 30000,
  proxyUrl?: string,
  clipSelector?: string,
  customCookies?: CookieParam[],
): Promise<{ html: string; title: string; screenshot?: string; finalUrl: string }> {
  const chromePath = resolveChromiumPath();
  if (!chromePath) {
    throw new Error('Chromium/Chrome が見つからないためブラウザレンダリングを実行できません');
  }

  await throttleDomain(url);

  // ブラウザ同時実行数制限（セマフォ待機）
  await browserSemaphore.acquire();

  try {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ];
    if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);

    const browser: Browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args,
    });

    try {
      const page: Page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.setViewport({ width: 1920, height: 1080 });

      if (customCookies && customCookies.length > 0) {
        const puppeteerCookies = customCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        }));
        await page.setCookie(...(puppeteerCookies as any));
      }

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });

      const finalUrl = page.url();
      const title = await page.title();
      const html = await page.content();

      let screenshot: string | undefined = undefined;
      if (clipSelector) {
        try {
          const el = await page.$(clipSelector);
          if (el) {
            const buf = await el.screenshot({ encoding: 'base64' });
            screenshot = buf as string;
          }
        } catch {}
      } else {
        const buf = await page.screenshot({ encoding: 'base64', fullPage: false });
        screenshot = buf as string;
      }

      return { html, title, screenshot, finalUrl };
    } finally {
      await browser.close();
    }
  } finally {
    browserSemaphore.release();
  }
}

// ==========================================
// 7. PDF 構造化抽出 (unpdf)
// ==========================================
export async function parsePdfToMarkdown(
  buffer: ArrayBuffer | Uint8Array,
  targetUrl: string,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<ScrapeResult> {
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const { text, totalPages } = await extractText(uint8, { mergePages: true });
  let pdfMetadata: any = {};
  try {
    const meta = await getMeta(uint8);
    pdfMetadata = meta?.info || {};
  } catch {}

  const title = pdfMetadata.Title || targetUrl.split('/').pop() || 'PDF Document';
  const author = pdfMetadata.Author || undefined;
  const rawText = Array.isArray(text) ? text.join('\n\n') : (text || '');
  const markdown = rawText.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

  const isTruncated = markdown.length > maxChars;
  const truncatedContent = safeTruncateMarkdown(markdown, maxChars);
  const estimatedTokens = estimateTokens(truncatedContent);

  return {
    url: targetUrl,
    title,
    author,
    content: truncatedContent,
    isTruncated,
    contentType: 'application/pdf',
    source: 'web',
    metadata: pdfMetadata,
    estimatedTokens,
  };
}

// ==========================================
// 10. 高度なブラウザ操作 (browser_action)
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
    proxyUrl: options.proxyUrl,
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
// 11. スクレイピング完了処理 & オプション統合
// ==========================================
async function finalizeScrapeResult(
  result: ScrapeResult,
  options: {
    query?: string;
    shouldExtractHighlights: boolean;
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
// 12. 単一 URL スクレイピング (scrapeUrl)
// ==========================================
export async function scrapeUrl(options: {
  url: string;
  maxChars?: number;
  mode?: 'auto' | 'fast' | 'browser';
  renderJs?: boolean;
  fastOnly?: boolean;
  formats?: ScrapeFormat[];
  onlyMainContent?: boolean;
  selectors?: Record<string, string>;
  clipSelector?: string;
  headers?: Record<string, string>;
  cookies?: CookieParam[];
  removeSelectors?: string[];
  query?: string;
  extractHighlights?: boolean;
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
  proxyUrl?: string;
  noCache?: boolean;
  timeoutMs?: number;
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

  onProgress?.({ stage: 'start', message: `Starting scrape for ${url}` });

  if (options.fastOnly && options.renderJs) {
    throw new Error('fastOnly と renderJs は同時に指定できません');
  }

  const cacheKey = `scrape:${url}:${maxChars}:${options.mode || 'auto'}:${onlyMainContent}:${formats.slice().sort().join(',')}:${(options.removeSelectors || []).join(',')}:${options.query || ''}:${options.extractSummary || false}:${options.extractCitations || false}:${options.chunkMarkdown || false}:${options.chunkSize || 1000}:${options.validateLinks || false}:${options.maskPii || false}:${options.formatAsPrompt || false}:${options.highlightMatches || false}`;

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
            shouldExtractHighlights: options.extractHighlights ?? false,
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
        );

        // Frontmatter を除いた実本文テキストの判定
        const bodyOnlyMarkdown = parsed.markdown.replace(/^---[\s\S]*?---\n*/, '').trim();
        const hasLittleContent = bodyOnlyMarkdown.length < 50;

        const chromePath = resolveChromiumPath();
        const isSpaOrBlank =
          !isFastMode &&
          chromePath &&
          (hasLittleContent ||
            html.includes('id="root"') ||
            html.includes('id="app"') ||
            html.includes('__NEXT_DATA__') ||
            html.includes('client-bootstrap') ||
            html.includes('data-build=') ||
            html.includes('data-reactroot') ||
            html.includes('Please enable JavaScript') ||
            html.includes('Checking your browser'));

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
            links: formats.includes('links') ? parsed.links : undefined,
            images: formats.includes('images') ? parsed.images : undefined,
            jsonLd: formats.includes('jsonLd') ? parsed.jsonLd : undefined,
            tables: formats.includes('tables') ? parsed.tables : undefined,
            extracted: parsed.extracted,
            media: parsed.media,
            html: formats.includes('html') ? parsed.html : undefined,
            rawHtml: formats.includes('rawHtml') ? html : undefined,
            estimatedTokens: parsed.estimatedTokens,
          };

          onProgress?.({ stage: 'enrich', message: 'Enriching content with metadata and summaries' });
          result = await finalizeScrapeResult(result, {
            query: options.query,
            shouldExtractHighlights: options.extractHighlights ?? false,
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

      // Chromium 自動昇格 または ブラウザ指定モード
      onProgress?.({ stage: 'render', message: 'Rendering SPA via Stealth Chromium' });
      const browserRes = await fetchWithStealthBrowser(
        url,
        timeoutMs,
        options.proxyUrl,
        options.clipSelector,
        options.cookies,
      );

      const parsed = convertHtmlToMarkdown(
        browserRes.html,
        browserRes.finalUrl,
        maxChars,
        true,
        onlyMainContent,
        options.selectors,
        options.removeSelectors,
      );

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
        screenshot: formats.includes('screenshot') ? browserRes.screenshot : undefined,
        links: formats.includes('links') ? parsed.links : undefined,
        images: formats.includes('images') ? parsed.images : undefined,
        jsonLd: formats.includes('jsonLd') ? parsed.jsonLd : undefined,
        tables: formats.includes('tables') ? parsed.tables : undefined,
        extracted: parsed.extracted,
        media: parsed.media,
        html: formats.includes('html') ? parsed.html : undefined,
        rawHtml: formats.includes('rawHtml') ? browserRes.html : undefined,
        estimatedTokens: parsed.estimatedTokens,
      };

      onProgress?.({ stage: 'enrich', message: 'Enriching rendered content with metadata and summaries' });
      result = await finalizeScrapeResult(result, {
        query: options.query,
        shouldExtractHighlights: options.extractHighlights ?? false,
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
// 13. 一括並行スクレイピング (scrapeBatchUrls)
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
  query?: string;
  extractHighlights?: boolean;
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
  proxyUrl?: string;
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
// 14. sitemap.xml の探索 & 再帰パース
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

    // 1. 通常の <urlset>
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

    // 2. <sitemapindex> (再帰走査)
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
// 15. サイトマップ探索 (mapSiteUrl)
// ==========================================
export async function mapSiteUrl(options: {
  url: string;
  limit?: number;
  includeSubdomains?: boolean;
  since?: string;
  timeoutMs?: number;
  noCache?: boolean;
  proxyUrl?: string;
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

  // 1. /robots.txt から Sitemap ディレクティブを探索
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

  // 2. 候補 Sitemap を順次試行
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

  // 3. Sitemap がない場合はトップページの内部リンクを抽出
  const scraped = await scrapeUrl({
    url,
    maxChars: 5000,
    formats: ['links'],
    noCache: options.noCache,
    proxyUrl: options.proxyUrl,
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
// 16. 再帰クロール (crawlSiteUrl)
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
  proxyUrl?: string;
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
    proxyUrl,
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
        proxyUrl,
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
// 17. リアルタイムトレンド取得 (fetchRealtimeTrends)
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
// 18. Firecrawl / Tavily 互換 統合深層検索 (integratedSearch)
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
  proxyUrl?: string;
  extractHighlights?: boolean;
  onlyMainContent?: boolean;
  formats?: ScrapeFormat[];
  dedup?: boolean;
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
  const proxyUrl = options.proxyUrl;
  const extractHighlights = options.extractHighlights ?? false;
  const onlyMainContent = options.onlyMainContent !== false;
  const formats = options.formats ?? ['markdown'];
  const dedup = options.dedup ?? false;
  const cacheKey = `search:integrated:${query}:${limit}:${scrapeContent}:${includeRealtime}:${realtimeSort}:${(includeDomains || []).join(',')}:${(excludeDomains || []).join(',')}:${updated || 'all'}:${extractHighlights}:${onlyMainContent}:${formats.slice().sort().join(',')}:${dedup}:${proxyUrl || ''}`;
  if (!noCache) {
    const cached = getFromCache<any>(cacheKey);
    if (cached) return cached;
  }

  // 1. Yahoo Web 検索 と リアルタイム検索を並行実行
  const [webParsedRes, realtimeMcpRes] = await Promise.all([
    searchYahooWeb({ query, includeDomains, excludeDomains, updated }),
    includeRealtime
      ? callYahooMcp('yahoo_realtime_search', { query, sort: realtimeSort }).catch(() => null)
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

  // リアルタイム検索結果のパース
  let realtimeItems: any[] = [];
  if (realtimeMcpRes) {
    const rtContent = realtimeMcpRes?.content?.[0]?.text || '[]';
    try {
      const parsed = JSON.parse(rtContent);
      const rawList = Array.isArray(parsed) ? parsed : (parsed?.items || parsed?.results || []);
      let mapped = rawList.map((item: any) => normalizeRealtimeItem(item));
      if (dedup && mapped.length > 0) {
        mapped = dedupSearchResults(mapped, (i: any) => `${i.text || i.content || ''}`);
      }
      realtimeItems = mapped;
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
            highlights: scrape.highlights,
            cached: scrape.cached,
          };

          if (formats.includes('markdown')) {
            enrichedItem.markdown = scrape.content;
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
      sort: realtimeSort,
      count: realtimeItems.length,
      items: realtimeItems,
    };
  }

  if (!noCache) setToCache(cacheKey, finalResponse);
  return finalResponse;
}
