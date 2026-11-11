import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createAuthMiddleware } from '../auth.js';
import { PUBLIC_PATHS } from '../security/public_paths.js';
import { toolsRoutes } from './tools.js';

const app = new Hono().route('/', toolsRoutes);
const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));

describe('GET /tools', () => {
  test('操作の一覧を返す（名前・メソッド・パス・カテゴリ・概要）', async () => {
    const res = await get('/tools');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; tools: Array<Record<string, string>> };
    expect(body.count).toBe(body.tools.length);
    expect(body.count).toBeGreaterThanOrEqual(50);
    expect(body.tools.find((tool) => tool.name === 'search_postal_code')).toEqual({
      name: 'search_postal_code',
      method: 'POST',
      path: '/geo/postal-code',
      category: 'disaster',
      summary: expect.any(String),
    });
  });

  test('q と category で絞る。該当が無ければ空（200）', async () => {
    const byWord = (await (await get(`/tools?q=${encodeURIComponent('郵便番号')}`)).json()) as { tools: Array<{ name: string }> };
    expect(byWord.tools.map((tool) => tool.name)).toContain('search_postal_code');
    const byCategory = (await (await get('/tools?category=trade')).json()) as { tools: Array<{ category: string }> };
    expect(byCategory.tools.length).toBeGreaterThan(0);
    expect(byCategory.tools.every((tool) => tool.category === 'trade')).toBe(true);
    const none = await get('/tools?q=zzzz-no-such');
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ count: 0, tools: [] });
  });
});

describe('GET /tools/{name}', () => {
  test('1 つの操作の定義を返す', async () => {
    const res = await get('/tools/search_postal_code');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ name: 'search_postal_code', method: 'POST', path: '/geo/postal-code' });
    expect(body.request.schema.properties.zipcode).toBeDefined();
    expect(body.response).toBeUndefined();
  });

  test('response=true で、成功時の応答のスキーマも付く', async () => {
    const body = (await (await get('/tools/search_postal_code?response=true')).json()) as any;
    expect(body.response.schema).toBeDefined();
  });

  test('知らない名前は、共通のエラーの形の 404', async () => {
    const res = await get('/tools/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND', status: 404, retryable: false });
  });

  test('一覧の全部の名前に、定義がある', async () => {
    const { tools } = (await (await get('/tools')).json()) as { tools: Array<{ name: string }> };
    for (const { name } of tools) expect((await get(`/tools/${name}`)).status).toBe(200);
  });
});

describe('認証', () => {
  test('ほかの REST と同じく API キーが要り、公開の経路ではない', async () => {
    expect([...PUBLIC_PATHS].some((p) => p.startsWith('/tools'))).toBe(false);
    const guarded = new Hono();
    guarded.use('*', createAuthMiddleware('secret-test-key'));
    guarded.route('/', toolsRoutes);
    const headers = { 'x-forwarded-for': '203.0.113.196' };
    const denied = await guarded.fetch(new Request('http://localhost/tools', { headers }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: 'UNAUTHORIZED', status: 401, retryable: false });
    const ok = await guarded.fetch(new Request('http://localhost/tools', { headers: { ...headers, 'X-API-Key': 'secret-test-key' } }));
    expect(ok.status).toBe(200);
  });
});
