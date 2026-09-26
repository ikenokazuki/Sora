// Shared safe-transport primitives (RFC P0-SEC-03/04).
// Call sites must validate before fetching and must never buffer
// unbounded bodies. New outbound code should build on safeFetch.
import { incrementSecurityCounter } from '../security/metrics.js';

export const DEFAULT_MAX_BODY_BYTES = 30 * 1024 * 1024;

/** Read a response body with a streaming byte cap (RFC P0-SEC-04). */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        incrementSecurityCounter('sora_response_size_abort_total');
        throw new Error(`Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  validate?: (url: URL) => Promise<void> | void;
}

const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
]);

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !SENSITIVE_REDIRECT_HEADERS.has(k.toLowerCase())),
  );
}

/** SSRF-checked fetch with manual redirects, credential stripping and body cap. */
export async function safeFetch(
  input: string,
  options: SafeFetchOptions & { validate: (url: URL) => Promise<void> | void },
): Promise<{ finalUrl: string; body: Uint8Array; response: Response }> {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  let currentUrl = input;
  let headers = { ...(options.headers ?? {}) };
  let redirects = 0;
  for (;;) {
    const parsed = new URL(currentUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Blocked protocol: ${parsed.protocol}`);
    await options.validate(parsed);
    const res = await fetch(currentUrl, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });
    const len = res.headers.get('content-length');
    if (len && parseInt(len, 10) > maxBytes) {
      incrementSecurityCounter('sora_response_size_abort_total');
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) return { finalUrl: currentUrl, body: await readBodyWithLimit(res, maxBytes), response: res };
      const next = new URL(location, currentUrl);
      await options.validate(next);
      if (next.origin !== parsed.origin) {
        const before = Object.keys(headers).length;
        headers = stripSensitiveHeaders(headers);
        if (Object.keys(headers).length !== before) incrementSecurityCounter('sora_credential_strip_total');
      }
      currentUrl = next.href;
      if (++redirects > maxRedirects) throw new Error(`Redirect limit exceeded (${maxRedirects})`);
      continue;
    }
    return { finalUrl: currentUrl, body: await readBodyWithLimit(res, maxBytes), response: res };
  }
}
