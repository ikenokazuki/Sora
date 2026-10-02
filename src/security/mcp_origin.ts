import type { MiddlewareHandler } from 'hono';

export interface McpOriginOptions {
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  port?: number;
}

export function resolveMcpPort(explicit?: number): number {
  if (explicit !== undefined && Number.isInteger(explicit) && explicit > 0) return explicit;
  const fromEnv = parseInt(process.env.PORT || '', 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return 8000;
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

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function normalizeHost(value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (v.indexOf('/') >= 0 || v.indexOf('?') >= 0 || v.indexOf('#') >= 0 || v.indexOf('@') >= 0) return undefined;
  if (/\s/.test(v)) return undefined;
  const lower = v.toLowerCase();
  if (lower.charAt(0) === '[') {
    const close = lower.indexOf(']');
    if (close < 0) return undefined;
    const rest = lower.slice(close + 1);
    if (rest !== '' && !/^:[0-9]+$/.test(rest)) return undefined;
    return lower;
  }
  const colon = lower.lastIndexOf(':');
  if (colon >= 0) {
    const portPart = lower.slice(colon + 1);
    if (!/^[0-9]+$/.test(portPart)) return undefined;
  }
  return lower;
}

export function normalizeOrigin(value: string): string | undefined {
  const v = value.trim();
  if (!v || v === 'null') return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return undefined;
  return url.origin;
}

export interface ResolvedMcpOriginConfig {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  primaryOrigin: string;
}

export function resolveMcpOriginConfig(options: McpOriginOptions = {}): ResolvedMcpOriginConfig {
  const port = resolveMcpPort(options.port);
  const hostRaw = options.allowedHosts !== undefined ? options.allowedHosts : parseList(process.env.SORA_ALLOWED_HOSTS);
  const originRaw = options.allowedOrigins !== undefined ? options.allowedOrigins : parseList(process.env.SORA_ALLOWED_ORIGINS);
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
  return { allowedHosts, allowedOrigins, primaryOrigin: first };
}

function deny(c: any) {
  return c.json({ error: 'Forbidden: untrusted host or origin for MCP endpoint' }, 403);
}

export function createMcpOriginMiddleware(options: McpOriginOptions = {}): MiddlewareHandler {
  const config = resolveMcpOriginConfig(options);
  const handler = (async (c: any, next: () => Promise<void>) => {
    const hostHeader = c.req.header('host');
    let headerHost = hostHeader ? normalizeHost(hostHeader) : undefined;
    if (headerHost === undefined && !hostHeader) {
      try {
        const u = new URL(c.req.url);
        headerHost = normalizeHost(u.host);
      } catch {
        headerHost = undefined;
      }
    }
    const normalizedHost = headerHost;
    if (!normalizedHost || !config.allowedHosts.has(normalizedHost)) return deny(c);
    const originHeader = c.req.header('origin');
    let echoOrigin: string | undefined;
    if (originHeader !== undefined && originHeader !== '') {
      if (originHeader.indexOf(',') >= 0) return deny(c);
      const normalized = normalizeOrigin(originHeader);
      if (!normalized || !config.allowedOrigins.has(normalized)) return deny(c);
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
