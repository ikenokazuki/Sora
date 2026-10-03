import { describe, expect, test } from 'bun:test';
import { filterSitemapEntriesByDate } from './scraper.js';
import { searchYahooWeb } from './services/yahoo.js';

describe('map date filter', () => {
  const entries = [{ url: 'a', lastmod: '2026-07-01' }, { url: 'b', lastmod: '2026-08-15' }, { url: 'c', lastmod: '2026-09-30' }, { url: 'd' }];
  test('since and until are inclusive; entries without lastmod are kept', () => {
    expect(filterSitemapEntriesByDate(entries, '2026-08-01', '2026-09-01').map((e) => e.url)).toEqual(['b', 'd']);
    expect(filterSitemapEntriesByDate(entries, undefined, '2026-08-15').map((e) => e.url)).toEqual(['a', 'b', 'd']);
  });
});

describe('Yahoo web noCache', () => {
  test('noCache bypasses the fresh cache', async () => {
    let calls = 0;
    const deps = { fetchYahooWebDirect: async () => { calls++; return [{ title: 't', url: 'https://example.com/a', snippet: 's' }]; } } as any;
    const query = `nocache-probe-${Date.now()}`;
    await searchYahooWeb({ query, disableFallback: true }, deps);
    const afterFirst = calls;
    await searchYahooWeb({ query, disableFallback: true }, deps);
    expect(calls).toBe(afterFirst);
    await searchYahooWeb({ query, disableFallback: true, noCache: true }, deps);
    expect(calls).toBeGreaterThan(afterFirst);
  });
});
