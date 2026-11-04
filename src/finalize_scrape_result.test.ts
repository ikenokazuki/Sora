import { describe, expect, test } from 'bun:test';
import { finalizeScrapeResult } from './scraper.js';
import type { ScrapeResult } from './types.js';

const base = (content: string, extra: Partial<ScrapeResult> = {}): ScrapeResult => ({
  url: 'https://example.com/p', title: 't', content, isTruncated: true, contentType: 'text/html', source: 'web', ...extra,
});
const opts = (extra: Record<string, unknown> = {}) => ({
  query: '開場時間',
  shouldExtractHighlights: true,
  shouldExtractSummary: false,
  shouldExtractCitations: false,
  shouldChunkMarkdown: false,
  chunkSize: 1000,
  shouldValidateLinks: false,
  shouldFormatAsPrompt: false,
  shouldHighlightMatches: false,
  shouldMaskPii: false,
  ...extra,
});

describe('finalizeScrapeResult のハイライト', () => {
  const tail = '## 当日の案内\n\n開場時間は 17:00、開演は 18:00 です。';
  const full = `${'## 前書き\n\n関係のない文が続きます。\n\n'.repeat(50)}${tail}`;

  test('切る前の全文から選ぶ（content は切ったまま）', async () => {
    const content = full.slice(0, 200);
    const result = await finalizeScrapeResult(base(content), opts({ highlightSource: full }));
    expect(result.content).toBe(content);
    expect(result.highlights?.join('\n')).toContain('開場時間は 17:00');
    expect('highlightSource' in result).toBe(false);
  });

  test('maskPii は全文にも当てる', async () => {
    const withMail = `${full}\n\n## 問い合わせ\n\n開場時間の問い合わせは info@example.com まで。`;
    const result = await finalizeScrapeResult(base(withMail.slice(0, 200)), opts({ highlightSource: withMail, shouldMaskPii: true, query: '開場時間 問い合わせ' }));
    expect(result.highlights?.join('\n')).toContain('問い合わせ');
    expect(result.highlights?.join('\n')).not.toContain('info@example.com');
  });

  test('annotateTemporal はハイライトにも注記を付け、ページの中の位置（textFragmentUrl）には注記を入れない', async () => {
    // 基準の日時は、テストを走らせる場所の時間帯の正午（日付の計算はその時間帯で行うため）
    const result = await finalizeScrapeResult(
      base('## 案内\n\n開場時間は明日の 17:00 です。', { publishedTime: new Date(2026, 10, 4, 12).toISOString() }),
      opts({ annotateTemporal: true }),
    );
    expect(result.highlights?.[0]).toContain('明日 [2026-11-05]');
    expect(decodeURIComponent(result.textFragmentUrl ?? '')).not.toContain('2026-11-05');
  });

  test('description はハイライトで置き換えない', async () => {
    expect((await finalizeScrapeResult(base(tail, { description: 'サイトの説明' }), opts())).description).toBe('サイトの説明');
    expect((await finalizeScrapeResult(base(tail), opts())).description).toBeUndefined();
  });
});
