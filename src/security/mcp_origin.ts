import type { MiddlewareHandler } from 'hono';
import { envInt, envList } from '../config.js';
import { normalizeHost, normalizeOrigin } from './host_origin.js';

export { normalizeHost, normalizeOrigin };

export interface McpOriginOptions {
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  port?: number;
}

export function resolveMcpPort(explicit?: number): number {
  if (explicit !== undefined && Number.isInteger(explicit) && explicit > 0) return explicit;
  return envInt('PORT');
}

export function defaultAllowedHosts(port: number): string[] {
  return ['localhost', '127.0.0.1', '[::1]', 'localhost:' + port, '127.0.0.1:' + port, '[::1]:' + port];
}

export function defaultAllowedOrigins(port: number): string[] {
  return [
    'http://localhost', 'http://127.0.0.1', 'http://[::1]',
    'http://localhost:' + port, 'http://127.0.0.1:' + port, 'http://[::1]:' + port,
  ];
}

export interface ResolvedMcpOriginConfig {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  primaryOrigin: string;
  /**
   * true のとき、loopback のホスト名（localhost / 127.0.0.1 / [::1]）は Host のポートを問わず許可する。
   * SORA_ALLOWED_HOSTS を設定していない既定の構成だけ true。`docker run -p 3016:8000` のように
   * ホスト側ポートがコンテナ内の PORT と違っても、既定のまま localhost から接続できるようにする。
   */
  allowLoopbackAnyPort: boolean;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `localhost:3016` のような Host が loopback のホスト名か。ポートは問わない（付ける場合は 1〜65535）。
 * DNS rebinding の防御は Host の「ホスト名」で成り立つ（攻撃者のドメインは loopback 名にならない）。
 */
export function isLoopbackAuthority(authority: string): boolean {
  const v = authority.trim().toLowerCase();
  let hostname = v;
  let port = '';
  if (v.startsWith('[')) {
    const close = v.indexOf(']');
    if (close < 0) return false;
    hostname = v.slice(0, close + 1);
    const rest = v.slice(close + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return false;
      port = rest.slice(1);
    }
  } else {
    const colon = v.lastIndexOf(':');
    if (colon >= 0) {
      hostname = v.slice(0, colon);
      port = v.slice(colon + 1);
    }
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  if (port === '') return true;
  if (!/^[0-9]{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

export function resolveMcpOriginConfig(options: McpOriginOptions = {}): ResolvedMcpOriginConfig {
  const port = resolveMcpPort(options.port);
  // 環境変数の列は、正しい要素だけを正規化して返す（不正な要素は起動時の検査が止める）。引数の不正な要素は下で例外にする
  const hostRaw = options.allowedHosts !== undefined ? options.allowedHosts : envList('SORA_ALLOWED_HOSTS');
  const originRaw = options.allowedOrigins !== undefined ? options.allowedOrigins : envList('SORA_ALLOWED_ORIGINS');
  const hostList = hostRaw.length > 0 ? hostRaw : defaultAllowedHosts(port);
  const originList = originRaw.length > 0 ? originRaw : defaultAllowedOrigins(port);
  const allowedHosts = new Set<string>();
  for (const h of hostList) {
    const n = normalizeHost(h);
    if (!n) throw new Error('Invalid SORA_ALLOWED_HOSTS entry: ' + h);
    allowedHosts.add(n);
  }
  const allowedOrigins = new Set<string>();
  for (const o of originList) {
    const n = normalizeOrigin(o);
    if (!n) throw new Error('Invalid SORA_ALLOWED_ORIGINS entry: ' + o);
    allowedOrigins.add(n);
  }
  if (allowedHosts.size === 0 || allowedOrigins.size === 0) throw new Error('MCP origin allowlist is empty');
  const first = originList.map((o) => normalizeOrigin(o) as string)[0];
  return { allowedHosts, allowedOrigins, primaryOrigin: first, allowLoopbackAnyPort: hostRaw.length === 0 };
}

function deny(c: any, reason: 'host' | 'origin', host?: string) {
  // 設定で直せる拒否は、何を設定すればよいかを返す（Docker のポート割り当て・公開ホスト名で最初につまずくため）
  const hint = reason === 'host'
    ? `Host '${host ?? ''}' is not allowed. Add it to SORA_ALLOWED_HOSTS (comma-separated, e.g. localhost:3016). `
      + 'Browser clients also need SORA_ALLOWED_ORIGINS (e.g. http://localhost:3016).'
    : 'Origin is not allowed. Add it to SORA_ALLOWED_ORIGINS (comma-separated, e.g. http://localhost:3016).';
  return c.json({ error: 'Forbidden: untrusted host or origin for MCP endpoint', hint }, 403);
}

/** 要求の Host（小文字化済み）。Host ヘッダーが無いときだけ URL のホストで代える。解釈できなければ undefined。 */
export function resolveRequestHost(c: any): string | undefined {
  const hostHeader = c.req.header('host');
  if (hostHeader) return normalizeHost(hostHeader);
  try {
    return normalizeHost(new URL(c.req.url).host);
  } catch {
    return undefined;
  }
}

export function createMcpOriginMiddleware(options: McpOriginOptions = {}): MiddlewareHandler {
  const config = resolveMcpOriginConfig(options);
  const handler = (async (c: any, next: () => Promise<void>) => {
    const normalizedHost = resolveRequestHost(c);
    const hostAllowed = normalizedHost !== undefined
      && (config.allowedHosts.has(normalizedHost) || (config.allowLoopbackAnyPort && isLoopbackAuthority(normalizedHost)));
    if (!normalizedHost || !hostAllowed) return deny(c, 'host', normalizedHost);
    const originHeader = c.req.header('origin');
    let echoOrigin: string | undefined;
    if (originHeader !== undefined && originHeader !== '') {
      if (originHeader.indexOf(',') >= 0) return deny(c, 'origin');
      const normalized = normalizeOrigin(originHeader);
      if (!normalized || !config.allowedOrigins.has(normalized)) return deny(c, 'origin');
      echoOrigin = normalized;
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Origin', echoOrigin !== undefined ? echoOrigin : config.primaryOrigin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, x-request-id, Last-Event-ID');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }
    await next();
    if (echoOrigin !== undefined) {
      c.header('Access-Control-Allow-Origin', echoOrigin);
      c.header('Vary', 'Origin');
    }
  }) as unknown as MiddlewareHandler;
  return handler;
}
