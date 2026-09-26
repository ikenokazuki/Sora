import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual, createHash } from 'crypto';
import { dbIncrementApiUsage } from './db.js';

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
      console.warn('[Sora/Auth] No API key configured; running in fail-open mode (anonymous access allowed).');
    } else {
      // 3. API キーの照合 (定数時間比較)
      const providedToken = extractAuthToken(c);
      const forwardedFor = c.req.header('x-forwarded-for');
      const realIp = c.req.header('x-real-ip');
      const isDirectLocal = !forwardedFor && !realIp && process.env.ALLOW_LOCAL_NO_AUTH === 'true';

      if (providedToken && isSecureEqual(providedToken, apiKey)) {
        tokenHash = hashApiKey(providedToken);
      } else if (isDirectLocal) {
        tokenHash = 'local_direct';
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
