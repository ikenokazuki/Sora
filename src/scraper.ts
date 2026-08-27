import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { Page, Protocol } from 'puppeteer-core';
import { XMLParser } from 'fast-xml-parser';
import { join } from 'path';
import { existsSync } from 'fs';
import { createSession, type BrowserProfile, type Response as WreqResponse, type Session } from 'wreq-js';

// 分割モジュールの型・関数をすべて re-export
export * from './types.js';
export * from './cache.js';
export * from './db.js';
import {
  dbGetDomainCookies,
  dbSaveDomainCookies,
  dbGetDomainStorage,
  dbSaveDomainStorage,
  type PersistedCookie,
} from './db.js';
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
  rerankSearchResults,
  generateTextFragmentUrl,
  chooseBestDescription,
} from './enrichment.js';

import {
  resolveChromiumPath,
  getChromiumMajorVersion,
  CHROME_EXECUTABLE_PATH,
  getBrowser,
  getProxyConfig,
  isSharedBrowserConnected,
  closeSharedBrowser,
  SimpleSemaphore,
  browserSemaphore,
  isPrivateIp,
  isBlockedHostname,
  validateHostIpDns,
  setupPageSecurity,
} from './browser_engine.js';

import { parsePdfToMarkdown } from './pdf.js';

import {
  callYahooMcp,
  searchYahooWeb,
  normalizeRealtimeItem,
} from './services/yahoo.js';

export const PORT = parseInt(process.env.PORT || '8000', 10);
export const DEFAULT_MAX_CHARS = 30_000;
/** 実行中のChromiumのバージョンすら取得できなかった場合の最終フォールバック。 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * ブラウザから UA を取得できなかった場合に使うフォールバック UA。
 * 固定値(Chrome/128)をそのまま使うと、実バージョンを名乗る静的fetch側との間で
 * 「同じCookieなのにChromeのメジャーバージョンが違う」矛盾が再発するため、
 * 実行環境のChromiumバージョンから組み立て直す。
 */
export function getFallbackUserAgent(): string {
  const major = getChromiumMajorVersion();
  if (!major) return USER_AGENT;
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * headless Chromium のデフォルト UA（"HeadlessChrome/N.N.N.N" を含む）から実バージョンを抜き出し、
 * Windows 版 Chrome の UA として組み立て直す。ハードコードのバージョン番号は Chromium の
 * アップデートで陳腐化し、TLS/実バージョンとの矛盾フィンガープリントになるため、
 * 実行中のブラウザから毎回動的に生成する。
 */
export function buildUserAgentFromDefault(defaultUa: string): string {
  const match = defaultUa.match(/(?:Headless)?Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  const version = match ? match[1] : '128.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/**
 * navigator.userAgentData (Client Hints) を UA 文字列(Windows Chrome)と一致させる。
 * setUserAgent() で UA 文字列だけ書き換えても userAgentData/navigator.platform は
 * 実機(Linux)のまま素通しになり、CreepJS等はこの矛盾を "headless likelihood" として検出する
 * （実測で確認済み: userAgent=Windows なのに userAgentData/platform=Linux のまま）。
 */
export function buildUserAgentMetadata(defaultUa: string): Protocol.Emulation.UserAgentMetadata {
  const match = defaultUa.match(/(?:Headless)?Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  const fullVersion = match ? match[1] : '128.0.0.0';
  const majorVersion = fullVersion.split('.')[0];
  return {
    brands: [
      { brand: 'Not)A;Brand', version: '99' },
      { brand: 'Chromium', version: majorVersion },
      { brand: 'Google Chrome', version: majorVersion },
    ],
    fullVersionList: [
      { brand: 'Not)A;Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Google Chrome', version: fullVersion },
    ],
    fullVersion,
    platform: 'Windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
}

/**
 * WebRTC の ICE candidate 収集から実IP（host/srflx）を除去する。
 * ブラウザ起動フラグ --force-webrtc-ip-handling-policy=disable_non_proxied_udp は
 * コマンドラインには正しく渡っているが、実測では srflx candidate（STUN経由の公開IP）が
 * 素通しになることを確認した（CreepJSの実IP露出の原因）。RTCPeerConnection.prototype の
 * addEventListener('icecandidate') / onicecandidate 経路の両方をフックし、host/srflxで
 * 実IPv4を含む candidate だけを握りつぶす（mDNS化された .local host candidate や、
 * relay/TURN経由の candidate はそのまま通す）。
 */
function patchWebRtcIpLeak(): void {
  const isRealIpCandidate = (candidate: string): boolean => {
    const m = candidate.match(/^candidate:\S+ \d+ udp \d+ (\S+) \d+ typ (host|srflx)/);
    if (!m) return false;
    const ip = m[1];
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip !== '0.0.0.0';
  };

  const NativeRTCPeerConnection = (globalThis as any).RTCPeerConnection;
  if (!NativeRTCPeerConnection) return;
  const proto = NativeRTCPeerConnection.prototype;

  const origAddEventListener = proto.addEventListener;
  proto.addEventListener = function (this: any, type: string, listener: any, options?: any) {
    if (type !== 'icecandidate' || typeof listener !== 'function') {
      return origAddEventListener.call(this, type, listener, options);
    }
    const wrapped = function (this: any, event: any) {
      if (event.candidate && isRealIpCandidate(event.candidate.candidate)) return;
      return listener.call(this, event);
    };
    return origAddEventListener.call(this, type, wrapped, options);
  };

  const nativeDescriptor = Object.getOwnPropertyDescriptor(proto, 'onicecandidate');
  if (nativeDescriptor?.set && nativeDescriptor.get) {
    Object.defineProperty(proto, 'onicecandidate', {
      configurable: true,
      enumerable: nativeDescriptor.enumerable,
      get: nativeDescriptor.get,
      set(this: any, handler: any) {
        if (typeof handler !== 'function') {
          return nativeDescriptor.set!.call(this, handler);
        }
        const wrapped = function (this: any, event: any) {
          if (event.candidate && isRealIpCandidate(event.candidate.candidate)) return;
          return handler.call(this, event);
        };
        return nativeDescriptor.set!.call(this, wrapped);
      },
    });
  }
}

export const VIEWPORT_WIDTH = 1920;
export const VIEWPORT_HEIGHT = 1080;
export const STEALTH_LOCALE = 'ja-JP';

/**
 * ビューポートと矛盾しない画面サイズ、および navigator.languages と一致する Intl ロケールを
 * CDPのネイティブoverrideで設定する。
 *
 * - screen: headless Chrome のデフォルトは 800x600 のままで、setViewport で 1920x1080 に
 *   しても screen.width/height は変わらない。「ビューポートが物理画面より大きい」という
 *   ありえない状態になり検出材料になる（実測で確認済み）。
 * - locale: Accept-Language と navigator.languages は ja-JP 優先に揃えたが、
 *   Intl.DateTimeFormat / Intl.NumberFormat の resolvedOptions().locale は en-US のまま
 *   取り残されていた（CreepJSは専用のIntlセクションでこれを検査する）。
 *
 * どちらも JS プロトタイプ改ざんではなく CDP のネイティブoverrideを使うため、
 * Function.prototype.toString() による改ざん検出（toString detection）の対象にならない。
 */
async function applyNativeEmulationOverrides(page: Page): Promise<void> {
  try {
    // detach() するとこれらの override は巻き戻る（実測: detach後に screen が 800x600、
    // locale が en-US に戻ることを確認）。そのためセッションは切らず、ページの寿命に
    // 任せて閉じさせる。
    const client = await page.createCDPSession();
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: VIEWPORT_WIDTH,
      screenHeight: VIEWPORT_HEIGHT,
    });
    await client.send('Emulation.setLocaleOverride', { locale: STEALTH_LOCALE });
  } catch {}
}

// 【既知の限界・実測で確認済み】Web Worker コンテキスト内の navigator は偽装しきれない。
// - UA は伝播する（Worker内でも Windows Chrome 148 を名乗る）
// - navigator.platform / navigator.languages は Worker に伝播せず、
//   'Linux x86_64' / 'en-US,en' が露出したままになる
// evaluateOnNewDocument のプロトタイプ改ざんが Worker に届かないのは既知だが、
// CDP の Emulation.setUserAgentOverride に platform / acceptLanguage を渡しても
// （page.setUserAgent を一切使わない状態で試しても）Worker には反映されないことを実測で確認した。
// 残る手段は Target.setAutoAttach で Worker 生成を捕まえてスクリプトを注入することだが、
// (1) Worker 内での JS 改ざんは toString detection の対象になる（WebGL偽装で実際に
// CreepJS の stealth スコアが 0%→20% に悪化してロールバックした前例がある）
// (2) CDP の露出面が増える
// という二重のリスクに対し、得られるのは CreepJS 等の Worker セクションの表示改善に留まるため、
// 費用対効果が見合わないと判断して対応しない。

/**
 * Canvasフィンガープリントに微小なノイズを注入する。getImageData()呼び出し結果の
 * 一部ピクセルの最下位ビットを、ページ(セッション)ごとに固定されたシードから決定論的に
 * 反転させる。同一セッション内では常に同じノイズ（Canvas自体は一貫して動作する）だが、
 * セッションが変わるとノイズパターンも変わるため、フィンガープリントとして収束しない。
 * ノイズはごく低確率かつ最下位ビットのみなので、実際の描画の見た目には影響しない。
 */
function patchCanvasFingerprint(): void {
  const seed = Math.random() * 10000;
  const proto = (globalThis as any).CanvasRenderingContext2D?.prototype;
  if (!proto?.getImageData) return;

  const originalGetImageData = proto.getImageData;
  proto.getImageData = function (this: any, ...args: any[]) {
    const imageData = originalGetImageData.apply(this, args);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const pseudoRandom = Math.abs(Math.sin(seed * (i + 1))) % 1;
      if (pseudoRandom < 0.02) {
        data[i] = data[i] ^ 1;
      }
    }
    return imageData;
  };
}

export async function applyStealthEvasions(page: Page): Promise<void> {
  try {
    const defaultUa = await page.browser().userAgent();
    await page.setUserAgent(buildUserAgentFromDefault(defaultUa), buildUserAgentMetadata(defaultUa));
  } catch {
    const fallbackUa = getFallbackUserAgent();
    await page.setUserAgent(fallbackUa, buildUserAgentMetadata(fallbackUa));
  }
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  await applyNativeEmulationOverrides(page);
  // navigator.languages(下記)と実際のHTTPリクエストヘッダーを一致させる。Chromiumの
  // Accept-Languageヘッダーは実行環境のロケール設定（例: コンテナのLANG=en_US.UTF-8）に
  // 依存し、JSでnavigator.languagesを上書きしても連動しない（実測で "en-US,en;q=0.9" の
  // まま送信され続け、jaが一切含まれない矛盾を確認済み）。
  await page.setExtraHTTPHeaders({ 'Accept-Language': ACCEPT_LANGUAGE });

  await page.evaluateOnNewDocument(() => {
    // navigator インスタンスではなく Navigator.prototype 上のgetterを上書きする。
    // インスタンスへの defineProperty だけでは検出サイトに素通しされる（実測で確認済み）。
    Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
    (globalThis as any).chrome = {
      runtime: {},
      app: {},
      csi: () => {},
      loadTimes: () => {},
    };
    // navigator.plugins はダミー配列で上書きしない。現代のheadless Chromeは
    // 標準でPDFビューア等の本物のPluginArrayを持つため、[1,2,3,4,5]のような
    // ダミー配列に置き換えると型がArrayになりPluginArray判定で逆に検出される
    // （実測で確認済み: 旧実装は "Plugins is of type PluginArray: failed"）。
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ja-JP', 'ja', 'en-US', 'en'],
    });
    // navigator.platform も UA(Windows)と一致させる。setUserAgent()のmetadata引数は
    // navigator.userAgentDataはカバーするが navigator.platform は別APIで対象外
    // （実測: CreepJSが "device: Linux" のまま検出、headless likelihood 56-67%だった）。
    Object.defineProperty(Object.getPrototypeOf(navigator), 'platform', {
      get: () => 'Win32',
      configurable: true,
    });
  });
  await page.evaluateOnNewDocument(patchWebRtcIpLeak);
  await page.evaluateOnNewDocument(patchCanvasFingerprint);
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
// 3. 安全な HTTP フェッチ (リダイレクト追跡 & SSRF/DNS Rebinding 再検証)
// ==========================================
export const MAX_RESPONSE_BODY_BYTES = 30 * 1024 * 1024; // 最大 30MB

// ==========================================
// 4. 安全な HTTP フェッチ (リダイレクト追跡 & SSRF/DNS Rebinding 再検証)
// ==========================================
// TLS/HTTP2/ヘッダー順序を一括で本物のブラウザに近づけるプロファイル群
// （wreq-js, MIT, https://github.com/sqdshguy/wreq-js）。
//
// 静的fetchとブラウザ経路は domain_cookies で同じCookieを共有するため、両者が名乗る
// identity は完全に一致していなければならない。実測で以下の矛盾を確認して潰した:
//   - Firefox 151 → Chrome 142 → Edge 147 とリクエスト毎にブラウザが変動していた
//   - 静的fetchが macOS、ブラウザ経路が Windows を名乗っていた（wreqのos既定が'macos'）
//   - 静的fetchが Chrome 141、ブラウザ経路が実バージョンの Chrome 148 を名乗っていた
// wreq がサポートする Chrome プロファイルの範囲（実行環境のChromiumに合わせて選ぶ）。
const SUPPORTED_CHROME_PROFILE_VERSIONS = [
  136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149,
];

/** wreq-js の os オプションは既定が 'macos'。ブラウザ経路(Windows)と揃えるため明示指定する。 */
export const EMULATION_OS = 'windows';

/** 両経路で共有する Accept-Language。片方だけ違うと同一Cookieで別設定を名乗ることになる。 */
export const ACCEPT_LANGUAGE = 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7';

/**
 * 実行環境の Chromium のバージョンに最も近い wreq プロファイルを選ぶ。
 * ブラウザ経路は buildUserAgentFromDefault で実バージョンを名乗るため、
 * 静的fetch側も同じバージョンに揃えないと同一Cookieでバージョンが飛ぶ。
 */
export function pickBrowserProfile(): BrowserProfile {
  const actual = getChromiumMajorVersion();
  const versions = SUPPORTED_CHROME_PROFILE_VERSIONS;
  const target = actual
    ? versions.reduce((best, v) => (Math.abs(v - actual) < Math.abs(best - actual) ? v : best), versions[0])
    : versions[versions.length - 1];
  return `chrome_${target}` as BrowserProfile;
}

/**
 * 静的fetch用プロキシURLをサーバー側の環境変数から選択する。
 * SORA_PROXY_LIST（カンマ区切り）が設定されていればランダムに1つ選び、
 * なければ getProxyConfig()（SORA_PROXY_URL > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY の優先順位、
 * browser_engine.ts のブラウザ用プロキシ解決と共通）にフォールバックする。
 * SSRF対策のため、ユーザー入力（MCP/RESTのリクエストパラメータ）からの
 * プロキシ指定は意図的に受け付けない。
 */
export function pickProxyUrl(): string | undefined {
  const list = process.env.SORA_PROXY_LIST?.trim();
  if (list) {
    const candidates = list.split(',').map((s) => s.trim()).filter(Boolean);
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  return getProxyConfig().proxyServer;
}

// ==========================================
// 静的fetch用 wreq-js セッションプール（ドメイン単位で再利用）
// ==========================================
// createSession() のネイティブTransport初期化コストは無視できないため
// （実測: 毎回create+closeだと標準fetchの約2.7倍遅い）、ブラウザセッション
// 管理（browser_session.ts）と同じTTL付きプールでドメインごとに使い回す。
const HTTP_SESSION_TTL_MS = 5 * 60 * 1000; // 非アクティブ5分でクローズ
const MAX_HTTP_SESSIONS = 50; // 同時保持上限（メモリ枯渇防止）

interface PooledHttpSession {
  session: Session;
  domain: string;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

const httpSessionPool = new Map<string, PooledHttpSession>();

function refreshHttpSessionTimer(pooled: PooledHttpSession): void {
  clearTimeout(pooled.timer);
  pooled.lastUsed = Date.now();
  pooled.timer = setTimeout(() => {
    void closeHttpSession(pooled.domain);
  }, HTTP_SESSION_TTL_MS);
  if (pooled.timer.unref) pooled.timer.unref();
}

/** プール内の最も長くアイドルなセッションを退避・クローズ (LRU) */
async function evictOldestHttpSessionIfNeeded(): Promise<void> {
  if (httpSessionPool.size < MAX_HTTP_SESSIONS) return;
  let oldestDomain: string | null = null;
  let oldestTime = Infinity;
  for (const [domain, p] of httpSessionPool.entries()) {
    if (p.lastUsed < oldestTime) {
      oldestTime = p.lastUsed;
      oldestDomain = domain;
    }
  }
  if (oldestDomain) await closeHttpSession(oldestDomain);
}

/** セッションをクローズし、Cookieを永続化してからプールから除去する */
export async function closeHttpSession(domain: string): Promise<void> {
  const pooled = httpSessionPool.get(domain);
  if (!pooled) return;
  clearTimeout(pooled.timer);
  httpSessionPool.delete(domain);
  try {
    const allCookies = pooled.session.getAllCookies();
    if (allCookies.length > 0) {
      dbSaveDomainCookies(domain, allCookies as PersistedCookie[]);
    }
  } catch {}
  try {
    await pooled.session.close();
  } catch {}
}

/** ドメインに対応するセッションをプールから取得、無ければ作成（保存済みCookieを復元） */
export async function getOrCreateHttpSession(
  domain: string,
  browser: BrowserProfile,
  proxyUrl?: string,
): Promise<Session> {
  const existing = httpSessionPool.get(domain);
  if (existing) {
    refreshHttpSessionTimer(existing);
    return existing.session;
  }

  await evictOldestHttpSessionIfNeeded();

  const session = await createSession({
    browser,
    os: EMULATION_OS,
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  });

  const savedCookies = dbGetDomainCookies(domain);
  if (savedCookies && savedCookies.length > 0) {
    for (const c of savedCookies) {
      try {
        session.setCookie(c.name, c.value, `https://${c.domain || domain}`);
      } catch {}
    }
  }

  const pooled: PooledHttpSession = { session, domain, lastUsed: Date.now(), timer: setTimeout(() => {}, 0) };
  clearTimeout(pooled.timer);
  httpSessionPool.set(domain, pooled);
  refreshHttpSessionTimer(pooled);
  return session;
}

export async function fetchWithSafeRedirects(
  initialUrl: string,
  timeoutMs = 15000,
  maxRedirects = 5,
  customHeaders?: Record<string, string>,
  customCookies?: CookieParam[],
  proxyUrl?: string,
): Promise<{ finalUrl: string; response: WreqResponse }> {
  let currentUrl = initialUrl;
  let redirects = 0;

  const cookieHeader = customCookies && customCookies.length > 0
    ? customCookies.map((c) => `${c.name}=${c.value}`).join('; ')
    : undefined;

  const initialDomain = new URL(initialUrl).hostname;
  const effectiveProxyUrl = proxyUrl ?? pickProxyUrl();
  // 実行環境のChromiumバージョンに揃える（ブラウザ経路と同じidentityを名乗るため）
  const browser = pickBrowserProfile();
  const session = await getOrCreateHttpSession(initialDomain, browser, effectiveProxyUrl);

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

    // User-Agent・Accept・Sec-Fetch-* 等は browser プロファイルが本物同等の値を自動注入する
    const headers: Record<string, string> = {
      'Accept-Language': ACCEPT_LANGUAGE,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(customHeaders || {}),
    };

    const res = await session.fetch(currentUrl, {
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
      const location = res.headers.get('location');
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

  // 8. ノイズ要素 & Cookie 同意バナー & 不可視要素（間接プロンプトインジェクション対策）等のパージ
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
    '[hidden]',
    '[aria-hidden="true"]',
    '[style*="display:none"]',
    '[style*="display: none"]',
    '[style*="visibility:hidden"]',
    '[style*="visibility: hidden"]',
    '[style*="font-size:0"]',
    '[style*="font-size: 0"]',
    '[style*="opacity:0"]',
    '[style*="opacity: 0"]',
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
        // カレンダー・テーブル等の構造化データがReadabilityで誤って間引かれていないか検証
        const bodyTextLen = $('body').text().replace(/\s+/g, ' ').trim().length;
        const articleTextLen = $(article.content).text().replace(/\s+/g, ' ').trim().length;
        const hasStructuredGrid = $('[role="grid"], [role="gridcell"], table, [class*="calendar"], [id*="calendar"], [data-test-id*="calendar"]').length > 0;

        if (hasStructuredGrid && articleTextLen < bodyTextLen * 0.4 && bodyTextLen > 200) {
          // カレンダー・グリッド構造が過剰に削ぎ落とされたと判定し、main/article/body にフォールバック
          contentHtml = $('main').html() || $('article').html() || $('#content').html() || $('body').html() || '';
        } else {
          contentHtml = article.content;
        }
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

/** ベジエ曲線+イージングで座標間をステップ移動し、mousemoveイベントを段階的に発火させる */
export async function humanMouseMove(
  page: Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<void> {
  const steps = 12 + Math.floor(Math.random() * 10);
  const ctrlX = fromX + (toX - fromX) * 0.5 + (Math.random() - 0.5) * 80;
  const ctrlY = fromY + (toY - fromY) * 0.5 + (Math.random() - 0.5) * 80;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const x = (1 - eased) ** 2 * fromX + 2 * (1 - eased) * eased * ctrlX + eased ** 2 * toX;
    const y = (1 - eased) ** 2 * fromY + 2 * (1 - eased) * eased * ctrlY + eased ** 2 * toY;
    await page.mouse.move(x, y);
    if (i < steps) await new Promise((r) => setTimeout(r, 3 + Math.random() * 7));
  }
}

/**
 * ブラウザから取得したCookieを、各Cookie自身の domain 属性ごとにグループ化する。
 * リクエスト前のURLとCookieの実ドメインはリダイレクトを跨ぐと食い違うことがあるため、
 * 常にリクエスト前ドメインをキーにすると復元時に見つからなくなる。domain属性が
 * 空の場合のみ fallbackDomain を使う。先頭の "." はホスト名比較のため正規化して除去する。
 */
export function groupCookiesByDomain(
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
    expires?: number;
  }[],
  fallbackDomain: string,
): Map<string, PersistedCookie[]> {
  const result = new Map<string, PersistedCookie[]>();
  for (const c of cookies) {
    const key = (c.domain || fallbackDomain).replace(/^\./, '');
    const persisted: PersistedCookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite ? (c.sameSite.toLowerCase() as PersistedCookie['sameSite']) : undefined,
      expiresAtMs: c.expires && c.expires > 0 ? c.expires * 1000 : undefined,
    };
    const list = result.get(key);
    if (list) list.push(persisted);
    else result.set(key, [persisted]);
  }
  return result;
}

/**
 * SPAの取りこぼしを防ぐための3つの後処理。実測で、goto直後にcontent()を取るだけでは
 * (1)遅延ロード (2)Shadow DOM (3)遅延レンダリング のコンテンツを取り落とすことを確認済み。
 * いずれもJSプロトタイプ改ざんを伴わないためbot検知リスクはない（自動スクロールはむしろ
 * 実ユーザーらしい挙動になる）。
 */

/** ページ末尾まで段階的にスクロールし、IntersectionObserverベースの遅延ロードを発火させる */
async function autoScrollPage(page: Page, maxScrolls = 8): Promise<void> {
  try {
    await page.evaluate(async (limit: number) => {
      const step = window.innerHeight;
      let lastHeight = 0;
      for (let i = 0; i < limit; i++) {
        window.scrollBy(0, step);
        await new Promise((r) => setTimeout(r, 80));
        const height = document.body.scrollHeight;
        // 最下部に到達し、かつ新規コンテンツの追加も止まったら終了（無限スクロール対策）
        if (window.scrollY + window.innerHeight >= height && height === lastHeight) break;
        lastHeight = height;
      }
      window.scrollTo(0, 0);
    }, maxScrolls);
  } catch {}
}

/**
 * 本文テキストの「増加」が止まるまで待つ。networkidleはネットワークの静止しか見ないため、
 * その後にクライアント側が描画するコンテンツを取り落とす（実測で確認済み）。
 *
 * MutationObserverで「DOM変化がゼロになるまで」待つ実装も試したが、時計表示やアニメーション等
 * 常時DOMを書き換えるページでハードリミットまで待ち続けてしまい、実測で6.3秒かかった。
 * ここで待ちたいのは「新しいコンテンツが出揃うこと」なので、文字数が増えなくなったかで判定する。
 * これなら常時書き換え系（文字数が増えない）は即座に抜けられる。
 */
async function waitForDomStable(page: Page, quietMs = 1200, timeoutMs = 5000): Promise<void> {
  try {
    await page.evaluate(
      async (quiet: number, limit: number) => {
        const start = Date.now();
        let maxScore = -1;
        let lastGrowth = Date.now();
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        const loadingSelectors = [
          '.loading',
          '.spinner',
          '.skeleton',
          '[aria-busy="true"]',
          '[role="progressbar"]',
          '.is-loading',
          '.loading__spinner',
          '.loading__content',
        ];

        while (Date.now() - start < limit) {
          let hasVisibleLoading = false;
          if (doc && win) {
            for (const sel of loadingSelectors) {
              const elements = doc.querySelectorAll(sel);
              for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                const style = win.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                  hasVisibleLoading = true;
                  break;
                }
              }
              if (hasVisibleLoading) break;
            }
          }

          const textLength = doc?.body?.innerText?.length ?? 0;
          const elementCount = doc?.querySelectorAll('*')?.length ?? 0;
          const currentScore = textLength + elementCount * 5;

          if (currentScore > maxScore || hasVisibleLoading) {
            maxScore = currentScore;
            lastGrowth = Date.now();
          }

          if (!hasVisibleLoading && Date.now() - lastGrowth >= quiet) {
            return;
          }

          await new Promise((r) => setTimeout(r, 100));
        }
      },
      quietMs,
      timeoutMs,
    );
  } catch {}
}

/**
 * open な shadow root の中身を、そのホスト要素配下の通常DOMとして複製する。
 * page.content() は outerHTML 相当で shadow root を含まないため、
 * Web Components ベースのサイトは本文が丸ごと欠落する（実測で確認済み）。
 * 元のshadow rootは触らず、抽出用の隠しコンテナを足すだけなのでページ動作に影響しない。
 */
async function inlineShadowDomContent(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const MARKER = 'data-sora-shadow-copy';
      const walk = (root: Document | ShadowRoot) => {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          const sr = (el as any).shadowRoot as ShadowRoot | null;
          if (!sr || el.hasAttribute?.(MARKER)) continue;
          walk(sr);
          const copy = document.createElement('div');
          copy.setAttribute(MARKER, '');
          copy.innerHTML = sr.innerHTML;
          el.appendChild(copy);
        }
      };
      walk(document);
    });
  } catch {}
}

// ==========================================
// 6. Stealth Chromium レンダリング
// ==========================================
export async function fetchWithStealthBrowser(
  url: string,
  timeoutMs = 30000,
  clipSelector?: string,
  customCookies?: CookieParam[],
  waitUntil: 'networkidle0' | 'networkidle2' = 'networkidle2',
  needScreenshot = false,
): Promise<{ html: string; title: string; screenshot?: string; finalUrl: string }> {
  const chromePath = resolveChromiumPath();
  if (!chromePath) {
    throw new Error('Chromium/Chrome が見つからないためブラウザレンダリングを実行できません');
  }

  await throttleDomain(url);

  // ブラウザ同時実行数制限（セマフォ待機）
  await browserSemaphore.acquire();

  try {
    const { browser, isDedicated } = await getBrowser();
    // 共有ブラウザは全ページでCookieJarを共有するため、リクエストごとに独立した
    // BrowserContext(Incognito相当)を使う。同時に処理される別リクエスト間で
    // Cookie/セッションが漏れないようにするための分離（実測で漏洩を確認済み）。
    const context = await browser.createBrowserContext();

    try {
      const page: Page = await context.newPage();
      // スクリーンショット非要求時は画像・メディア・フォント・広告トラッカーを高速遮断
      await setupPageSecurity(page, !needScreenshot && !clipSelector);
      try {
        const defaultUa = await browser.userAgent();
        await page.setUserAgent(buildUserAgentFromDefault(defaultUa), buildUserAgentMetadata(defaultUa));
      } catch {
        const fallbackUa = getFallbackUserAgent();
        await page.setUserAgent(fallbackUa, buildUserAgentMetadata(fallbackUa));
      }
      await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
      await applyNativeEmulationOverrides(page);
      await page.setExtraHTTPHeaders({ 'Accept-Language': ACCEPT_LANGUAGE });

      const domain = new URL(url).hostname;
      const persistedCookies = dbGetDomainCookies(domain);
      if (persistedCookies && persistedCookies.length > 0) {
        const restoredCookies = persistedCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || domain,
          path: c.path || '/',
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        }));
        try {
          await page.setCookie(...(restoredCookies as any));
        } catch {}
      }

      const persistedStorage = dbGetDomainStorage(domain);
      if (persistedStorage && Object.keys(persistedStorage).length > 0) {
        // localStorageはオリジンに紐づくAPIのためgoto前には書き込めない。ページの
        // 実スクリプトが走る前にセットするため evaluateOnNewDocument で注入する
        // （Cookieだけでは引き継がれないサイトトークン等の再利用のため）。
        await page.evaluateOnNewDocument((data: Record<string, string>) => {
          try {
            for (const [k, v] of Object.entries(data)) {
              localStorage.setItem(k, v);
            }
          } catch {}
        }, persistedStorage);
      }

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
        // navigator インスタンスではなく Navigator.prototype 上のgetterを上書きする。
        // インスタンスへの defineProperty だけでは検出サイトに素通しされる（実測で確認済み）。
        Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
          get: () => undefined,
          configurable: true,
        });
        // navigator.platform も UA(Windows)と一致させる（CreepJS実測で矛盾を検出済み）。
        Object.defineProperty(Object.getPrototypeOf(navigator), 'platform', {
          get: () => 'Win32',
          configurable: true,
        });
        // navigator.languages を Accept-Language ヘッダー(page.setExtraHTTPHeaders)と一致させる。
        Object.defineProperty(navigator, 'languages', {
          get: () => ['ja-JP', 'ja', 'en-US', 'en'],
        });
      });
      await page.evaluateOnNewDocument(patchWebRtcIpLeak);
      await page.evaluateOnNewDocument(patchCanvasFingerprint);

      await page.goto(url, { waitUntil, timeout: timeoutMs });

      // ページ滞在中の行動シグナル（マウス移動皆無)は invisible な bot 判定材料になりうるため、
      // コンテンツ取得前に軽くマウスを動かす（クリックは行わない、受動的な閲覧を模す）
      try {
        const viewport = page.viewport();
        const w = viewport?.width ?? 1920;
        const h = viewport?.height ?? 1080;
        const x1 = w * (0.2 + Math.random() * 0.3);
        const y1 = h * (0.2 + Math.random() * 0.3);
        const x2 = w * (0.5 + Math.random() * 0.3);
        const y2 = h * (0.5 + Math.random() * 0.3);
        await humanMouseMove(page, x1, y1, x2, y2);
      } catch {}

      // SPA取りこぼし対策: 遅延ロードを発火させ、DOMが落ち着くまで待ち、
      // shadow root の中身を抽出可能な形に展開してから content() を取る
      await autoScrollPage(page);
      await waitForDomStable(page);
      await inlineShadowDomContent(page);

      const finalUrl = page.url();
      const title = await page.title();
      const html = await page.content();

      try {
        const currentCookies = await page.cookies();
        if (currentCookies.length > 0) {
          const cookiesByDomain = groupCookiesByDomain(currentCookies, domain);
          for (const [key, list] of cookiesByDomain) {
            dbSaveDomainCookies(key, list);
          }
        }
      } catch {}

      try {
        const currentStorage = await page.evaluate(() => {
          try {
            return { ...localStorage };
          } catch {
            return null;
          }
        });
        if (currentStorage && Object.keys(currentStorage).length > 0) {
          dbSaveDomainStorage(domain, currentStorage);
        }
      } catch {}

      let screenshot: string | undefined = undefined;
      if (needScreenshot || clipSelector) {
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
      }

      return { html, title, screenshot, finalUrl };
    } finally {
      if (isDedicated) {
        await browser.close();
      } else {
        await context.close();
      }
    }
  } finally {
    browserSemaphore.release();
  }
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
// 12. 単一 URL スクレイピング (scrapeUrl)
// ==========================================

const BOT_MITIGATION_STATUS_CODES = new Set([403, 429, 503]);

// 静的fetch→ブラウザ昇格、ブラウザレンダリング後の再試行がどれだけ発生しているかの運用可視化用カウンタ
let botUpgradeCount = 0;
let botRetryCount = 0;

export function getBotDetectionMetrics(): { upgradeCount: number; retryCount: number } {
  return { upgradeCount: botUpgradeCount, retryCount: botRetryCount };
}

/**
 * 静的fetch結果がSPA(JS描画)またはbot対策の壁である可能性を判定する。
 * HTML文字列マーカーに加えて、HTTPステータスコードとCloudflare系ヘッダーも見る。
 */
export function detectSpaOrBotPage(options: {
  html: string;
  bodyOnlyMarkdown: string;
  status?: number;
  headers?: Record<string, string>;
}): boolean {
  const { html, bodyOnlyMarkdown, status, headers } = options;
  const hasLittleContent = bodyOnlyMarkdown.length < 50;

  // JavaScript 有効化要求・SPA マウントポイント・Cloudflare 待機画面の検知
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

/**
 * ブラウザレンダリング後も依然としてコンテンツが取得できていない（ブロック/空白）かを判定する。
 * react-root や react-data などのSPAマーカーは成功の証拠なのでマッチさせず、
 * 純粋に本文が極端に少ないか、Cloudflare等のブロック画面のままかだけを判定する。
 */
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
  onlyMainContent?: boolean;
  selectors?: Record<string, string>;
  clipSelector?: string;
  headers?: Record<string, string>;
  cookies?: CookieParam[];
  removeSelectors?: string[];
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

  const cacheKey = `scrape:${url}:${maxChars}:${options.mode || 'auto'}:${onlyMainContent}:${formats.slice().sort().join(',')}:${(options.removeSelectors || []).join(',')}:${options.query || ''}:${options.extractHighlights || false}:${options.onlyHighlights || false}:${options.extractSummary || false}:${options.extractCitations || false}:${options.chunkMarkdown || false}:${options.chunkSize || 1000}:${options.validateLinks || false}:${options.maskPii || false}:${options.formatAsPrompt || false}:${options.highlightMatches || false}`;

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
            shouldExtractHighlights: options.extractHighlights ?? (options.onlyHighlights ? true : false),
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
        );

        // Frontmatter を除いた実本文テキストの判定
        const bodyOnlyMarkdown = parsed.markdown.replace(/^---[\s\S]*?---\n*/, '').trim();

        const chromePath = resolveChromiumPath();
        const isSpaOrBlank =
          !isFastMode &&
          chromePath &&
          detectSpaOrBotPage({
            html,
            bodyOnlyMarkdown,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
          });
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
            shouldExtractHighlights: options.extractHighlights ?? (options.onlyHighlights ? true : false),
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

      // Chromium 自動昇格 または ブラウザ指定モード
      onProgress?.({ stage: 'render', message: 'Rendering SPA via Stealth Chromium' });
      const needScreenshot = formats.includes('screenshot');
      let browserRes = await fetchWithStealthBrowser(
        url,
        timeoutMs,
        options.clipSelector,
        options.cookies,
        'networkidle2',
        needScreenshot,
      );

      let parsed = convertHtmlToMarkdown(
        browserRes.html,
        browserRes.finalUrl,
        maxChars,
        true,
        onlyMainContent,
        options.selectors,
        options.removeSelectors,
      );

      // レンダリング後も空/JS警告のままなら waitUntil を変えて1回だけ再試行する
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
        );
        parsed = convertHtmlToMarkdown(
          browserRes.html,
          browserRes.finalUrl,
          maxChars,
          true,
          onlyMainContent,
          options.selectors,
          options.removeSelectors,
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
        shouldExtractHighlights: options.extractHighlights ?? (options.onlyHighlights ? true : false),
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
  const extractHighlights = options.extractHighlights ?? false;
  const onlyMainContent = options.onlyMainContent !== false;
  const formats = options.formats ?? ['markdown'];
  const dedup = options.dedup ?? false;
  const cacheKey = `search:integrated:${query}:${limit}:${scrapeContent}:${includeRealtime}:${realtimeSort}:${(includeDomains || []).join(',')}:${(excludeDomains || []).join(',')}:${updated || 'all'}:${extractHighlights}:${onlyMainContent}:${formats.slice().sort().join(',')}:${dedup}`;
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
            textFragmentUrl: scrape.textFragmentUrl,
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
