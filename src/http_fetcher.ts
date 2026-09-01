import { URL } from 'url';
import { createSession, type Session, type BrowserProfile, type Response } from 'wreq-js';
import type { CookieParam } from 'puppeteer-core';
import type { PersistedCookie } from './db.js';
import { dbGetDomainCookies, dbSaveDomainCookies } from './db.js';
import { getChromiumMajorVersion, getProxyConfig, validateHostIpDns } from './browser_engine.js';

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
