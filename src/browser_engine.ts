import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { existsSync, readFileSync } from 'fs';
import { promises as dnsPromises } from 'dns';
import { totalmem } from 'os';
import { errorMessage } from './errors.js';

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
 * 共有ブラウザを起動している最中の Promise。無操作終了の直後などに getBrowser() が同時に呼ばれても、
 * 起動は 1 回だけにして全員が同じブラウザを受け取る。共有しないと、呼び出しの数だけ Chromium が起動し、
 * 最後に代入された 1 つ以外は参照を失って閉じられないまま残る（1 つあたり数百 MB）。
 */
let sharedBrowserLaunch: Promise<Browser> | null = null;

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
    const dedicated = await launchStealthChromium(effectiveProxy, effectiveBypass);
    return { browser: dedicated, isDedicated: true };
  }

  // 共有ブラウザ: 起動済みならそれを、起動中ならその完了を待って受け取る（同時に複数起動しない）。
  // 待っている間に閉じられた場合に備え、起動の完了後は状態を見直す。
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = sharedBrowserInstance;
    if (existing?.connected) {
      try {
        await existing.version();
        // 疎通確認の await 中に閉じられた・差し替えられた場合は渡さず、次の周回で取り直す
        if (sharedBrowserInstance === existing) {
          markSharedBrowserUsed();
          return { browser: existing, isDedicated: false };
        }
      } catch {
        if (sharedBrowserInstance === existing) sharedBrowserInstance = null;
      }
    }

    if (!CHROME_EXECUTABLE_PATH) {
      throw new Error('Chromium/Chrome が見つからないためブラウザを起動できません');
    }

    if (!sharedBrowserLaunch) {
      sharedBrowserLaunch = launchSharedBrowser(effectiveProxy, effectiveBypass);
    }
    // 失敗したときは待っている全員に同じエラーが伝わり、次の呼び出しで起動をやり直せる
    await sharedBrowserLaunch;
  }
  throw new Error('共有ブラウザを起動できませんでした');
}

/** ブラウザが名乗るタイムゾーン。ロケール（ja-JP）と、日本の IP に合わせる。 */
export const STEALTH_TIMEZONE = 'Asia/Tokyo';

/**
 * 起動時に --user-agent へ渡す UA。ページごとの CDP の上書きは、Service Worker などには届かず
 * "HeadlessChrome" と本物の OS が見える（実測で CreepJS の headless 判定が 33% → 0%）。
 * browser_stealth.ts と循環するので、起動のときに読み込む。
 */
async function stealthUserAgent(): Promise<string | undefined> {
  try {
    return (await import('./browser_stealth.js')).getFallbackUserAgent();
  } catch {
    return undefined;
  }
}

/** 共有・専用のどちらの Chromium も、ここで起動する。 */
async function launchStealthChromium(proxy: string | undefined, bypass: string | undefined): Promise<Browser> {
  const userAgent = await stealthUserAgent();
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
    // navigator.language(s)・Worker・別オリジンの iframe・Accept-Language（Chrome と同じ位置）まで Chromium 自身が揃える。
    // JS で上書きすると getter が native でなくなり、Worker や iframe には届かない。静的取得の ACCEPT_LANGUAGE と同じ並び。
    '--accept-lang=ja-JP,ja,en-US,en',
    // ヘッドレスは hover / pointer が none になる。デスクトップのマウスに揃える。
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
  ];
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
    if (bypass) args.push(`--proxy-bypass-list=${bypass}`);
  }
  return puppeteer.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args,
    // Puppeteerがデフォルト付与するフラグのうち、一般ユーザー環境に不自然な差分を除去
    // （Patchright方式に倣った近似化）。--enable-automation は navigator.webdriver を
    // true にする一因（実測で確認済み）。--disable-popup-blocking/--disable-default-apps
    // は通常のブラウザでは有効な設定で、無効化されていること自体が検出材料になりうる。
    ignoreDefaultArgs: ['--enable-automation', '--disable-popup-blocking', '--disable-default-apps'],
    // コンテナは UTC のため、ロケールが ja-JP でも時刻が UTC になる。日本の IP と ja-JP に合わせる（Worker にも届く）。
    env: { ...process.env, TZ: STEALTH_TIMEZONE },
  });
}

/** 共有 Chromium を 1 つ起動する。成功したら sharedBrowserInstance に登録し、終わったら起動中の印を外す。 */
function launchSharedBrowser(effectiveProxy: string | undefined, effectiveBypass: string | undefined): Promise<Browser> {
  const launched = launchStealthChromium(effectiveProxy, effectiveBypass)
    .then((browser) => {
      sharedBrowserInstance = browser;
      markSharedBrowserUsed();
      return browser;
    });
  const tracked: Promise<Browser> = launched.finally(() => {
    if (sharedBrowserLaunch === tracked) sharedBrowserLaunch = null;
  });
  return tracked;
}

export function isSharedBrowserConnected(): boolean {
  return sharedBrowserInstance?.connected === true;
}

export async function closeSharedBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  // 起動の最中なら、完了を待ってから閉じる（起動途中のまま放置すると、管理されない Chromium が残る）
  const launching = sharedBrowserLaunch;
  if (launching) {
    try {
      await launching;
    } catch {}
  }
  // 閉じる前に共有インスタンスを外し、閉じかけのブラウザを getBrowser() が渡さないようにする
  const browser = sharedBrowserInstance;
  sharedBrowserInstance = null;
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
}

/**
 * 共有 Chromium の無操作終了。常駐させると約700MB（実測、7プロセス）を占有し続けるため、最後に取得されてから
 * BROWSER_IDLE_TTL_MS（既定 5 分、0 で無効）使われなければ閉じる。次回の getBrowser() で自動再起動する。
 * 開いているコンテキスト/ページ（ブラウザセッション・追跡・SNS 取得）やセマフォ保持中は使用中とみなす。
 */
const DEFAULT_BROWSER_IDLE_TTL_MS = 300_000;
let lastSharedBrowserUse = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function browserIdleTtlMs(): number {
  const raw = process.env.BROWSER_IDLE_TTL_MS;
  const n = raw === undefined || raw === '' ? DEFAULT_BROWSER_IDLE_TTL_MS : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function markSharedBrowserUsed(): void {
  lastSharedBrowserUse = Date.now();
  armIdleTimer(browserIdleTtlMs());
}

function armIdleTimer(delayMs: number): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (delayMs <= 0) return;
  idleTimer = setTimeout(() => void closeIfIdle(), delayMs);
  idleTimer.unref?.();
}

async function closeIfIdle(): Promise<void> {
  idleTimer = undefined;
  const browser = sharedBrowserInstance;
  const ttl = browserIdleTtlMs();
  if (!browser || ttl <= 0) return;
  const remaining = ttl - (Date.now() - lastSharedBrowserUse);
  if (remaining > 0) return armIdleTimer(remaining);
  const checkedUse = lastSharedBrowserUse;
  let busy = browserSemaphore.activeCount > 0 || browserSemaphore.pendingCount > 0;
  if (!busy) {
    try {
      busy = browser.browserContexts().length > 1 || (await browser.pages()).length > 1;
    } catch {
      busy = false; // 接続が壊れている場合は閉じてよい
    }
  }
  // 判定の await 中に getBrowser() で渡されていたら閉じない（その呼び出しがタイマーを張り直している）
  if (lastSharedBrowserUse !== checkedUse) return;
  if (busy) return armIdleTimer(ttl);
  if (browser === sharedBrowserInstance) await closeSharedBrowser();
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

/**
 * ブラウザ同時実行数の既定値。bun 本体 + Chromium の常駐に約700MB、1ページあたり約300MB を見込み、
 * 利用可能メモリから導く（1〜5）。メモリ不明なら従来の 5。MAX_CONCURRENT_BROWSERS 明示時はそちらが優先。
 * ponytail: 1ページ300MBは目安。実測で外れるなら係数を調整する。
 */
export function defaultBrowserConcurrency(memBytes: number | undefined): number {
  if (memBytes === undefined) return 5;
  const MB = 1024 * 1024;
  return Math.max(1, Math.min(5, Math.floor((memBytes / MB - 700) / 300)));
}

/** cgroup (v2/v1) のメモリ上限と搭載メモリの小さい方。取得できなければ undefined。 */
export function detectMemoryLimitBytes(): number | undefined {
  let limit = totalmem() || undefined;
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const n = Number(readFileSync(path, 'utf8').trim());
      if (Number.isFinite(n) && n > 0) limit = limit === undefined ? n : Math.min(limit, n);
    } catch {}
  }
  return limit;
}

/**
 * MAX_CONCURRENT_BROWSERS の解釈。正の整数ならそれ（上限 50）、それ以外（未設定・数値でない・0 以下）はメモリからの既定値。
 * 数値でない値をそのまま使うとセマフォの上限が NaN になり、ブラウザ描画が永久に待つため。
 */
export function resolveBrowserConcurrency(raw: string | undefined, memBytes: number | undefined): number {
  const n = raw && /^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : NaN;
  return n > 0 ? Math.min(n, 50) : defaultBrowserConcurrency(memBytes);
}

export const MAX_CONCURRENT_BROWSERS = resolveBrowserConcurrency(process.env.MAX_CONCURRENT_BROWSERS, detectMemoryLimitBytes());
export const browserSemaphore = new SimpleSemaphore(MAX_CONCURRENT_BROWSERS);

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
    if (Number.isNaN(val) || val < 0) return null;
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

/**
 * IPv6 アドレス文字列を 8 個の 16bit 値へ展開する。`::` の省略、末尾の IPv4 表記（::ffff:1.2.3.4）、
 * ゾーン ID（fe80::1%eth0）に対応。解釈できなければ null。
 */
function parseIpv6(text: string): number[] | null {
  let s = text;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;

  // 末尾が IPv4 表記なら 2 個の 16bit 値に直す
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return null;
    const v4 = parseIpv4ToUint32(tail);
    if (v4 === null) return null;
    s = s.slice(0, lastColon + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }

  let groups: string[];
  const dc = s.indexOf('::');
  if (dc >= 0) {
    if (s.indexOf('::', dc + 1) >= 0) return null; // `::` は 1 回だけ
    const [left, right] = s.split('::');
    const head = left ? left.split(':') : [];
    const rest = right ? right.split(':') : [];
    if (head.length + rest.length > 7) return null;
    groups = [...head, ...new Array<string>(8 - head.length - rest.length).fill('0'), ...rest];
  } else {
    groups = s.split(':');
    if (groups.length !== 8) return null;
  }

  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** IPv6 リテラルが、ループバック・プライベート・リンクローカル・マルチキャスト等の宛先か（埋め込み IPv4 も見る） */
function isPrivateIpv6(text: string): boolean {
  const g = parseIpv6(text);
  // ':' を含むのに IPv6 として読めない文字列は、通すより止める方が安全
  if (!g) return true;
  const [a, b, c, d, e, f, x, y] = g;
  const embeddedV4 = (((x << 16) | y) >>> 0);
  const upperFiveZero = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;

  // ::/96 は、未指定（::）・ループバック（::1）・IPv4 互換の旧形式（::a.b.c.d）で、どれも公開された宛先にならない
  if (upperFiveZero && f === 0) return true;
  if (upperFiveZero && f === 0xffff) return isPrivateIpUint32(embeddedV4); // IPv4-mapped  ::ffff:a.b.c.d
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) return isPrivateIpUint32(embeddedV4); // IPv4-translated
  if (a === 0x64 && b === 0xff9b) {
    if (c === 0 && d === 0 && e === 0 && f === 0) return isPrivateIpUint32(embeddedV4); // NAT64 64:ff9b::/96
    if (c === 1) return true; // 64:ff9b:1::/48 ローカル用 NAT64
  }
  if (a === 0x2002) return isPrivateIpUint32((((b << 16) | c) >>> 0)); // 6to4 2002::/16（IPv4 は 16〜47bit）
  if (a === 0x2001 && b === 0) return true; // Teredo 2001::/32
  if (a === 0x2001 && b === 0x0db8) return true; // ドキュメント用 2001:db8::/32
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // 100::/64 破棄用
  if ((a & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // リンクローカル fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true; // サイトローカル fec0::/10（非推奨）
  if ((a & 0xff00) === 0xff00) return true; // マルチキャスト ff00::/8
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');

  // 1. IPv6 リテラルは必ず ':' を含み、ホスト名には現れない。':' の有無で IPv6 判定に入るかを決める。
  //    （以前は先頭が 'fc'/'fd'/'ff' の文字列を無条件に IPv6 扱いにして、fda.gov や ffmpeg.org まで遮断していた）
  if (trimmed.includes(':')) return isPrivateIpv6(trimmed);

  // 2. 任意の進数・短縮表記を含む IPv4 の 32bit 整数への正規化
  const num = parseIpv4ToUint32(trimmed);
  if (num !== null) {
    return isPrivateIpUint32(num);
  }

  // 3. 先頭が IPv4 の名前（127.0.0.1.nip.io のようなワイルドカード DNS）は、解決を待たずに止める。
  //    先頭の 4 ラベルが IPv4 として読める場合だけ見る（10.example.com のような通常の名前は対象外）。
  const lead = trimmed.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\./);
  if (lead) {
    const leadNum = parseIpv4ToUint32(lead[1]);
    if (leadNum !== null) return isPrivateIpUint32(leadNum);
  }

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
  } catch (err) {
    const message = errorMessage(err);
    if (message && (message.includes('DNS Rebinding') || message.includes('プライベートネットワーク'))) {
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
export async function pruneInvisibleElements(page: Page, cloneOnly = false): Promise<string | undefined> {
  try {
    if (page.isClosed()) return;
    return await page
      .evaluate((cloneOnly: boolean) => {
        try {
          const root = cloneOnly ? document.documentElement.cloneNode(true) as HTMLElement : document.documentElement;
          const allElements = Array.from(document.body?.querySelectorAll('*') ?? []);
          const outputElements = cloneOnly ? Array.from(root.querySelector('body')?.querySelectorAll('*') ?? []) : allElements;
          // 1. 標準的な不可視・テンプレート要素の先行除去
          const staticTags = root.querySelectorAll('noscript, template, [hidden]');
          staticTags.forEach((el) => {
            try {
              el.remove();
            } catch {}
          });

          // 2. DOMツリーの走査とComputed Styleによる不可視要素の剪定
          if (!document.body) return;
          for (const [index, el] of allElements.entries()) {
            const output = outputElements[index];
            if (!output || !root.contains(output)) continue;

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
                output.remove();
                continue;
              }

              if (el.getAttribute('aria-hidden') === 'true' && el.classList.contains('visually-hidden')) {
                output.remove();
              }
            } catch {}
          }
          if (cloneOnly) return `<!DOCTYPE html>${root.outerHTML}`;
        } catch {}
      }, cloneOnly)
      .catch(() => undefined);
  } catch {}
}
