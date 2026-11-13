import { afterEach, describe, expect, test } from 'bun:test';
import { app } from './index.js';
import { ScrapeInputError } from './errors.js';
import { assertCrawlInputs, assertScrapeInputs, crawlSiteUrl } from './scraper.js';
import { STANDARD_LIMITS, STRICT_LIMITS } from './security/limits.js';

/**
 * 利用者の文字列から作るもの（crawl のパターン・scrape のセレクタ）の、個数と長さの上限（設計 6。穴 21）。
 * 上限は水準（SORA_ISOLATION）で決まる。入力の誤りとして、取得の前に断る（REST では 400）。
 */

const previous = process.env.SORA_ISOLATION;
afterEach(() => {
  if (previous === undefined) delete process.env.SORA_ISOLATION;
  else process.env.SORA_ISOLATION = previous;
});
const level = (value: 'standard' | 'strict') => {
  process.env.SORA_ISOLATION = value;
};
const many = (n: number, make: (i: number) => string = (i) => `p${i}`) => Array.from({ length: n }, (_, i) => make(i));

describe('assertCrawlInputs（includePatterns・excludePatterns）', () => {
  test('strict: 20 個まで通り、21 個目で断る（include・exclude それぞれ）', () => {
    level('strict');
    expect(() => assertCrawlInputs({ includePatterns: many(STRICT_LIMITS.patternCount) })).not.toThrow();
    expect(() => assertCrawlInputs({ excludePatterns: many(STRICT_LIMITS.patternCount) })).not.toThrow();
    expect(() => assertCrawlInputs({ includePatterns: many(STRICT_LIMITS.patternCount + 1) })).toThrow(ScrapeInputError);
    expect(() => assertCrawlInputs({ excludePatterns: many(STRICT_LIMITS.patternCount + 1) })).toThrow(/excludePatterns は 20 個まで/);
    expect(() => assertCrawlInputs({ includePatterns: many(21) })).toThrow(/includePatterns は 20 個まで/);
  });

  test('strict: 1 つが 200 文字まで通り、201 文字で断る', () => {
    level('strict');
    expect(() => assertCrawlInputs({ includePatterns: ['a'.repeat(STRICT_LIMITS.patternLength)] })).not.toThrow();
    expect(() => assertCrawlInputs({ includePatterns: ['a'.repeat(STRICT_LIMITS.patternLength + 1)] })).toThrow(/includePatterns の 1 つは 200 文字まで/);
    expect(() => assertCrawlInputs({ excludePatterns: ['ok', 'a'.repeat(STRICT_LIMITS.patternLength + 1)] })).toThrow(/excludePatterns の 1 つは 200 文字まで/);
  });

  test('standard: 緩い値（100 個・1000 文字）まで通る。超えたら断る', () => {
    level('standard');
    expect(() => assertCrawlInputs({ includePatterns: many(STANDARD_LIMITS.patternCount), excludePatterns: ['a'.repeat(STANDARD_LIMITS.patternLength)] })).not.toThrow();
    expect(() => assertCrawlInputs({ includePatterns: many(STANDARD_LIMITS.patternCount + 1) })).toThrow(ScrapeInputError);
    expect(() => assertCrawlInputs({ includePatterns: ['a'.repeat(STANDARD_LIMITS.patternLength + 1)] })).toThrow(ScrapeInputError);
  });

  test('パターンが無ければ、何もしない', () => {
    level('strict');
    expect(() => assertCrawlInputs({})).not.toThrow();
    expect(() => assertCrawlInputs({ includePatterns: [], excludePatterns: undefined })).not.toThrow();
  });
});

describe('crawlSiteUrl 自身も検査する（MCP の crawl_site は、REST のルートを通らない）', () => {
  test('strict: パターンが多い・長いと、取得の前に ScrapeInputError', async () => {
    level('strict');
    await expect(crawlSiteUrl({ url: 'https://example.com/', tenantId: 'name:input-limits', includePatterns: many(21) })).rejects.toBeInstanceOf(ScrapeInputError);
    await expect(crawlSiteUrl({ url: 'https://example.com/', tenantId: 'name:input-limits', excludePatterns: ['a'.repeat(201)] })).rejects.toBeInstanceOf(ScrapeInputError);
  });
});

describe('assertScrapeInputs（selectors・removeSelectors・clipSelector）', () => {
  test('strict: removeSelectors は 20 個まで', () => {
    level('strict');
    expect(() => assertScrapeInputs({ removeSelectors: many(STRICT_LIMITS.selectorCount, (i) => `.r${i}`) })).not.toThrow();
    expect(() => assertScrapeInputs({ removeSelectors: many(STRICT_LIMITS.selectorCount + 1, (i) => `.r${i}`) })).toThrow(/removeSelectors は 20 個まで/);
  });

  test('strict: selectors（名前つきの抽出）は 20 個まで', () => {
    level('strict');
    const make = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, `.s${i}`]));
    expect(() => assertScrapeInputs({ selectors: make(STRICT_LIMITS.selectorCount) })).not.toThrow();
    expect(() => assertScrapeInputs({ selectors: make(STRICT_LIMITS.selectorCount + 1) })).toThrow(/selectors は 20 個まで/);
  });

  test('strict: セレクタ 1 つは 500 文字まで（removeSelectors・selectors の値・clipSelector）', () => {
    level('strict');
    const ok = `.${'a'.repeat(STRICT_LIMITS.selectorLength - 1)}`;
    const long = `.${'a'.repeat(STRICT_LIMITS.selectorLength)}`;
    expect(() => assertScrapeInputs({ removeSelectors: [ok], selectors: { k: ok }, clipSelector: ok })).not.toThrow();
    expect(() => assertScrapeInputs({ removeSelectors: [long] })).toThrow(/removeSelectors の 1 つは 500 文字まで/);
    expect(() => assertScrapeInputs({ selectors: { k: long } })).toThrow(/selectors の 1 つは 500 文字まで/);
    expect(() => assertScrapeInputs({ clipSelector: long })).toThrow(/clipSelector は 500 文字まで/);
  });

  test('standard: 緩い値（100 個・2000 文字）まで通る。超えたら断る', () => {
    level('standard');
    expect(() => assertScrapeInputs({ removeSelectors: many(STANDARD_LIMITS.selectorCount, (i) => `.r${i}`) })).not.toThrow();
    expect(() => assertScrapeInputs({ removeSelectors: many(STANDARD_LIMITS.selectorCount + 1, (i) => `.r${i}`) })).toThrow(ScrapeInputError);
    expect(() => assertScrapeInputs({ clipSelector: `.${'a'.repeat(STANDARD_LIMITS.selectorLength)}` })).toThrow(ScrapeInputError);
  });

  test('これまでの検査（fastOnly と renderJs の同時指定・読めない CSS セレクタ）は、そのまま', () => {
    level('strict');
    expect(() => assertScrapeInputs({ fastOnly: true, renderJs: true })).toThrow(/fastOnly と renderJs/);
    expect(() => assertScrapeInputs({ removeSelectors: ['[[['] })).toThrow(ScrapeInputError);
  });
});

describe('REST: 上限を超えた入力は 400（INVALID_INPUT）で、取得の前に断る', () => {
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('POST /crawl: パターンが多い・長い', async () => {
    level('strict');
    const tooMany = await post('/crawl', { url: 'https://example.com/', includePatterns: many(21) });
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { code: string }).code).toBe('INVALID_INPUT');
    const tooLong = await post('/crawl', { url: 'https://example.com/', excludePatterns: ['a'.repeat(201)] });
    expect(tooLong.status).toBe(400);
  });

  test('POST /crawl/stream: ストリームを開く前に 400', async () => {
    level('strict');
    const res = await post('/crawl/stream', { url: 'https://example.com/', includePatterns: many(21) });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('POST /scrape: セレクタが多い', async () => {
    level('strict');
    const res = await post('/scrape', { url: 'https://example.com/', removeSelectors: many(21, (i) => `.r${i}`) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_INPUT');
  });
});
