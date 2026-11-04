import { describe, expect, test } from 'bun:test';
import { extractQueryHighlightDetails } from '../enrichment.js';
import { isNavBlock, parseMarkdownSections } from './markdown_sections.js';

const langs = ['English', 'Français', 'Deutsch', '中文', '한국어'].map((l) => `- [${l}](https://${encodeURIComponent(l)}.example.org/wiki/Tokyo_Dome)`).join('\n');

describe('parseMarkdownSections のナビの段落', () => {
  test('節の中の、短いラベルのリンクだけの段落（2 行以上）を外す', () => {
    const [sec] = parseMarkdownSections(`# 東京ドーム\n\n${langs}\n\n東京ドームは東京都文京区にある球場です。収容人数は約 5 万人です。`);
    expect(sec.fullText).not.toContain('English');
    expect(sec.fullText).toContain('収容人数は約 5 万人');
  });

  test('長いラベルのリンクの一覧・1 行だけのリンク・コードブロックは外さない', () => {
    const news = ['新しいアルバムの発売日が決まりました', '全国ツアーの追加公演のお知らせです'].map((t, i) => `- [${t}](https://example.com/n/${i})`).join('\n');
    const [sec] = parseMarkdownSections(`# お知らせ\n\n${news}\n\n[申し込み](https://example.com/apply)\n\n\`\`\`\n[a](b)\n\n[c](d)\n\`\`\``);
    expect(sec.fullText).toContain('新しいアルバム');
    expect(sec.fullText).toContain('[申し込み](https://example.com/apply)');
    expect(sec.fullText).toContain('[c](d)');
  });

  test('ハイライトの書き出しに言語の一覧が入らない', () => {
    const body = `東京ドームは東京都文京区にある球場です。${'野球の試合とコンサートに使われます。'.repeat(50)}収容人数は約 5 万人です。`;
    const { highlights } = extractQueryHighlightDetails(`# 東京ドーム\n\n${langs}\n\n${body}`, '東京ドーム 収容人数');
    expect(highlights.join('\n')).not.toContain('Français');
  });
});

test('isNavBlock: 短いラベルのリンク行だけの塊', () => {
  expect(isNavBlock('- [ホーム](/)\n- [会社概要](/about)')).toBe(true);
  expect(isNavBlock('- [ホーム](/)\n本文の文')).toBe(false);
  // 行全体が 1 つのリンクか（最後の `](` の後ろの最初の `)` が行の末尾か）の境目: URL が空でも閉じていれば真、URL の後ろに文字と `)` があれば偽
  expect(isNavBlock('[a]()\n[b](c)')).toBe(true);
  expect(isNavBlock('[a](b) c)\n[d](e)')).toBe(false);
});

test('細工した入力でも、リンク行と前置きのパンくずの判定に時間がかからない', () => {
  // リンク行の判定: `](` の多い 1 行（前の正規表現は長さの二乗の時間で、200,000 字で 7〜18 秒止まった）
  let t = performance.now();
  expect(isNavBlock(`[${']('.repeat(50_000)}))\n[a](b)`)).toBe(false);
  expect(performance.now() - t).toBeLessThan(500);
  // 前置きのパンくずの判定: リンクの並びの後ろに別の字（前の正規表現は組み合わせが指数で増え、121 字で 2 秒止まった）
  t = performance.now();
  const sections = parseMarkdownSections(`${'[a](b)'.repeat(20)}x\n\n# 見出し\n\n本文です。`);
  expect(performance.now() - t).toBeLessThan(500);
  // 「x」があるのでリンクの並びだけではなく、前置きは節に残る
  expect(sections.map((s) => s.fullText)).toEqual([`${'[a](b)'.repeat(20)}x`, '本文です。']);
});

test('前置きのパンくず（リンクの並び）は、区切りがあってもなくても節にしない', () => {
  expect(parseMarkdownSections('[ホーム](/) > [ニュース](/news)\n\n# 見出し\n\n本文です。').map((s) => s.fullText)).toEqual(['本文です。']);
  expect(parseMarkdownSections('[ホーム](/x)[会社概要](/about)\n\n# 見出し\n\n本文です。').map((s) => s.fullText)).toEqual(['本文です。']);
});

test('パンくずの行から最後の節を取る（区切りが多くても、行が並んでも時間がかからない）', () => {
  expect(parseMarkdownSections('> 📍 **階層**: ホーム > ニュース > 記事の題\n\n本文です。').map((s) => s.heading)).toEqual(['記事の題']);
  // 行が区切りで終わるときは、次の行の字を見出しにしない（前の正規表現は改行をまたいで「本文です。」を取った）
  expect(parseMarkdownSections('> 📍 **階層**: ホーム >\n\n本文です。').map((s) => s.heading)).toEqual(['']);
  let t = performance.now();
  parseMarkdownSections(`# 見出し\n\n本文です。\n\n> 📍 **階層**: ${'>'.repeat(30)}`);
  expect(performance.now() - t).toBeLessThan(500);
  t = performance.now();
  parseMarkdownSections(`# 見出し\n\n本文です。\n\n${'> 📍 **階層**: >\n'.repeat(5000)}`);
  expect(performance.now() - t).toBeLessThan(500);
});

describe('パンくずの行から最後の節を取る（行の区切り・区切りの文字・最後の区間が空の行）', () => {
  const headings = (doc: string) => parseMarkdownSections(doc).map((s) => s.heading);
  const crumb = '> 📍 **階層**: ホーム > ニュース > 記事の題';

  test('CRLF の文書でも最後の節を取る', () => {
    expect(headings(`${crumb}\r\n\r\n本文です。`)).toEqual(['記事の題']);
    // 行が区切りで終わるときは、CRLF でも次の行の字を見出しにしない
    expect(headings('> 📍 **階層**: ホーム >\r\n\r\n本文です。')).toEqual(['']);
  });

  test('区切りが › でも、最後の節を取る', () => {
    expect(headings('> 📍 **階層**: ホーム › ニュース › 記事の題\n\n本文です。')).toEqual(['記事の題']);
  });

  test('最後の区間が空の行は飛ばして、後ろの別のパンくずの行から取る', () => {
    expect(headings(`> 📍 **階層**: ホーム >\n${crumb}\n\n本文です。`)).toEqual(['記事の題']);
    expect(headings(`> 📍 **階層**: ホーム >\r\n${crumb}\r\n\r\n本文です。`)).toEqual(['記事の題']);
  });

  test('単独の \\r・U+2028・U+2029 で区切った文書でも、最後の節を取る', () => {
    // JSON-LD の BreadcrumbList の名前に、これらの字が入りうる。前は \r?\n でしか行を分けず、行全体が 1 行のまま読めなかった
    for (const [label, sep] of [['\\r', '\r'], ['U+2028', String.fromCharCode(0x2028)], ['U+2029', String.fromCharCode(0x2029)]] as const) {
      expect(headings(`${crumb}${sep}${sep}本文です。`), label).toEqual(['記事の題']);
      expect(headings(`> 📍 **階層**: ホーム >${sep}${crumb}${sep}${sep}本文です。`), `${label}: 最後の区間が空の行のあと`).toEqual(['記事の題']);
    }
  });
});
