/** catch で受けた値（unknown）から message を取り出す。文字列の message が無ければ undefined。 */
export function errorMessage(err: unknown): string | undefined {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
}

/** catch で受けた値（unknown）から文字列の code を取り出す。無ければ undefined。 */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}
