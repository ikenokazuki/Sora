import { beforeEach, describe, expect, test } from 'bun:test';
import { clearCache } from '../cache.js';
import { createGeocoder } from './geocoding.js';

const harajuku = [
  { display_name: '東京都渋谷区神宮前 原宿', lat: '35.669968', lon: '139.709008', address: { 'ISO3166-2-lvl4': 'JP-13' } },
  { display_name: '原宿, 群馬県', lat: '36.3', lon: '139.0', address: { 'ISO3166-2-lvl4': 'JP-10' } },
];
const response = (body: unknown = harajuku) => Response.json(body);

beforeEach(() => clearCache());

describe('nominatim', () => {
  test('resolves the top hit and flags verification when candidates span prefectures', async () => {
    const geocode = createGeocoder({ fetchFn: async (url, init) => {
      const u = new URL(url);
      expect(u.origin).toBe('https://nominatim.openstreetmap.org');
      expect(u.searchParams.get('q')).toBe('原宿');
      expect(u.searchParams.get('countrycodes')).toBe('jp');
      expect(new Headers(init?.headers).get('User-Agent')).toContain('Sora');
      return response();
    } });
    expect(await geocode(' 原宿 ')).toEqual({
      address: '東京都渋谷区神宮前 原宿', lat: 35.669968, lon: 139.709008,
      source: 'nominatim', needsVerification: true,
    });
  });

  test('does not flag verification when all candidates share a prefecture', async () => {
    const geocode = createGeocoder({ fetchFn: async () => response([harajuku[0], harajuku[0]]) });
    expect((await geocode('原宿')).needsVerification).toBe(false);
  });

  test('falls back to the GSI address search when nominatim has no match', async () => {
    const hosts: string[] = [];
    const geocode = createGeocoder({ fetchFn: async (url) => {
      hosts.push(new URL(url).hostname);
      if (hosts.length === 1) return response([]);
      expect(new URL(url).searchParams.get('q')).toBe('東京都千代田区永田町1-7-1');
      return response([{ geometry: { coordinates: [139.744385, 35.677414], type: 'Point' }, properties: { title: '東京都千代田区永田町一丁目７番' } }]);
    } });
    expect(await geocode('東京都千代田区永田町1-7-1')).toEqual({
      address: '東京都千代田区永田町一丁目７番', lat: 35.677414, lon: 139.744385, source: 'gsi', needsVerification: false,
    });
    expect(hosts).toEqual(['nominatim.openstreetmap.org', 'msearch.gsi.go.jp']);
  });

  test('spaces concurrent requests for different places at least 1.1 seconds apart', async () => {
    let time = 0;
    const starts: Array<{ query: string; at: number }> = [];
    const geocode = createGeocoder({
      now: () => time,
      sleep: async (ms) => { time += ms; },
      fetchFn: async (url) => {
        starts.push({ query: new URL(url).searchParams.get('q')!, at: time });
        return response();
      },
    });
    await Promise.all(['原宿', '渋谷', '京都駅'].map((query) => geocode(query)));
    expect(starts).toEqual([
      { query: '原宿', at: 0 }, { query: '渋谷', at: 1100 }, { query: '京都駅', at: 2200 },
    ]);
  });

  test('coalesces simultaneous requests for the same place and reuses the cache', async () => {
    let requests = 0;
    const geocode = createGeocoder({ fetchFn: async () => { requests++; return response(); } });
    const results = await Promise.all([geocode('原宿'), geocode('原宿'), geocode(' 原宿 ')]);
    expect(results.every((r) => r.lat === 35.669968 && r.lon === 139.709008)).toBe(true);
    expect((await geocode('原宿')).address).toBe('東京都渋谷区神宮前 原宿');
    expect(requests).toBe(1);
  });

  test('an empty result releases the queue but still consumes the interval', async () => {
    let time = 0;
    const starts: number[] = [];
    const geocode = createGeocoder({
      now: () => time,
      sleep: async (ms) => { time += ms; },
      fetchFn: async (url) => {
        const q = new URL(url).searchParams.get('q');
        if (new URL(url).hostname === 'nominatim.openstreetmap.org') starts.push(time);
        return q === '存在しない地名' ? response([]) : response();
      },
    });
    const [failed, successful] = await Promise.allSettled([geocode('存在しない地名'), geocode('原宿')]);
    expect(failed.status).toBe('rejected');
    if (failed.status === 'rejected') expect(failed.reason.message).toContain('no match');
    expect(successful.status).toBe('fulfilled');
    expect(starts).toEqual([0, 1100]);
  });

  test('a network failure leaves subsequent requests usable and rate limited', async () => {
    let time = 0;
    const starts: number[] = [];
    const geocode = createGeocoder({
      now: () => time, sleep: async (ms) => { time += ms; },
      fetchFn: async () => {
        starts.push(time);
        if (starts.length === 1) throw new Error('network down');
        return response();
      },
    });
    await expect(geocode('原宿')).rejects.toThrow('network down');
    expect((await geocode('原宿')).lat).toBe(35.669968);
    expect(starts).toEqual([0, 1100]);
  });

  test('cache bypass still enforces the interval', async () => {
    let time = 0;
    const starts: number[] = [];
    const geocode = createGeocoder({
      now: () => time, sleep: async (ms) => { time += ms; },
      fetchFn: async () => { starts.push(time); return response(); },
    });
    await geocode('原宿');
    await geocode('原宿', { noCache: true });
    expect(starts).toEqual([0, 1100]);
  });

  test.each([
    '<html><body>Unavailable</body></html>',
    '{"error":"bad"}',
    '[{"lat":"","lon":"139"}]',
    '[{"lat":"NaN","lon":"139"}]',
    '[{"lat":"91","lon":"139"}]',
    '[{"lat":"35","lon":"181"}]',
  ])('rejects malformed responses and invalid coordinates: %s', async (body) => {
    const geocode = createGeocoder({ fetchFn: async () => new Response(body) });
    await expect(geocode('原宿')).rejects.toThrow('nominatim');
  });

  test('rejects HTTP errors without parsing their bodies as locations', async () => {
    const geocode = createGeocoder({ fetchFn: async () => Response.json(harajuku, { status: 503 }) });
    await expect(geocode('原宿')).rejects.toThrow('503');
  });
});
