import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual, createHash } from 'crypto';
import { envBool, envInt, envStr } from './config.js';
import { dbIncrementApiUsage } from './db.js';
import { getApiKeyStore, type ApiKeyStore } from './security/api_keys.js';
import { incrementSecurityCounter } from './security/metrics.js';
import { isPublicPath } from './security/public_paths.js';
import { resolveTenantContext, type TenantContext } from './security/tenant_context.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** 認証ミドルウェアが要求ごとに設定するテナント */
    tenant: TenantContext;
  }
}

/** タイミング攻撃（Timing Attack）を防ぐ定数時間文字列比較 */
export function isSecureEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * リクエストから Bearer Token または X-API-Key を抽出する。Authorization の scheme は大文字小文字を区別しない（RFC 7235 §2.1）。
 * 認証も MCP も、鍵はここだけで読む（読み方が食い違うと、認証が通った利用者が別の tenant になれた）。
 */
export function extractAuthToken(c: any): string | undefined {
  const bearer = /^Bearer[ \t]+(.*)$/i.exec(c.req.header('authorization') ?? '');
  if (bearer) return bearer[1].trim();
  const xApiKey = c.req.header('x-api-key');
  return xApiKey ? xApiKey.trim() : undefined;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

let warnedNoKeyMode = false;
/** One-time dev-mode notice: anonymous access without a configured key. */
export function warnOnceNoKey(): void {
  if (warnedNoKeyMode) return;
  warnedNoKeyMode = true;
  try {
    console.warn('[Sora] No API key configured: anonymous access is open (set SORA_API_KEY, or SORA_ALLOW_ANONYMOUS=true to silence).');
  } catch {}
}

/** 401。拒否の回数を数える（鍵なしと、誤った鍵を分ける） */
function unauthorized(c: any, token: string | undefined) {
  incrementSecurityCounter(token ? 'sora_auth_rejected_invalid_total' : 'sora_auth_rejected_missing_total');
  return c.json(
    {
      error: 'Unauthorized: Invalid or missing API key',
      code: 'UNAUTHORIZED',
      status: 401,
      retryable: false,
      message: 'Please provide a valid API key via Authorization: Bearer <key> or X-API-Key header.',
    },
    401,
  );
}

const loggedAuthUnavailable = new Set<string>();
/**
 * 鍵ファイルを読めない（起動のあとに壊れた）。匿名にも、鍵なしの通過にもせず、すべての要求を断る。理由は、同じものを 1 回だけログに出す（クライアントには出さない）。
 * 起動の検査（startup_check.ts）が先に鍵ファイルを読んで検査するので、起動した Sora では、ふつう起きない。
 */
function authUnavailable(c: any, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  if (!loggedAuthUnavailable.has(reason)) {
    loggedAuthUnavailable.add(reason);
    try {
      console.error(`[Sora] 鍵ファイルを読めないので、認証が要る要求をすべて 503 で断ります: ${reason}`);
    } catch {}
  }
  return c.json(
    { error: 'Authentication is unavailable', code: 'AUTH_UNAVAILABLE', status: 503, retryable: false, message: 'The server could not load its API key file. Contact the operator.' },
    503,
  );
}

/**
 * 単一の鍵（SORA_API_KEY。または引数の鍵）か、鍵なし（Fail-Open）での認証。
 * 通すときは、使用量を数える鍵（鍵のハッシュ。匿名は 'anonymous'）、断るときは 401 の応答を返す。
 */
function authenticateWithSingleKey(c: any, expectedApiKey: string | undefined): string | Response {
  let tokenHash = 'anonymous';

  // 2. API キーが環境変数等で設定されていない場合の挙動（Fail-Open）
  // 注意: bun build は process.env.NODE_ENV をビルド時にインライン化し、
  // 到達不能分岐を削除するため、認証判断に NODE_ENV を使わないこと。
  // 2026-09-26 に本番バンドルから Fail-Closed 分岐が消滅し、
  // 意図せず常時開放になっていた実績がある。
  // 本サーバーはキー未設定でも利用可能とする方針のため、
  // キー未設定時は警告ログのみで全リクエストを許可する。
  const apiKey = expectedApiKey ?? envStr('SORA_API_KEY');
  if (!apiKey) {
    // Fail-open without a configured key (v2.30.2): do not gate on
    // NODE_ENV here — bun build inlines it and the branch vanishes
    // from the production bundle. Warn once; silence the notice with
    // SORA_ALLOW_ANONYMOUS=true.
    if (!envBool('SORA_ALLOW_ANONYMOUS')) warnOnceNoKey();
    return tokenHash;
  }

  // 3. API キーの照合 (定数時間比較)
  const providedToken = extractAuthToken(c);
  const allowAnonymous = envBool('SORA_ALLOW_ANONYMOUS');

  if (providedToken && isSecureEqual(providedToken, apiKey)) {
    tokenHash = hashApiKey(providedToken);
    try {
      c.set('tenant', resolveTenantContext({ apiKey: providedToken }));
    } catch {}
  } else if (allowAnonymous) {
    try {
      c.set('tenant', resolveTenantContext({}));
    } catch {}
  } else {
    return unauthorized(c, providedToken);
  }
  return tokenHash;
}

/**
 * 鍵ファイル（SORA_AUTH_KEYS_FILE。または引数の keyStore）での認証。鍵ごとに別の tenant（`name:<name>`）。匿名は認めない（SORA_ALLOW_ANONYMOUS は効かない）。
 * 鍵から tenant の name を引く（SHA-256 にして表を引くので、鍵の数によらない）。通すときは、使用量を数える鍵（tenant の ID）、断るときは 401 の応答を返す。
 */
function authenticateWithKeyFile(c: any, store: ApiKeyStore): string | Response {
  const providedToken = extractAuthToken(c);
  const name = providedToken ? store.lookup(providedToken) : undefined;
  if (name !== undefined) {
    const tenant = resolveTenantContext({ tenantName: name });
    c.set('tenant', tenant);
    return tenant.tenantId;
  }
  return unauthorized(c, providedToken);
}

/**
 * 認証のミドルウェア。鍵の決め方は 3 通り:
 *  - 鍵ファイル（SORA_AUTH_KEYS_FILE。または引数の keyStore）: 鍵ごとに別の tenant。匿名は認めない
 *  - 単一の鍵（SORA_API_KEY。または引数の expectedApiKey。引数が先）: tenant は鍵のハッシュ。匿名は SORA_ALLOW_ANONYMOUS で認める
 *  - どちらも無い: 認証なし（Fail-Open）
 */
export function createAuthMiddleware(expectedApiKey?: string, keyStore?: ApiKeyStore): MiddlewareHandler {
  return async (c, next) => {
    // 1. 公開エンドポイント（ヘルスチェック、ルート、メトリクス、ドキュメント）は認証不要
    if (isPublicPath(c.req.path)) {
      return next();
    }

    let store: ApiKeyStore | undefined;
    try {
      store = keyStore ?? (expectedApiKey === undefined ? getApiKeyStore() : undefined);
    } catch (error) {
      return authUnavailable(c, error);
    }

    // 回数を数える鍵（API の使用量の表の key）。単一の鍵は鍵のハッシュ、鍵ファイルは tenant の ID
    const authenticated = store ? authenticateWithKeyFile(c, store) : authenticateWithSingleKey(c, expectedApiKey);
    if (typeof authenticated !== 'string') return authenticated;
    const tokenHash = authenticated;

    try {
      const existing: TenantContext | undefined = c.get('tenant');
      if (!existing) c.set('tenant', resolveTenantContext({}));
    } catch {}

    // 4. API キーごとの日次レート制限 & クォータ制御 (SQLite 永続化)
    const todayStr = new Date().toISOString().slice(0, 10);
    const usageCount = dbIncrementApiUsage(tokenHash, todayStr);

    // 1 以上の整数。未設定・不正な値は無制限（不正な値は起動時の検査が止める）
    const dailyLimit = envInt('SORA_AUTH_DAILY_LIMIT');
    if (dailyLimit !== undefined) {
      c.header('X-RateLimit-Limit', String(dailyLimit));
      c.header('X-RateLimit-Remaining', String(Math.max(0, dailyLimit - usageCount)));

      if (usageCount > dailyLimit) {
        return c.json(
          {
            error: 'Too Many Requests: Daily quota limit exceeded',
            code: 'RATE_LIMIT_EXCEEDED',
            status: 429,
            retryable: false,
            limit: dailyLimit,
            current: usageCount,
            message: `You have reached the daily quota of ${dailyLimit} requests. Resets at next UTC day.`,
          },
          429,
        );
      }
    }

    return next();
  };
}
