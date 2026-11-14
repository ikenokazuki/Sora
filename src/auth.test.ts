import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createAuthMiddleware, extractAuthToken } from './auth.js';
import { secondsUntilNextUtcDay } from './errors.js';
import { removedSettings, withEnv } from './test_fixtures/env.js';

function mockCtx(headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { req: { header: (n: string) => lower[n.toLowerCase()] } } as any;
}

describe('auth middleware tenant', () => {
  const build = () => {
    const app = new Hono();
    app.use('*', createAuthMiddleware('secret-test-key'));
    app.get('/protected', (c) => c.json({ status: 'authenticated', tenant: (c as any).get('tenant') }));
    return app;
  };
  test('鍵を設定していれば、ループバックからでも、X-Forwarded-For が無くても、鍵が要る（鍵なしの通過は、v5 で廃止した。旧い設定が残っていても効かない）', async () => {
    await withEnv({ SORA_ALLOW_ANONYMOUS: undefined, ...removedSettings() }, async () => {
      for (const remoteAddr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', null, undefined]) {
        const res = await build().fetch(new Request('http://localhost/protected'), { remoteAddr } as never);
        expect(res.status, String(remoteAddr)).toBe(401);
      }
      const forwarded = await build().fetch(new Request('http://localhost/protected', { headers: { 'X-Forwarded-For': '127.0.0.1' } }), { remoteAddr: '127.0.0.1' } as never);
      expect(forwarded.status).toBe(401);
      // 鍵があれば通り、tenant は鍵のハッシュ（ループバックでも、特別な tenant にならない）
      const ok = await build().fetch(new Request('http://localhost/protected', { headers: { 'X-API-Key': 'secret-test-key' } }), { remoteAddr: '127.0.0.1' } as never);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { tenant: { authMode: string } }).tenant.authMode).toBe('api_key');
    });
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
  const noKeys = { SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined };

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
    // 429 には Retry-After（次の UTC の日の始まりまでの秒）が付く（一括・crawl の件数で断った 429 と同じ）
    await withEnv({ SORA_AUTH_DAILY_LIMIT: '1' }, async () => {
      const key = `daily-retry-${randomUUID()}`;
      await app(key).request('/p', { headers: { 'X-API-Key': key } });
      const res = await app(key).request('/p', { headers: { 'X-API-Key': key } });
      expect(res.status).toBe(429);
      const retryAfter = Number(res.headers.get('Retry-After'));
      expect(Math.abs(retryAfter - secondsUntilNextUtcDay())).toBeLessThanOrEqual(2);
    });
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
    await withEnv({ SORA_ALLOW_ANONYMOUS: undefined }, async () => {
      expect((await app.request('/p', { headers: { Authorization: 'bearer secret-test-key' } })).status).toBe(200);
      expect((await app.request('/p', { headers: { Authorization: 'bearer wrong-key' } })).status).toBe(401);
    });
  });
});
