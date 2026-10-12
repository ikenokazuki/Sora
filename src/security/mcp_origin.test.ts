import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createMcpOriginMiddleware, isLoopbackAuthority, normalizeHost, normalizeOrigin, resolveMcpOriginConfig } from './mcp_origin.js';
import { app as soraApp } from '../index.js';

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

describe('既定の Host 許可: loopback のホスト名はポートを問わない', () => {
  // README の Quickstart（docker run -p 3016:8000 → http://localhost:3016/mcp）の Host は localhost:3016。
  // コンテナ内の PORT（8000）と違っても、既定のまま接続できること。
  test('ホスト側ポートが違う localhost / 127.0.0.1 / [::1] は通る', async () => {
    const app = buildApp({ port: 8000 });
    for (const host of ['localhost:3016', '127.0.0.1:3016', '[::1]:3016', 'LocalHost:65535', 'localhost', '127.0.0.1:8000']) {
      const res = await req(app, '/mcp', 'POST', { host });
      expect(res.status, host).toBe(200);
    }
  });

  test('loopback 以外のホスト名は、ポートが合っていても拒否する（DNS rebinding・LAN からの到達）', async () => {
    const app = buildApp({ port: 8000 });
    for (const host of ['evil.example:8000', 'evil.example:3016', 'localhost.evil.example:3016', '192.168.1.5:3016', '10.0.0.1:8000', 'notlocalhost:3016', '0.0.0.0:3016']) {
      const res = await req(app, '/mcp', 'POST', { host });
      expect(res.status, host).toBe(403);
    }
  });

  test('範囲外・不正なポートは拒否する', async () => {
    const app = buildApp({ port: 8000 });
    for (const host of ['localhost:0', 'localhost:65536', 'localhost:99999', 'localhost:abc', 'localhost:', '[::1]:x']) {
      const res = await req(app, '/mcp', 'POST', { host });
      expect(res.status, host).toBe(403);
    }
  });

  test('SORA_ALLOWED_HOSTS を明示した構成では、従来どおり指定した Host だけを厳密に通す', async () => {
    const app = buildApp({ port: 8000, allowedHosts: ['localhost:8000'] });
    expect((await req(app, '/mcp', 'POST', { host: 'localhost:8000' })).status).toBe(200);
    expect((await req(app, '/mcp', 'POST', { host: 'localhost:3016' })).status).toBe(403);
    expect((await req(app, '/mcp', 'POST', { host: 'localhost' })).status).toBe(403);
  });

  test('Origin は既定でも厳密。必要なら SORA_ALLOWED_ORIGINS で追加できる', async () => {
    const strict = buildApp({ port: 8000 });
    const denied = await req(strict, '/mcp', 'POST', { host: 'localhost:3016', origin: 'http://localhost:3016' });
    expect(denied.status).toBe(403);
    const configured = buildApp({ port: 8000, allowedOrigins: ['http://localhost:3016'] });
    const allowed = await req(configured, '/mcp', 'POST', { host: 'localhost:3016', origin: 'http://localhost:3016' });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3016');
  });

  test('拒否時の 403 には、設定すべき環境変数のヒントを含める', async () => {
    const app = buildApp({ port: 8000 });
    const host = await req(app, '/mcp', 'POST', { host: 'mcp.example.com' });
    expect(host.status).toBe(403);
    const hostBody = (await host.json()) as any;
    expect(hostBody.error).toContain('untrusted host or origin');
    expect(hostBody.hint).toContain('SORA_ALLOWED_HOSTS');
    expect(hostBody.hint).toContain('mcp.example.com');

    const origin = await req(app, '/mcp', 'POST', { host: 'localhost:8000', origin: 'https://evil.example' });
    expect(origin.status).toBe(403);
    const originBody = (await origin.json()) as any;
    expect(originBody.hint).toContain('SORA_ALLOWED_ORIGINS');
    expect(JSON.stringify(originBody)).not.toContain('evil.example');
  });

  test('isLoopbackAuthority', () => {
    expect(isLoopbackAuthority('localhost:3016')).toBe(true);
    expect(isLoopbackAuthority('[::1]')).toBe(true);
    expect(isLoopbackAuthority('[::1]:1')).toBe(true);
    expect(isLoopbackAuthority('[::2]:3016')).toBe(false);
    expect(isLoopbackAuthority('127.0.0.2:3016')).toBe(false);
    expect(isLoopbackAuthority('localhost:3016/x')).toBe(false);
  });

  test('実アプリ: Quickstart と同じ Host (localhost:3016) で initialize が通り、外部ホストは拒否される', async () => {
    const init = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'quickstart-check', version: '1' } },
    };
    const call = (host: string) => soraApp.request('/mcp', {
      method: 'POST',
      headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(init),
    });
    const ok = await call('localhost:3016');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('mcp-session-id')).toBeTruthy();
    const remote = await call('mcp.example.com:3016');
    expect(remote.status).toBe(403);
  });
});
