import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual, createHash } from 'crypto';

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

export function createAuthMiddleware(expectedApiKey?: string): MiddlewareHandler {
  return async (c, next) => {
    // 1. 公開エンドポイント（ヘルスチェック、ルート、メトリクス）は認証不要
    const path = c.req.path;
    if (path === '/health' || path === '/' || path === '/metrics') {
      return next();
    }

    // 2. API キーが環境変数等で設定されていない場合は全許可（開発環境・内部利用用）
    const apiKey = expectedApiKey ?? process.env.WEB_FETCHER_API_KEY ?? process.env.API_KEY;
    if (!apiKey) {
      return next();
    }

    // 3. API キーの照合 (定数時間比較)
    const providedToken = extractAuthToken(c);
    if (providedToken && isSecureEqual(providedToken, apiKey)) {
      return next();
    }

    // 4. 明示的に許可された場合のみローカルバイパスを許容 (Secure by Default)
    const forwardedFor = c.req.header('x-forwarded-for');
    const realIp = c.req.header('x-real-ip');
    const isDirectLocal = !forwardedFor && !realIp && process.env.ALLOW_LOCAL_NO_AUTH === 'true';

    if (isDirectLocal) {
      return next();
    }

    return c.json(
      {
        error: 'Unauthorized: Invalid or missing API key',
        message: 'Please provide a valid API key via Authorization: Bearer <API_KEY> or X-API-Key header.',
      },
      401,
    );
  };
}
