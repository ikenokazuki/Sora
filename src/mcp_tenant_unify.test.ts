import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeHttpSession } from './http_fetcher.js';
import { app, mcpSessionManager } from './index.js';
import { McpSessionManager } from './mcp.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * MCP の tenant は、認証のミドルウェアが決めたものだけを使う（設計書 4。穴 15）。
 * 以前は MCP が、生の Authorization / X-API-Key から別に tenant を作り、認証が通った利用者が、任意の文字列で別の tenant になれた。
 */

type Headers_ = Record<string, string>;
const KEY = 'unify-test-key-0123456789abcdef';
const rpcHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2024-11-05',
};
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tenant-unify-test', version: '1' } } };
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

/** 本物のアプリ（認証のミドルウェア → MCP のルート）に送る。remoteAddr は、ソケットの相手（無ければ不明） */
const send = (headers: Record<string, string>, body: object, sessionId?: string, remoteAddr?: string) =>
  app.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...rpcHeaders, ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
      body: JSON.stringify(body),
    }),
    { remoteAddr: remoteAddr ?? null },
  );

async function open(headers: Record<string, string>, remoteAddr?: string): Promise<string> {
  const res = await send(headers, initialize, undefined, remoteAddr);
  expect(res.status).toBe(200);
  const sessionId = res.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

const keyed = (extra: Record<string, string | undefined> = {}) => ({ SORA_API_KEY: KEY, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_LOOPBACK_NO_KEY: undefined, ...extra });

afterEach(() => mcpSessionManager.clearAllSessions());

describe('MCP の tenant は、認証が決めたもの', () => {
  test('同じ鍵は、どの書き方でも同じ tenant（X-API-Key・Bearer の大文字小文字）', async () => {
    await withEnv(keyed(), async () => {
      const sessionId = await open({ 'X-API-Key': KEY });
      const sameTenant: Headers_[] = [
        { 'X-API-Key': KEY },
        { Authorization: `Bearer ${KEY}` },
        { Authorization: `bearer ${KEY}` },
        { Authorization: `BEARER ${KEY}` },
        // Authorization に Bearer があれば、鍵はそれだけを読む（X-API-Key は見ない）
        { Authorization: `bearer ${KEY}`, 'X-API-Key': 'not-read-when-bearer-is-present' },
      ];
      for (const headers of sameTenant) {
        expect((await send(headers, listTools, sessionId)).status, JSON.stringify(headers)).toBe(200);
      }
    });
  });

  test('誤った bearer と正しい X-API-Key を併せても、通らない（以前は、認証が X-API-Key で通り、MCP は bearer の任意の文字列で別の tenant になれた）', async () => {
    await withEnv(keyed(), async () => {
      const rejected: Headers_[] = [
        { Authorization: 'bearer attacker-chosen-a', 'X-API-Key': KEY },
        { Authorization: 'Bearer attacker-chosen-a', 'X-API-Key': KEY },
        { Authorization: 'bearer wrong-key' },
        { 'X-API-Key': 'wrong-key' },
        {},
      ];
      for (const headers of rejected) {
        expect((await send(headers, initialize)).status, JSON.stringify(headers)).toBe(401);
      }
    });
  });

  test('鍵を持つ利用者のセッションを、匿名の利用者は使えない（SORA_ALLOW_ANONYMOUS=true でも、別の tenant）', async () => {
    await withEnv(keyed({ SORA_ALLOW_ANONYMOUS: 'true' }), async () => {
      const keyedSession = await open({ 'X-API-Key': KEY });
      const anonymousSession = await open({ Authorization: 'bearer junk-token' });
      const anonymousHeaders: Headers_[] = [{}, { Authorization: 'bearer junk-token' }, { Authorization: 'bearer another-junk' }];
      for (const headers of anonymousHeaders) {
        const res = await send(headers, listTools, keyedSession);
        expect(res.status, JSON.stringify(headers)).toBe(404);
        expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Session not found');
      }
      // 匿名どうしは、どれも同じ scope（legacy）。任意の bearer で、匿名の中の別の tenant にはならない
      for (const headers of [{}, { Authorization: 'bearer another-junk' }] as Headers_[]) {
        expect((await send(headers, listTools, anonymousSession)).status, JSON.stringify(headers)).toBe(200);
      }
      // 逆に、匿名のセッションを、鍵を持つ利用者は使えない
      expect((await send({ 'X-API-Key': KEY }, listTools, anonymousSession)).status).toBe(404);
    });
  });

  test('鍵を設定していないとき: 任意の Bearer を付けても、付けなくても、同じ tenant（REST と同じ legacy）', async () => {
    await withEnv({ SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_LOOPBACK_NO_KEY: undefined }, async () => {
      const sessionId = await open({});
      for (const headers of [{}, { Authorization: 'Bearer some-token' }, { 'X-API-Key': 'some-key' }] as Headers_[]) {
        expect((await send(headers, listTools, sessionId)).status, JSON.stringify(headers)).toBe(200);
      }
    });
  });

  test('鍵なしのループバック通過（SORA_AUTH_LOOPBACK_NO_KEY）は、REST と同じ internal の scope（匿名の legacy とも、鍵を持つ利用者とも別）', async () => {
    await withEnv(keyed({ SORA_AUTH_LOOPBACK_NO_KEY: 'true', SORA_ALLOW_ANONYMOUS: 'true' }), async () => {
      const local = await open({}, '127.0.0.1');
      const remote = await open({}, '203.0.113.5');
      const keyedSession = await open({ 'X-API-Key': KEY }, '203.0.113.5');
      expect((await send({}, listTools, local, '127.0.0.1')).status).toBe(200);
      expect((await send({}, listTools, remote, '203.0.113.5')).status).toBe(200);
      expect((await send({}, listTools, local, '203.0.113.5')).status).toBe(404);
      expect((await send({}, listTools, remote, '127.0.0.1')).status).toBe(404);
      expect((await send({ 'X-API-Key': KEY }, listTools, local, '203.0.113.5')).status).toBe(404);
      expect((await send({}, listTools, keyedSession, '127.0.0.1')).status).toBe(404);
    });
  });
});

describe('McpSessionManager は、渡された tenant でセッションを分ける', () => {
  const call = (manager: McpSessionManager, tenantId: string | undefined, body: object, sessionId?: string) =>
    manager.handleRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        // 生のヘッダーは、tenant に使わない（誰かの鍵らしいヘッダーを付けても、渡された tenant だけが効く）
        headers: { ...rpcHeaders, Authorization: 'Bearer ignored-by-the-manager', 'X-API-Key': 'ignored-too', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
        body: JSON.stringify(body),
      }),
      { tenantId },
    );

  test('同じ tenant は続けられ、別の tenant と tenant なし（legacy）は 404', async () => {
    const manager = new McpSessionManager();
    try {
      const created = await call(manager, 'name:alice', initialize);
      expect(created.status).toBe(200);
      const sessionId = created.headers.get('mcp-session-id')!;
      expect((await call(manager, 'name:alice', listTools, sessionId)).status).toBe(200);
      expect((await call(manager, 'name:bob', listTools, sessionId)).status).toBe(404);
      expect((await call(manager, undefined, listTools, sessionId)).status).toBe(404);
      expect((await call(manager, 'legacy', listTools, sessionId)).status).toBe(404);
    } finally {
      manager.clearAllSessions();
    }
  });

  test('tenant を渡さなければ legacy（ヘッダーから作らない）', async () => {
    const manager = new McpSessionManager();
    try {
      const created = await call(manager, undefined, initialize);
      const sessionId = created.headers.get('mcp-session-id')!;
      expect((await call(manager, 'legacy', listTools, sessionId)).status).toBe(200);
      expect((await call(manager, 'name:alice', listTools, sessionId)).status).toBe(404);
    } finally {
      manager.clearAllSessions();
    }
  });
});

describe('MCP のツールは、セッションの tenant でサイトごとの Cookie を分ける', () => {
  // MCP の scrape には noCache が無く、公開ページの結果は tenant をまたいで共有されるので、呼ぶたびに別の URL にする（Cookie の jar は、ホストごと）
  let calls = 0;
  const scrapeCall = (base: string) => ({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scrape', arguments: { url: `${base}/jar/${++calls}`, mode: 'fast' } } });

  test('同じ tenant は Cookie を引き継ぎ、別の tenant には見せない（状態あり・状態なしの両方）', async () => {
    const seen: Array<string | undefined> = [];
    let hits = 0;
    const server = createServer((request, response) => {
      hits++;
      seen.push(request.headers.cookie);
      response.writeHead(200, { 'content-type': 'text/html', 'Set-Cookie': `sess=${hits}; Path=/` });
      response.end('<html><head><title>t</title></head><body><p>hello world content here and more text for the extractor</p></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const manager = new McpSessionManager();
    const call = async (tenantId: string, body: object, sessionId?: string) => {
      const response = await manager.handleRequest(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { ...rpcHeaders, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
          body: JSON.stringify(body),
        }),
        { tenantId },
      );
      expect(response.status).toBe(200);
      return response;
    };
    const open = async (tenantId: string) => {
      const created = await call(tenantId, initialize);
      const sessionId = created.headers.get('mcp-session-id')!;
      await call(tenantId, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId).catch(() => {});
      return sessionId;
    };
    try {
      await withEnv({ SORA_FETCH_ALLOW_PRIVATE_NETWORK: 'true' }, async () => {
        const alice = await open('name:alice');
        const bob = await open('name:bob');
        // 結果が返ったこと（ツールの失敗・JSON-RPC のエラーを見逃さない）を確かめて、サーバーが見た Cookie を比べる
        const scraped = async (response: Response) => {
          const body = (await response.json()) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: unknown };
          expect(body.error).toBeUndefined();
          expect(body.result?.isError).toBeFalsy();
          expect(body.result?.content?.[0]?.text).toContain('hello world content');
        };
        await scraped(await call('name:alice', scrapeCall(url), alice)); // 1 回目: Cookie なし
        await scraped(await call('name:alice', scrapeCall(url), alice)); // 2 回目: alice の Cookie
        await scraped(await call('name:bob', scrapeCall(url), bob)); // bob: alice の Cookie は見えない
        await scraped(await call('name:alice', scrapeCall(url))); // 状態なしの呼び出しも、alice の Cookie
        await scraped(await call('name:carol', scrapeCall(url))); // 状態なしの別の tenant
      });
      expect(seen).toHaveLength(5);
      expect(seen[0]).toBeUndefined();
      expect(seen[1]).toBe('sess=1');
      expect(seen[2]).toBeUndefined();
      expect(seen[3]).toBe('sess=2'); // alice の jar は 2 回目の応答で更新されている
      expect(seen[4]).toBeUndefined();
    } finally {
      server.close();
      manager.clearAllSessions();
      for (const tenantId of ['name:alice', 'name:bob', 'name:carol']) await closeHttpSession('127.0.0.1', tenantId).catch(() => {});
    }
  });
});
