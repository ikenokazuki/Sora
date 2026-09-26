import { URL } from 'url';
import type { CookieParam } from 'puppeteer-core';
import type { PersistedCookie } from './db.js';
import { dbSaveTenantCookies, dbGetTenantCookies } from './db.js';
import { getChromiumMajorVersion, getProxyConfig, validateHostIpDns } from './browser_engine.js';
import { getFallbackUserAgent } from './browser_stealth.js';
import { incrementSecurityCounter } from './security/metrics.js';

// ==========================================
// 0. wreq-js の動的遅延読み込み & ネイティブ fetch フォールバック
// ==========================================
type WreqModule = typeof import('wreq-js');
export type BrowserProfile = import('wreq-js').BrowserProfile;

let wreqModule: WreqModule | null = null;
let wreqLoadAttempted = false;

async function getWreqModule(): Promise<WreqModule | null> {
  if (wreqLoadAttempted) return wreqModule;
  wreqLoadAttempted = true;
  try {
    wreqModule = await import('wreq-js');
  } catch (err: any) {
    console.warn(`[http_fetcher] wreq-js native module unavailable (${err?.message || err}). Gracefully falling back to native fetch.`);
    wreqModule = null;
  }
  return wreqModule;
}

export interface UniversalHttpSession {
  fetch(url: string, init?: any): Promise<any>;
  setCookie(name: string, value: string, urlOrDomain?: string | URL): void;
  getAllCookies(): Array<{ name: string; value: string; domain?: string }>;
  close(): Promise<void>;
}

// ==========================================
// 1. ドメイン単位の適応型レート制限 & Jitter
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
// 2. 安全な HTTP フェッチ (TLS プロファイル & プロキシ解決)
// ==========================================
export const MAX_RESPONSE_BODY_BYTES = 30 * 1024 * 1024; // 最大 30MB

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
// 3. 静的fetch用 wreq-js セッションプール
// ==========================================
const HTTP_SESSION_TTL_MS = 5 * 60 * 1000; // 非アクティブ5分でクローズ
const MAX_HTTP_SESSIONS = 50; // 同時保持上限

interface PooledHttpSession {
  session: UniversalHttpSession;
  domain: string;
  tenantId: string;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Tenant-scoped session key (RFC P1-SEC-02). Default tenant preserves single-user behavior. */
export function sessionKey(tenantId: string, hostname: string): string {
  return `${tenantId || 'legacy'}:${hostname.toLowerCase()}`;
}

class NativeFetchSession implements UniversalHttpSession {
  private cookies = new Map<string, string>();

  setCookie(name: string, value: string, _urlOrDomain?: string | URL) {
    this.cookies.set(name, value);
  }

  getAllCookies() {
    return Array.from(this.cookies.entries()).map(([name, value]) => ({ name, value }));
  }

  async close() {
    this.cookies.clear();
  }

  async fetch(url: string, init: any = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has('User-Agent') && !headers.has('user-agent')) {
      headers.set('User-Agent', getFallbackUserAgent());
    }
    if (this.cookies.size > 0 && !headers.has('Cookie')) {
      const cookieStr = Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
      headers.set('Cookie', cookieStr);
    }
    const res = await fetch(url, {
      ...init,
      headers,
    });

    // Set-Cookie ヘッダーの収集
    const setCookieHeaders = (res.headers as any).getSetCookie?.() || [];
    for (const sc of setCookieHeaders) {
      const parts = sc.split(';')[0].split('=');
      if (parts.length >= 2) {
        this.cookies.set(parts[0].trim(), parts.slice(1).join('=').trim());
      }
    }

    return res;
  }
}

const httpSessionPool = new Map<string, PooledHttpSession>();

function refreshHttpSessionTimer(pooled: PooledHttpSession): void {
  clearTimeout(pooled.timer);
  pooled.lastUsed = Date.now();
  pooled.timer = setTimeout(() => {
    void closeHttpSession(pooled.domain, pooled.tenantId);
  }, HTTP_SESSION_TTL_MS);
  if (pooled.timer.unref) pooled.timer.unref();
}

async function evictOldestHttpSessionIfNeeded(): Promise<void> {
  if (httpSessionPool.size < MAX_HTTP_SESSIONS) return;
  let oldest: PooledHttpSession | null = null;
  for (const p of httpSessionPool.values()) {
    if (!oldest || p.lastUsed < oldest.lastUsed) oldest = p;
  }
  if (oldest) await closeHttpSession(oldest.domain, oldest.tenantId);
}

/** セッションをクローズし、Cookieを永続化してからプールから除去する */
export async function closeHttpSession(domain: string, tenantId = 'legacy'): Promise<void> {
  const pooled = httpSessionPool.get(sessionKey(tenantId, domain));
  if (!pooled) return;
  clearTimeout(pooled.timer);
  httpSessionPool.delete(sessionKey(tenantId, domain));
  try {
    const allCookies = pooled.session.getAllCookies();
    if (allCookies.length > 0) {
      dbSaveTenantCookies(pooled.tenantId, domain, allCookies as PersistedCookie[]);
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
  tenantId = 'legacy',
): Promise<UniversalHttpSession> {
  const key = sessionKey(tenantId, domain);
  const existing = httpSessionPool.get(key);
  if (existing) {
    refreshHttpSessionTimer(existing);
    return existing.session;
  }

  await evictOldestHttpSessionIfNeeded();

  const mod = await getWreqModule();
  let session: UniversalHttpSession;

  if (mod) {
    session = await mod.createSession({
      browser,
      os: EMULATION_OS,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
  } else {
    session = new NativeFetchSession();
  }

  const savedCookies = dbGetTenantCookies(tenantId, domain);
  if (savedCookies && savedCookies.length > 0) {
    for (const c of savedCookies) {
      try {
        session.setCookie(c.name, c.value, `https://${c.domain || domain}`);
      } catch {}
    }
  }

  const pooled: PooledHttpSession = { session, domain, tenantId, lastUsed: Date.now(), timer: setTimeout(() => {}, 0) };
  clearTimeout(pooled.timer);
  httpSessionPool.set(key, pooled);
  refreshHttpSessionTimer(pooled);
  return session;
}

/**
 * リクエスト後に取得したCookie一覧をドメインごとにグルーピングする。
 */
export function groupCookiesByDomain(
  cookies: Array<{ name: string; value: string; domain?: string }>,
  fallbackDomain: string,
): Map<string, PersistedCookie[]> {
  const map = new Map<string, PersistedCookie[]>();
  for (const c of cookies) {
    const rawDomain = (c.domain || fallbackDomain).trim().toLowerCase();
    const normalizedDomain = rawDomain.replace(/^\.+/, '');
    if (!normalizedDomain) continue;

    let list = map.get(normalizedDomain);
    if (!list) {
      list = [];
      map.set(normalizedDomain, list);
    }
    list.push({
      name: c.name,
      value: c.value,
      domain: normalizedDomain,
    });
  }
  return map;
}

/**
 * 安全な HTTP リダイレクト追跡フェッチ
 */
export async function fetchWithSafeRedirects(
  initialUrl: string,
  timeoutMs = 15000,
  maxRedirects = 5,
  customHeaders?: Record<string, string>,
  customCookies?: CookieParam[],
  proxyUrl?: string,
): Promise<{ finalUrl: string; response: Response }> {
  let currentUrl = initialUrl;
  let redirects = 0;

  const cookieHeader = customCookies && customCookies.length > 0
    ? customCookies.map((c) => `${c.name}=${c.value}`).join('; ')
    : undefined;

  const initialDomain = new URL(initialUrl).hostname;
  const effectiveProxyUrl = proxyUrl ?? pickProxyUrl();
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

    // Security: redirect時の認証漏洩防止
    // - Authorization/Proxy-Authorization: origin変化(scheme/host/port)で除去
    // - Cookie: ホスト変化で除去 (同一ホストのhttp->https等は維持)
    let originChanged = false;
    let hostChanged = false;
    try {
      const cur = new URL(currentUrl);
      const init = new URL(initialUrl);
      originChanged = cur.origin !== init.origin;
      hostChanged = cur.hostname !== init.hostname;
    } catch { originChanged = false; hostChanged = false; }
    let strippedAuth = false;
    const sanitizedCustomHeaders: Record<string, string> = {};
    if (customHeaders) {
      for (const [k, v] of Object.entries(customHeaders)) {
        const lk = k.toLowerCase();
        if (originChanged && (lk === 'authorization' || lk === 'proxy-authorization' || lk === 'x-api-key' || lk === 'x-auth-token' || lk === 'x-access-token')) { strippedAuth = true; continue; }
        if (hostChanged && lk === 'cookie') { strippedAuth = true; continue; }
        sanitizedCustomHeaders[k] = v;
      }
    }
    const keepCookie = !hostChanged && cookieHeader;
    if (strippedAuth || (hostChanged && cookieHeader)) incrementSecurityCounter('sora_credential_strip_total');
    const headers: Record<string, string> = {
      'Accept-Language': ACCEPT_LANGUAGE,
      ...(keepCookie ? { Cookie: cookieHeader } : {}),
      ...sanitizedCustomHeaders,
    };

    const res = await session.fetch(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

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

/** HTML/テキストのバッファから文字コードを自動判定してデコード */
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
