import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { clearCache, setToCache } from '../cache.js';
import { ResourceBusyError } from '../errors.js';
import * as disaster from '../services/disaster.js';
import * as geocoding from '../services/geocoding.js';
import { searchOpenPoi } from '../services/poi.js';
import { publicDataRoutes } from './public_data.js';
import { busyEventFields } from './utils.js';

/**
 * 共有の外部資源（地名の検索）の順番・予算で断られたとき（ResourceBusyError。設計 6。穴 25）の REST: 429 と Retry-After。
 * ブラウザの枠のときの code（BROWSER_BUSY）は、そのまま。ほかの資源は RESOURCE_BUSY。
 */

const spies: Array<{ mockRestore: () => void }> = [];
// 標高の結果のキャッシュに、同じ地名の結果が入っていても（別のテストが入れた場合と同じ状態を、毎回作る）、noCache で地名の検索まで進む
beforeEach(() => setToCache('geo:elevation:v2:原宿::', { elevationMeters: 40, cached: false }, 60_000));
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  clearCache();
});

// 標高の結果は、同じプロセスの別のテストが入れたキャッシュに当たりうる（実行順で変わる）ので、noCache で、必ず地名の検索まで進める
const geoBusy = () => new ResourceBusyError('地名の検索の、この利用者の予算（1 分に 20 回）を使い切りました。42 秒たってから、もう一度試してください', 'tenant_budget', 42, 'geocoding');
const app = () => new Hono().route('/', publicDataRoutes);
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('busyEventFields の code', () => {
  test('ブラウザは BROWSER_BUSY のまま。ほかの資源は RESOURCE_BUSY', () => {
    expect(busyEventFields(new ResourceBusyError('x', 'queue_full', 5))).toEqual({ code: 'BROWSER_BUSY', status: 429, retryable: true, retryAfterSec: 5 });
    expect(busyEventFields(new ResourceBusyError('x', 'session_limit', 5, 'browser'))?.code).toBe('BROWSER_BUSY');
    for (const resource of ['geocoding', 'yahoo', 'country_intel', 'address'] as const) {
      expect(busyEventFields(new ResourceBusyError('x', 'tenant_budget', 9, resource))).toEqual({ code: 'RESOURCE_BUSY', status: 429, retryable: true, retryAfterSec: 9 });
    }
  });

  test('混み合い以外の失敗は undefined', () => {
    expect(busyEventFields(new Error('x'))).toBeUndefined();
  });
});

describe('地名の検索が断られたら、429 と Retry-After', () => {
  test('GET・POST /geo/elevation（address）', async () => {
    spies.push(spyOn(geocoding, 'geocodeAddress').mockRejectedValue(geoBusy()));
    const a = app();
    const responses = [
      await a.request('/geo/elevation?noCache=true&address=' + encodeURIComponent('原宿')),
      await a.request('/geo/elevation', post({ address: '原宿', noCache: true })),
    ];
    for (const res of responses) {
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('42');
      expect(await res.json()).toMatchObject({ code: 'RESOURCE_BUSY', status: 429, retryable: true });
    }
  });

  test('GET・POST /geo/poi（center）', async () => {
    spies.push(spyOn(geocoding, 'geocodeAddress').mockRejectedValue(geoBusy()));
    const a = app();
    const responses = [
      await a.request('/geo/poi?noCache=true&center=' + encodeURIComponent('原宿') + '&query=cafe'),
      await a.request('/geo/poi', post({ center: '原宿', query: 'cafe' })),
    ];
    for (const res of responses) {
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('42');
      expect(await res.json()).toMatchObject({ code: 'RESOURCE_BUSY', status: 429, retryable: true });
    }
  });

  test('混み合い以外の失敗は、これまでどおり 500（GEO_ERROR）', async () => {
    spies.push(spyOn(geocoding, 'geocodeAddress').mockRejectedValue(new Error('nominatim HTTP 503')));
    const res = await app().request('/geo/elevation?noCache=true&address=' + encodeURIComponent('原宿'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'GEO_ERROR' });
  });
});

describe('サービスの中で、混み合いを包み直さない', () => {
  test('searchOpenPoi: 中心の地名の検索が断られたら、その ResourceBusyError のまま投げる（「POI center geocoding failed」に包まない）', async () => {
    const error = geoBusy();
    await expect(searchOpenPoi({ center: '原宿', query: 'cafe' }, fetch, 10000, async () => { throw error; })).rejects.toBe(error);
  });

  test('searchOpenPoi: ほかの失敗は、これまでどおり包む', async () => {
    await expect(searchOpenPoi({ center: '原宿', query: 'cafe' }, fetch, 10000, async () => { throw new Error('boom'); })).rejects.toThrow('POI center geocoding failed: boom');
  });

  test('fetchElevationAndCoordinates: 断られたら、そのまま投げる', async () => {
    const error = geoBusy();
    spies.push(spyOn(geocoding, 'geocodeAddress').mockRejectedValue(error));
    await expect(disaster.fetchElevationAndCoordinates({ address: '原宿', noCache: true })).rejects.toBe(error);
  });
});
