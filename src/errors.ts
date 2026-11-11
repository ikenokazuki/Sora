/** catch で受けた値（unknown）から message を取り出す。文字列の message が無ければ undefined。 */
export function errorMessage(err: unknown): string | undefined {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
}

/**
 * errorMessage の文の中の URL を `<url>` に置き換える。秘密を含む宛先（Webhook など）への fetch の例外を記録するとき用
 * （Bun の fetch の例外の文は、宛先の URL を丸ごと含む。例: `UnexpectedRedirect fetching "https://…"`）。
 */
export function errorMessageWithoutUrls(err: unknown): string | undefined {
  return errorMessage(err)?.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, '<url>');
}

/** catch で受けた値（unknown）から文字列の code を取り出す。無ければ undefined。 */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** scrape（url・urls）と REST の /scrape・/scrape/batch の入力の誤り（REST では 400 の INVALID_INPUT）。取得の前に見つけたものに使う */
export class ScrapeInputError extends Error {}
