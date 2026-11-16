import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { callerScope, createAuthMiddleware } from './auth.js';
import { ResourceBusyError } from './errors.js';
import { createMcpServer } from './mcp.js';
import { registerStructuredTool, registerTool, type ToolCatalogEntry } from './mcp/registry.js';
import { resetApiKeyStoreCache } from './security/api_keys.js';
import { currentCaller } from './security/caller.js';
import * as geocoding from './services/geocoding.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * 「いま呼んでいる利用者」（security/caller.ts）を、REST の認証のあとと、MCP のツールの呼び出しで、認証が決めた tenant にする（設計 6。穴 25）。
 * 共有の外部資源の順番と予算が、呼び出しの引数を足さずに、利用者を区別できる。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-caller-'));
  resetApiKeyStoreCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetApiKeyStoreCache();
});

const clean = { SORA_API_KEY: undefined, SORA_ALLOW_ANONYMOUS: undefined, SORA_AUTH_DAILY_LIMIT: undefined, SORA_AUTH_KEYS_FILE: undefined };

function keyFile(keys: unknown[]): string {
  const path = join(dir, `keys-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ keys }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe('REST: 認証のあと', () => {
  const app = () => {
    const a = new Hono();
    a.use('*', createAuthMiddleware());
    a.use('*', callerScope);
    a.get('/who', async (c) => {
      const before = currentCaller();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return c.json({ before, after: currentCaller() });
    });
    a.get('/health', (c) => c.json({ caller: currentCaller() }));
    return a;
  };
  const get = async (path: string, headers: Record<string, string> = {}) => app().fetch(new Request(`http://localhost${path}`, { headers }), { remoteAddr: null });

  test('鍵ファイルの鍵: その鍵の tenant（name:<name>）。await をまたいでも同じ。鍵ごとに別', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }, { name: 'bob', key: 'bob-key-0123456789abcdefgh' }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      const [alice, bob] = await Promise.all([
        get('/who', { 'X-API-Key': 'alice-key-0123456789abcdef' }).then((r) => r.json()),
        get('/who', { 'X-API-Key': 'bob-key-0123456789abcdefgh' }).then((r) => r.json()),
      ]);
      expect(alice).toEqual({ before: 'name:alice', after: 'name:alice' });
      expect(bob).toEqual({ before: 'name:bob', after: 'name:bob' });
    });
  });

  test('単一の鍵: 鍵のハッシュの tenant（key:…）。鍵の値そのものは入らない', async () => {
    await withEnv({ ...clean, SORA_API_KEY: 'single-key-0123456789abcdef' }, async () => {
      const body = (await (await get('/who', { 'X-API-Key': 'single-key-0123456789abcdef' })).json()) as { before: string };
      expect(body.before).toMatch(/^key:[0-9a-f]{16}$/);
      expect(body.before).not.toContain('single-key');
    });
  });

  test('認証なし（鍵の設定が無い運用）は legacy。公開のパス（/health）も legacy', async () => {
    await withEnv(clean, async () => {
      expect(await (await get('/who')).json()).toEqual({ before: 'legacy', after: 'legacy' });
      expect(await (await get('/health')).json()).toEqual({ caller: 'legacy' });
    });
  });

  test('クライアントが送るヘッダー・パラメーターでは、別の利用者を名乗れない', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      const res = await get('/who?tenantId=name:bob', { 'X-API-Key': 'alice-key-0123456789abcdef', 'X-Tenant-Id': 'name:bob' });
      expect(await res.json()).toEqual({ before: 'name:alice', after: 'name:alice' });
    });
  });

  test('要求が終わると、範囲は外れる（次の要求・範囲の外は legacy）', async () => {
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }]);
    await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
      await get('/who', { 'X-API-Key': 'alice-key-0123456789abcdef' });
      expect(currentCaller()).toBe('legacy');
    });
  });
});

describe('REST: 本物のアプリ（index.ts）', () => {
  test('認証のあと、ルートの中で、鍵の tenant が見える（index.ts が callerScope を配線している）', async () => {
    const { app } = await import('./index.js');
    const path = keyFile([{ name: 'alice', key: 'alice-key-0123456789abcdef' }, { name: 'bob', key: 'bob-key-0123456789abcdefgh' }]);
    const seen: string[] = [];
    const spy = spyOn(geocoding, 'geocodeAddress').mockImplementation(async () => {
      seen.push(currentCaller());
      throw new ResourceBusyError('混み合っています', 'queue_full', 5, 'geocoding');
    });
    try {
      await withEnv({ ...clean, SORA_AUTH_KEYS_FILE: path }, async () => {
        const res = await app.request('/geo/elevation?address=x', { headers: { 'X-API-Key': 'alice-key-0123456789abcdef' } });
        expect(res.status).toBe(429);
        await app.request('/geo/elevation?address=y', { headers: { 'X-API-Key': 'bob-key-0123456789abcdefgh' } });
      });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual(['name:alice', 'name:bob']);
  });
});

describe('MCP: ツールの呼び出し', () => {
  /** セッションの tenant で、MCP のサーバーを作り、call を実行する */
  async function withServer<T>(tenantId: string | undefined, run: (client: Client, server: ReturnType<typeof createMcpServer>) => Promise<T>): Promise<T> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false, modules: ['web'], ...(tenantId ? { sessionState: { activatedTools: new Set<string>(), tenantId } } : {}) });
    const client = new Client({ name: 'caller-wiring', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await run(client, server);
    } finally {
      await client.close();
      await server.close();
    }
  }

  test('registerTool で登録したツール: ハンドラの中で、セッションの tenant が見える（await の先でも）', async () => {
    const seen: string[] = [];
    await withServer('name:alice', async (client, server) => {
      registerTool(server, new Map<string, ToolCatalogEntry>(), new Set<string>(), 'probe_plain', 'web', 'probe', { x: z.string().optional() }, async () => {
        seen.push(currentCaller());
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        seen.push(currentCaller());
        return { content: [{ type: 'text', text: 'ok' }] };
      }, { defaultEnabled: true });
      await client.callTool({ name: 'probe_plain', arguments: { x: 'name:bob' } });
    });
    expect(seen).toEqual(['name:alice', 'name:alice']);
  });

  test('registerStructuredTool で登録したツールも同じ', async () => {
    const seen: string[] = [];
    await withServer('name:alice', async (client, server) => {
      registerStructuredTool(server, new Map<string, ToolCatalogEntry>(), new Set<string>(), 'probe_structured', 'web', 'probe', { x: z.string().optional() }, z.object({ y: z.string() }), async () => {
        seen.push(currentCaller());
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { y: 'ok' } };
      }, { defaultEnabled: true });
      await client.callTool({ name: 'probe_structured', arguments: {} });
    });
    expect(seen).toEqual(['name:alice']);
  });

  test('遅延で有効にしたツールの別名（default.<名前>）も、同じ範囲の中で動く', async () => {
    const seen: string[] = [];
    await withServer('name:alice', async (client, server) => {
      registerTool(server, new Map<string, ToolCatalogEntry>(), new Set<string>(['probe_deferred']), 'probe_deferred', 'web', 'probe', {}, async () => {
        seen.push(currentCaller());
        return { content: [{ type: 'text', text: 'ok' }] };
      }, { defaultEnabled: false });
      await client.callTool({ name: 'probe_deferred', arguments: {} });
      await client.callTool({ name: 'default.probe_deferred', arguments: {} });
    });
    expect(seen).toEqual(['name:alice', 'name:alice']);
  });

  test('registerStructuredTool の別名（default.<名前>）も同じ', async () => {
    const seen: string[] = [];
    await withServer('name:alice', async (client, server) => {
      registerStructuredTool(server, new Map<string, ToolCatalogEntry>(), new Set<string>(['probe_structured_deferred']), 'probe_structured_deferred', 'web', 'probe', {}, z.object({ y: z.string() }), async () => {
        seen.push(currentCaller());
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { y: 'ok' } };
      }, { defaultEnabled: false });
      await client.callTool({ name: 'default.probe_structured_deferred', arguments: {} });
    });
    expect(seen).toEqual(['name:alice']);
  });

  test('セッションの tenant が無い（鍵なし）ときは legacy', async () => {
    const seen: string[] = [];
    await withServer(undefined, async (client, server) => {
      registerTool(server, new Map<string, ToolCatalogEntry>(), new Set<string>(), 'probe_plain', 'web', 'probe', {}, async () => {
        seen.push(currentCaller());
        return { content: [{ type: 'text', text: 'ok' }] };
      }, { defaultEnabled: true });
      await client.callTool({ name: 'probe_plain', arguments: {} });
    });
    expect(seen).toEqual(['legacy']);
  });

  test('2 つのセッションが同時に呼んでも、混ざらない', async () => {
    const seen: Record<string, string[]> = { alice: [], bob: [] };
    const make = (name: 'alice' | 'bob', ms: number) =>
      withServer(`name:${name}`, async (client, server) => {
        registerTool(server, new Map<string, ToolCatalogEntry>(), new Set<string>(), 'probe_plain', 'web', 'probe', {}, async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, ms));
          seen[name].push(currentCaller());
          return { content: [{ type: 'text', text: 'ok' }] };
        }, { defaultEnabled: true });
        await client.callTool({ name: 'probe_plain', arguments: {} });
      });
    await Promise.all([make('alice', 20), make('bob', 5)]);
    expect(seen).toEqual({ alice: ['name:alice'], bob: ['name:bob'] });
  });

  test('ツールが投げても、範囲は外れる', async () => {
    await withServer('name:alice', async (client, server) => {
      registerTool(server, new Map<string, ToolCatalogEntry>(), new Set<string>(), 'probe_throw', 'web', 'probe', {}, async () => {
        throw new Error('boom');
      }, { defaultEnabled: true });
      await client.callTool({ name: 'probe_throw', arguments: {} });
    });
    expect(currentCaller()).toBe('legacy');
  });
});
