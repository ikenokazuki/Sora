import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { existsSync } from 'fs';
import { promises as dnsPromises } from 'dns';

/** Chromium 実行バイナリパスの自動検出 */
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
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  if (process.env.LOCALAPPDATA) {
    standardPaths.push(`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`);
    standardPaths.push(`${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`);
  }
  for (const p of standardPaths) {
    if (existsSync(p)) return p;
  }

  // PATH 環境変数の走査 (NixOS / Custom distros / Windows)
  const pathEnv = process.env.PATH || '';
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const pathDirs = pathEnv.split(pathSeparator);
  const binaries = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe', 'msedge.exe']
    : ['chromium', 'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chrome'];
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

export const CHROME_EXECUTABLE_PATH = resolveChromiumPath();

let cachedChromiumMajorVersion: number | undefined | null = null;

/**
 * 実行に使う Chromium のメジャーバージョンを取得する（結果はキャッシュ）。
 * 静的fetch(wreq)側のプロファイル選択を、ブラウザ経路が名乗るバージョンと一致させるために使う。
 * 両経路は Cookie を共有するため、バージョンがずれると「同じセッションのブラウザが
 * 別バージョンに変わる」矛盾になる（実測で Chrome 141 と 148 の食い違いを確認済み）。
 */
export function getChromiumMajorVersion(): number | undefined {
  if (cachedChromiumMajorVersion !== null) return cachedChromiumMajorVersion;
  cachedChromiumMajorVersion = undefined;
  if (CHROME_EXECUTABLE_PATH) {
    try {
      const { execSync } = require('child_process');
      const out: string = execSync(`"${CHROME_EXECUTABLE_PATH}" --version`, {
        encoding: 'utf8',
        timeout: 5000,
      });
      const major = out.match(/\b(\d+)\.\d+\.\d+/)?.[1];
      if (major) cachedChromiumMajorVersion = parseInt(major, 10);
    } catch {}
  }
  return cachedChromiumMajorVersion;
}

let sharedBrowserInstance: Browser | null = null;

/**
 * 環境変数からプロキシ設定を取得します。
 * 優先順位: SORA_PROXY_URL > HTTPS_PROXY / https_proxy > HTTP_PROXY / http_proxy > ALL_PROXY / all_proxy
 * NO_PROXY / no_proxy はプロキシ除外リストとして解釈されます。
 */
export function getProxyConfig(): { proxyServer?: string; proxyBypassList?: string } {
  const proxyServer =
    process.env.SORA_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    process.env.ALL_PROXY?.trim() ||
    process.env.all_proxy?.trim() ||
    undefined;

  const proxyBypassList =
    process.env.NO_PROXY?.trim() ||
    process.env.no_proxy?.trim() ||
    undefined;

  return { proxyServer, proxyBypassList };
}

/** 共有または専用 Chromium ブラウザインスタンスの取得 */
export async function getBrowser(overrideProxyUrl?: string): Promise<{ browser: Browser; isDedicated: boolean }> {
  const config = getProxyConfig();
  const effectiveProxy = overrideProxyUrl?.trim() || config.proxyServer;
  const effectiveBypass = config.proxyBypassList;

  // overrideProxyUrl が明示的に指定され、かつ環境変数の設定と異なる場合のみ専用インスタンスを起動
  if (overrideProxyUrl && overrideProxyUrl.trim() !== config.proxyServer) {
    if (!CHROME_EXECUTABLE_PATH) {
      throw new Error('Chromium/Chrome が見つからないためブラウザを起動できません');
    }
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      // --disable-gpu は付けない: WebGLコンテキスト自体が取得不能になり
      // (canvas.getContext('webgl') が null)、bot対策サイトの検出項目になる。
      // SwiftShaderソフトウェアレンダリングで代替され、実測でパフォーマンス
      // 悪化もない（誤差範囲でむしろ僅かに高速）。
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      // WebRTCがSTUN経由で実IPを漏らす対策（プロキシ運用時に致命的、実測でIP露出を確認済み）。
      // 非プロキシ経由のUDP直接通信を無効化する。
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      `--proxy-server=${effectiveProxy}`,
    ];
    if (effectiveBypass) {
      args.push(`--proxy-bypass-list=${effectiveBypass}`);
    }
    const dedicated = await puppeteer.launch({
      executablePath: CHROME_EXECUTABLE_PATH,
      headless: true,
      args,
      // Puppeteerがデフォルト付与するフラグのうち、一般ユーザー環境に不自然な差分を除去
      // （Patchright方式に倣った近似化）。--enable-automation は navigator.webdriver を
      // true にする一因（実測で確認済み）。--disable-popup-blocking/--disable-default-apps
      // は通常のブラウザでは有効な設定で、無効化されていること自体が検出材料になりうる。
      ignoreDefaultArgs: ['--enable-automation', '--disable-popup-blocking', '--disable-default-apps'],
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
    // --disable-gpu は付けない（理由は上記 dedicated ブラウザ側のコメント参照）
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    // WebRTCがSTUN経由で実IPを漏らす対策（理由は上記 dedicated ブラウザ側のコメント参照）
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];

  if (effectiveProxy) {
    args.push(`--proxy-server=${effectiveProxy}`);
    if (effectiveBypass) {
      args.push(`--proxy-bypass-list=${effectiveBypass}`);
    }
  }

  sharedBrowserInstance = await puppeteer.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args,
    // 理由は上記 dedicated ブラウザ側のコメント参照
    ignoreDefaultArgs: ['--enable-automation', '--disable-popup-blocking', '--disable-default-apps'],
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

let sharedBrowserUsageCount = 0;
const MAX_SHARED_BROWSER_USES = 200;

export function recordBrowserUsage(): void {
  sharedBrowserUsageCount++;
}

export function maybeRotateSharedBrowser(): void {
  if (browserSemaphore.activeCount === 0 && sharedBrowserUsageCount >= MAX_SHARED_BROWSER_USES) {
    sharedBrowserUsageCount = 0;
    void closeSharedBrowser();
  }
}

/** 簡易セマフォ（ブラウザ同時実行数制限） */
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
    } else if (this.current === 0) {
      maybeRotateSharedBrowser();
    }
  }

  get activeCount(): number {
    return this.current;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

export const MAX_CONCURRENT_BROWSERS = parseInt(process.env.MAX_CONCURRENT_BROWSERS || '5', 10);
export const browserSemaphore = new SimpleSemaphore(Math.max(1, Math.min(MAX_CONCURRENT_BROWSERS, 50)));

/**
 * 任意の IPv4 表記（10進ドット、8進数、16進数、短縮表記、32bit整数）を 32bit 符号なし整数に正規化する。
 * SSRF バイパス攻撃（0177.0.0.1 や 0x7f000001、127.1 等）を確実に検知・遮断するために使用。
 */
export function parseIpv4ToUint32(host: string): number | null {
  const clean = host.toLowerCase().trim().replace(/^\[|\]$/g, '');
  const parts = clean.split('.');
  if (parts.length > 4 || parts.length === 0) return null;

  const values: number[] = [];
  for (const p of parts) {
    if (!p) return null;
    let val: number;
    if (p.startsWith('0x')) {
      val = parseInt(p.slice(2), 16);
    } else if (p.startsWith('0') && p.length > 1 && !/[89a-f]/i.test(p)) {
      val = parseInt(p, 8);
    } else if (/^\d+$/.test(p)) {
      val = parseInt(p, 10);
    } else {
      return null;
    }
    if (isNaN(val) || val < 0) return null;
    values.push(val);
  }

  let ip = 0;
  if (values.length === 1) {
    ip = values[0];
  } else if (values.length === 2) {
    if (values[0] > 0xff || values[1] > 0xffffff) return null;
    ip = ((values[0] << 24) >>> 0) + values[1];
  } else if (values.length === 3) {
    if (values[0] > 0xff || values[1] > 0xff || values[2] > 0xffff) return null;
    ip = ((values[0] << 24) >>> 0) + (values[1] << 16) + values[2];
  } else if (values.length === 4) {
    if (values.some((v) => v > 0xff)) return null;
    ip = ((values[0] << 24) >>> 0) + (values[1] << 16) + (values[2] << 8) + values[3];
  } else {
    return null;
  }
  return ip >>> 0;
}

export function isPrivateIpUint32(num: number): boolean {
  const b0 = (num >>> 24) & 0xff;
  const b1 = (num >>> 16) & 0xff;
  const b2 = (num >>> 8) & 0xff;

  // 0.0.0.0/8 (Current network / broadcast)
  if (b0 === 0) return true;
  // 10.0.0.0/8 (Private)
  if (b0 === 10) return true;
  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;
  // 100.64.0.0/10 (CGNAT / RFC 6598)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 169.254.0.0/16 (Link-Local / Cloud Metadata)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12 (Private)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  // 192.168.0.0/16 (Private)
  if (b0 === 192 && b1 === 168) return true;
  // 198.18.0.0/15 (Benchmark testing)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved) & 255.255.255.255 (Broadcast)
  if (b0 >= 224) return true;

  return false;
}

export function isPrivateIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');

  // 1. IPv6 の直接判定
  if (trimmed === '::1' || trimmed === '::') return true;
  if (trimmed.startsWith('fc') || trimmed.startsWith('fd') || trimmed.startsWith('fe80:') || trimmed.startsWith('ff')) return true;

  // IPv6 埋め込み IPv4 (例: ::ffff:127.0.0.1, ::ffff:7f00:1, ::ffff:7f00:0001)
  if (trimmed.startsWith('::ffff:')) {
    const mapped = trimmed.replace(/^::ffff:/, '');
    if (mapped.includes(':')) {
      const hexParts = mapped.split(':');
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (!isNaN(hi) && !isNaN(lo)) {
          const num = (((hi & 0xffff) << 16) | (lo & 0xffff)) >>> 0;
          return isPrivateIpUint32(num);
        }
      }
    }
    return isPrivateIp(mapped);
  }

  // 2. 任意の進数・短縮表記を含む IPv4 の 32bit 整数への正規化
  const num = parseIpv4ToUint32(trimmed);
  if (num !== null) {
    return isPrivateIpUint32(num);
  }

  // 3. 一般的なプレフィックスフォールバック
  if (trimmed.startsWith('10.') || trimmed.startsWith('192.168.') || trimmed.startsWith('0.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(trimmed)) return true;
  if (trimmed.startsWith('169.254.')) return true;

  return false;
}

/** ブロック対象ホスト名判定ヘルパー */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
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
  return isPrivateIp(h);
}

const dnsValidationCache = new Map<string, { addresses: string[]; expiresAt: number }>();
const DNS_CACHE_TTL_MS = 60_000;

export const BLOCKED_TRACKER_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'appsflyer.com',
  'sentry.io',
  'cookieyes.com',
  'facebook.net',
  'clarity.ms',
  'adservice.google.',
  'pagead2.googlesyndication.com',
];

/** DNS 解決後の実 IP アドレスを検証（DNS Rebinding 攻撃対策＋インメモリキャッシュ） */
export async function validateHostIpDns(hostname: string): Promise<string[]> {
  if (process.env.ALLOW_LOCAL_FETCH === 'true') return [];

  const cleanHost = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (isBlockedHostname(cleanHost) || isPrivateIp(cleanHost)) {
    throw new Error(`プライベートネットワークまたは安全でないホストへのアクセスは遮断されています: ${hostname}`);
  }

  const now = Date.now();
  const cached = dnsValidationCache.get(cleanHost);
  if (cached && cached.expiresAt > now) {
    return cached.addresses;
  }

  try {
    const addresses = await dnsPromises.lookup(cleanHost, { all: true });
    if (!addresses || addresses.length === 0) {
      return [];
    }
    for (const addr of addresses) {
      if (isBlockedHostname(addr.address) || isPrivateIp(addr.address)) {
        throw new Error(`DNS Rebinding 攻撃（プライベート IP への解決）が検知されたため遮断されました: ${hostname} -> ${addr.address}`);
      }
    }
    const result = addresses.map((a) => a.address);
    dnsValidationCache.set(cleanHost, { addresses: result, expiresAt: now + DNS_CACHE_TTL_MS });
    return result;
  } catch (err: any) {
    if (err.message && (err.message.includes('DNS Rebinding') || err.message.includes('プライベートネットワーク'))) {
      throw err;
    }
    return [];
  }
}

/** Headless Chromium のページ内サブリクエストに対する SSRF 防御 & 不要リソース高速遮断 */
export async function setupPageSecurity(page: Page, blockMedia = false): Promise<void> {
  try {
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      try {
        const reqUrlStr = req.url();
        const resourceType = req.resourceType();

        // 動画・音声・3Dモデル・広告トラッカーは帯域・メモリ保護のため常時高速遮断
        if (
          ['media'].includes(resourceType) ||
          /\.(gltf|glb|obj|fbx|mp4|webm|m4v|m4a|mp3|ogg|wav|flac)(\?.*)?$/i.test(reqUrlStr) ||
          BLOCKED_TRACKER_DOMAINS.some((d) => reqUrlStr.includes(d))
        ) {
          return req.abort('blockedbyclient');
        }

        // スクリーンショット非要求時 (blockMedia=true) は画像・Webフォントも追加遮断
        if (blockMedia && ['image', 'font'].includes(resourceType)) {
          return req.abort('blockedbyclient');
        }

        if (process.env.ALLOW_LOCAL_FETCH === 'true') {
          return req.continue();
        }

        if (reqUrlStr.startsWith('data:') || reqUrlStr.startsWith('blob:') || reqUrlStr.startsWith('about:')) {
          return req.continue();
        }
        let reqUrl: URL;
        try {
          reqUrl = new URL(reqUrlStr);
        } catch {
          return req.abort('blockedbyclient');
        }
        if (!['http:', 'https:'].includes(reqUrl.protocol)) {
          return req.abort('blockedbyclient');
        }
        const host = reqUrl.hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
        if (isBlockedHostname(host) || isPrivateIp(host)) {
          return req.abort('accessdenied');
        }

        // キャッシュ付きホスト検証
        const now = Date.now();
        const cached = dnsValidationCache.get(host);
        if (cached && cached.expiresAt > now) {
          return req.continue();
        }

        try {
          const addresses = await dnsPromises.lookup(host, { all: true });
          for (const addr of addresses) {
            if (isBlockedHostname(addr.address) || isPrivateIp(addr.address)) {
              return req.abort('accessdenied');
            }
          }
          dnsValidationCache.set(host, {
            addresses: addresses.map((a) => a.address),
            expiresAt: now + DNS_CACHE_TTL_MS,
          });
        } catch {}
        req.continue();
      } catch {
        req.abort('failed');
      }
    });
  } catch (err) {
    console.warn('[Sora] Warning: Failed to set request interception for page security:', err);
  }
}

/**
 * 画面上に非表示となっている不要ノード（CSS display:none, visibility:hidden, hidden属性, aria-hidden等）を
 * DOMツリーから安全に剪定（Prune）し、LLM誤読・ハルシネーションを防ぐ。
 */
export async function pruneInvisibleElements(page: Page): Promise<void> {
  try {
    if (page.isClosed()) return;
    await page
      .evaluate(() => {
        try {
          // 1. 標準的な不可視・テンプレート要素の先行除去
          const staticTags = document.querySelectorAll('noscript, template, [hidden]');
          staticTags.forEach((el) => {
            try {
              el.remove();
            } catch {}
          });

          // 2. DOMツリーの走査とComputed Styleによる不可視要素の剪定
          if (!document.body) return;
          const allElements = Array.from(document.body.querySelectorAll('*'));
          for (const el of allElements) {
            if (!el.isConnected) continue;

            const tag = el.tagName.toLowerCase();
            // script, style, link, meta 等はパーサー処理（JSON-LD等）のために維持
            if (['script', 'style', 'meta', 'link', 'title'].includes(tag)) continue;

            try {
              const style = window.getComputedStyle(el);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse'
              ) {
                el.remove();
                continue;
              }

              if (el.getAttribute('aria-hidden') === 'true' && el.classList.contains('visually-hidden')) {
                el.remove();
                continue;
              }
            } catch {}
          }
        } catch {}
      })
      .catch(() => {});
  } catch {}
}

