import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { ResourceBusyError } from './errors.js';
import { createMcpServer } from './mcp.js';
import { createSocialRoutes } from './routes/social.js';
import { createSocialPostsProvider } from './services/country_intel/providers/social_posts.js';
import * as socialIndex from './services/social/index.js';
import * as transport from './services/social/transport.js';

/**
 * SNS の検索・投稿の取得（Weibo の匿名セッション・Meta の本文のブラウザ描画を使う）が、呼んだ利用者（tenant）を、ブラウザの枠まで渡す（設計 6。穴 22・25）。
 * REST は認証が決めた利用者、MCP はサーバーの利用者、国の情報（利用者を持たない取得）は public。
 * 本物のサービス・ブラウザは使わない（作る関数と、作られた部品を、テストの偽物に替える）。
 */

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const emptySearch = { platform: 'weibo', query: 'q', status: 'ok', items: [], failures: [] };
const fakeService = { search: async () => emptySearch, fetch: async () => ({ found: false }), enrichWeiboTop: async () => [] };

/** 枠を使う 2 つの部品の作り方を、利用者の記録つきの偽物に替える。記録した利用者を返す */
function fakeTransport() {
  const opener: Array<string | undefined> = [];
  const meta: Array<string | undefined> = [];
  spies.push(
    spyOn(socialIndex, 'createSocialService').mockReturnValue(fakeService as never),
    spyOn(transport, 'createProdSessionOpener').mockImplementation(((tenantId?: string) => {
      opener.push(tenantId);
      return { openWeiboSession: async () => [] };
    }) as never),
    spyOn(transport, 'createProdMetaBrowser').mockImplementation(((tenantId?: string) => {
      meta.push(tenantId);
      return { readPage: async () => ({ finalUrl: '', html: '', title: '' }) };
    }) as never),
  );
  return { opener, meta };
}

const appFor = (tenantId: string | undefined) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (tenantId) c.set('tenant', { tenantId, requestId: 'req-1', authMode: 'api_key' });
    await next();
  });
  app.route('/', createSocialRoutes());
  return app;
};
const post = (path: string, body: unknown) => ({ path, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } });

describe('REST（/social/search・/social/fetch）', () => {
  test('認証が決めた利用者を、2 つの部品に渡す。本文の tenantId は無視する', async () => {
    const seen = fakeTransport();
    const app = appFor('name:alice');
    const search = post('/social/search', { platform: 'weibo', query: 'q', tenantId: 'name:bob' });
    expect((await app.request(search.path, search.init)).status).toBe(200);
    const fetched = post('/social/fetch', { url: 'https://www.threads.net/@x/post/1', tenantId: 'name:bob' });
    await app.request(fetched.path, fetched.init);
    expect(seen.opener).toEqual(['name:alice', 'name:alice']);
    expect(seen.meta).toEqual(['name:alice', 'name:alice']);
  });

  test('tenant を決めた認証が無い組み立てでは legacy', async () => {
    const seen = fakeTransport();
    const search = post('/social/search', { platform: 'weibo', query: 'q' });
    await appFor(undefined).request(search.path, search.init);
    expect(seen.opener).toEqual(['legacy']);
    expect(seen.meta).toEqual(['legacy']);
  });
});

describe('MCP（search_social_posts・fetch_social_post）', () => {
  test('サーバーの利用者を、2 つの部品に渡す', async () => {
    const seen = fakeTransport();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = createMcpServer({ deferTools: false, sessionState: { activatedTools: new Set(), tenantId: 'name:alice' } });
    const client = new Client({ name: 'social-tenant', version: '1.0.0' });
    await mcp.connect(st);
    await client.connect(ct);
    try {
      await client.callTool({ name: 'search_social_posts', arguments: { platform: 'weibo', query: 'q' } });
      await client.callTool({ name: 'fetch_social_post', arguments: { url: 'https://www.threads.net/@x/post/1' } });
      expect(seen.opener).toEqual(['name:alice', 'name:alice']);
      expect(seen.meta).toEqual(['name:alice', 'name:alice']);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});

describe('国の情報（利用者を持たない取得）', () => {
  test('public の利用者として数える', async () => {
    const seen = fakeTransport();
    const provider = createSocialPostsProvider();
    // 入力は最小。サービスを作る（= 2 つの部品を作る）ところまでを確かめる
    await provider.run({ request: { includeSocial: true } } as never, new AbortController().signal).catch(() => {});
    expect(seen.opener).toEqual(['public']);
    expect(seen.meta).toEqual(['public']);
  });
});

describe('REST: 枠が混み合って断られたら', () => {
  test('/social/search・/social/fetch は、429 と Retry-After。ほかの失敗は、これまでどおり 500（SOCIAL_ERROR）', async () => {
    const busyService = {
      search: async () => {
        throw new ResourceBusyError('ブラウザの枠が混み合っています', 'queue_full', 6);
      },
      fetch: async () => {
        throw new ResourceBusyError('ブラウザの枠が混み合っています', 'queue_full', 6);
      },
    };
    const busyApp = new Hono().route('/', createSocialRoutes({ service: busyService as never }));
    for (const request of [post('/social/search', { platform: 'weibo', query: 'q' }), post('/social/fetch', { url: 'https://www.threads.net/@x/post/1' })]) {
      const res = await busyApp.request(request.path, request.init);
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('6');
      expect(await res.json()).toMatchObject({ code: 'BROWSER_BUSY', status: 429, retryable: true });
    }
    const failing = new Hono().route('/', createSocialRoutes({ service: { search: async () => { throw new Error('boom'); } } as never }));
    const search = post('/social/search', { platform: 'weibo', query: 'q' });
    const other = await failing.request(search.path, search.init);
    expect(other.status).toBe(500);
    expect(other.headers.get('retry-after')).toBeNull();
  });
});

