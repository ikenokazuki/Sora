import { describe, expect, test } from 'bun:test';
import { buildGoogleNewsSearchUrl, planGoogleNewsQueries } from './google_news.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYahooWebHtml } from '../../yahoo.js';
describe('yahoo direct fallback', () => {
  test('parses live result html into publisher urls', () => {
    const html = readFileSync(join(import.meta.dir, '..', 'fixtures', 'yahoo-web-china.html'), 'utf8');
    const items = parseYahooWebHtml(html);
    expect(items.length).toBeGreaterThan(5);
    expect(items[0].url).toMatch(/^https?:\/\//);
    expect(items[0].url).not.toContain('yahoo.co.jp');
    expect(items.every((item) => item.title && item.title.length > 0)).toBe(true);
  });
  test('parses current sw-Card markup with summaries', () => {
    const html = `<a href="https://openai.com/ja-JP/" class="sw-Card__titleInner"><br/><h3 class="x"><span>研究と実用化 - OpenAI</span></h3></a><p class="sw-Card__summary">汎用人工知能の実現につながると信じています。</p>`;
    const items = parseYahooWebHtml(html);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://openai.com/ja-JP/');
    expect(items[0].title).toContain('OpenAI');
    expect(items[0].snippet).toContain('汎用人工知能');
  });
});
import { currentEventsPageFor, extractRegionBullets } from './wiki_current.js';
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
  test('google news plans local-language facets without country-specific configuration', () => {
    const china = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [] });
    const queries = planGoogleNewsQueries(china);
    expect(queries.map((item) => item.query)).toContain('中国 经济 when:7d');
    expect(queries.map((item) => item.query)).toContain('中国 旅游 when:7d');
    expect(queries.map((item) => item.query)).toContain('中国 when:7d');
    expect(queries.every((item) => item.language === 'zh')).toBe(true);
  });
  test('google news keeps an explicit research question in both local and English searches', () => {
    const china = inputFor({ id: 'country:CN', name: 'China', countryCode: 'CN', languages: [], aliases: [] });
    china.request.query = 'EV batteries';
    expect(planGoogleNewsQueries(china).map((item) => item.query)).toEqual([
      '中国 EV batteries when:7d', 'China EV batteries when:7d',
    ]);
  });
  test('travel topic selects tourism news on the first search', () => {
    const input = { ...JP, request: { region: 'JP', topics: ['travel' as const] } };
    expect(planGoogleNewsQueries(input).map((item) => item.facet)).toEqual(['tourism', 'general']);
  });
  test('google news prefers source publisher urls', async () => {
    const xml = '<rss version="2.0"><channel><item><title>T</title><link>https://news.google.com/rss/articles/CBMiX</link><source url="https://www.bbc.com">BBC</source></item><item><title>U</title><link>https://example.org/direct</link></item></channel></rss>';
    const { parseFeed } = await import('./feeds.js');
    const [a, b] = parseFeed(xml, 'google-news');
    expect(a.sourceUrl).toBe('https://www.bbc.com');
    expect(a.publisher).toBe('BBC');
    expect(b.sourceUrl).toBeUndefined();
  });
  test('current events page uses UTC month and day', () => {
    expect(currentEventsPageFor(new Date('2026-09-22T00:00:00Z'))).toBe('Portal:Current events/2026 September 22');
  });
  test('region bullets keep mentions and drop the rest', () => {
    const wiki = ['* [[Typhoon Ragasa]] makes landfall in [[Japan]], killing 3.', '* Election results announced in [[France]].', '** sub bullet Japan nested, skipped.', '* Plain line without links.'].join('\n');
    expect(extractRegionBullets(wiki, JP.region)).toEqual(['Typhoon Ragasa makes landfall in Japan, killing 3.']);
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
  test('google news run uses the planned request query', async () => {
    const { createGoogleNewsProvider } = await import('./google_news.js');
    let captured = '';
    const fetchFn = (async (url: string) => {
      captured = url;
      return new Response('<rss version="2.0"><channel><item><title>E</title><link>https://example.org/e</link></item></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } });
    }) as unknown as never;
    const input = { ...JP, queries: [{ pass: 1 as const, providerId: 'google_news', query: 'Japan economy', topics: [], maxItems: 15 }] };
    const result = await createGoogleNewsProvider(fetchFn).run(input, signal);
    expect(result.items).toHaveLength(1);
    expect(captured).toContain('Japan+economy');
  });
  test('google news first run collects facets with actual query and subject area', async () => {
    const { createGoogleNewsProvider } = await import('./google_news.js');
    const visited: string[] = [];
    const fetchFn = (async (url: string) => {
      visited.push(url);
      const q = new URL(url).searchParams.get('q') ?? '';
      const title = q.includes('経済') ? '日本経済ニュース' : q.includes('観光') ? '日本観光ニュース' : '日本のニュース';
      const rss = `<rss version="2.0"><channel><item><title>${title}</title><link>https://example.org/${encodeURIComponent(title)}</link><pubDate>Wed, 23 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
      return new Response(rss, { headers: { 'content-type': 'application/rss+xml' } });
    }) as unknown as never;
    const result = await createGoogleNewsProvider(fetchFn).run(JP, signal);
    expect(visited.length).toBeGreaterThan(3);
    const economy = result.items.find((item) => item.evidence?.title === '日本経済ニュース');
    expect(economy?.areas).toContain('economy');
    expect(economy?.evidence?.acquisition?.query).toContain('経済');
    expect(result.items.some((item) => item.evidence?.title === '日本観光ニュース')).toBe(true);
  });
  test('google news reports an empty subject and keeps other subjects', async () => {
    const { createGoogleNewsProvider } = await import('./google_news.js');
    const fetchFn = (async (url: string) => {
      const query = new URL(url).searchParams.get('q') ?? '';
      const item = query.includes('観光') ? '' : '<item><title>日本のニュース</title><link>https://example.org/a</link></item>';
      return new Response(`<rss version="2.0"><channel>${item}</channel></rss>`, { headers: { 'content-type': 'application/rss+xml' } });
    }) as never;
    const result = await createGoogleNewsProvider(fetchFn).run(JP, signal);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.gaps).toContainEqual({ area: 'tourism', reason: 'tourism no_recent_items' });
  });
  test('google news run keeps the article link and records the publisher url', async () => {
    const { createGoogleNewsProvider } = await import('./google_news.js');
    const rss = '<rss version="2.0"><channel><item><title>BBC story</title><link>https://news.google.com/rss/articles/CBMiX</link><source url="https://www.bbc.com">BBC</source></item></channel></rss>';
    const result = await createGoogleNewsProvider(stubFetch(rss, 'application/rss+xml')).run(JP, signal);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].evidence?.url).toBe('https://news.google.com/rss/articles/CBMiX');
    expect(result.items[0].detail?.sourceRecordUrl).toBe('https://news.google.com/rss/articles/CBMiX');
    expect(result.items[0].detail?.structuredData).toMatchObject({ publisherUrl: 'https://www.bbc.com' });
    expect(result.items[0].evidence?.publisher).toBe('BBC');
  });
  test('google news does not present its repeated HTML headline as article text', async () => {
    const { createGoogleNewsProvider } = await import('./google_news.js');
    const rss = '<rss version="2.0"><channel><item><title>Japan economy</title><link>https://news.google.com/rss/articles/abc</link><description><![CDATA[<a href="https://news.google.com/rss/articles/abc">Japan economy</a><font>Publisher</font>]]></description></item></channel></rss>';
    const result = await createGoogleNewsProvider((async () => new Response(rss, { headers: { 'content-type': 'application/rss+xml' } })) as never).run(JP, signal);
    expect(result.items[0].detail?.contentKind).toBe('title_only');
    expect(result.items[0].evidence?.excerpt).toBeUndefined();
  });
  test('google news drops dated articles outside its seven-day search window', async () => {
    const { createGoogleNewsProvider } = await import('./google_news.js');
    const old = new Date(Date.now() - 9 * 86_400_000).toUTCString();
    const fresh = new Date().toUTCString();
    const rss = `<rss version="2.0"><channel><item><title>Old</title><link>https://example.org/old</link><pubDate>${old}</pubDate></item><item><title>Fresh</title><link>https://example.org/fresh</link><pubDate>${fresh}</pubDate></item></channel></rss>`;
    const result = await createGoogleNewsProvider((async () => new Response(rss, { headers: { 'content-type': 'application/rss+xml' } })) as never).run(JP, signal);
    expect(result.items.map((item) => item.evidence?.title)).toEqual(['Fresh']);
  });
  test('wiki current run keeps region bullets only', async () => {
    const { createWikiCurrentProvider } = await import('./wiki_current.js');
    const wikitext = '* Typhoon hits [[Japan]], one dead.\n* Election in [[France]].\n';
    const body = JSON.stringify({ parse: { title: 'Portal:Current events/2026 September 22', wikitext: { '*': wikitext } } });
    const result = await createWikiCurrentProvider(stubFetch(body, 'application/json'), new Date('2026-09-22T00:00:00Z')).run(JP, signal);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].evidence?.title).toContain('Japan');
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
  test('parses tophub mirror links with decode, dedupe and cap', async () => {
    const { parseTopHubBaiduHtml } = await import('./baidu_hot.js');
    const link = (wd: string) => '<a href="https://www.baidu.com/s?wd=' + wd + '">x</a>';
    const html = '<html><body>'
      + link(encodeURIComponent('中美关系')) + link(encodeURIComponent('中美关系'))
      + link(encodeURIComponent('中国女排')) + '<a href="https://tophub.today/n/other">other</a>'
      + '</body></html>';
    const entries = parseTopHubBaiduHtml(html);
    expect(entries.map((e) => e.query)).toEqual(['中美关系', '中国女排']);
    expect(entries[0]).toMatchObject({ rank: 1 });
    expect(entries[0].url).toContain('baidu.com/s?wd=');
  });
  test('falls back to tophub when direct baidu is unreachable', async () => {
    const { createBaiduHotProvider } = await import('./baidu_hot.js');
    expect(createBaiduHotProvider().timeoutMs).toBe(12000);
    const topics = ['话题A', '话题B', '话题C', '话题D', '话题E', '话题F'];
    const mirror = '<html><body>' + topics.map((q) => '<a href="https://www.baidu.com/s?wd=' + encodeURIComponent(q) + '">' + q + '</a>').join('') + '</body></html>';
    const fetchFn = (async (url: string) => {
      if (String(url).includes('tophub.today')) return new Response(mirror, { headers: { 'content-type': 'text/html' } });
      throw new Error('socket timeout');
    }) as unknown as never;
    const result = await createBaiduHotProvider(fetchFn).run(CN, AbortSignal.timeout(5000));
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].evidence?.publisher).toBe('Baidu Hot Search');
  });
});
