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

/**
 * 例外の種類だけ（文字列の code、無ければ文字列の name、どちらも無ければ 'unknown error'）。
 * 秘密を含む宛先（Webhook など）への fetch の例外を記録するとき用。Bun の fetch の例外の文（message）は宛先の URL を
 * 丸ごと含むので、文は出さない（例: code `UnexpectedRedirect`・`ConnectionRefused`、時間切れは code が数なので name `TimeoutError`）。
 */
export function errorKind(err: unknown): string {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return errorCode(err) ?? (typeof name === 'string' ? name : 'unknown error');
}

/** scrape（url・urls）と REST の /scrape・/scrape/batch の入力の誤り（REST では 400 の INVALID_INPUT）。取得の前に見つけたものに使う */
export class ScrapeInputError extends Error {}
