import type { Context, MiddlewareHandler } from 'hono';
import {
  isLoopbackAuthority,
  normalizeOrigin,
  resolveMcpOriginConfig,
  resolveRequestHost,
  type McpOriginOptions,
  type ResolvedMcpOriginConfig,
} from './mcp_origin.js';
import { incrementSecurityCounter } from './metrics.js';
import { MCP_PATHS, PUBLIC_PATHS } from './public_paths.js';

// REST の信頼境界。
//
// 手元で動かすサーバーは、利用者がブラウザで開いた任意のページから呼ばれうる。別サイトのページからの fetch と、
// DNS rebinding（攻撃者のドメインが 127.0.0.1 に解決される）である。認証のない既定の構成では、それだけで
// 監視設定の読み取りや、利用者の回線を使った取得ができてしまう。
//
// そこで、ブラウザ由来の要求にだけ、MCP と同じ Host と Origin の許可リストをかける。curl・サーバー間通信・
// MCP クライアントのようにブラウザを介さない要求は Origin も Sec-Fetch-* も付けないので、検査せず従来どおり通す。
// （Origin と Sec-Fetch-* は、ページ上のスクリプトから書き換えられないヘッダーである。）

export type RestOriginDecision =
  | { allowed: true; /** CORS で返してよい Origin（ブラウザの CORS 要求だけ） */ origin?: string }
  | { allowed: false; reason: 'host' | 'origin'; host?: string };

/**
 * ブラウザ（ページ上のスクリプトや、ページからの遷移・埋め込み）が出した要求か。
 * `Sec-Fetch-Site: none` は、利用者がアドレスバーやブックマークから直接開いた要求なので、ページ由来ではない。
 */
export function isBrowserRequest(origin: string | undefined, secFetchSite: string | undefined): boolean {
  if (origin !== undefined && origin !== '') return true;
  return secFetchSite !== undefined && secFetchSite !== 'none';
}

export function evaluateRestRequest(
  config: ResolvedMcpOriginConfig,
  input: { host: string | undefined; origin: string | undefined; secFetchSite: string | undefined },
): RestOriginDecision {
  const origin = input.origin === '' ? undefined : input.origin;
  const site = input.secFetchSite?.trim().toLowerCase();
  if (!isBrowserRequest(origin, site)) return { allowed: true };

  const host = input.host;
  const hostAllowed = host !== undefined
    && (config.allowedHosts.has(host) || (config.allowLoopbackAnyPort && isLoopbackAuthority(host)));
  if (!hostAllowed) return { allowed: false, reason: 'host', host };

  if (origin === undefined) {
    // Origin の無いブラウザ要求は、他サイトのページが埋め込んだ <img>・<script> や、リンクからの遷移。
    // ページは結果を読めないが、GET の副作用は起こせる
    return site === 'cross-site' ? { allowed: false, reason: 'origin' } : { allowed: true };
  }
  if (origin.indexOf(',') >= 0) return { allowed: false, reason: 'origin' };
  const normalized = normalizeOrigin(origin);
  if (!normalized) return { allowed: false, reason: 'origin' };
  if (config.allowedOrigins.has(normalized)) return { allowed: true, origin: normalized };
  // 同一オリジン（Host は許可済み）。組み込みの /docs や /swagger の「試す」が、ポートを割り当てた構成でも動く
  if (new URL(normalized).host === host) return { allowed: true, origin: normalized };
  return { allowed: false, reason: 'origin' };
}

function deny(c: Context, decision: Extract<RestOriginDecision, { allowed: false }>) {
  const isHost = decision.reason === 'host';
  const hint = isHost
    ? `Host '${decision.host ?? ''}' is not allowed for requests from a browser. Add it to SORA_ALLOWED_HOSTS `
      + '(comma-separated, e.g. localhost:3016). Requests that do not come from a browser (curl, servers) are not checked.'
    : 'This origin is not allowed to call the API from a browser. Add it to SORA_ALLOWED_ORIGINS '
      + '(comma-separated, e.g. http://localhost:5173).';
  return c.json(
    {
      error: 'Forbidden: untrusted host or origin',
      code: isHost ? 'HOST_NOT_ALLOWED' : 'ORIGIN_NOT_ALLOWED',
      status: 403,
      retryable: false,
      hint,
    },
    403,
  );
}

export interface RestOriginPolicy {
  /** ブラウザ由来の要求の Host と Origin を検査する。cors() より前に置く（プリフライトも先に検査するため） */
  guard: MiddlewareHandler;
  /** cors() の origin に渡す。許可済みの Origin だけを返す。公開経路は誰でも読んでよいので '*' */
  corsOrigin: (origin: string, c: Context) => string | null;
}

export function createRestOriginPolicy(options: McpOriginOptions = {}): RestOriginPolicy {
  const config = resolveMcpOriginConfig(options);

  const decide = (c: Context): RestOriginDecision => evaluateRestRequest(config, {
    host: resolveRequestHost(c),
    origin: c.req.header('origin'),
    secFetchSite: c.req.header('sec-fetch-site'),
  });

  const guard: MiddlewareHandler = async (c, next) => {
    // 公開経路は誰でも読んでよい。MCP の経路は mcp_origin.ts が、ブラウザかどうかによらず検査する
    if (PUBLIC_PATHS.has(c.req.path) || MCP_PATHS.has(c.req.path)) return next();
    const decision = decide(c);
    if (decision.allowed) return next();
    incrementSecurityCounter('sora_rest_origin_rejected_total');
    return deny(c, decision);
  };

  const corsOrigin = (origin: string, c: Context): string | null => {
    if (PUBLIC_PATHS.has(c.req.path)) return '*';
    if (!origin) return null;
    const decision = decide(c);
    return decision.allowed && decision.origin !== undefined ? decision.origin : null;
  };

  return { guard, corsOrigin };
}
