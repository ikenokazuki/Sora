import type { MiddlewareHandler } from 'hono';

export function createAuthMiddleware(expectedApiKey?: string): MiddlewareHandler {
  return async (c, next) => {
    // 1. ヘルスチェックとルートの GET は認証不要
    const path = c.req.path;
    if (path === '/health' || path === '/') {
      return next();
    }

    // 2. API キーが環境変数等で設定されていない場合は全許可（開発環境・内部利用用）
    const apiKey = expectedApiKey ?? process.env.WEB_FETCHER_API_KEY ?? process.env.API_KEY;
    if (!apiKey) {
      return next();
    }

    // 3. API キーの照合 (Bearer Token または X-API-Key)
    const authHeader = c.req.header('authorization');
    const xApiKey = c.req.header('x-api-key');

    let providedToken: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.substring(7).trim();
    } else if (xApiKey) {
      providedToken = xApiKey.trim();
    }

    if (providedToken && providedToken === apiKey) {
      return next();
    }

    // 4. Caddy などのリバースプロキシを経由しない直接ローカルアクセス（127.0.0.1）はバイパス
    // Caddy 経由の場合は X-Forwarded-For または X-Real-IP が付与される
    const forwardedFor = c.req.header('x-forwarded-for');
    const realIp = c.req.header('x-real-ip');
    const isDirectLocal = !forwardedFor && !realIp;

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
