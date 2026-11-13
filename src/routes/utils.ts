import type { Context } from 'hono';
import { ResourceBusyError } from '../errors.js';

/**
 * JSON の本文の最上位で null の項目を、指定なしとして取り除く（None・nil を「未指定」として送るクライアント向け）。
 * 必須の項目が null なら、取り除いたあとの検証で欠けとして 400 になる。オブジェクトでない本文はそのまま返す。
 */
export function dropNullFields(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null));
}

/** JSON の本文を読む。JSON として読めなければ 400 INVALID_JSON の応答を返す（呼び出し側は Response かどうかで分ける） */
export async function jsonBodyOr400(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }
}

/**
 * 構造化エラーレスポンス ヘルパー
 */
export function formatError(
  c: Context,
  message: string,
  code = 'INTERNAL_ERROR',
  status: 400 | 401 | 403 | 404 | 408 | 413 | 422 | 429 | 500 | 502 = 500,
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

/**
 * ブラウザの枠が混み合って断られたとき（ResourceBusyError。設計 6。穴 25）の、エラーの情報（code・status・retryable・Retry-After の秒数）。
 * ほかの失敗は undefined（呼び出し側が、これまでどおり分類する）。ストリームは、200 で開いたあとなので、error イベントにこれを入れる
 */
export function busyEventFields(err: unknown): { code: 'BROWSER_BUSY'; status: 429; retryable: true; retryAfterSec: number } | undefined {
  if (!(err instanceof ResourceBusyError)) return undefined;
  return { code: 'BROWSER_BUSY', status: 429, retryable: true, retryAfterSec: err.retryAfterSec };
}

/** 混み合って断られたとき（ResourceBusyError）の応答: 429 と Retry-After（秒）。ほかの失敗は undefined */
export function busyResponse(c: Context, err: unknown): Response | undefined {
  const fields = busyEventFields(err);
  if (!fields) return undefined;
  c.header('Retry-After', String(fields.retryAfterSec));
  return formatError(c, (err as ResourceBusyError).message, fields.code, fields.status, fields.retryable);
}
