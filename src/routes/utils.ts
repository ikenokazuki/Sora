import type { Context } from 'hono';

/**
 * JSON の本文の最上位で null の項目を、指定なしとして取り除く（None・nil を「未指定」として送るクライアント向け）。
 * 必須の項目が null なら、取り除いたあとの検証で欠けとして 400 になる。オブジェクトでない本文はそのまま返す。
 */
export function dropNullFields(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null));
}

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
