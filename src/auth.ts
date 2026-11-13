import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual, createHash } from 'crypto';
import { envBool, envInt, envStr } from './config.js';
import { dbIncrementApiUsage } from './db.js';
import { ipLiteralVersion } from './net/ip_policy.js';
import { isPublicPath } from './security/public_paths.js';
import { resolveTenantContext, type TenantContext } from './security/tenant_context.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** 認証ミドルウェアが要求ごとに設定するテナント */
    tenant: TenantContext;
  }
}

/** タイミング攻撃（Timing Attack）を防ぐ定数時間文字列比較 */
export function isSecureEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * リクエストから Bearer Token または X-API-Key を抽出する。Authorization の scheme は大文字小文字を区別しない（RFC 7235 §2.1）。
 * 認証も MCP も、鍵はここだけで読む（読み方が食い違うと、認証が通った利用者が別の tenant になれた）。
 */
export function extractAuthToken(c: any): string | undefined {
  const bearer = /^Bearer[ \t]+(.*)$/i.exec(c.req.header('authorization') ?? '');
  if (bearer) return bearer[1].trim();
  const xApiKey = c.req.header('x-api-key');
  return xApiKey ? xApiKey.trim() : undefined;
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

/**
 * X-Forwarded-For の値から、信頼するプロキシの段数 hops だけ右へ数えた位置の接続元を返す。
 * hops=1 は、いちばん右（Sora の手前のプロキシが見た相手）。左の値は、利用者が書けるので使わない。
 * 段数に足りないとき（プロキシを通っていない）と、IP アドレスでないときは undefined（信じない）。
 */
export function forwardedClientAddress(header: string, hops: number): string | undefined {
  const chain = header.split(',');
  if (chain.length < hops) return undefined;
  const address = chain[chain.length - hops].trim();
  return ipLiteralVersion(address) !== 0 ? address : undefined;
}

export function resolvePeerLocal(c: any): boolean {
  const forwardedFor = c.req.header('x-forwarded-for');
  const realIp = c.req.header('x-real-ip');
  const directConnection = !forwardedFor && !realIp;
  const peer = getPeerAddress(c);
  if (envBool('SORA_AUTH_TRUST_PROXY')) {
    // X-Forwarded-For があれば、信頼するプロキシの段数から数えた値だけで決める（足りなければ信じない）。無ければ、ソケットの相手
    const clientIp = forwardedFor ? forwardedClientAddress(forwardedFor, envInt('SORA_AUTH_PROXY_HOPS')) : peer;
    return clientIp !== undefined && isLoopbackAddress(clientIp);
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
    console.warn('[Sora] No API key configured: anonymous access is open (set SORA_API_KEY, or SORA_ALLOW_ANONYMOUS=true to silence).');
  } catch {}
}

export function createAuthMiddleware(expectedApiKey?: string): MiddlewareHandler {
  return async (c, next) => {
    // 1. 公開エンドポイント（ヘルスチェック、ルート、メトリクス、ドキュメント）は認証不要
    if (isPublicPath(c.req.path)) {
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
    const apiKey = expectedApiKey ?? envStr('SORA_API_KEY');
    if (!apiKey) {
      // Fail-open without a configured key (v2.30.2): do not gate on
      // NODE_ENV here — bun build inlines it and the branch vanishes
      // from the production bundle. Warn once; silence the notice with
      // SORA_ALLOW_ANONYMOUS=true.
      if (!envBool('SORA_ALLOW_ANONYMOUS')) warnOnceNoKey();
    } else {
      // 3. API キーの照合 (定数時間比較)
      const providedToken = extractAuthToken(c);
      const isDirectLocal = resolvePeerLocal(c) && envBool('SORA_AUTH_LOOPBACK_NO_KEY');
      const allowAnonymous = envBool('SORA_ALLOW_ANONYMOUS');

      if (providedToken && isSecureEqual(providedToken, apiKey)) {
        tokenHash = hashApiKey(providedToken);
        try {
          c.set('tenant', resolveTenantContext({ apiKey: providedToken }));
        } catch {}
      } else if (isDirectLocal) {
        tokenHash = 'local_direct';
        try {
          c.set('tenant', resolveTenantContext({ internal: true }));
        } catch {}
      } else if (allowAnonymous) {
        try {
          c.set('tenant', resolveTenantContext({}));
        } catch {}
      } else {
        return c.json(
          {
            error: 'Unauthorized: Invalid or missing API key',
            code: 'UNAUTHORIZED',
            status: 401,
            retryable: false,
            message: 'Please provide a valid API key via Authorization: Bearer <key> or X-API-Key header.',
          },
          401,
        );
      }
    }

    try {
      const existing: TenantContext | undefined = c.get('tenant');
      if (!existing) c.set('tenant', resolveTenantContext({}));
    } catch {}

    // 4. API キーごとの日次レート制限 & クォータ制御 (SQLite 永続化)
    const todayStr = new Date().toISOString().slice(0, 10);
    const usageCount = dbIncrementApiUsage(tokenHash, todayStr);

    // 1 以上の整数。未設定・不正な値は無制限（不正な値は起動時の検査が止める）
    const dailyLimit = envInt('SORA_AUTH_DAILY_LIMIT');
    if (dailyLimit !== undefined) {
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
