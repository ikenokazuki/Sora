import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { getFromCache, setToCache } from '../cache.js';
import { tenantCacheKey } from '../security/tenant_state.js';
import { systemRoutes } from './system.js';

/**
 * POST /cache/clear（設計 5。穴 19）: 管理者（鍵ファイルの admin: true の鍵。鍵ファイルを使わない運用は、全員）だけが、全員分を消せる。
 * それ以外は、呼んだ tenant のキャッシュ（`tenant:<ID>:…`）だけを消す。共有のキーを消すと、全員のキャッシュの命中が下がるため。
 */

const alice = 'name:cc-route-alice';
const bob = 'name:cc-route-bob';

const appFor = (tenant: { tenantId: string; admin?: boolean } | undefined) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (tenant) c.set('tenant', { requestId: 'req-1', authMode: 'api_key', ...tenant });
    await next();
  });
  app.route('/', systemRoutes);
  return app;
};
const seed = () => {
  setToCache(tenantCacheKey(alice, 'route:k'), { v: 'alice' });
  setToCache(tenantCacheKey(bob, 'route:k'), { v: 'bob' });
  setToCache('route:shared', { v: 'shared' });
};
const alive = () => ({
  alice: getFromCache(tenantCacheKey(alice, 'route:k')) !== null,
  bob: getFromCache(tenantCacheKey(bob, 'route:k')) !== null,
  shared: getFromCache('route:shared') !== null,
});

describe('POST /cache/clear', () => {
  test('管理者: 全員分（共有のキーも）を消す。scope は all', async () => {
    seed();
    const res = await appFor({ tenantId: 'name:cc-route-ops', admin: true }).request('/cache/clear', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', scope: 'all' });
    expect(alive()).toEqual({ alice: false, bob: false, shared: false });
  });

  test('管理者でない利用者: 自分の tenant のキーだけを消す。共有のキーと、ほかの tenant のキーは残る。scope は tenant', async () => {
    seed();
    const res = await appFor({ tenantId: alice, admin: false }).request('/cache/clear', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', scope: 'tenant', cleared: 1 });
    expect(alive()).toEqual({ alice: false, bob: true, shared: true });
    appFor({ tenantId: 'x', admin: true }).request('/cache/clear', { method: 'POST' });
  });

  test('admin の欄が無い tenant（認証の組み立てが違う）も、管理者として扱わない', async () => {
    seed();
    await appFor({ tenantId: bob }).request('/cache/clear', { method: 'POST' });
    expect(alive()).toEqual({ alice: true, bob: false, shared: true });
    await appFor({ tenantId: 'x', admin: true }).request('/cache/clear', { method: 'POST' });
  });

  test('tenant を決めた認証が無い組み立てでは、legacy の分だけ（全体は消さない）', async () => {
    seed();
    setToCache(tenantCacheKey('legacy', 'route:k'), { v: 'legacy' });
    const res = await appFor(undefined).request('/cache/clear', { method: 'POST' });
    expect(await res.json()).toMatchObject({ scope: 'tenant', cleared: 1 });
    expect(getFromCache(tenantCacheKey('legacy', 'route:k'))).toBeNull();
    expect(alive()).toEqual({ alice: true, bob: true, shared: true });
    await appFor({ tenantId: 'x', admin: true }).request('/cache/clear', { method: 'POST' });
  });
});
