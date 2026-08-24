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

export const CHROME_EXECUTABLE_PATH = resolveChromiumPath();

let sharedBrowserInstance: Browser | null = null;

/** 共有または専用 Chromium ブラウザインスタンスの取得 */
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

/** ブロック対象ホスト名判定ヘルパー */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
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
  if (isPrivateIp(h)) {
    return true;
  }
  return false;
}

/** DNS 解決後の実 IP アドレスを検証（DNS Rebinding 攻撃対策） */
export async function validateHostIpDns(hostname: string): Promise<string[]> {
  if (process.env.ALLOW_LOCAL_FETCH === 'true') return [];

  const cleanHost = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (isBlockedHostname(cleanHost) || isPrivateIp(cleanHost)) {
    throw new Error(`プライベートネットワークまたは安全でないホストへのアクセスは遮断されています: ${hostname}`);
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
    return addresses.map((a) => a.address);
  } catch (err: any) {
    if (err.message && (err.message.includes('DNS Rebinding') || err.message.includes('プライベートネットワーク'))) {
      throw err;
    }
    return [];
  }
}

/** Headless Chromium のページ内サブリクエスト（iframe, XHR, fetch, img 等）に対する SSRF 防御 */
export async function setupPageSecurity(page: Page): Promise<void> {
  if (process.env.ALLOW_LOCAL_FETCH === 'true') {
    return;
  }
  try {
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      try {
        const reqUrlStr = req.url();
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
        try {
          const addresses = await dnsPromises.lookup(host, { all: true });
          for (const addr of addresses) {
            if (isBlockedHostname(addr.address) || isPrivateIp(addr.address)) {
              return req.abort('accessdenied');
            }
          }
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
