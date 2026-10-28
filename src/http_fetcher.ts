import { URL } from 'url';
import { createHash } from 'crypto';
import type { CookieParam } from 'puppeteer-core';
import type { PersistedCookie } from './db.js';
import { dbSaveTenantCookies, dbGetTenantCookies } from './db.js';
import { getChromiumMajorVersion, getProxyConfig, validateHostIpDns } from './browser_engine.js';
import { getFallbackUserAgent } from './browser_stealth.js';
import { incrementSecurityCounter } from './security/metrics.js';
import { hasSensitiveRequestCredentials, isSensitiveHeaderName } from './security/credential_scope.js';
import { isProxyBypassed } from './net/no_proxy.js';
import { errorMessage } from './errors.js';

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
  } catch (err) {
    console.warn(`[http_fetcher] wreq-js native module unavailable (${errorMessage(err) || err}). Gracefully falling back to native fetch.`);
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

/** wreq-js が持つ最新の Chrome プロファイル。実ブラウザがこれより新しい場合の上限。 */
export const MAX_SUPPORTED_CHROME_PROFILE_VERSION =
  SUPPORTED_CHROME_PROFILE_VERSIONS[SUPPORTED_CHROME_PROFILE_VERSIONS.length - 1];

/** wreq-js の os オプションは既定が 'macos'。ブラウザ経路(Windows)と揃えるため明示指定する。 */
export const EMULATION_OS = 'windows';

/** 両経路で共有する Accept-Language。片方だけ違うと同一Cookieで別設定を名乗ることになる。 */
export const ACCEPT_LANGUAGE = 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7';

/**
 * Chrome がヘッダを送る順序と、HTTP/1.1 での表記（HTTP/2 では wreq-js が小文字にする）。Host は先頭。
 * wreq-js は要求ごとに渡したヘッダを先頭へ移すので、Accept-Language や Referer を要求ごとに渡すと Chrome の順序が崩れる。
 * セッションにこの順序を持たせれば、日本語の Accept-Language も、Referer も、本物の位置に入る（tls.peet.ws で確認）。
 */
const CHROME_HEADER_ORDER = [
  'Host', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'Upgrade-Insecure-Requests', 'User-Agent', 'Accept',
  'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-User', 'Sec-Fetch-Dest', 'Referer', 'Accept-Encoding', 'Accept-Language', 'priority',
];

/** 検索結果から来たように見せる Referer。 */
const GOOGLE_REFERER = 'https://www.google.com/';

/**
 * ページ取得の 1 回目に付ける、検索経由の閲覧のヘッダ（Referer と、それに合う Sec-Fetch-Site: cross-site）。
 * 付けないのは、SORA_DEFAULT_REFERER=off のとき、呼び出し側が Referer を指定したとき、資格情報を運ぶとき。
 * 有料記事の「Google 経由は無料」を装う形にもなり、アクセス解析には検索流入として数えられるので、切れる口を残す。
 * 汎用の fetchWithSafeRedirects は robots.txt・sitemap・画像・JSON API にも使われる（他サイトの Referer を弾くサイトがある）ので、
 * ここでは付けず、呼び出し側（scrapeUrl のページ取得）が使う。
 */
export function defaultReferrerHeaders(headers?: Record<string, string>, cookies?: Array<unknown>): Record<string, string> {
  if (process.env.SORA_DEFAULT_REFERER?.trim().toLowerCase() === 'off') return {};
  if (hasSensitiveRequestCredentials({ headers, cookies })) return {};
  if (Object.keys(headers ?? {}).some((k) => k.toLowerCase() === 'referer')) return {};
  return { Referer: GOOGLE_REFERER, 'Sec-Fetch-Site': 'cross-site' };
}

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
  /** プール内のキー。タイマーや退避から自分自身を特定するために持つ */
  key: string;
  /**
   * 資格情報付きリクエスト専用セッションの分離キー。通常（資格情報なし）のセッションは undefined。
   * 資格情報で得た Set-Cookie が、資格情報なしのリクエストへ流れないようにジャーを分ける。
   */
  scope?: string;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tenant-scoped session key (RFC P1-SEC-02). Default tenant preserves single-user behavior.
 * scope は資格情報付きリクエスト用の分離キー。指定時は通常セッションと別のキーになる。
 */
export function sessionKey(tenantId: string, hostname: string, scope?: string): string {
  const base = `${tenantId || 'legacy'}:${hostname.toLowerCase()}`;
  return scope ? `${base}#${scope}` : base;
}

/**
 * 資格情報（Cookie・認証系ヘッダー）の組から、セッション分離キーを作る。
 * 資格情報そのものはキーに残さずハッシュにする。資格情報が無ければ undefined（通常セッションを使う）。
 */
export function credentialScopeFor(
  headers?: Record<string, string>,
  cookies?: Array<{ name: string; value: string }>,
): string | undefined {
  if (!hasSensitiveRequestCredentials({ headers, cookies })) return undefined;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (isSensitiveHeaderName(k)) parts.push(`h:${k.toLowerCase()}=${v}`);
  }
  for (const c of cookies ?? []) parts.push(`c:${c.name}=${c.value}`);
  parts.sort();
  return 'cred-' + createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

export class NativeFetchSession implements UniversalHttpSession {
  // Domain-scoped jar: cookies must never cross origins on redirect.
  private cookies = new Map<string, Map<string, string>>();

  private static domainOf(urlOrDomain?: string | URL): string {
    try {
      if (!urlOrDomain) return '';
      const s = String(urlOrDomain);
      const host = s.includes('://') ? new URL(s).hostname : s.split('/')[0].split(':')[0];
      return host.toLowerCase();
    } catch {
      return '';
    }
  }

  setCookie(name: string, value: string, urlOrDomain?: string | URL) {
    const domain = NativeFetchSession.domainOf(urlOrDomain);
    if (!domain) return;
    let jar = this.cookies.get(domain);
    if (!jar) {
      jar = new Map<string, string>();
      this.cookies.set(domain, jar);
    }
    jar.set(name, value);
  }

  getAllCookies() {
    const out: Array<{ name: string; value: string; domain?: string }> = [];
    for (const [domain, jar] of this.cookies.entries()) {
      for (const [name, value] of jar.entries()) out.push({ name, value, domain });
    }
    return out;
  }

  async close() {
    this.cookies.clear();
  }

  async fetch(url: string, init: any = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has('User-Agent') && !headers.has('user-agent')) {
      headers.set('User-Agent', getFallbackUserAgent());
    }
    // wreq-js のセッションは emulation に持つ。要求ごとに渡すと Chrome の順序が崩れるので、こちらだけが既定を足す
    if (!headers.has('Accept-Language')) headers.set('Accept-Language', ACCEPT_LANGUAGE);
    const host = NativeFetchSession.domainOf(url);
    const jar = this.cookies.get(host);
    if (jar && jar.size > 0 && !headers.has('Cookie')) {
      const cookieStr = Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
      headers.set('Cookie', cookieStr);
    }
    const res = await fetch(url, {
      ...init,
      headers,
    });

    // Set-Cookie ヘッダーの収集 (response origin scope only)
    const setCookieHeaders = (res.headers as any).getSetCookie?.() || [];
    for (const sc of setCookieHeaders) {
      const parts = sc.split(';')[0].split('=');
      if (parts.length >= 2) {
        this.setCookie(parts[0].trim(), parts.slice(1).join('=').trim(), url);
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
    void closePooledHttpSession(pooled);
  }, HTTP_SESSION_TTL_MS);
  if (pooled.timer.unref) pooled.timer.unref();
}

async function evictOldestHttpSessionIfNeeded(): Promise<void> {
  if (httpSessionPool.size < MAX_HTTP_SESSIONS) return;
  let oldest: PooledHttpSession | null = null;
  for (const p of httpSessionPool.values()) {
    if (!oldest || p.lastUsed < oldest.lastUsed) oldest = p;
  }
  if (oldest) await closePooledHttpSession(oldest);
}

/**
 * プール内のセッションを閉じて除去する。通常セッションは Cookie を永続化する（bot 対策の通過状態の再利用）。
 * 資格情報付きリクエスト専用セッション（scope あり）は、ログイン状態を含み得るので永続化しない。
 */
async function closePooledHttpSession(pooled: PooledHttpSession): Promise<void> {
  clearTimeout(pooled.timer);
  // 同じキーに別のセッションが入り直していたら、そちらは触らない
  if (httpSessionPool.get(pooled.key) === pooled) httpSessionPool.delete(pooled.key);
  if (!pooled.scope) {
    try {
      const allCookies = pooled.session.getAllCookies();
      const byDomain = new Map<string, PersistedCookie[]>();
      for (const c of allCookies) {
        const d = (c.domain || pooled.domain).toLowerCase();
        if (!byDomain.has(d)) byDomain.set(d, []);
        byDomain.get(d)!.push(c as PersistedCookie);
      }
      for (const [d, list] of byDomain) {
        if (list.length > 0) dbSaveTenantCookies(pooled.tenantId, d, list);
      }
    } catch {}
  }
  try {
    await pooled.session.close();
  } catch {}
}

/** セッションをクローズし、Cookieを永続化してからプールから除去する（scope は資格情報付き専用セッション用） */
export async function closeHttpSession(domain: string, tenantId = 'legacy', scope?: string): Promise<void> {
  const pooled = httpSessionPool.get(sessionKey(tenantId, domain, scope));
  if (!pooled) return;
  await closePooledHttpSession(pooled);
}

/**
 * ドメインに対応するセッションをプールから取得、無ければ作成（保存済みCookieを復元）。
 * scope を渡すと資格情報付きリクエスト専用の分離セッションになり、保存済み Cookie は復元せず、終了時も永続化しない。
 */
export async function getOrCreateHttpSession(
  domain: string,
  browser: BrowserProfile,
  proxyUrl?: string,
  tenantId = 'legacy',
  scope?: string,
): Promise<UniversalHttpSession> {
  const key = sessionKey(tenantId, domain, scope);
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
      emulation: { headers: { 'accept-language': ACCEPT_LANGUAGE }, origHeaders: CHROME_HEADER_ORDER },
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
  } else {
    session = new NativeFetchSession();
  }

  // 資格情報付きの分離セッションは、保存済み Cookie を引き継がず空のジャーで始める
  const savedCookies = scope ? undefined : dbGetTenantCookies(tenantId, domain);
  if (savedCookies && savedCookies.length > 0) {
    for (const c of savedCookies) {
      try {
        session.setCookie(c.name, c.value, `https://${c.domain || domain}`);
      } catch {}
    }
  }

  const pooled: PooledHttpSession = { session, domain, tenantId, key, scope, lastUsed: Date.now(), timer: setTimeout(() => {}, 0) };
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
  tenantId = 'legacy',
  parentSignal?: AbortSignal,
): Promise<{ finalUrl: string; response: Response }> {
  let currentUrl = initialUrl;
  let redirects = 0;

  const cookieHeader = customCookies && customCookies.length > 0
    ? customCookies.map((c) => `${c.name}=${c.value}`).join('; ')
    : undefined;

  const initialDomain = new URL(initialUrl).hostname;
  // 環境変数由来のプロキシは NO_PROXY の除外先には使わない（ブラウザ側と同じ扱い）。明示指定の proxyUrl はそのまま使う
  const effectiveProxyUrl = proxyUrl
    ?? (isProxyBypassed(initialDomain, getProxyConfig().proxyBypassList) ? undefined : pickProxyUrl());
  const browser = pickBrowserProfile();
  // 資格情報付きリクエストは専用のジャーで動かす。通常セッションと共有すると、認証で得た Set-Cookie が
  // 後続の「資格情報なし」リクエストに流れ、ログイン済みの内容が共有キャッシュに入ってしまう。
  const credentialScope = credentialScopeFor(customHeaders, customCookies);
  const session = await getOrCreateHttpSession(initialDomain, browser, effectiveProxyUrl, tenantId, credentialScope);

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

    try {
      await validateHostIpDns(parsed.hostname);
    } catch (e) {
      incrementSecurityCounter('sora_redirect_block_total');
      throw e;
    }
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
      ...(keepCookie ? { Cookie: cookieHeader } : {}),
      ...sanitizedCustomHeaders,
    };

    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
    const res = await session.fetch(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: combined,
    });

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BODY_BYTES) {
      // 読まない本体は捨てる（受け取り続けない）。大きな動画・音声のファイルを呼び出し側が見分けられるよう、種類も渡す
      await res.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`レスポンスサイズが上限 (${MAX_RESPONSE_BODY_BYTES / (1024 * 1024)}MB) を超過しています: ${contentLength} bytes`), {
        code: 'RESPONSE_TOO_LARGE', finalUrl: currentUrl, contentType: res.headers.get('content-type') ?? '', contentLength,
      });
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

  const headerMatch = contentTypeHeader.match(/charset=([a-zA-Z0-9_-]+)/i);
  let charset = headerMatch ? headerMatch[1].toLowerCase().trim() : '';

  if (!charset) {
    const headChunk = new (TextDecoder as any)('latin1').decode(uint8.slice(0, 2048));
    const metaCharsetMatch = headChunk.match(/<meta[^>]+charset=["']?\s*([a-zA-Z0-9_-]+)/i);
    if (metaCharsetMatch) {
      charset = metaCharsetMatch[1].toLowerCase().trim();
    } else {
      const metaHttpEquivMatch = headChunk.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["'][^"']*charset=([a-zA-Z0-9_-]+)/i);
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
