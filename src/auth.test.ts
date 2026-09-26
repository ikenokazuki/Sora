import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createAuthMiddleware, isLoopbackAddress, resolvePeerLocal } from './auth.js';

function mockCtx(headers: Record<string, string> = {}, env: any = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { req: { header: (n: string) => lower[n.toLowerCase()] }, env } as any;
}

describe('auth peer check (P1-SEC-04)', () => {
  test('loopback detection', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.53')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('[::1]')).toBe(true);
    expect(isLoopbackAddress('203.0.113.5')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isLoopbackAddress('127.999.1.1')).toBe(false);
  });
  test('legacy fallback when peer unknown', () => {
    expect(resolvePeerLocal(mockCtx())).toBe(true);
    expect(resolvePeerLocal(mockCtx({ 'x-forwarded-for': '1.2.3.4' }))).toBe(false);
  });
  test('socket peer decides when known', () => {
    expect(resolvePeerLocal(mockCtx({}, { remoteAddr: '127.0.0.1' }))).toBe(true);
    expect(resolvePeerLocal(mockCtx({}, { remoteAddr: '203.0.113.5' }))).toBe(false);
    expect(resolvePeerLocal(mockCtx({}, { remoteAddr: null }))).toBe(true);
  });
});

describe('auth middleware peer + tenant', () => {
  const build = () => {
    const app = new Hono();
    app.use('*', createAuthMiddleware('secret-test-key'));
    app.get('/protected', (c) => c.json({ status: 'authenticated', tenant: (c as any).get('tenant') }));
    return app;
  };
  test('non-loopback peer is rejected even with ALLOW_LOCAL_NO_AUTH', async () => {
    const prev = process.env.ALLOW_LOCAL_NO_AUTH;
    process.env.ALLOW_LOCAL_NO_AUTH = 'true';
    try {
      const res = await build().fetch(new Request('http://localhost/protected'), { remoteAddr: '203.0.113.5' });
      expect(res.status).toBe(401);
    } finally {
      if (prev !== undefined) process.env.ALLOW_LOCAL_NO_AUTH = prev;
      else delete process.env.ALLOW_LOCAL_NO_AUTH;
    }
  });
  test('loopback peer bypass sets internal tenant', async () => {
    const prev = process.env.ALLOW_LOCAL_NO_AUTH;
    process.env.ALLOW_LOCAL_NO_AUTH = 'true';
    try {
      const res = await build().fetch(new Request('http://localhost/protected'), { remoteAddr: '127.0.0.1' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.tenant.authMode).toBe('internal');
    } finally {
      if (prev !== undefined) process.env.ALLOW_LOCAL_NO_AUTH = prev;
      else delete process.env.ALLOW_LOCAL_NO_AUTH;
    }
  });
  test('api key sets hashed tenant, SORA_ALLOW_ANONYMOUS opens gate', async () => {
    const prevAnon = process.env.SORA_ALLOW_ANONYMOUS;
    const app = build();
    const ok = await app.fetch(new Request('http://localhost/protected', { headers: { Authorization: 'Bearer secret-test-key' } }));
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(body.tenant.authMode).toBe('api_key');
    expect(body.tenant.tenantId).not.toContain('secret-test-key');
    process.env.SORA_ALLOW_ANONYMOUS = 'true';
    try {
      const anon = await app.fetch(new Request('http://localhost/protected'));
      expect(anon.status).toBe(200);
    } finally {
      if (prevAnon !== undefined) process.env.SORA_ALLOW_ANONYMOUS = prevAnon;
      else delete process.env.SORA_ALLOW_ANONYMOUS;
    }
  });
});
