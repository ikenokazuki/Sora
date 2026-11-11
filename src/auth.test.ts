import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createAuthMiddleware, isLoopbackAddress, resolvePeerLocal } from './auth.js';

/** 環境変数を書き換えて fn を回し、元に戻す（undefined は消す）。 */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const set = (entries: [string, string | undefined][]) => {
    for (const [k, v] of entries) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const saved = Object.keys(vars).map((k): [string, string | undefined] => [k, process.env[k]]);
  set(Object.entries(vars));
  try {
    return await fn();
  } finally {
    set(saved);
  }
}

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
  test('non-loopback peer is rejected even with SORA_AUTH_LOOPBACK_NO_KEY', async () => {
    const prev = process.env.SORA_AUTH_LOOPBACK_NO_KEY;
    process.env.SORA_AUTH_LOOPBACK_NO_KEY = 'true';
    try {
      const res = await build().fetch(new Request('http://localhost/protected'), { remoteAddr: '203.0.113.5' });
      expect(res.status).toBe(401);
    } finally {
      if (prev !== undefined) process.env.SORA_AUTH_LOOPBACK_NO_KEY = prev;
      else delete process.env.SORA_AUTH_LOOPBACK_NO_KEY;
    }
  });
  test('loopback peer bypass sets internal tenant', async () => {
    const prev = process.env.SORA_AUTH_LOOPBACK_NO_KEY;
    process.env.SORA_AUTH_LOOPBACK_NO_KEY = 'true';
    try {
      const res = await build().fetch(new Request('http://localhost/protected'), { remoteAddr: '127.0.0.1' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.tenant.authMode).toBe('internal');
    } finally {
      if (prev !== undefined) process.env.SORA_AUTH_LOOPBACK_NO_KEY = prev;
      else delete process.env.SORA_AUTH_LOOPBACK_NO_KEY;
    }
  });
  test('SORA_ALLOW_ANONYMOUS も v5 の真偽値の読み方（yes・1 も真、知らない値は偽）', async () => {
    await withEnv({ SORA_ALLOW_ANONYMOUS: 'yes' }, async () => expect((await build().request('/protected')).status).toBe(200));
    await withEnv({ SORA_ALLOW_ANONYMOUS: '1' }, async () => expect((await build().request('/protected')).status).toBe(200));
    await withEnv({ SORA_ALLOW_ANONYMOUS: 'nope' }, async () => expect((await build().request('/protected')).status).toBe(401));
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

describe('v5 の環境変数の名前（認証）', () => {
  // 旧名を読まないことは env_names.test.ts で確かめる（旧名を書くのは、そのファイルと config.test.ts だけ）
  const app = (key?: string) => {
    const a = new Hono();
    a.use('*', createAuthMiddleware(key));
    a.get('/p', (c) => c.json({ ok: true }));
    return a;
  };
  const noKeys = { SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_LOOPBACK_NO_KEY: undefined };

  test('SORA_API_KEY を読む（キーが無いか誤りなら 401、正しいキーなら通す）', async () => {
    await withEnv({ ...noKeys, SORA_API_KEY: 'env-key-1' }, async () => {
      const missing = await app().request('/p');
      expect(missing.status).toBe(401);
      expect(((await missing.json()) as any).message).toBe('Please provide a valid API key via Authorization: Bearer <key> or X-API-Key header.');
      expect((await app().request('/p', { headers: { Authorization: 'Bearer env-key-1' } })).status).toBe(200);
      expect((await app().request('/p', { headers: { 'X-API-Key': 'wrong' } })).status).toBe(401);
    });
  });

  test('キー無しの警告は SORA_API_KEY を案内する', async () => {
    const { warnOnceNoKey } = await import(`./auth.js?no-key-warning=${Date.now()}`);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnOnceNoKey();
      expect(warn.mock.calls.map((c) => c.map(String).join(' '))).toEqual([
        '[Sora] No API key configured: anonymous access is open (set SORA_API_KEY, or SORA_ALLOW_ANONYMOUS=true to silence).',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test('SORA_AUTH_LOOPBACK_NO_KEY を読む（1 も真）', async () => {
    const local = () => app('secret-test-key').fetch(new Request('http://localhost/p'), { remoteAddr: '127.0.0.1' });
    await withEnv({ ...noKeys, SORA_AUTH_LOOPBACK_NO_KEY: '1' }, async () => expect((await local()).status).toBe(200));
    await withEnv(noKeys, async () => expect((await local()).status).toBe(401));
  });

  test('SORA_AUTH_TRUST_PROXY を読む', async () => {
    const viaProxy = () => resolvePeerLocal(mockCtx({ 'x-forwarded-for': '127.0.0.1' }, { remoteAddr: '203.0.113.5' }));
    await withEnv({ SORA_AUTH_TRUST_PROXY: 'true' }, () => expect(viaProxy()).toBe(true));
    await withEnv({ SORA_AUTH_TRUST_PROXY: undefined }, () => expect(viaProxy()).toBe(false));
  });

  test('SORA_AUTH_DAILY_LIMIT: 1 以上の整数が上限。不正な値・0 は無制限', async () => {
    const run = (raw: string | undefined) => withEnv({ SORA_AUTH_DAILY_LIMIT: raw }, async () => {
      // 回数は API キーと日で数えるので、呼ぶたびに新しいキーにする
      const key = `daily-limit-${randomUUID()}`;
      const statuses: number[] = [];
      let limit: string | null = null;
      for (let i = 0; i < 3; i++) {
        const res = await app(key).request('/p', { headers: { 'X-API-Key': key } });
        statuses.push(res.status);
        limit = res.headers.get('X-RateLimit-Limit');
      }
      return { statuses, limit };
    });
    expect(await run('2')).toEqual({ statuses: [200, 200, 429], limit: '2' });
    expect(await run(' 2 ')).toEqual({ statuses: [200, 200, 429], limit: '2' });
    for (const raw of [undefined, '0', 'abc', '2abc', '-1', '1.5', '']) {
      expect(await run(raw), String(raw)).toEqual({ statuses: [200, 200, 200], limit: null });
    }
  });
});
