import type { Context } from 'hono';

/**
 * 構造化エラーレスポンス ヘルパー
 */
export function formatError(
  c: Context,
  message: string,
  code = 'INTERNAL_ERROR',
  status: 400 | 401 | 403 | 404 | 408 | 422 | 429 | 500 | 502 = 500,
  retryable = false,
  details?: unknown,
) {
  return c.json(
    {
      error: message,
      code,
      status,
      retryable,
      ...(details ? { details } : {}),
    },
    status,
  );
}
