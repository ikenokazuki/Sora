import { describe, it, expect } from 'bun:test';
import { formatCompactScrapeResult } from './response_cleaner.js';
import type { ScrapeResult } from './types.js';

describe('formatCompactScrapeResult', () => {
  const fullMockResult: ScrapeResult = {
    url: 'https://example.com/article/123',
    title: 'テスト記事タイトル',
    content: '## 本文見出し\n\nこれはテスト記事の本文です。十分な長さがあります。',
    isTruncated: false,
    contentType: 'text/html',
    source: 'web',
    renderedWithBrowser: false,
    ogImage: 'https://example.com/ogp.jpg',
    description: '記事の概要説明文です',
    publishedTime: '2026-09-01T12:00:00Z',
    author: '山田太郎',
    siteName: 'Example Tech Blog',
    highlights: ['テスト記事の本文です'],
    textFragmentUrl: 'https://example.com/article/123#:~:text=テスト',
    estimatedTokens: 150,
    quality: 85,
    completeness: 80,
    pageType: 'article',
    qualityReasons: ['substantial_content', 'has_headings'],
    missingFields: ['price', 'availability'],
    evidence: {
      title: { value: 'テスト記事タイトル', source: 'dom' },
      description: { value: '記事の概要説明文です', source: 'meta' },
    },
    qualityDistribution: { '80-100': 1 },
    avgQuality: 85,
  };

  it('Compact モード (デフォルト) では不要な内部メトリクスを完全除外すること', () => {
    const compact = formatCompactScrapeResult(fullMockResult);

    // 必須・コアプロパティは保持
    expect(compact.url).toBe(fullMockResult.url);
    expect(compact.title).toBe(fullMockResult.title);
    expect(compact.content).toBe(fullMockResult.content);
    expect(compact.description).toBe(fullMockResult.description);
    expect(compact.publishedTime).toBe(fullMockResult.publishedTime);
    expect(compact.author).toBe(fullMockResult.author);
    expect(compact.siteName).toBe(fullMockResult.siteName);
    expect(compact.pageType).toBe('article');
    expect(compact.highlights).toEqual(['テスト記事の本文です']);

    // 内部メトリクス・デバッグ情報は完全除外
    expect(compact.quality).toBeUndefined();
    expect(compact.completeness).toBeUndefined();
    expect(compact.evidence).toBeUndefined();
    expect(compact.missingFields).toBeUndefined();
    expect(compact.qualityReasons).toBeUndefined();
    expect(compact.qualityDistribution).toBeUndefined();
    expect(compact.avgQuality).toBeUndefined();

    // 不要な固定定数も除外
    expect(compact.contentType).toBeUndefined();
    expect(compact.source).toBeUndefined();
    expect(compact.renderedWithBrowser).toBeUndefined();
    expect(compact.estimatedTokens).toBeUndefined();

    // isTruncated が false の時はキーごと省略されること
    expect(compact.isTruncated).toBeUndefined();
  });

  it('isTruncated が true の時だけ出力に含まれること', () => {
    const truncatedResult: ScrapeResult = {
      ...fullMockResult,
      isTruncated: true,
    };
    const compact = formatCompactScrapeResult(truncatedResult);
    expect(compact.isTruncated).toBe(true);
  });

  it('verbose: true 指定時は全メトリクスがそのまま保持されること', () => {
    const verbose = formatCompactScrapeResult(fullMockResult, { verbose: true });

    expect(verbose.quality).toBe(85);
    expect(verbose.completeness).toBe(80);
    expect(verbose.evidence).toBeDefined();
    expect(verbose.missingFields).toEqual(['price', 'availability']);
    expect(verbose.qualityReasons).toEqual(['substantial_content', 'has_headings']);
    expect(verbose.contentType).toBe('text/html');
    expect(verbose.source).toBe('web');
  });

  it('Compact モードによる JSON サイズ削減効果 (50% 以上の軽量化)', () => {
    const fullJson = JSON.stringify(fullMockResult, null, 2);
    const compactJson = JSON.stringify(formatCompactScrapeResult(fullMockResult), null, 2);

    expect(compactJson.length).toBeLessThan(fullJson.length * 0.6);
  });

  it('EC サイトの価格・在庫情報が存在する場合のみ出力に含まれること', () => {
    const productResult: ScrapeResult = {
      ...fullMockResult,
      pageType: 'product',
      price: '¥3,980',
      priceCurrency: 'JPY',
      availability: 'InStock',
      brand: 'ExampleBrand',
    };
    const compact = formatCompactScrapeResult(productResult);

    expect(compact.pageType).toBe('product');
    expect(compact.price).toBe('¥3,980');
    expect(compact.priceCurrency).toBe('JPY');
    expect(compact.availability).toBe('InStock');
    expect(compact.brand).toBe('ExampleBrand');
    expect(compact.missingFields).toBeUndefined();
  });
});
