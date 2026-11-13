import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { ResourceBusyError } from '../errors.js';
import * as tracking from '../services/tracking/index.js';
import { trackingPageUrl } from '../services/tracking/page.js';
import { trackingRoutes } from './tracking.js';

/**
 * 荷物追跡の REST: 認証が決めた利用者（tenant）を trackPackage に渡し（ブラウザの枠を数える）、枠が混み合って断られたら 429 と Retry-After（設計 6。穴 25）。
 * 本文・クエリで tenantId を名乗っても無視する。
 */

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const appFor = (tenantId: string | undefined) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (tenantId) c.set('tenant', { tenantId, requestId: 'req-1', authMode: 'api_key' });
    await next();
  });
  app.route('/', trackingRoutes);
  return app;
};
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const busy = () => new ResourceBusyError('ブラウザの枠を待つ要求が、この利用者の上限（10 件）に達しています。実行中の要求が終わってから、もう一度試してください', 'tenant_queue_full', 5);
const result = { carrier: 'ups', carrierName: 'UPS', trackingNumber: '1Z999AA10123456784', status: 'unknown', statusText: 'x', events: [], trackingUrl: 'https://www.ups.com/' } as const;

describe('利用者を trackPackage に渡す', () => {
  test('POST /tracking・GET /tracking/:carrier/:number・GET /tracking/:number: 認証が決めた利用者。本文の tenantId は無視する', async () => {
    const spy = spyOn(tracking, 'trackPackage').mockResolvedValue(result as never);
    spies.push(spy);
    const app = appFor('name:alice');
    expect((await app.request('/tracking', post({ trackingNumber: '1Z999AA10123456784', carrier: 'ups', tenantId: 'name:bob' }))).status).toBe(200);
    expect((await app.request('/tracking/ups/1Z999AA10123456784?tenantId=name:bob')).status).toBe(200);
    expect((await app.request('/tracking/1Z999AA10123456784')).status).toBe(200);
    expect(spy.mock.calls.map((call) => call[1])).toEqual([{ tenantId: 'name:alice' }, { tenantId: 'name:alice' }, { tenantId: 'name:alice' }]);
  });

  test('認証のない組み立て（tenant が無い）では legacy', async () => {
    const spy = spyOn(tracking, 'trackPackage').mockResolvedValue(result as never);
    spies.push(spy);
    await appFor(undefined).request('/tracking/1Z999AA10123456784');
    expect(spy.mock.calls[0][1]).toEqual({ tenantId: 'legacy' });
  });
});

describe('枠が混み合って断られたら、429 と Retry-After', () => {
  test('POST /tracking・GET /tracking/:carrier/:number・GET /tracking/:number', async () => {
    spies.push(spyOn(tracking, 'trackPackage').mockRejectedValue(busy()));
    const app = appFor('name:alice');
    const responses = [
      await app.request('/tracking', post({ trackingNumber: '1Z999AA10123456784', carrier: 'ups' })),
      await app.request('/tracking/ups/1Z999AA10123456784'),
      await app.request('/tracking/1Z999AA10123456784'),
    ];
    for (const res of responses) {
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(await res.json()).toMatchObject({ code: 'BROWSER_BUSY', status: 429, retryable: true });
    }
  });

  test('混み合い以外の失敗は、これまでどおり 500（TRACKING_ERROR）', async () => {
    spies.push(spyOn(tracking, 'trackPackage').mockRejectedValue(new Error('boom')));
    const res = await appFor('name:alice').request('/tracking/1Z999AA10123456784');
    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toMatchObject({ code: 'TRACKING_ERROR' });
  });
});

describe('GET /t/:carrier/:number（署名つきの表示ページ）', () => {
  /** 署名つきの URL（SORA_TRACKING_PAGE_SECRET と SORA_PUBLIC_URL を設定したときに発行される）の、パスとクエリだけ */
  const signedPath = () => {
    const url = new URL(trackingPageUrl('ups', '1Z999AA10123456784') as string);
    return url.pathname + url.search;
  };
  const withPageSecret = async (fn: () => Promise<void>) => {
    const previous = { secret: process.env.SORA_TRACKING_PAGE_SECRET, url: process.env.SORA_PUBLIC_URL };
    process.env.SORA_TRACKING_PAGE_SECRET = 'tracking-page-secret-for-test';
    process.env.SORA_PUBLIC_URL = 'https://sora.example.com';
    try {
      await fn();
    } finally {
      if (previous.secret === undefined) delete process.env.SORA_TRACKING_PAGE_SECRET;
      else process.env.SORA_TRACKING_PAGE_SECRET = previous.secret;
      if (previous.url === undefined) delete process.env.SORA_PUBLIC_URL;
      else process.env.SORA_PUBLIC_URL = previous.url;
    }
  };

  test('利用者を trackPackage に渡す', async () => {
    await withPageSecret(async () => {
      const spy = spyOn(tracking, 'trackPackage').mockResolvedValue(result as never);
      spies.push(spy);
      const res = await appFor('name:alice').request(signedPath());
      expect(res.status).toBe(200);
      expect(spy.mock.calls[0][1]).toEqual({ tenantId: 'name:alice' });
    });
  });

  test('枠が混み合って断られたら、429 と Retry-After。混み合い以外の失敗は、これまでどおり投げる（500）', async () => {
    await withPageSecret(async () => {
      spies.push(spyOn(tracking, 'trackPackage').mockRejectedValue(busy()));
      const res = await appFor('name:alice').request(signedPath());
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('5');
      spies.pop()?.mockRestore();
      spies.push(spyOn(tracking, 'trackPackage').mockRejectedValue(new Error('boom')));
      expect((await appFor('name:alice').request(signedPath())).status).toBe(500);
    });
  });
});

