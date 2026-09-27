import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual, createHash } from 'crypto';
import { dbIncrementApiUsage } from './db.js';
import { resolveTenantContext, type TenantContext } from './security/tenant_context.js';

/** タイミング攻撃（Timing Attack）を防ぐ定数時間文字列比較 */
export function isSecureEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/** リクエストから Bearer Token または X-API-Key を抽出 */
export function extractAuthToken(c: any): string | undefined {
  const authHeader = c.req.header('authorization');
  const xApiKey = c.req.header('x-api-key');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (xApiKey) {
    return xApiKey.trim();
  }
  return undefined;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Socket peer address injected by the server wrapper (never client-controlled). */
export function getPeerAddress(c: any): string | undefined {
  const env = (c as any)?.env;
  const raw = env?.remoteAddr ?? env?.remoteAddress;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return undefined;
}

/** Loopback check for peer IPs (RFC P1-SEC-04). Zone IDs and brackets stripped. */
export function isLoopbackAddress(ip: string): boolean {
  const v = ip.trim().replace(/^\[/, '').split('%')[0].split(']')[0].toLowerCase();
  if (v === 'localhost' || v === '::1' || v === '0:0:0:0:0:0:0:1') return true;
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const octets = m.slice(1, 5).map((x) => parseInt(x, 10));
    if (octets.every((x) => x >= 0 && x <= 255) && octets[0] === 127) return true;
  }
  return false;
}

export function resolvePeerLocal(c: any): boolean {
  const forwardedFor = c.req.header('x-forwarded-for');
  const realIp = c.req.header('x-real-ip');
  const directConnection = !forwardedFor && !realIp;
  const peer = getPeerAddress(c);
  if (process.env.TRUST_PROXY === 'true') {
    const clientIp = (forwardedFor || '').split(',')[0].trim() || peer;
    if (!clientIp) return false;
    return isLoopbackAddress(clientIp);
  }
  if (!directConnection) return false;
  // Peer unknown (unit tests, non-Bun runtimes): legacy header heuristic.
  if (peer === undefined) return true;
  return isLoopbackAddress(peer);
}

let warnedNoKeyMode = false;
/** One-time dev-mode notice: anonymous access without a configured key. */
export function warnOnceNoKey(): void {
  if (warnedNoKeyMode) return;
  warnedNoKeyMode = true;
  try {
    console.warn('[Sora] No API key configured: anonymous access is open (set WEB_FETCHER_API_KEY, or SORA_ALLOW_ANONYMOUS=true to silence).');
  } catch {}
}

export function createAuthMiddleware(expectedApiKey?: string): MiddlewareHandler {
  return async (c, next) => {
    // 1. 公開エンドポイント（ヘルスチェック、ルート、メトリクス、ドキュメント）は認証不要
    const path = c.req.path;
    if (
      path === '/health' ||
      path === '/' ||
      path === '/metrics' ||
      path === '/openapi.json' ||
      path === '/docs' ||
      path === '/swagger'
    ) {
      return next();
    }

    let tokenHash = 'anonymous';

    // 2. API キーが環境変数等で設定されていない場合の挙動（Fail-Open）
    // 注意: bun build は process.env.NODE_ENV をビルド時にインライン化し、
    // 到達不能分岐を削除するため、認証判断に NODE_ENV を使わないこと。
    // 2026-09-26 に本番バンドルから Fail-Closed 分岐が消滅し、
    // 意図せず常時開放になっていた実績がある。
    // 本サーバーはキー未設定でも利用可能とする方針のため、
    // キー未設定時は警告ログのみで全リクエストを許可する。
    const apiKey = expectedApiKey ?? process.env.WEB_FETCHER_API_KEY ?? process.env.API_KEY;
    if (!apiKey) {
      // Fail-open without a configured key (v2.30.2): do not gate on
      // NODE_ENV here — bun build inlines it and the branch vanishes
      // from the production bundle. Warn once; silence the notice with
      // SORA_ALLOW_ANONYMOUS=true.
      if (process.env.SORA_ALLOW_ANONYMOUS !== 'true') warnOnceNoKey();
    } else {
      // 3. API キーの照合 (定数時間比較)
      const providedToken = extractAuthToken(c);
      const isDirectLocal = resolvePeerLocal(c) && process.env.ALLOW_LOCAL_NO_AUTH === 'true';
      const allowAnonymous = process.env.SORA_ALLOW_ANONYMOUS === 'true';

      if (providedToken && isSecureEqual(providedToken, apiKey)) {
        tokenHash = hashApiKey(providedToken);
        try {
          (c as any).set('tenant', resolveTenantContext({ apiKey: providedToken }));
        } catch {}
      } else if (isDirectLocal) {
        tokenHash = 'local_direct';
        try {
          (c as any).set('tenant', resolveTenantContext({ internal: true }));
        } catch {}
      } else if (allowAnonymous) {
        try {
          (c as any).set('tenant', resolveTenantContext({}));
        } catch {}
      } else {
        return c.json(
          {
            error: 'Unauthorized: Invalid or missing API key',
            message: 'Please provide a valid API key via Authorization: Bearer <API_KEY> or X-API-Key header.',
          },
          401,
        );
      }
    }

    try {
      const existing = (c as any).get?.('tenant') as TenantContext | undefined;
      if (!existing) (c as any).set('tenant', resolveTenantContext({}));
    } catch {}

    // 4. API キーごとの日次レート制限 & クォータ制御 (SQLite 永続化)
    const todayStr = new Date().toISOString().slice(0, 10);
    const usageCount = dbIncrementApiUsage(tokenHash, todayStr);

    const dailyLimit = process.env.DAILY_REQUEST_LIMIT ? parseInt(process.env.DAILY_REQUEST_LIMIT, 10) : undefined;
    if (dailyLimit && dailyLimit > 0) {
      c.header('X-RateLimit-Limit', String(dailyLimit));
      c.header('X-RateLimit-Remaining', String(Math.max(0, dailyLimit - usageCount)));

      if (usageCount > dailyLimit) {
        return c.json(
          {
            error: 'Too Many Requests: Daily quota limit exceeded',
            code: 'RATE_LIMIT_EXCEEDED',
            status: 429,
            retryable: false,
            limit: dailyLimit,
            current: usageCount,
            message: `You have reached the daily quota of ${dailyLimit} requests. Resets at next UTC day.`,
          },
          429,
        );
      }
    }

    return next();
  };
}
