import { beforeEach, describe, expect, test } from 'bun:test';
import { clearCache } from '../cache.js';
import { createGeocoder } from './geocoding.js';

const harajukuXml = `<?xml version="1.0" encoding="UTF-8" ?>
<result><version>1.2</version><address>原宿</address>
<coordinate><lat>35.669968</lat><lng>139.709008</lng>
<lat_dms>35,40,11.886</lat_dms><lng_dms>139,42,32.429</lng_dms></coordinate>
<open_location_code>8Q7XMP95+XJ</open_location_code>
<url>https://www.geocoding.jp/?q=原宿</url>
<needs_to_verify>yes</needs_to_verify><google_maps>東京都渋谷区神宮前 原宿</google_maps></result>`;
const response = (body = harajukuXml) => new Response(body, { headers: { 'content-type': 'text/xml; charset=UTF-8' } });

beforeEach(() => clearCache());

describe('geocoding.jp', () => {
  test('resolves XML coordinates and preserves the returned place label and verification flag', async () => {
    const geocode = createGeocoder({ fetchFn: async (url) => {
      expect(new URL(url).origin).toBe('https://www.geocoding.jp');
      expect(new URL(url).searchParams.get('q')).toBe('原宿');
      return response();
    } });
    expect(await geocode(' 原宿 ')).toEqual({
      address: '東京都渋谷区神宮前 原宿', lat: 35.669968, lon: 139.709008,
      source: 'geocoding.jp', needsVerification: true,
    });
  });

  test('spaces concurrent requests for different places at least ten seconds apart', async () => {
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
      { query: '原宿', at: 0 }, { query: '渋谷', at: 10000 }, { query: '京都駅', at: 20000 },
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

  test('an XML error inside HTTP 200 releases the queue but still consumes the interval', async () => {
    let time = 0;
    const starts: number[] = [];
    const geocode = createGeocoder({
      now: () => time,
      sleep: async (ms) => { time += ms; },
      fetchFn: async () => {
        starts.push(time);
        return starts.length === 1 ? response('<result><error>001</error></result>') : response();
      },
    });
    const [failed, successful] = await Promise.allSettled([geocode('札幌時計台'), geocode('原宿')]);
    expect(failed.status).toBe('rejected');
    if (failed.status === 'rejected') expect(failed.reason.message).toContain('001');
    expect(successful.status).toBe('fulfilled');
    expect(starts).toEqual([0, 10000]);
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
    expect(starts).toEqual([0, 10000]);
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
    expect(starts).toEqual([0, 10000]);
  });

  test.each([
    '<html><body>Unavailable</body></html>',
    '<result><coordinate><lat>35</lat><lng>139</lng>',
    '<result><coordinate><lat></lat><lng>139</lng></coordinate></result>',
    '<result><coordinate><lat>NaN</lat><lng>139</lng></coordinate></result>',
    '<result><coordinate><lat>91</lat><lng>139</lng></coordinate></result>',
    '<result><coordinate><lat>35</lat><lng>181</lng></coordinate></result>',
  ])('rejects malformed responses and invalid coordinates: %s', async (xml) => {
    const geocode = createGeocoder({ fetchFn: async () => response(xml) });
    await expect(geocode('原宿')).rejects.toThrow('geocoding.jp');
  });

  test('rejects HTTP errors without parsing their bodies as locations', async () => {
    const geocode = createGeocoder({ fetchFn: async () => new Response(harajukuXml, { status: 503 }) });
    await expect(geocode('原宿')).rejects.toThrow('503');
  });
});
