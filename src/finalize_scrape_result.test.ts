import { describe, expect, test } from 'bun:test';
import { HIGHLIGHT_CHAR_BUDGET } from './enrichment.js';
import { capHighlightItems, finalizeScrapeResult } from './scraper.js';
import type { ScrapeResult } from './types.js';

const base = (content: string, extra: Partial<ScrapeResult> = {}): ScrapeResult => ({
  url: 'https://example.com/p', title: 't', content, isTruncated: true, contentType: 'text/html', source: 'web', ...extra,
});
const opts = (extra: Record<string, unknown> = {}) => ({
  query: '開場時間',
  shouldExtractHighlights: true,
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
    // 先に textFragmentUrl があることを確かめる（無いときに `?? ''` で通らないように）
    expect(result.textFragmentUrl).toContain('#:~:text=');
    expect(decodeURIComponent(result.textFragmentUrl as string)).toContain('明日の');
    expect(decodeURIComponent(result.textFragmentUrl as string)).not.toContain('2026-11-05');
  });

  test('shouldOnlyHighlights（responseMode: evidence の内部の形）は、ハイライトがあれば content をハイライトに置き換える', async () => {
    const text = '## 当日の案内\n\n開場時間は 17:00、開演は 18:00 です。\n\n## ほか\n\n関係のない文。';
    const result = await finalizeScrapeResult(base(text), opts({ shouldOnlyHighlights: true }));
    expect(result.content).toContain('開場時間は 17:00');
    expect(result.content).not.toContain('関係のない文');
  });

  test('description はハイライトで置き換えない', async () => {
    expect((await finalizeScrapeResult(base(tail, { description: 'サイトの説明' }), opts())).description).toBe('サイトの説明');
    expect((await finalizeScrapeResult(base(tail), opts())).description).toBeUndefined();
  });
});

describe('finalizeScrapeResult: maskPii は応答に出る文字列すべてに当てる', () => {
  const mail = 'info@example.com';
  const tel = '03-1234-5678';
  const page = () => base(`連絡先は ${mail} です。`, {
    title: `問い合わせ ${mail}`,
    description: `電話 ${tel}`,
    html: `<p>${mail}</p>`,
    rawHtml: `<a href="mailto:${mail}">${tel}</a>`,
    tables: [{ caption: `担当 ${mail}`, headers: ['名前', `連絡先 ${tel}`], rows: [{ 名前: '田中', [`連絡先 ${tel}`]: tel }] }],
    extracted: { mail, none: null },
  });

  test('html・rawHtml・title・description・tables・extracted もマスクする', async () => {
    const result = await finalizeScrapeResult(page(), opts({ shouldExtractHighlights: false, shouldMaskPii: true }));
    const json = JSON.stringify(result);
    expect(json).not.toContain(mail);
    expect(json).not.toContain(tel);
    expect(result.title).toBe('問い合わせ [EMAIL]');
    expect(result.description).toBe('電話 [PHONE]');
    expect(result.html).toBe('<p>[EMAIL]</p>');
    expect(result.rawHtml).toBe('<a href="mailto:[EMAIL]">[PHONE]</a>');
    expect(result.tables).toEqual([{ caption: '担当 [EMAIL]', headers: ['名前', '連絡先 [PHONE]'], rows: [{ 名前: '田中', '連絡先 [PHONE]': '[PHONE]' }] }]);
    expect(result.extracted).toEqual({ mail: '[EMAIL]', none: null });
  });

  test('jsonLd・events・links・author・images の alt・evidence・breadcrumb にもかける（URL や日付は変えない）', async () => {
    const result = await finalizeScrapeResult(base('本文です。', {
      author: `担当 ${mail}`,
      siteName: `${mail} の店`,
      jsonLd: [{ '@type': 'Organization', url: 'https://example.com/', contactPoint: { email: mail, telephone: tel, nested: [{ note: `連絡は ${mail}` }] } }],
      events: [{ name: '公演', startDate: '2026-04-19T06:20:00Z', url: 'https://example.com/e/1', location: `会場 ${tel}`, performer: mail, offers: { price: '5000', url: 'https://example.com/t' } }],
      links: ['https://example.com/a', `mailto:${mail}`, `tel:${tel.replaceAll('-', '')}`, 'https://example.com/items/42'],
      images: [{ url: 'https://example.com/a.png', alt: `連絡先 ${mail}`, title: tel, caption: `電話 ${tel}`, width: 10 }],
      breadcrumb: ['トップ', `店 ${tel}`],
      evidence: { title: { value: `${mail} の案内`, source: 'meta' } },
    }), opts({ shouldExtractHighlights: false, shouldMaskPii: true }));
    const json = JSON.stringify(result);
    expect(json).not.toContain(mail);
    expect(json).not.toContain(tel);
    expect(json).not.toContain('0312345678');
    expect(result.author).toBe('担当 [EMAIL]');
    expect(result.jsonLd).toEqual([{ '@type': 'Organization', url: 'https://example.com/', contactPoint: { email: '[EMAIL]', telephone: '[PHONE]', nested: [{ note: '連絡は [EMAIL]' }] } }]);
    expect(result.events).toEqual([{ name: '公演', startDate: '2026-04-19T06:20:00Z', url: 'https://example.com/e/1', location: '会場 [PHONE]', performer: '[EMAIL]', offers: { price: '5000', url: 'https://example.com/t' } }]);
    expect(result.links).toEqual(['https://example.com/a', 'mailto:[EMAIL]', 'tel:[PHONE]', 'https://example.com/items/42']);
    expect(result.images).toEqual([{ url: 'https://example.com/a.png', alt: '連絡先 [EMAIL]', title: '[PHONE]', caption: '電話 [PHONE]', width: 10 }]);
    expect(result.breadcrumb).toEqual(['トップ', '店 [PHONE]']);
    expect(result.evidence).toEqual({ title: { value: '[EMAIL] の案内', source: 'meta' } });
  });

  test('PDF のメタデータと、動画のチャプターの題にもかける（時刻・秒・作成日時は変えない）', async () => {
    const result = await finalizeScrapeResult(base('本文です。', {
      metadata: { Author: `田中 ${mail}`, Producer: 'Writer', CreationDate: 'D:20260105120000+09\'00\'', totalPages: 3 },
      media: { type: 'youtube', videoId: 'v1', chapters: [{ title: `問い合わせ ${tel}`, time: '1:23', seconds: 83 }] },
    }), opts({ shouldExtractHighlights: false, shouldMaskPii: true }));
    expect(result.metadata).toEqual({ Author: '田中 [EMAIL]', Producer: 'Writer', CreationDate: 'D:20260105120000+09\'00\'', totalPages: 3 });
    expect(result.media).toEqual({ type: 'youtube', videoId: 'v1', chapters: [{ title: '問い合わせ [PHONE]', time: '1:23', seconds: 83 }] });
  });

  test('maskPii でなければ、そのまま返す', async () => {
    const result = await finalizeScrapeResult(page(), opts({ shouldExtractHighlights: false, shouldMaskPii: false }));
    expect(result.html).toBe(`<p>${mail}</p>`);
    expect(result.rawHtml).toContain(mail);
    expect(result.extracted?.mail).toBe(mail);
  });

  test('description を補完証拠のハイライトにする場合も、マスクのあとの値を使う', async () => {
    const result = await finalizeScrapeResult(
      base('関係のない本文です。', { description: `開場時間の問い合わせは ${mail}` }),
      opts({ shouldMaskPii: true, query: '開場時間 問い合わせ' }),
    );
    expect(JSON.stringify(result.highlights)).not.toContain(mail);
  });
});

describe('finalizeScrapeResult: ハイライトの元が長くても（20 万字まで）止まらない', () => {
  // 値の種類・N 日前（annotateTemporal）・メール（maskPii）の正規表現が、数字・英字が長く続くと、並びの途中のすべての位置から並びの最後まで読んで、
  // 長さの二乗の時間になっていた（20 万桁の数字で数分、20 万字の英字で十数秒）。作った入力で、抽出全体が数秒で終わることを確かめる。
  // 上限の 3 秒は、直した形の単体の時間（Bun 1.4.2 で 0.02〜0.11 秒、1.3.3 で 0.4〜0.7 秒）の 4 倍以上で、前の形（14 秒以上）よりは十分に短い
  const N = 200_000;
  const query = '検索語 テスト';
  // maskPii・annotateTemporal・verbose を同時に付けた形
  const withOptions = {
    shouldMaskPii: true, annotateTemporal: true, verbose: true,
  };
  const code = (payload: string) => `# 記事\n\n本文です。\n\n## コード\n\n\`\`\`\n${query} ${payload}\n\`\`\`\n`;
  const prose = (payload: string) => `# 記事\n\n本文です。\n\n## 説明\n\n${query} ${payload}\n`;
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['「## コード」の節の 20 万桁の数字', code('1'.repeat(N)), {}],
    ['ふつうの段落の 20 万桁の数字', prose('1'.repeat(N)), {}],
    ['maskPii: 20 万字の英字', prose('a'.repeat(N)), { shouldMaskPii: true }],
    ['maskPii: 10 万字の英字のあとに @ と 10 万字のドメイン', prose(`${'a'.repeat(N / 2)}@${'b'.repeat(N / 2)}`), { shouldMaskPii: true }],
    ['maskPii: a_a_a_…（メールの直後の _ + も読む枝）', prose('a_'.repeat(N / 2)), { shouldMaskPii: true }],
    ['maskPii・annotateTemporal・verbose あり: 20 万桁の数字', prose('1'.repeat(N)), withOptions],
    ['maskPii・annotateTemporal・verbose あり: 20 万桁の全角数字', prose('１'.repeat(N)), withOptions],
    ['maskPii・annotateTemporal・verbose あり: カンマ区切りの数字が 20 万字', prose('1,'.repeat(N / 2)), withOptions],
    ['maskPii・annotateTemporal・verbose あり: 10 万桁の数字のあとに 10 万字の空白', prose(`${'1'.repeat(N / 2)}${' '.repeat(N / 2)}x`), withOptions],
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
  // 要求の maxChars を渡したときは、つないだ字数（区切りの分も数える）が maxChars に収まるように、ふつうのハイライトを前から丸ごと確保して、
  // 残りで巨大なものを切る。maxChars を渡さないときは切らない
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

  test('合計より小さい maxChars でも、ふつうの窓つきのハイライトは前から丸ごと残る（等分に切って答えを失わない）', async () => {
    // 答えが各ハイライトの後半にある、同じ長さのハイライトが 3 件（窓で切った節。巨大なものは無い）
    const filler = (tag: string, n: number) => `${tag}の案内です。`.repeat(Math.ceil(n / (tag.length + 6))).slice(0, n);
    const doc = `# 公演案内\n\n${[1, 2, 3].map((i) => `## 会場${i}\n\n${filler(`会場${i}の説明`, 500)}開場時間は ANS${i} です。${filler(`会場${i}の注意`, 600)}`).join('\n\n')}`;
    const run = (extra: Record<string, unknown> = {}) => finalizeScrapeResult(base(doc.slice(0, 15_000)), opts({ query: '開場時間', highlightSource: doc, ...extra }));
    const whole = (await run()).highlights ?? [];
    expect(whole.length).toBe(3);
    expect(whole.every((h) => h.length <= HIGHLIGHT_CHAR_BUDGET && /ANS\d/.test(h))).toBe(true);
    const answers = (hs: string[]) => hs.join('').match(/ANS\d/g) ?? [];

    // 前の 2 件が丸ごと入り、3 件目は残りの 50 字で切れる（答えは前の 2 件のもの）
    const twoMax = whole[0].length + SEP.length + whole[1].length + SEP.length + 50;
    const two = await run({ maxChars: twoMax });
    expect(two.highlights?.slice(0, 2)).toEqual(whole.slice(0, 2));
    expect(two.highlights?.length).toBe(3);
    expect(whole[2].startsWith(two.highlights?.[2] ?? '\0')).toBe(true);
    expect(two.highlights?.[2].length).toBe(50);
    expect(answers(two.highlights ?? [])).toEqual(answers(whole.slice(0, 2)));
    expect(sum(two.highlights)).toBe(twoMax);

    // 1 件目だけが丸ごと入り、2 件目は残りの 40 字で切れる
    const oneMax = whole[0].length + SEP.length + 40;
    const one = await run({ maxChars: oneMax });
    expect(one.highlights?.[0]).toBe(whole[0]);
    expect(whole[1].startsWith(one.highlights?.[1] ?? '\0')).toBe(true);
    expect(one.highlights?.length).toBe(2);
    expect(one.highlights?.[1].length).toBe(40);
    expect(answers(one.highlights ?? [])).toEqual(answers(whole.slice(0, 1)));
    expect(sum(one.highlights)).toBe(oneMax);
  }, 30_000);

  test('responseMode: evidence の content（ハイライトを区切りでつないだもの）も maxChars を超えない', async () => {
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

describe('capHighlightItems: ふつうのハイライトを前から丸ごと確保し、残りを巨大なものに分ける', () => {
  // HIGHLIGHT_CHAR_BUDGET（1,600 字）以下のふつうのハイライトを、出力の順に丸ごと確保する。丸ごと入らないものが出たら、残りの字数で切り（空白だけなら外し）、
  // そこでやめる（その後ろのふつうのものは外す）。残りの予算は、それより長いもの（表・コード・1 文の節）に、短いものを先に確保する形で分ける:
  // 長さの短い順に、自分の長さと「残りの予算 ÷ 残りの件数（切り捨て）」の小さいほうを割り当てる。残りが無ければ外す。
  // 区切り（7 字）は残す件数に合わせて数え、並びは変えない。予算（maxChars − 区切り ×（件数 − 1））が件数より小さいときは、先頭の 1 件だけを maxChars で切る
  const SEP = '\n\n---\n\n';
  const make = (...lengths: number[]) => lengths.map((n, i) => ({ text: 'abcdefghij'[i % 10].repeat(n), score: i }));

  test.each([
    // ふつうのものだけ: 前から丸ごと。丸ごと入らないものを残りで切り、後ろは外す
    [[460, 460, 460], 1000, [460, 460, 66]],
    [[460, 460, 460], 500, [460, 33]],
    [[10, 100, 1000], 1000, [10, 100, 876]],
    [[10, 100, 1000], 200, [10, 100, 76]],
    [[100, 100, 100], 100, [100]],
    [[10, 100], 117, [10, 100]], // ちょうど収まれば切らない
    [[10, 100], 116, [10, 99]],
    [[1000], 100, [100]],
    [[100, 100, 100], 17, [17]], // 予算（17 − 区切り 14）が件数と同じ 3 なので、ふつうに前から
    [[100, 100, 100], 16, [16]], // 予算 2 が件数 3 より小さい（区切りの分も入らない）ので、先頭の 1 件だけを maxChars で切る
    [[100, 100, 100], 0, []],
    // 巨大なもの（HIGHLIGHT_CHAR_BUDGET より長い）がある: ふつうのものを丸ごと確保して、残りを巨大なものが使う
    [[460, 460, 120_000, 460], 5000, [460, 460, 3599, 460]], // 5000 − ふつう 3 件 1,380 − 区切り 3 つ 21
    [[120_000, 460], 15_000, [14_533, 460]],
    [[2000, 3000, 100], 3000, [1443, 1443, 100]], // 巨大なものが 2 つ: 残りを max-min で分ける
    [[2000, 5000, 100], 6000, [2000, 3886, 100]],
    [[5000, 2000, 100], 6000, [3886, 2000, 100]], // 短いほうを先に確保するので、並びが逆でも同じ
    [[3000, 5000], 4000, [1996, 1997]], // 巨大なものだけ
    [[460, 460, 460, 3000], 1000, [460, 460, 66]], // ふつうのもので予算を使い切ったら、巨大なものは外す
    [[460, 2000], 467, [460]], // 残りが無い（467 − 460 − 区切り 7 = 0）
    [[460, 2000, 3000], 475, [460]], // 残りは 1 字（475 − 460 − 区切り 14）で、巨大なもの 2 件に 1 字ずつは分けられない
    [[HIGHLIGHT_CHAR_BUDGET, 100], 1000, [1000]], // ちょうど HIGHLIGHT_CHAR_BUDGET の長さはふつうのもの
    [[HIGHLIGHT_CHAR_BUDGET + 1, 100], 1000, [893, 100]], // 1 字長いと巨大なもの
  ] as Array<[number[], number, number[]]>)('長さ %j を maxChars %d に収める → %j', (lengths, maxChars, expected) => {
    const capped = capHighlightItems(make(...lengths), maxChars);
    expect(capped.map((item) => item.text.length)).toEqual(expected);
    expect(capped.map((item) => item.text).join(SEP).length).toBeLessThanOrEqual(maxChars);
  });

  test('収まるときは同じ配列を返し、切らないものは同じ項目のまま。切ったものは text だけが変わる', () => {
    const items = make(10, 100);
    expect(capHighlightItems(items, 117)).toBe(items);
    const long = make(10, 100, 1000);
    const capped = capHighlightItems(long, 200);
    expect(capped[0]).toBe(long[0]);
    expect(capped[1]).toBe(long[1]);
    expect(capped[2]).toEqual({ text: 'c'.repeat(76), score: 2 });
  });

  test('並びは変えない: 点数順でない並び（1 位・3 位・2 位）でも、末尾（2 位）を落とさない', () => {
    const capped = capHighlightItems([
      { text: 'a'.repeat(58), score: 3 },
      { text: 'c'.repeat(120_000), score: 1 },
      { text: 'b'.repeat(47), score: 2 },
    ], 15_000);
    expect(capped.map((item) => item.text.length)).toEqual([58, 14_881, 47]);
    expect(capped.map((item) => item.score)).toEqual([3, 1, 2]);
    expect(capped.map((item) => item.text).join(SEP).length).toBe(15_000);
  });

  test('切った結果が空白だけになったものは外す（ふつうのものなら、そこでやめる）', () => {
    // ふつうのもの: 丸ごと入らず、残りの字数で切ると空白だけ → 外して、後ろのふつうのものも外す
    expect(capHighlightItems([{ text: ' '.repeat(50) + 'x'.repeat(50), score: 1 }, { text: 'y'.repeat(100), score: 2 }], 40)).toEqual([]);
    // 巨大なもの: 割り当ての字数で切ると空白だけ → 外す
    const capped = capHighlightItems([{ text: 'a'.repeat(100), score: 1 }, { text: ' '.repeat(2000) + 'x'.repeat(2000), score: 2 }], 1000);
    expect(capped).toEqual([{ text: 'a'.repeat(100), score: 1 }]);
  });
});
