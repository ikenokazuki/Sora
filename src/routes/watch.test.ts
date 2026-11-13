import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createWatchRoutes, type WatchRouteDeps } from './watch.js';
import { WatchSelectorNotFoundError } from '../services/watch.js';

describe('F7 watch route errors', () => {
  test('selector miss maps to 502 with code and retryable=false', async () => {
    const app = createWatchRoutes({
      checkWatchTarget: async () => { throw new WatchSelectorNotFoundError('#status', 'https://example.com/p'); },
    });
    const res = await app.request('/watch/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'wt_1' }) });
    expect(res.status).toBe(502);
    const body = await res.json() as { code: string; retryable: boolean };
    expect(body.code).toBe('WATCH_SELECTOR_NOT_FOUND');
    expect(body.retryable).toBe(false);
  });
  test('batch results carry errorCode per target', async () => {
    const app = createWatchRoutes({
      checkAllWatchTargets: async () => [{ targetId: 'wt_1', url: 'https://example.com/a', changed: false, currentHash: '', checkedAt: new Date().toISOString(), errorCode: 'WATCH_SELECTOR_NOT_FOUND' }],
    });
    const res = await app.request('/watch/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ errorCode?: string }> };
    expect(body.results[0].errorCode).toBe('WATCH_SELECTOR_NOT_FOUND');
  });
  test('single result is wrapped in result', async () => {
    const app = createWatchRoutes({
      checkWatchTarget: async () => ({ targetId: 'wt_1', url: 'https://example.com/a', changed: false, currentHash: 'h', checkedAt: new Date().toISOString() }),
    });
    const res = await app.request('/watch/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'wt_1' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { targetId: string } };
    expect(body.result.targetId).toBe('wt_1');
  });
});

describe('ウォッチの REST は、認証が決めた tenant の分だけに効く（設計 5。穴 2・18）', () => {
  const TARGET = { id: 'wt_1', url: 'https://example.com/a', interval_seconds: 3600, created_at: 1 };
  const RESULT = { targetId: 'wt_1', url: TARGET.url, changed: false, currentHash: 'h', checkedAt: '2026-11-13T00:00:00Z' };

  /** 認証のミドルウェアが tenant を決めたあとの組み立て。tenantId が無ければ、認証を通さない組み立て */
  const appFor = (tenantId: string | undefined, deps: WatchRouteDeps) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (tenantId) c.set('tenant', { tenantId, requestId: 'req-1', authMode: 'api_key' });
      await next();
    });
    app.route('/', createWatchRoutes(deps));
    return app;
  };
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const recorder = () => {
    const calls: unknown[][] = [];
    const deps: WatchRouteDeps = {
      registerWatchTarget: (async (options: { tenantId: string; id?: string }) => { calls.push(['register', options]); return { target: TARGET }; }) as never,
      checkWatchTarget: (async (id: string, tenantId: string) => { calls.push(['check', id, tenantId]); return RESULT; }) as never,
      checkAllWatchTargets: (async (tenantId: string) => { calls.push(['checkAll', tenantId]); return [RESULT]; }) as never,
      listWatchTargets: ((tenantId: string) => { calls.push(['list', tenantId]); return [TARGET]; }) as never,
      deleteWatchTarget: ((id: string, tenantId: string) => { calls.push(['delete', id, tenantId]); return false; }) as never,
    };
    return { calls, deps };
  };

  test('register・check（id あり・なし）・list・delete のすべてが、tenant をサービスに渡す', async () => {
    const { calls, deps } = recorder();
    const app = appFor('name:alice', deps);
    await app.request('/watch/register', json({ url: 'https://example.com/a' }));
    await app.request('/watch/check', json({ id: 'wt_1' }));
    await app.request('/watch/check', json({}));
    await app.request('/watch/list');
    await app.request('/watch/wt_1', { method: 'DELETE' });
    expect(calls).toEqual([
      ['register', { url: 'https://example.com/a', tenantId: 'name:alice' }],
      ['check', 'wt_1', 'name:alice'],
      ['checkAll', 'name:alice'],
      ['list', 'name:alice'],
      ['delete', 'wt_1', 'name:alice'],
    ]);
  });

  test('tenant を決めた認証が無い組み立てでは legacy', async () => {
    const { calls, deps } = recorder();
    const app = appFor(undefined, deps);
    await app.request('/watch/check', json({}));
    await app.request('/watch/list');
    expect(calls).toEqual([['checkAll', 'legacy'], ['list', 'legacy']]);
  });

  test('本文に tenantId や id を足しても無視される（持ち主も id も、呼び出し側が決められない）', async () => {
    const { calls, deps } = recorder();
    const app = appFor('name:alice', deps);
    await app.request('/watch/register', json({ url: 'https://example.com/a', tenantId: 'name:bob', id: 'wt_victim' }));
    expect(calls).toEqual([['register', { url: 'https://example.com/a', tenantId: 'name:alice' }]]);
  });

  test('応答の形は変わらない（list は count と targets。delete は success と id）', async () => {
    const { deps } = recorder();
    const app = appFor('name:alice', deps);
    expect(await (await app.request('/watch/list')).json()).toEqual({ count: 1, targets: [TARGET] });
    expect(await (await app.request('/watch/wt_9', { method: 'DELETE' })).json()).toEqual({ success: false, id: 'wt_9' });
  });
});
