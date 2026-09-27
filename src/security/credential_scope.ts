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

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}
