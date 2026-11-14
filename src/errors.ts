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

/**
 * 断った理由（ブラウザの枠の待ち行列。設計 6。穴 25）:
 * tenant_queue_full = その利用者が待てる数の上限・queue_full = 全体で待てる数の上限・queue_timeout = 待ち時間の上限
 * （ブラウザセッションの数。設計 6。穴 22）session_limit = 全体のセッション数の上限（ほかの利用者のセッションは閉じない）
 */
export type BusyReason = 'tenant_queue_full' | 'queue_full' | 'queue_timeout' | 'session_limit';

/**
 * 資源（ブラウザの枠・セッションの数）が混み合っていて、待たせずに（または待たせたあとに）断ったときの例外。
 * REST では 429 と Retry-After（秒）、MCP ではエラーの文になる。再試行してよい
 */
export class ResourceBusyError extends Error {
  constructor(
    message: string,
    readonly reason: BusyReason,
    readonly retryAfterSec = 5,
  ) {
    super(message);
    this.name = 'ResourceBusyError';
  }
}

/**
 * 日次クォータ（SORA_AUTH_DAILY_LIMIT）を超える件数の呼び出しを、始める前に断ったときの例外（一括・crawl は、件数分を数える。設計 6。穴 26）。
 * REST では 429（RATE_LIMIT_EXCEEDED）と Retry-After（次の UTC の日の始まりまでの秒）、MCP ではエラーの文になる。その日のうちは、再試行しても通らない
 */
export class QuotaExceededError extends Error {
  constructor(
    /** 1 日の上限（回数） */
    readonly limit: number,
    /** 断った時点の、今日の回数 */
    readonly current: number,
    /** この呼び出しが足そうとした件数（最初の 1 回の要求の分を除く） */
    readonly requested: number,
  ) {
    super(`日次クォータ（1 日 ${limit} 回）を超えるため、始めません。この呼び出しは、あと ${requested} 回分を数えますが、今日の回数は ${current} 回です。次の UTC の日の始まりに戻ります`);
    this.name = 'QuotaExceededError';
  }

  /** 次の UTC の日の始まりまでの秒（Retry-After） */
  get retryAfterSec(): number {
    return secondsUntilNextUtcDay();
  }
}

/** 次の UTC の日の始まりまでの秒（日次クォータが戻るまで。1 以上） */
export function secondsUntilNextUtcDay(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
