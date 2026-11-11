import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createAuthMiddleware, resolvePeerLocal } from './auth.js';
import { app } from './index.js';
import { createMcpServer, sanitizeMcpResponse, toolCatalogOf } from './mcp.js';
import { isModuleActive } from './mcp/registry.js';
import { resolveMcpOriginConfig, resolveMcpPort } from './security/mcp_origin.js';
import { sendAdminAlert } from './services/health.js';
import { withEnv } from './test_fixtures/env.js';

// v5.0.0 の環境変数の名前（全体・認証・ログ・通知・MCP）。新しい名前で効き、旧名は別名として読まない（旧名を知らせるのは起動時の検査）。
// 旧名を書くテストは、このファイルと config.test.ts だけにする（ほかのテストは新しい名前だけを使う）。

describe('SORA_MODULES', () => {
  const modules = (value: string | undefined, old?: string) => withEnv({ SORA_MODULES: value, ENABLED_MODULES: old }, () => ({
    web: isModuleActive('web'),
    trade: isModuleActive('trade'),
    lyrics: isModuleActive('lyrics'),
    shazam: isModuleActive('shazam'),
  }));

  test('新しい名前で絞り、旧名 ENABLED_MODULES だけでは絞らない', async () => {
    expect(await modules('web')).toEqual({ web: true, trade: false, lyrics: false, shazam: false });
    expect(await modules(undefined, 'web')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
    expect(await modules(undefined, 'all,lyrics')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
  });

  test('列の読み方: 大文字小文字を問わず、知らない名前は除き、all と * は値のどこにあっても全部', async () => {
    expect(await modules('Web,weeb')).toEqual({ web: true, trade: false, lyrics: false, shazam: false });
    expect(await modules('web,*')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
    expect(await modules('lyrics,ALL')).toEqual({ web: true, trade: true, lyrics: true, shazam: false });
    // 正しい名前が 1 つも無いのは未設定と同じ（起動時の検査が止める）
    expect(await modules('weeb')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
    expect(await modules(' , ')).toEqual({ web: true, trade: true, lyrics: false, shazam: false });
  });

  test('引数で渡したモジュールは環境変数より優先する', async () => {
    await withEnv({ SORA_MODULES: 'web' }, () => expect(isModuleActive('trade', ['all'])).toBe(true));
  });
});

describe('SORA_MCP_DEFER_TOOLS', () => {
  // 遅延した（search_tools で有効にするまで無効の）ツールがあるか。ツールの名前に頼らず、モジュールも全部にして数える
  const deferred = (vars: Record<string, string | undefined>, deferTools?: boolean) =>
    withEnv({ SORA_MCP_DEFER_TOOLS: undefined, SORA_DEFER_TOOLS: undefined, SORA_MODULES: undefined, ...vars }, () =>
      [...toolCatalogOf(createMcpServer(deferTools === undefined ? undefined : { deferTools })).values()].some((entry) => entry.handle.enabled === false));

  test('既定は遅延。false・0・off・no（大文字小文字は問わない）で全部を最初から有効にする', async () => {
    expect(await deferred({})).toBe(true);
    for (const value of ['false', '0', 'off', 'no', 'OFF']) expect(await deferred({ SORA_MCP_DEFER_TOOLS: value }), value).toBe(false);
    for (const value of ['true', '1', 'on', 'abc']) expect(await deferred({ SORA_MCP_DEFER_TOOLS: value }), value).toBe(true);
  });

  test('旧名 SORA_DEFER_TOOLS は読まない。引数の deferTools は環境変数より優先する', async () => {
    expect(await deferred({ SORA_DEFER_TOOLS: 'false' })).toBe(true);
    expect(await deferred({ SORA_MCP_DEFER_TOOLS: 'off' }, true)).toBe(true);
  });
});

describe('SORA_MCP_OUTPUT_SCHEMA', () => {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 't', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }] } });
  const listed = (vars: Record<string, string | undefined>) => withEnv({ SORA_MCP_OUTPUT_SCHEMA: undefined, SORA_TOOL_OUTPUT_SCHEMA: undefined, ...vars }, async () =>
    (await (await sanitizeMcpResponse(new Response(payload, { headers: { 'content-type': 'application/json' } }))).text()).includes('outputSchema'));

  test('新しい名前（1 も真）で outputSchema を残し、旧名 SORA_TOOL_OUTPUT_SCHEMA は読まない', async () => {
    expect(await listed({})).toBe(false);
    expect(await listed({ SORA_MCP_OUTPUT_SCHEMA: '1' })).toBe(true);
    expect(await listed({ SORA_TOOL_OUTPUT_SCHEMA: 'true' })).toBe(false);
  });
});

describe('SORA_LOG_FORMAT', () => {
  const logged = (vars: Record<string, string | undefined>) => withEnv({ SORA_LOG_FORMAT: undefined, LOG_FORMAT: undefined, ...vars }, async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await app.request('/env-names-log-probe');
      return log.mock.calls.some(([line]) => typeof line === 'string' && line.includes('"path":"/env-names-log-probe"'));
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test('json（大文字小文字は問わない）で要求のログを JSON で出し、旧名 LOG_FORMAT は読まない', async () => {
    expect(await logged({})).toBe(false);
    expect(await logged({ SORA_LOG_FORMAT: 'JSON' })).toBe(true);
    expect(await logged({ LOG_FORMAT: 'json' })).toBe(false);
  });
});

describe('PORT・SORA_ALLOWED_HOSTS・SORA_ALLOWED_ORIGINS（Origin の中間層）', () => {
  test('PORT は 1〜65535 の整数。不正な値は既定の 8000、引数のポートが優先', async () => {
    await withEnv({ PORT: '3016' }, () => expect(resolveMcpPort()).toBe(3016));
    for (const raw of ['abc', '3016abc', '0', '70000']) await withEnv({ PORT: raw }, () => expect(resolveMcpPort(), raw).toBe(8000));
    await withEnv({ PORT: '3016' }, () => expect(resolveMcpPort(1234)).toBe(1234));
  });

  test('環境変数の列は、正しい要素を正規化して残し、不正な要素は例外にせず除く（起動時の検査が止める）', async () => {
    await withEnv({ SORA_ALLOWED_HOSTS: ' Sora.Example.com:8443 , bad/entry ', SORA_ALLOWED_ORIGINS: 'https://Sora.Example.com:8443,javascript:x' }, () => {
      const config = resolveMcpOriginConfig();
      expect([...config.allowedHosts]).toEqual(['sora.example.com:8443']);
      expect([...config.allowedOrigins]).toEqual(['https://sora.example.com:8443']);
      expect(config.primaryOrigin).toBe('https://sora.example.com:8443');
      expect(config.allowLoopbackAnyPort).toBe(false);
    });
  });

  test('引数で渡した不正な要素は、これまでどおり例外にする', () => {
    expect(() => resolveMcpOriginConfig({ allowedHosts: ['bad/entry'] })).toThrow('Invalid SORA_ALLOWED_HOSTS entry: bad/entry');
  });
});

describe('認証の旧名は読まない（新しい名前の動きは auth.test.ts）', () => {
  const app = (key?: string) => {
    const a = new Hono();
    a.use('*', createAuthMiddleware(key));
    a.get('/p', (c) => c.json({ ok: true }));
    return a;
  };
  const clean = { SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_LOOPBACK_NO_KEY: undefined, SORA_AUTH_TRUST_PROXY: undefined, SORA_AUTH_DAILY_LIMIT: undefined };

  test('WEB_FETCHER_API_KEY・API_KEY だけでは認証を掛けない（Fail-Open。起動の拒否は起動時の検査）', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const old of ['WEB_FETCHER_API_KEY', 'API_KEY']) {
        await withEnv({ ...clean, [old]: 'old-key' }, async () => expect((await app().request('/p')).status, old).toBe(200));
      }
    } finally {
      warn.mockRestore();
    }
  });

  test('ALLOW_LOCAL_NO_AUTH・TRUST_PROXY・DAILY_REQUEST_LIMIT は効かない', async () => {
    await withEnv({ ...clean, ALLOW_LOCAL_NO_AUTH: 'true' }, async () => {
      expect((await app('secret-test-key').fetch(new Request('http://localhost/p'), { remoteAddr: '127.0.0.1' })).status).toBe(401);
    });
    await withEnv({ ...clean, TRUST_PROXY: 'true' }, () => {
      expect(resolvePeerLocal({ req: { header: (n: string) => (n === 'x-forwarded-for' ? '127.0.0.1' : undefined) }, env: { remoteAddr: '203.0.113.5' } })).toBe(false);
    });
    await withEnv({ ...clean, DAILY_REQUEST_LIMIT: '1' }, async () => {
      const key = `old-limit-${randomUUID()}`;
      for (let i = 0; i < 3; i++) {
        const res = await app(key).request('/p', { headers: { 'X-API-Key': key } });
        expect(res.status).toBe(200);
        expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
      }
    });
  });
});

describe('通知の旧名は読まない（新しい名前の動きは index.test.ts の SSRF 対策）', () => {
  test('ADMIN_ALERT_WEBHOOK_URL だけでは送らない', async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withEnv({ SORA_ALERT_WEBHOOK_URL: undefined, ADMIN_ALERT_WEBHOOK_URL: 'https://93.184.216.34/hooks/alert' }, async () => {
        sendAdminAlert('test', { a: 1 });
        await Bun.sleep(50);
      });
      expect(fetched).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      globalThis.fetch = realFetch;
    }
  });
});
