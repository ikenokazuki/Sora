import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createMcpOriginMiddleware, normalizeHost, normalizeOrigin, resolveMcpOriginConfig } from './mcp_origin.js';

function buildApp(options?: Parameters<typeof createMcpOriginMiddleware>[0]) {
  const app = new Hono();
  app.use('/mcp', createMcpOriginMiddleware(options));
  app.use('/sse', createMcpOriginMiddleware(options));
  app.use('/message', createMcpOriginMiddleware(options));
  app.all('/mcp', (c) => c.json({ ok: true }));
  app.all('/sse', (c) => c.json({ ok: true }));
  app.all('/message', (c) => c.json({ ok: true }));
  return app;
}

const req = (app: Hono, path: string, method: string, headers: Record<string, string>) =>
  app.request(path, { method, headers });

describe('mcp origin/host trust boundary', () => {
  test('non-browser client without origin passes on trusted host', async () => {
    const app = buildApp({ port: 8000 });
    const res = await req(app, '/mcp', 'POST', { host: 'localhost:8000' });
    expect(res.status).toBe(200);
  });
  test('evil origin is rejected', async () => {
    const app = buildApp({ port: 8000 });
    const res = await req(app, '/mcp', 'POST', { host: 'localhost:8000', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
  test('attacker host is rejected even when origin matches the host', async () => {
    const app = buildApp({ port: 8000 });
    const res = await req(app, '/mcp', 'POST', { host: 'attacker.example', origin: 'http://attacker.example' });
    expect(res.status).toBe(403);
  });
  test('null, multiple, and malformed origins are rejected', async () => {
    const app = buildApp({ port: 8000 });
    for (const origin of ['null', 'https://a.example, https://b.example', 'not-a-url', 'ftp://localhost']) {
      const res = await req(app, '/mcp', 'POST', { host: 'localhost:8000', origin });
      expect(res.status).toBe(403);
    }
  });
  test('untrusted url host without header is rejected', async () => {
    const app = new Hono();
    app.use('/mcp', createMcpOriginMiddleware({ port: 8000 }));
    app.all('/mcp', (c) => c.json({ ok: true }));
    const res = await app.request('http://evil.example/mcp', { method: 'POST' });
    expect(res.status).toBe(403);
  });
  test('scheme and port mismatch are rejected', async () => {
    const app = buildApp({ port: 8000 });
    const https = await req(app, '/mcp', 'POST', { host: 'localhost:8000', origin: 'https://localhost:8000' });
    expect(https.status).toBe(403);
    const port = await req(app, '/mcp', 'POST', { host: 'localhost:8000', origin: 'http://localhost:9999' });
    expect(port.status).toBe(403);
  });
  test('OPTIONS preflight succeeds without reaching the handler and echoes the origin', async () => {
    const app = buildApp({ port: 8000 });
    const res = await req(app, '/mcp', 'OPTIONS', { host: 'localhost:8000', origin: 'http://localhost:8000' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8000');
  });
  test('OPTIONS with evil origin is rejected', async () => {
    const app = buildApp({ port: 8000 });
    const res = await req(app, '/sse', 'OPTIONS', { host: 'localhost:8000', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
  test('custom allowlist passes exact public host and origin only', async () => {
    const options = { allowedHosts: ['app.example.com'], allowedOrigins: ['https://app.example.com'] };
    const app = buildApp(options);
    const ok = await req(app, '/message', 'POST', { host: 'app.example.com', origin: 'https://app.example.com' });
    expect(ok.status).toBe(200);
    const badOrigin = await req(app, '/message', 'POST', { host: 'app.example.com', origin: 'https://evil.example' });
    expect(badOrigin.status).toBe(403);
    const badHost = await req(app, '/message', 'POST', { host: 'evil.example', origin: 'https://app.example.com' });
    expect(badHost.status).toBe(403);
  });
  test('invalid allowlist entries fail at startup', async () => {
    expect(() => resolveMcpOriginConfig({ allowedHosts: ['http://localhost'] })).toThrow();
    expect(() => resolveMcpOriginConfig({ allowedOrigins: ['not-a-url'] })).toThrow();
    expect(() => resolveMcpOriginConfig({ allowedOrigins: ['null'] })).toThrow();
  });
  test('normalize helpers behave', async () => {
    expect(normalizeHost('LocalHost:8000')).toBe('localhost:8000');
    expect(normalizeHost('http://localhost')).toBeUndefined();
    expect(normalizeOrigin('https://App.Example.com')).toBe('https://app.example.com');
    expect(normalizeOrigin('null')).toBeUndefined();
  });
});
