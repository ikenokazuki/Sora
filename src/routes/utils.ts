/**
 * 構造化エラーレスポンス ヘルパー
 */
export function formatError(
  c: any,
  message: string,
  code = 'INTERNAL_ERROR',
  status: 400 | 401 | 403 | 404 | 408 | 422 | 429 | 500 | 502 = 500,
  retryable = false,
  details?: any,
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
