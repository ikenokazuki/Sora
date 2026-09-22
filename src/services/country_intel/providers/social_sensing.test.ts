import { describe, expect, test } from 'bun:test';
import { buildGoogleNewsSearchUrl } from './google_news.js';
import { currentEventsPageFor, extractRegionBullets } from './wiki_current.js';
import { buildGtrendsDailyUrl, parseGtrendsDaily } from './gtrends.js';
import { parseGdeltExport, summarizeGdeltTone } from './gdelt_files.js';
import type { ProviderInput } from '../provider_registry.js';
const inputFor = (region: Record<string, unknown>): ProviderInput => ({ request: { region: 'X' } as never, region: region as never, queries: [] });
const JP = inputFor({ id: 'country:JP', name: 'Japan', countryCode: 'JP', languages: ['ja'], aliases: ['Nihon'] });
describe('social sensing providers', () => {
  test('google news url derives gl/hl/ceid from region only', () => {
    const url = buildGoogleNewsSearchUrl(JP.region) ?? '';
    expect(url).toContain('news.google.com/rss/search');
    expect(url).toContain('gl=JP');
    expect(url).toContain('hl=ja');
    expect(url).toContain(encodeURIComponent('JP:ja'));
    expect(url).toContain(encodeURIComponent('Japan'));
  });
  test('google news url omits gl without country code', () => {
    const url = buildGoogleNewsSearchUrl(inputFor({ id: 'x', name: 'Nowhere', languages: [] }).region) ?? '';
    expect(url).not.toContain('gl=');
    expect(url).toContain('hl=en');
  });
  test('current events page uses UTC month and day', () => {
    expect(currentEventsPageFor(new Date('2026-09-22T00:00:00Z'))).toBe('Portal:Current events/September_22');
  });
  test('region bullets keep mentions and drop the rest', () => {
    const wiki = ['* [[Typhoon Ragasa]] makes landfall in [[Japan]], killing 3.', '* Election results announced in [[France]].', '** sub bullet Japan nested, skipped.', '* Plain line without links.'].join('\n');
    expect(extractRegionBullets(wiki, JP.region)).toEqual(['Typhoon Ragasa makes landfall in Japan, killing 3.']);
  });
  test('gtrends strips xssi prefix and caps entries', () => {
    const body = ")]}',\n" + JSON.stringify({ default: { trendingSearchesDays: [{ trendingSearches: [{ title: { query: 'Japan election' }, formattedTraffic: '50K+' }, { title: {} }] }] } });
    const entries = parseGtrendsDaily(body);
    expect(entries).toHaveLength(1);
    expect(entries[0].query).toBe('Japan election');
    expect(entries[0].traffic).toBe('50K+');
  });
  test('gtrends rejects broken json', () => {
    expect(parseGtrendsDaily('not json')).toEqual([]);
  });
  test('gtrends url carries geo from region', () => {
    expect(buildGtrendsDailyUrl(JP.region)).toContain('geo=JP');
  });
  test('gdelt export parses tone and summarizes region rows', () => {
    const cols = new Array(61).fill('');
    cols[0] = '1'; cols[33] = '5'; cols[34] = '-3.5'; cols[53] = 'JP'; cols[60] = 'https://example.org/a';
    const rows = parseGdeltExport(cols.join('\t'));
    expect(rows).toHaveLength(1);
    expect(rows[0].AvgTone).toBe(-3.5);
    expect(summarizeGdeltTone(rows)).toEqual({ count: 1, avgTone: -3.5 });
    expect(summarizeGdeltTone([{ SOURCEURL: 'https://example.org/b' }])).toBeUndefined();
  });
});
