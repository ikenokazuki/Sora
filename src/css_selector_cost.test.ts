import { describe, expect, test } from 'bun:test';
import { findCostlySelector } from './css_selector_cost.js';
import { ScrapeInputError } from './errors.js';
import { assertScrapeInputs } from './scraper.js';

// removeSelectors・selectors は、取得したページをメインスレッドで読む（cheerio）。段を重ねると、小さいページでも時間が掛け算で伸びる形は、取得の前に断る
// （実測: 1KB のページで :has の入れ子 4 段が 2 秒・段ごとに約 10 倍。兄弟 100 個で ~ 4 つが 0.8 秒・300 個で 3 つが 3 秒・1,000 個では終わらない）

describe('findCostlySelector', () => {
  test(':has の入れ子は断る（:not などを挟んでも同じ）', () => {
    for (const selector of ['div:has(div:has(q))', 'div:has(:not(:has(a)))', ':is(p:has(span:has(b)))', 'DIV:HAS(P:HAS(A))', 'a, div:has(div:has(q))']) {
      expect(findCostlySelector([selector]), selector).toEqual({ selector, reason: ':has の中に :has は書けません' });
    }
  });

  test('1 つの組み立てに ~ が 2 つ以上は断る（:has などの中の ~ も数える）', () => {
    for (const selector of ['q ~ p ~ p', 'h2 ~ p ~ ul li', 'a ~ b:has(~ c)', 'div:has(~ p ~ p)', 'a ~ b:not(c ~ d)', 'x, a ~ b ~ c']) {
      expect(findCostlySelector([selector]), selector).toEqual({ selector, reason: '1 つのセレクタに ~ は 1 つまでです' });
    }
  });

  test('ふつうの形は通す。カンマで並べた物は足し算なので、それぞれで数える', () => {
    for (const selector of [
      '.ads', '#cookie-banner', '[class*="badge-sold-out" i]', 'div > p + p', 'li:nth-child(2n)', 'p:last-of-type',
      'div:has(a)', 'div:has(> a):has(img)', 'article div:has(figure) img', 'h2 ~ p', 'a ~ b, c ~ d', ':is(a ~ b, c ~ d) e',
      'p:not(.a):not(.b)', '[data-x=":has(:has("]', 'p:contains(":has(a ~ b ~ c)")',
    ]) {
      expect(findCostlySelector([selector]), selector).toBeUndefined();
    }
  });

  test('読めないセレクタは、ここでは断らない（今までどおりの検査が扱う）', () => {
    expect(findCostlySelector(['div:has(', '[', 'a@href'])).toBeUndefined();
  });
});

describe('取得の入力の検査（assertScrapeInputs）', () => {
  test('removeSelectors の重い形は、取得の前に ScrapeInputError', () => {
    expect(() => assertScrapeInputs({ removeSelectors: ['.ads', 'div:has(div:has(q))'] })).toThrow(ScrapeInputError);
    expect(() => assertScrapeInputs({ removeSelectors: ['div:has(div:has(q))'] })).toThrow('removeSelectors の "div:has(div:has(q))" は使えません: :has の中に :has は書けません');
  });

  test('selectors の値（監視の selector もここを通る）も同じ。@属性の指定は外して調べる', () => {
    expect(() => assertScrapeInputs({ selectors: { content: 'q ~ p ~ p' } })).toThrow('selectors の "q ~ p ~ p" は使えません: 1 つのセレクタに ~ は 1 つまでです');
    expect(() => assertScrapeInputs({ selectors: { link: 'div:has(a:has(b))@href' } })).toThrow('selectors の "div:has(a:has(b))" は使えません: :has の中に :has は書けません');
    expect(() => assertScrapeInputs({ selectors: { link: 'div:has(a) a@href', price: '.price' } })).not.toThrow();
  });
});
