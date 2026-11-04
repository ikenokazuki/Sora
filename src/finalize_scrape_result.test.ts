import { describe, expect, test } from 'bun:test';
import { capHighlightItems, finalizeScrapeResult } from './scraper.js';
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

describe('finalizeScrapeResult: ハイライトの合計は maxChars に収まる', () => {
  // ハイライトは全文から選ぶので、窓で切らない表・コードの節や、文が 1 つの節は、全文の字数のまま選ばれる（120,000 字の表の節で 120,000 字のハイライト）。
  // 要求の maxChars を渡したときは、つないだ字数（区切りの分も数える）が maxChars に収まるように、短いハイライトを先に確保して、長いものを切る。
  // maxChars を渡さないときは切らない
  const SEP = '\n\n---\n\n';
  const query = '開場時間 料金';
  const sum = (hs: string[] | undefined) => (hs ?? []).join(SEP).length;
  const rows = (cell: (i: number) => string, size = 120_000) => {
    let out = '';
    for (let i = 0; out.length < size; i++) out += `${cell(i)}\n`;
    return out;
  };
  const huge: Array<[string, string]> = [
    ['表の節', `# 公演案内\n\n## 料金表\n\n| 項目 | 内容 |\n|---|---|\n${rows((i) => `| 開場時間 ${i} | 料金 ${i} 円 |`)}`],
    ['コードの節', `# 公演案内\n\n## コード\n\n\`\`\`\n${rows((i) => `開場時間 ${i} 料金 ${i} const x${i} = ${i};`)}\`\`\`\n`],
    ['文が 1 つの節', `# 公演案内\n\n## 長い文\n\n開場時間 料金 ${'あ'.repeat(120_000)}\n`],
  ];
  for (const [name, doc] of huge) {
    test(`${name}: 120,000 字の節は、maxChars 15,000 で合計 15,000 字以内に切る（指定が無ければ切らない）`, async () => {
      const whole = await finalizeScrapeResult(base(doc.slice(0, 15_000)), opts({ query, highlightSource: doc }));
      expect(sum(whole.highlights)).toBeGreaterThan(100_000);

      const capped = await finalizeScrapeResult(base(doc.slice(0, 15_000)), opts({ query, highlightSource: doc, maxChars: 15_000 }));
      expect(capped.highlights?.length).toBeGreaterThan(0);
      expect(sum(capped.highlights)).toBeLessThanOrEqual(15_000);
      // 後ろを切るので、書き出し（見出しと最初の行）は同じ。コードの節は、切ったあとにコードブロックを閉じる
      expect(capped.highlights?.[0].slice(0, 1000)).toBe(whole.highlights?.[0].slice(0, 1000));
      expect(((capped.highlights?.join('') ?? '').match(/```/g) ?? []).length % 2).toBe(0);
      expect(capped.highlightItems?.map((item) => item.text)).toEqual(capped.highlights);
      expect(capped.highlightItems?.[0].score).toBe(whole.highlightItems?.[0].score);
    }, 30_000);
  }

  test('短いハイライトは丸ごと残し、巨大なハイライトをその残りの字数に切る', async () => {
    // 短い節 2 つのあとに、巨大な表の節（料金だけが合う）が 3 番目に選ばれる
    const doc = [
      '# 公演案内',
      '## 当日の案内\n\n開場時間は 17:00、開演は 18:00 です。料金は前売 5,000 円です。',
      `## 料金表\n\n| 項目 | 内容 |\n|---|---|\n${rows((i) => `| 項目 ${i} | 料金 ${i} 円 |`)}`,
      '## 注意事項\n\n開場時間より前の入場はできません。料金の払い戻しは行いません。',
      '## アクセス\n\n最寄り駅から徒歩 5 分です。',
    ].join('\n\n');
    const run = (extra: Record<string, unknown> = {}) => finalizeScrapeResult(base(doc.slice(0, 15_000)), opts({ query, highlightSource: doc, ...extra }));
    const whole = (await run()).highlights ?? [];
    expect(whole.map((h) => h.length > 1000)).toEqual([false, false, true]);

    // 前の 2 つは丸ごと、3 番目の表は残りの字数（表の行の途中は落とす）
    const room = 1000;
    const maxChars = whole[0].length + SEP.length + whole[1].length + SEP.length + room;
    const capped = await run({ maxChars });
    expect(capped.highlights?.slice(0, 2)).toEqual(whole.slice(0, 2));
    expect(capped.highlights?.length).toBe(3);
    expect(whole[2].startsWith(capped.highlights?.[2] ?? '\0')).toBe(true);
    expect(capped.highlights?.[2].length).toBeLessThanOrEqual(room);
    expect(capped.highlights?.[2].length).toBeGreaterThan(room - 100);
    expect(sum(capped.highlights)).toBeLessThanOrEqual(maxChars);
    expect(capped.highlightItems?.map((item) => item.text)).toEqual(capped.highlights);
  }, 30_000);

  test('点で 1 位の巨大な表があっても、表より前にある短い答えの節を落とさない（表をその残りで切る）', async () => {
    // 表（開場時間も料金も合う）が 1 位、短い答えの節は表より前の位置。本文を先頭 15,000 字で切って選んでいた base は、この 2 つを両方返していた
    const doc = [
      '# 公演案内',
      '## 当日の案内\n\n開場時間は 17:00、開演は 18:00 です。料金は前売 5,000 円です。',
      `## 料金表\n\n| 項目 | 内容 |\n|---|---|\n${rows((i) => `| 開場時間 ${i} | 料金 ${i} 円 |`, 60_000)}`,
      '## 注意事項\n\n開場時間より前の入場はできません。料金の払い戻しは行いません。',
      '## アクセス\n\n最寄り駅から徒歩 5 分です。',
    ].join('\n\n');
    const run = (extra: Record<string, unknown> = {}) => finalizeScrapeResult(base(doc.slice(0, 15_000)), opts({ query, highlightSource: doc, ...extra }));
    const whole = await run();
    expect(whole.highlights?.map((h) => h.length > 1000)).toEqual([true, false]);

    const capped = await run({ maxChars: 15_000 });
    expect(capped.highlights?.length).toBe(2);
    expect(capped.highlights?.[1]).toBe(whole.highlights?.[1]);
    expect(capped.highlights?.[1]).toContain('17:00');
    expect(whole.highlights?.[0].startsWith(capped.highlights?.[0] ?? '\0')).toBe(true);
    // 表は、短い節と区切りを引いた残りをほぼ使う（表の行の途中は落とす）
    expect(capped.highlights?.[0].length).toBeGreaterThan(15_000 - SEP.length - (whole.highlights?.[1].length ?? 0) - 100);
    expect(sum(capped.highlights)).toBeLessThanOrEqual(15_000);
    expect(capped.highlightItems?.map((item) => item.text)).toEqual(capped.highlights);
    expect(capped.highlightItems?.map((item) => item.score)).toEqual(whole.highlightItems?.map((item) => item.score));
  }, 30_000);

  test('onlyHighlights の content（ハイライトを区切りでつないだもの）も maxChars を超えない', async () => {
    const doc = huge[0][1];
    const result = await finalizeScrapeResult(base(doc.slice(0, 15_000)), opts({ query, highlightSource: doc, shouldOnlyHighlights: true, maxChars: 15_000 }));
    expect(result.content.length).toBeLessThanOrEqual(15_000);
    expect(result.content.length).toBeGreaterThan(14_000);
    expect(result.characterCount).toBe(result.content.length);
  }, 30_000);

  test('補完の証拠（スニペット）のハイライトも maxChars を超えない', async () => {
    const result = await finalizeScrapeResult(base('関係のない本文です。'), opts({ query: '開場時間', snippet: '開場時間は 17:00 です。'.repeat(20), maxChars: 50 }));
    expect(result.highlights?.length).toBe(1);
    expect(result.highlights?.[0].startsWith('> 📌 **補完証拠 (スニペット)**')).toBe(true);
    expect(result.highlights?.[0].length).toBe(50);
    expect(result.highlightItems?.[0].text).toBe(result.highlights?.[0]);
    expect(decodeURIComponent(result.textFragmentUrl ?? '')).toContain('補完証拠');
  });

  test('ふつうの長さのハイライトは、maxChars があっても変わらない', async () => {
    const doc = `${'## 前書き\n\n関係のない文が続きます。\n\n'.repeat(50)}## 当日の案内\n\n開場時間は 17:00、開演は 18:00 です。`;
    const without = await finalizeScrapeResult(base(doc.slice(0, 200)), opts({ highlightSource: doc }));
    const withMax = await finalizeScrapeResult(base(doc.slice(0, 200)), opts({ highlightSource: doc, maxChars: 15_000 }));
    expect(withMax.highlights).toEqual(without.highlights);
    expect(withMax.highlightItems).toEqual(without.highlightItems);
    expect(withMax.textFragmentUrl).toBe(without.textFragmentUrl);
  });
});

describe('capHighlightItems: 短いものを先に確保し、残りを長いものに分ける', () => {
  // 予算 = maxChars − 区切り（7 字）×（件数 − 1）。長さの短い順に、自分の長さと「残りの予算 ÷ 残りの件数（切り捨て）」の小さいほうを割り当てる。
  // 割り当てが長さより短いものだけ切り、並びは変えない
  const SEP = '\n\n---\n\n';
  const make = (...lengths: number[]) => lengths.map((n, i) => ({ text: 'abcdefghij'[i % 10].repeat(n), score: i }));

  test.each([
    [[10, 100, 1000], 1000, [10, 100, 876]], // 短い 2 つは丸ごと。長いものが残りを使う
    [[10, 100, 1000], 200, [10, 88, 88]], // 長い 2 つが、残りを等分する
    [[100, 100, 100], 100, [28, 29, 29]], // 切り捨ての端数は、先に見る（同じ長さなら前の）ものが少ない
    [[10, 100], 117, [10, 100]], // ちょうど収まれば切らない
    [[10, 100], 116, [10, 99]],
    [[1000], 100, [100]],
    [[100, 100, 100], 17, [1, 1, 1]], // 予算（17 − 区切り 14）が件数と同じなら、1 字ずつ
    [[100, 100, 100], 16, [16]], // 区切りの分も入らないほど小さければ、先頭の 1 件だけを maxChars で切る
    [[100, 100, 100], 0, []],
  ] as Array<[number[], number, number[]]>)('長さ %j を maxChars %d に収める → %j', (lengths, maxChars, expected) => {
    const capped = capHighlightItems(make(...lengths), maxChars);
    expect(capped.map((item) => item.text.length)).toEqual(expected);
    expect(capped.map((item) => item.text).join(SEP).length).toBeLessThanOrEqual(maxChars);
  });

  test('収まるときは同じ配列を返し、切らないものは同じ項目のまま。切ったものは text だけが変わる', () => {
    const items = make(10, 100);
    expect(capHighlightItems(items, 117)).toBe(items);
    const capped = capHighlightItems(make(10, 100, 1000), 200);
    expect(capped[0]).toEqual({ text: 'a'.repeat(10), score: 0 });
    expect(capped[2]).toEqual({ text: 'c'.repeat(88), score: 2 });
  });

  test('並びは変えない: U 字（1 位・3 位・2 位）に並んでいても、末尾（2 位）を落とさない', () => {
    const capped = capHighlightItems([
      { text: 'a'.repeat(58), score: 3 },
      { text: 'c'.repeat(120_000), score: 1 },
      { text: 'b'.repeat(47), score: 2 },
    ], 15_000);
    expect(capped.map((item) => item.text.length)).toEqual([58, 14_881, 47]);
    expect(capped.map((item) => item.score)).toEqual([3, 1, 2]);
    expect(capped.map((item) => item.text).join(SEP).length).toBe(15_000);
  });

  test('切った結果が空白だけになったものは外す', () => {
    const capped = capHighlightItems([{ text: ' '.repeat(50) + 'x'.repeat(50), score: 1 }, { text: 'y'.repeat(100), score: 2 }], 40);
    expect(capped).toEqual([{ text: 'y'.repeat(17), score: 2 }]);
  });
});
