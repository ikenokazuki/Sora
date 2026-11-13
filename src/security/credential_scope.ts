// Credential scope detection (RFC P0-SEC-01).
// Never place credential-scoped content in public cache.
// This invariant is required for multi-tenant safety.

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
]);

/** 資格情報を運ぶヘッダー名か（大文字小文字は区別しない） */
export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}

export function hasSensitiveRequestCredentials(options: {
  headers?: Record<string, string>;
  cookies?: Array<unknown>;
}): boolean {
  if (options.cookies && options.cookies.length > 0) return true;
  const headers = options.headers ?? {};
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) return true;
  }
  return false;
}

/** 結果の言語・形にだけ影響し、秘密を運ばないヘッダー。これ以外のヘッダーを渡した取得は、共有キャッシュを使わない（大文字小文字は区別しない） */
const HARMLESS_HEADER_NAMES = new Set(['accept', 'accept-language', 'user-agent', 'referer', 'cache-control', 'pragma', 'dnt']);

export function isHarmlessHeaderName(name: string): boolean {
  return HARMLESS_HEADER_NAMES.has(name.toLowerCase());
}

/**
 * 共有キャッシュを読まず、書かない取得か（設計 5。未決 9）。Cookie を渡した、または、無害と決めたもの以外のヘッダーを渡した。
 * 資格情報の名前の一覧（SENSITIVE_HEADER_NAMES）には頼らない: X-Auth・Api-Key・X-CSRF-Token などの、一覧に無い名前で運ばれた秘密を、取りこぼさないため。
 */
export function bypassesSharedCache(options: {
  headers?: Record<string, string>;
  cookies?: Array<unknown>;
}): boolean {
  if (options.cookies && options.cookies.length > 0) return true;
  return Object.keys(options.headers ?? {}).some((name) => !isHarmlessHeaderName(name));
}

