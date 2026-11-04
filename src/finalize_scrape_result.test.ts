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

describe('finalizeScrapeResult: ハイライトの元が長くても（20 万字まで）止まらない', () => {
  // 値の種類・金額・N 日前・「万」・メールの正規表現が、数字・英字が長く続くと、並びの途中のすべての位置から並びの最後まで読んで、
  // 長さの二乗の時間になっていた（20 万桁の数字で数分、20 万字の英字で十数秒）。作った入力で、抽出全体が数秒で終わることを確かめる。
  // 上限の 3 秒は、直した形の単体の時間（Bun 1.4.2 で 0.02〜0.11 秒、1.3.3 で 0.4〜0.7 秒）の 4 倍以上で、前の形（14 秒以上）よりは十分に短い
  const N = 200_000;
  const query = '検索語 テスト';
  const everything = {
    shouldMaskPii: true, safeNormalize: true, annotateTemporal: true, includeDiscrepancies: true, includeDiagnostics: true, verbose: true, reorderUFlat: true,
  };
  const code = (payload: string) => `# 記事\n\n本文です。\n\n## コード\n\n\`\`\`\n${query} ${payload}\n\`\`\`\n`;
  const prose = (payload: string) => `# 記事\n\n本文です。\n\n## 説明\n\n${query} ${payload}\n`;
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['「## コード」の節の 20 万桁の数字', code('1'.repeat(N)), {}],
    ['ふつうの段落の 20 万桁の数字', prose('1'.repeat(N)), {}],
    ['maskPii: 20 万字の英字', prose('a'.repeat(N)), { shouldMaskPii: true }],
    ['maskPii: 10 万字の英字のあとに @ と 10 万字のドメイン', prose(`${'a'.repeat(N / 2)}@${'b'.repeat(N / 2)}`), { shouldMaskPii: true }],
    ['maskPii: a_a_a_…（メールの直後の _ + も読む枝）', prose('a_'.repeat(N / 2)), { shouldMaskPii: true }],
    ['全部の引数あり: 20 万桁の数字', prose('1'.repeat(N)), everything],
    ['全部の引数あり: 20 万桁の全角数字', prose('１'.repeat(N)), everything],
    ['全部の引数あり: カンマ区切りの数字が 20 万字', prose('1,'.repeat(N / 2)), everything],
    ['全部の引数あり: 10 万桁の数字のあとに 10 万字の空白', prose(`${'1'.repeat(N / 2)}${' '.repeat(N / 2)}x`), everything],
  ];
  for (const [name, doc, extra] of cases) {
    test(name, async () => {
      const t0 = performance.now();
      const result = await finalizeScrapeResult(base(doc.slice(0, 15_000)), opts({ query, highlightSource: doc, ...extra }));
      const ms = performance.now() - t0;
      expect(result.highlights?.join('\n')).toContain('検索語');
      expect(ms).toBeLessThan(3000);
    });
  }
});
