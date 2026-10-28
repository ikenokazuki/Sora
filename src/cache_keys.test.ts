import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cacheKeyDigest, clearCache } from './cache.js';
import { buildScrapeCacheKey, scrapeUrl } from './scraper.js';
import { trackingCacheKey } from './services/tracking/index.js';
import { fetchRoadTraffic } from './services/traffic.js';
import { DEFAULT_MAX_CHARS, type ScrapeFormat } from './types.js';

// キャッシュキーが、結果に影響する入力をすべて含むこと。
// 以前は scrape のキーに selectors・clipSelector・fullPage・renderJs・fastOnly・keepDataImages などが無く、
// 別のセレクタで取得し直したはずの要求に、前の結果が `cached: true` で返っていた。

type ScrapeOptions = Parameters<typeof scrapeUrl>[0];

describe('cacheKeyDigest', () => {
  type Sample = { a?: number; b?: string; ignored?: boolean };

  test('同じ入力は同じ値、入力が違えば違う値', () => {
    expect(cacheKeyDigest<Sample, 'ignored'>({ a: 1, b: 'x' })).toBe(cacheKeyDigest<Sample, 'ignored'>({ a: 1, b: 'x' }));
    expect(cacheKeyDigest<Sample, 'ignored'>({ a: 1, b: 'x' })).not.toBe(cacheKeyDigest<Sample, 'ignored'>({ a: 2, b: 'x' }));
    expect(cacheKeyDigest<Sample, 'ignored'>({ a: 1, b: 'x' })).toMatch(/^[0-9a-f]{32}$/);
  });

  test('型: 項目を入れ忘れる・知らない項目を足すとコンパイルできない（足した項目の入れ忘れを防ぐ）', () => {
    // 下の @ts-expect-error が不要になる（＝型が緩む）と、typecheck が失敗する
    // @ts-expect-error b を入れていない
    cacheKeyDigest<Sample, 'ignored'>({ a: 1 });
    // @ts-expect-error Sample に無い項目
    cacheKeyDigest<Sample, 'ignored'>({ a: 1, b: 'x', c: 2 });
    // 無視すると宣言した項目は入れなくてよい
    expect(cacheKeyDigest<Sample, 'ignored'>({ a: 1, b: 'x' })).toBeString();
  });
});

describe('buildScrapeCacheKey', () => {
  const url = 'https://example.com/item';
  const resolved = {
    maxChars: DEFAULT_MAX_CHARS,
    formats: ['markdown'] as ScrapeFormat[],
    onlyMainContent: true,
    shouldExtractHighlights: false,
  };
  const keyOf = (patch: Partial<ScrapeOptions> = {}, r: Partial<typeof resolved> = {}) =>
    buildScrapeCacheKey({ url, ...patch }, { ...resolved, ...r });
  const baseKey = keyOf();

  const changesTheResult: Array<[string, Partial<ScrapeOptions>]> = [
    ['selectors', { selectors: { name: 'h1' } }],
    ['selectors（別のセレクタ）', { selectors: { price: '.price' } }],
    ['clipSelector', { clipSelector: '.card' }],
    ['fullPage', { fullPage: false }],
    ['renderJs', { renderJs: true }],
    ['fastOnly', { fastOnly: true }],
    ['keepDataImages', { keepDataImages: true }],
    ['verbose', { verbose: true }],
    ['headers（資格情報ではないもの）', { headers: { 'Accept-Language': 'en' } }],
    ['headers（別の値）', { headers: { 'Accept-Language': 'ja' } }],
    ['contextTitle', { contextTitle: '見出し' }],
    ['snippet', { snippet: '抜粋' }],
    ['mode', { mode: 'browser' }],
    ['query', { query: '重さ' }],
    ['removeSelectors', { removeSelectors: ['.ad'] }],
    ['stripLinks', { stripLinks: true }],
    ['filterLinkDensity', { filterLinkDensity: true }],
    ['onlyHighlights', { onlyHighlights: true }],
    ['highlightMaxCount', { highlightMaxCount: 5 }],
    ['evidenceMode', { evidenceMode: 'highlights' }],
    ['includeDiagnostics', { includeDiagnostics: false }],
    ['includeDiscrepancies', { includeDiscrepancies: true }],
    ['safeNormalize', { safeNormalize: true }],
    ['reorderUFlat', { reorderUFlat: true }],
    ['diversityWeight', { diversityWeight: 0.2 }],
    ['annotateTemporal', { annotateTemporal: true }],
    ['minimizeTables', { minimizeTables: false }],
    ['extractSummary', { extractSummary: true }],
    ['extractCitations', { extractCitations: true }],
    ['chunkMarkdown', { chunkMarkdown: true }],
    ['chunkSize', { chunkSize: 500 }],
    ['validateLinks', { validateLinks: true }],
    ['formatAsPrompt', { formatAsPrompt: true }],
    ['highlightMatches', { highlightMatches: true }],
    ['maskPii', { maskPii: true }],
    ['url', { url: 'https://example.com/other' }],
  ];

  test('結果の中身を変える入力は、どれもキーを変える（互いにも重ならない）', () => {
    const keys = [baseKey];
    for (const [label, patch] of changesTheResult) {
      const key = keyOf(patch);
      expect(key, label).not.toBe(baseKey);
      keys.push(key);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('解決済みの値（maxChars・formats・onlyMainContent・ハイライト抽出）もキーを変える', () => {
    const keys = [
      baseKey,
      keyOf({}, { maxChars: 300 }),
      keyOf({}, { formats: ['markdown', 'links'] }),
      keyOf({}, { onlyMainContent: false }),
      keyOf({}, { shouldExtractHighlights: true }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('結果の中身を変えない入力・既定値と同じ指定は、キーを変えない', () => {
    const same: Array<[string, Partial<ScrapeOptions>]> = [
      ['noCache', { noCache: true }],
      ['timeoutMs', { timeoutMs: 1000 }],
      ['retries', { retries: 2 }],
      ['retryDelayMs', { retryDelayMs: 10 }],
      ['tenantId', { tenantId: 'key:abc' }],
      ['webhookUrl', { webhookUrl: 'https://hooks.example.com/x' }],
      ['onProgress', { onProgress: () => {} }],
      ['fullPage の既定値', { fullPage: true }],
      ['mode の既定値', { mode: 'auto' }],
      ['renderJs の既定値', { renderJs: false }],
      ['stripLinks の既定値', { stripLinks: false }],
      ['minimizeTables の既定値', { minimizeTables: true }],
      ['includeDiagnostics の既定値', { includeDiagnostics: true }],
      ['空の headers', { headers: {} }],
      // 資格情報付きの要求は共有キャッシュを使わない（読みも書きもしない）ので、キーには入れない
      ['Authorization', { headers: { Authorization: 'Bearer secret' } }],
    ];
    for (const [label, patch] of same) expect(keyOf(patch), label).toBe(baseKey);
  });

  test('ヘッダー名の大文字小文字と並び順、formats の並び順は区別しない', () => {
    const a = keyOf({ headers: { 'Accept-Language': 'en', 'X-Trace': '1' } });
    const b = keyOf({ headers: { 'x-trace': '1', 'accept-language': 'en' } });
    expect(a).toBe(b);
    expect(keyOf({}, { formats: ['links', 'markdown'] })).toBe(keyOf({}, { formats: ['markdown', 'links'] }));
  });

  test('資格情報を運ぶヘッダーの値は、キーのどこにも現れない', () => {
    const key = keyOf({ headers: { Authorization: 'Bearer top-secret-token', 'X-Api-Key': 'another-secret' } });
    expect(key).not.toContain('top-secret-token');
    expect(key).not.toContain('another-secret');
  });
});

describe('scrapeUrl のキャッシュ（手元のサーバーで確認）', () => {
  let server: ReturnType<typeof Bun.serve>;
  let hits = 0;
  let prevAllowLocal: string | undefined;

  beforeAll(() => {
    prevAllowLocal = process.env.ALLOW_LOCAL_FETCH;
    process.env.ALLOW_LOCAL_FETCH = 'true';
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        hits++;
        const lang = req.headers.get('accept-language') ?? '';
        const greeting = lang.startsWith('ja') ? 'こんにちは' : 'Hello';
        return new Response(
          `<!doctype html><html><head><title>Shop</title></head><body><main>
            <h1>Blue Widget</h1><p class="price">1,980 yen</p><p>${greeting}</p>
            <p>${'This is a long description paragraph for the widget. '.repeat(20)}</p>
          </main></body></html>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      },
    });
  });

  afterAll(() => {
    server.stop(true);
    if (prevAllowLocal === undefined) delete process.env.ALLOW_LOCAL_FETCH;
    else process.env.ALLOW_LOCAL_FETCH = prevAllowLocal;
  });

  const urlFor = (name: string) => `http://127.0.0.1:${server.port}/${name}`;
  const cached = (r: unknown) => (r as { cached?: boolean }).cached;

  test('別のセレクタで取得し直すと、前のセレクタの結果ではなく、そのセレクタの結果が返る', async () => {
    const url = urlFor('selectors');
    const before = hits;
    const a = await scrapeUrl({ url, mode: 'fast', selectors: { name: 'h1' } });
    const b = await scrapeUrl({ url, mode: 'fast', selectors: { price: '.price' } });
    const c = await scrapeUrl({ url, mode: 'fast' });

    expect(a.extracted).toEqual({ name: 'Blue Widget' });
    expect(b.extracted).toEqual({ price: '1,980 yen' });
    expect(c.extracted).toBeUndefined();
    expect([cached(a), cached(b), cached(c)]).toEqual([undefined, undefined, undefined]);
    expect(hits - before).toBe(3);
  });

  test('同じ指定の繰り返しはキャッシュから返る', async () => {
    const url = urlFor('repeat');
    const before = hits;
    const first = await scrapeUrl({ url, mode: 'fast', selectors: { name: 'h1' } });
    const second = await scrapeUrl({ url, mode: 'fast', selectors: { name: 'h1' } });

    expect(second.extracted).toEqual(first.extracted);
    expect(cached(second)).toBe(true);
    expect(hits - before).toBe(1);
  });

  test('資格情報ではないヘッダー（Accept-Language）が違えば、別の結果として取得する', async () => {
    const url = urlFor('lang');
    const before = hits;
    const ja = await scrapeUrl({ url, mode: 'fast', headers: { 'Accept-Language': 'ja' } });
    const en = await scrapeUrl({ url, mode: 'fast', headers: { 'Accept-Language': 'en' } });
    const jaAgain = await scrapeUrl({ url, mode: 'fast', headers: { 'accept-language': 'ja' } });

    expect(ja.content).toContain('こんにちは');
    expect(en.content).toContain('Hello');
    expect(en.content).not.toContain('こんにちは');
    expect(cached(jaAgain)).toBe(true);
    expect(hits - before).toBe(2);
  });
});

describe('trackingCacheKey', () => {
  const num = '123456789012';

  test('キャリアを明示した照会は、ヒントを渡してもキーが変わらない（ヒントを使わないため）', () => {
    const plain = trackingCacheKey({ carrier: 'yamato' }, num);
    expect(trackingCacheKey({ carrier: 'yamato', preferredCarriers: ['sagawa'], originCountry: 'JP', destinationCountry: 'US' }, num)).toBe(plain);
    expect(trackingCacheKey({ carrier: 'sagawa' }, num)).not.toBe(plain);
  });

  test('自動判別は、判別に渡すヒントが違えば別のキーになる', () => {
    const plain = trackingCacheKey({}, num);
    expect(trackingCacheKey({ carrier: 'auto' }, num)).toBe(plain);

    const variants = [
      trackingCacheKey({ preferredCarriers: ['sagawa'] }, num),
      trackingCacheKey({ preferredCarriers: ['yamato'] }, num),
      trackingCacheKey({ preferredCarriers: ['yamato', 'sagawa'] }, num),
      trackingCacheKey({ originCountry: 'JP' }, num),
      trackingCacheKey({ destinationCountry: 'US' }, num),
    ];
    expect(new Set([plain, ...variants]).size).toBe(variants.length + 1);
  });

  test('優先キャリアの並び順・重複と、空のヒントは区別しない', () => {
    expect(trackingCacheKey({ preferredCarriers: ['sagawa', 'yamato'] }, num)).toBe(trackingCacheKey({ preferredCarriers: ['yamato', 'sagawa', 'yamato'] }, num));
    expect(trackingCacheKey({ preferredCarriers: [], originCountry: ' ', destinationCountry: '' }, num)).toBe(trackingCacheKey({}, num));
  });
});

describe('道路交通のキャッシュキー', () => {
  test('同じ道路コードになる呼び方でも、指定した道路名は別の結果として返す', async () => {
    clearCache();
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('<html><head><title>東名高速道路の交通情報</title></head><body></body></html>');
    }) as unknown as typeof fetch;
    try {
      const short = await fetchRoadTraffic({ road: '東名' });
      const long = await fetchRoadTraffic({ road: '東名高速道路' });
      const shortAgain = await fetchRoadTraffic({ road: '東名' });

      expect(short.road).toBe('東名');
      expect(long.road).toBe('東名高速道路');
      expect(shortAgain.road).toBe('東名');
      expect((shortAgain as { cached?: boolean }).cached).toBe(true);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
      clearCache();
    }
  });
});
