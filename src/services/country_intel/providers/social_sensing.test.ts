import { describe, expect, test } from 'bun:test';
import { buildGoogleNewsSearchUrl, decodeGoogleNewsUrl } from './google_news.js';
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
  test('google news redirect urls decode to publisher', () => {
    const inner = 'https://example.org/article/1';
    const token = Buffer.from('prefix\x08' + inner + '\x08suffix', 'latin1').toString('base64url');
    expect(decodeGoogleNewsUrl('https://news.google.com/__i/rss/rd/articles/' + token + '?oc=5')).toBe(inner);
    expect(decodeGoogleNewsUrl('https://example.org/direct')).toBe('https://example.org/direct');
  });
  test('current events page uses UTC month and day', () => {
    expect(currentEventsPageFor(new Date('2026-09-22T00:00:00Z'))).toBe('Portal:Current events/2026 September 22');
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

describe('social sensing provider runs', () => {
  const stubFetch = (body: string, contentType = 'text/plain'): never =>
    ((() => Promise.resolve(new Response(body, { headers: { 'content-type': contentType } }))) as unknown as never);
  const signal = AbortSignal.timeout(5000);
  test('google news run emits acquisition items', async () => {
    const { createGoogleNewsProvider } = await import('./google_news.js');
    const rss = '<rss version="2.0"><channel><item><title>Japan quake</title><link>https://example.org/q</link><description>shaking</description></item></channel></rss>';
    const result = await createGoogleNewsProvider(stubFetch(rss, 'application/rss+xml')).run(JP, signal);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].evidence?.publisher).toBe('Google News');
  });
  test('wiki current run keeps region bullets only', async () => {
    const { createWikiCurrentProvider } = await import('./wiki_current.js');
    const wikitext = '* Typhoon hits [[Japan]], one dead.\n* Election in [[France]].\n';
    const body = JSON.stringify({ parse: { title: 'Portal:Current events/2026 September 22', wikitext: { '*': wikitext } } });
    const result = await createWikiCurrentProvider(stubFetch(body, 'application/json'), new Date('2026-09-22T00:00:00Z')).run(JP, signal);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].evidence?.title).toContain('Japan');
  });
  test('gtrends run maps queries to evidence', async () => {
    const { createGtrendsProvider } = await import('./gtrends.js');
    const body = ")]}',\n" + JSON.stringify({ default: { trendingSearchesDays: [{ trendingSearches: [{ title: { query: 'Japan election' }, formattedTraffic: '50K+' }] }] } });
    const result = await createGtrendsProvider(stubFetch(body)).run(JP, signal);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].detail?.structuredData).toMatchObject({ traffic: '50K+' });
  });
});

describe('baidu hot search', () => {
  const CN = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: ['zh'], aliases: [] });
  const htmlOf = (state: unknown): string => '<html><script>window.__INITIAL_STATE__=' + JSON.stringify(state) + ';</script></html>';
  test('finds topic lists without fixed key names', async () => {
    const { parseBaiduHotHtml } = await import('./baidu_hot.js');
    const words = ['Test Topic', 'T2', 'T3', 'T4', 'T5', 'T6'].map((word) => ({ word, hotScore: '700万', desc: 'desc here', url: 'https://example.org/t' }));
    const entries = parseBaiduHotHtml(htmlOf({ data: { cards: [{ content: words }] } }));
    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({ rank: 1, query: 'Test Topic', hotIndex: '700万' });
  });
  test('rejects pages without embedded topics', async () => {
    const { parseBaiduHotHtml } = await import('./baidu_hot.js');
    expect(parseBaiduHotHtml('<html><body>login required</body></html>')).toEqual([]);
  });
  test('parses live-shape api json', async () => {
    const { jsonHotEntries } = await import('./baidu_hot.js');
    const content = ['陈观泰离世', 'T2', 'T3', 'T4', 'T5', 'T6'].map((query) => ({
      query, desc: 'desc', hotScore: '712万', url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(query), hotTag: 'hot', img: '', index: 'https://top.baidu.com/board/detail?b=1',
    }));
    const entries = jsonHotEntries(JSON.stringify({ errno: 0, data: { cards: [{ content }] }, cost: { params: 1 } }));
    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({ rank: 1, query: '陈观泰离世', hotIndex: '712万', tag: 'hot' });
    expect(jsonHotEntries('not json')).toEqual([]);
  });
  test('runs for CN only', async () => {
    const { createBaiduHotProvider } = await import('./baidu_hot.js');
    const topics = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'].map((query) => ({ query, hotValue: '1万' }));
    const fetchFn = (() => Promise.resolve(new Response(htmlOf({ content: topics }), { headers: { 'content-type': 'text/html' } }))) as unknown as never;
    const cn = await createBaiduHotProvider(fetchFn).run(CN, AbortSignal.timeout(5000));
    expect(cn.items.length).toBeGreaterThan(0);
    expect(cn.items[0].evidence?.publisher).toBe('Baidu Hot Search');
    const jp = await createBaiduHotProvider(fetchFn).run(JP, AbortSignal.timeout(5000));
    expect(jp.items).toEqual([]);
  });
});
