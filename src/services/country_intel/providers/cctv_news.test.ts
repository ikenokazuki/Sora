import { describe, expect, test } from 'bun:test';
import { parseCctvNewsJsonp } from './cctv_news.js';
import type { ProviderInput } from '../provider_registry.js';
const inputFor = (region: Record<string, unknown>): ProviderInput =>
  ({ request: { region: 'X' } as never, region: region as never, queries: [] });
const CN = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [] });
const liveShape = (list: unknown[]): string =>
  'china(' + JSON.stringify({ data: { list } }) + ')';
const itemA = { title: 'headline-a', brief: 'brief-a', url: 'https://news.cctv.com/2026/09/23/ARTI0001.shtml', focus_date: '2026-09-23 11:57:22', keywords: 'a', image: '' };
const itemB = { title: 'headline-b', brief: '', url: 'https://news.cctv.com/2026/09/23/VIDE0002.shtml', focus_date: 'not-a-date', keywords: '', image: '' };
const itemBad = { title: '', brief: '', url: 'notaurl', focus_date: '', keywords: '', image: '' };
describe('cctv news', () => {
  test('unwraps jsonp and converts focus dates from UTC+8', () => {
    const entries = parseCctvNewsJsonp(liveShape([itemA, itemB, itemBad]), 'china');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: 'ARTI0001', title: 'headline-a', publishedAt: '2026-09-23T03:57:22.000Z', category: 'china' });
    expect(entries[1].publishedAt).toBeUndefined();
  });
  test('emits acquisition items for CN only', async () => {
    const { createCctvNewsProvider } = await import('./cctv_news.js');
    const fetchFn = (async () => new Response(liveShape([itemA]), { headers: { 'content-type': 'application/javascript' } })) as unknown as never;
    const result = await createCctvNewsProvider(fetchFn).run(CN, AbortSignal.timeout(5000));
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].evidence?.publisher).toBe('CCTV News');
    expect(result.items[0].detail?.providerItemId).toBe('cctv:ARTI0001');
    expect(result.items[0].detail?.timeBasis).toBe('provider_publication');
  });
  test('skips non-CN regions without fetch', async () => {
    const { createCctvNewsProvider } = await import('./cctv_news.js');
    const fetchFn = (() => Promise.reject(new Error('must not fetch'))) as unknown as never;
    const jp = inputFor({ id: 'country:JP', name: 'Japan', countryCode: 'JP', languages: [], aliases: [] });
    expect((await createCctvNewsProvider(fetchFn).run(jp, AbortSignal.timeout(5000))).items).toEqual([]);
  });
  test('rejects unexpected envelopes', () => {
    expect(() => parseCctvNewsJsonp('china(' + JSON.stringify({ data: {} }) + ')', 'china')).toThrow();
    expect(() => parseCctvNewsJsonp('not jsonp at all', 'china')).toThrow();
  });
});
