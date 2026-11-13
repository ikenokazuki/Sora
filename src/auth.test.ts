import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createAuthMiddleware, extractAuthToken, forwardedClientAddress, isLoopbackAddress, resolvePeerLocal } from './auth.js';
import { withEnv } from './test_fixtures/env.js';

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

describe('Authorization の Bearer（RFC 7235: scheme は大文字小文字を区別しない）', () => {
  const token = (headers: Record<string, string>) => extractAuthToken(mockCtx(headers));

  test('Bearer は、大文字小文字を問わずに読む', () => {
    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) expect(token({ authorization: `${scheme} key-1` }), scheme).toBe('key-1');
  });
  test('鍵の前後の空白は除く。scheme と鍵の間は、空白かタブ', () => {
    expect(token({ authorization: 'Bearer    key-1  ' })).toBe('key-1');
    expect(token({ authorization: 'bearer\tkey-1' })).toBe('key-1');
  });
  test('X-API-Key の前後の空白も除く。空の X-API-Key は鍵なし', () => {
    expect(token({ 'x-api-key': '  key-3 ' })).toBe('key-3');
    expect(token({ 'x-api-key': '' })).toBeUndefined();
    expect(token({})).toBeUndefined();
  });
  test('Bearer のあとに鍵が無いときは、空（X-API-Key には落とさない。従来どおり）', () => {
    expect(token({ authorization: 'Bearer ', 'x-api-key': 'key-2' })).toBe('');
  });
  test('Bearer ではない scheme と、Bearer に似た語は読まず、X-API-Key を使う', () => {
    expect(token({ authorization: 'Basic abc', 'x-api-key': 'key-2' })).toBe('key-2');
    expect(token({ authorization: 'Bearerx key-1', 'x-api-key': 'key-2' })).toBe('key-2');
    expect(token({ authorization: 'Bearer', 'x-api-key': 'key-2' })).toBe('key-2');
    expect(token({ authorization: 'Basic abc' })).toBeUndefined();
  });
  test('Bearer があれば X-API-Key より優先する', () => {
    expect(token({ authorization: 'bearer key-1', 'x-api-key': 'key-2' })).toBe('key-1');
  });
  test('小文字の bearer でも、正しい鍵なら認証が通り、誤った鍵なら 401', async () => {
    const app = new Hono();
    app.use('*', createAuthMiddleware('secret-test-key'));
    app.get('/p', (c) => c.json({ ok: true }));
    await withEnv({ SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_LOOPBACK_NO_KEY: undefined }, async () => {
      expect((await app.request('/p', { headers: { Authorization: 'bearer secret-test-key' } })).status).toBe(200);
      expect((await app.request('/p', { headers: { Authorization: 'bearer wrong-key' } })).status).toBe(401);
    });
  });
});

describe('forwardedClientAddress（信頼するプロキシの段数から、右へ数える）', () => {
  test('1 段: いちばん右（そのプロキシが見た接続元）。先頭の値は利用者が書けるので、使わない', () => {
    expect(forwardedClientAddress('198.51.100.7', 1)).toBe('198.51.100.7');
    expect(forwardedClientAddress('127.0.0.1, 198.51.100.7', 1)).toBe('198.51.100.7');
    expect(forwardedClientAddress('127.0.0.1,10.9.9.9 ,198.51.100.7', 1)).toBe('198.51.100.7');
  });
  test('2 段: 右から 2 番目（右端は、手前のプロキシ）', () => {
    expect(forwardedClientAddress('127.0.0.1, 198.51.100.7, 10.1.1.1', 2)).toBe('198.51.100.7');
    expect(forwardedClientAddress('198.51.100.7, 10.1.1.1', 2)).toBe('198.51.100.7');
  });
  test('段数に足りない値は、信じない（プロキシを通っていない）', () => {
    expect(forwardedClientAddress('198.51.100.7', 2)).toBeUndefined();
    expect(forwardedClientAddress('', 1)).toBeUndefined();
  });
  test('IP アドレスでない値は、信じない（名前・ポートつき・括弧つき・空・不正な形）', () => {
    for (const bad of ['localhost', '127.0.0.1:8080', 'unknown', '_hidden', '[::1]', '127.0.0.1,', '127.1', '0x7f.1', '0177.0.0.1', '127.00.0.1', '2130706433', '999.1.1.1', '127.0.0.1 evil', 'fe80::1%eth0']) {
      expect(forwardedClientAddress(bad, 1), bad).toBeUndefined();
    }
  });
  test('IPv6 も読む', () => {
    expect(forwardedClientAddress('2001:db8::1', 1)).toBe('2001:db8::1');
    expect(forwardedClientAddress('::1', 1)).toBe('::1');
    expect(forwardedClientAddress('::ffff:127.0.0.1', 1)).toBe('::ffff:127.0.0.1');
  });
});

describe('X-Forwarded-For（SORA_AUTH_TRUST_PROXY と SORA_AUTH_PROXY_HOPS）', () => {
  /** peer は、ソケットの相手（既定は外部のプロキシ。同じホストのプロキシなら 127.0.0.1） */
  const via = (forwardedFor: string | undefined, peer = '10.0.0.2') =>
    resolvePeerLocal(mockCtx(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }, { remoteAddr: peer }));
  const trusted = (hops: string | undefined) => ({ SORA_AUTH_TRUST_PROXY: 'true', SORA_AUTH_PROXY_HOPS: hops });

  test('1 段（既定）: 利用者が書いた先頭の 127.0.0.1 は信じない', async () => {
    await withEnv(trusted(undefined), () => {
      expect(via('127.0.0.1, 198.51.100.7')).toBe(false);
      expect(via('198.51.100.7')).toBe(false);
      expect(via('127.0.0.1')).toBe(true); // プロキシが見た接続元がループバック
      expect(via('203.0.113.9, ::1')).toBe(true);
    });
  });
  test('2 段: 右から 2 番目で決める', async () => {
    await withEnv(trusted('2'), () => {
      expect(via('203.0.113.9, 127.0.0.1, 10.1.1.1')).toBe(true);
      expect(via('127.0.0.1, 203.0.113.9, 10.1.1.1')).toBe(false);
      expect(via('127.0.0.1, 10.1.1.1')).toBe(true);
    });
  });
  test('段数に足りない X-Forwarded-For は、信じない（先頭にも、ソケットの相手にも落とさない）', async () => {
    await withEnv(trusted('2'), () => {
      expect(via('127.0.0.1')).toBe(false);
      // 同じホストのプロキシ（ソケットの相手が 127.0.0.1）でも、短い X-Forwarded-For が「ローカル」で素通りしない
      expect(via('203.0.113.9', '127.0.0.1')).toBe(false);
      expect(via('127.0.0.1', '127.0.0.1')).toBe(false);
    });
    await withEnv(trusted(undefined), () => {
      // 1 段でも、右端が IP アドレスでない（空・名前）なら、ソケットの相手が 127.0.0.1 でも、ローカルではない
      for (const bad of ['203.0.113.9,', 'localhost', 'unknown']) expect(via(bad, '127.0.0.1'), bad).toBe(false);
    });
  });
  test('X-Forwarded-For を複数の行で送ると、Headers が ", " で束ねた 1 つの列として、右から数える', async () => {
    const headers = new Headers();
    headers.append('X-Forwarded-For', '127.0.0.1');
    headers.append('X-Forwarded-For', '198.51.100.7');
    const ctx = (h: Headers, peer: string) => ({ req: { header: (name: string) => h.get(name) ?? undefined }, env: { remoteAddr: peer } }) as any;
    await withEnv(trusted(undefined), () => {
      expect(headers.get('x-forwarded-for')).toBe('127.0.0.1, 198.51.100.7');
      expect(resolvePeerLocal(ctx(headers, '10.0.0.2'))).toBe(false);
      const reversed = new Headers();
      reversed.append('X-Forwarded-For', '198.51.100.7');
      reversed.append('X-Forwarded-For', '127.0.0.1');
      expect(resolvePeerLocal(ctx(reversed, '10.0.0.2'))).toBe(true);
    });
  });
  test('IP アドレスでない値は、ループバックとみなさない', async () => {
    await withEnv(trusted(undefined), () => {
      for (const bad of ['localhost', '127.0.0.1:8080', 'unknown', '127.1']) expect(via(bad), bad).toBe(false);
    });
  });
  test('X-Forwarded-For が無いときは、接続元（ソケットの相手）で決める', async () => {
    await withEnv(trusted(undefined), () => {
      expect(via(undefined)).toBe(false); // 10.0.0.2
      expect(resolvePeerLocal(mockCtx({}, { remoteAddr: '127.0.0.1' }))).toBe(true);
    });
  });
  test('SORA_AUTH_TRUST_PROXY が無ければ、X-Forwarded-For が付いた要求は、直接の接続ではない（段数は効かない）', async () => {
    await withEnv({ SORA_AUTH_TRUST_PROXY: undefined, SORA_AUTH_PROXY_HOPS: '1' }, () => {
      expect(via('127.0.0.1')).toBe(false);
      expect(resolvePeerLocal(mockCtx({ 'x-real-ip': '127.0.0.1' }, { remoteAddr: '127.0.0.1' }))).toBe(false);
    });
  });
  test('不正な段数は既定（1）に読む（起動の検査が止める）', async () => {
    for (const raw of ['0', 'abc', '-1', '1.5', '11']) {
      await withEnv(trusted(raw), () => {
        expect(via('127.0.0.1, 198.51.100.7'), raw).toBe(false);
        expect(via('198.51.100.7, 127.0.0.1'), raw).toBe(true);
      });
    }
  });

  test('ミドルウェア: 利用者が X-Forwarded-For: 127.0.0.1 を付けても、鍵なしの通過（SORA_AUTH_LOOPBACK_NO_KEY）にならない', async () => {
    const app = new Hono();
    app.use('*', createAuthMiddleware('secret-test-key'));
    app.get('/p', (c) => c.json({ mode: c.get('tenant')?.authMode }));
    const request = (forwardedFor: string) =>
      app.fetch(new Request('http://localhost/p', { headers: { 'X-Forwarded-For': forwardedFor } }), { remoteAddr: '10.0.0.2' });
    await withEnv({ ...trusted(undefined), SORA_AUTH_LOOPBACK_NO_KEY: 'true', SORA_ALLOW_ANONYMOUS: undefined }, async () => {
      expect((await request('127.0.0.1, 198.51.100.7')).status).toBe(401);
      expect((await request('198.51.100.7')).status).toBe(401);
      const local = await request('127.0.0.1');
      expect(local.status).toBe(200);
      expect(((await local.json()) as { mode: string }).mode).toBe('internal');
    });
  });
});
