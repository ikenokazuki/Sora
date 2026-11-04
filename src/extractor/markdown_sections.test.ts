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
});

test('細工した入力でも、リンク行と前置きのパンくずの判定に時間がかからない', () => {
  // リンク行の判定: `](` の多い 1 行（前の正規表現は長さの二乗の時間で、200,000 字で 7〜18 秒止まった）
  let t = performance.now();
  expect(isNavBlock(`[${'](' .repeat(50_000)}))\n[a](b)`)).toBe(false);
  expect(performance.now() - t).toBeLessThan(500);
  // 前置きのパンくずの判定: リンクの並びの後ろに別の字（前の正規表現は組み合わせが指数で増え、121 字で 2 秒止まった）
  t = performance.now();
  parseMarkdownSections(`${'[a](b)'.repeat(20)}x\n\n# 見出し\n\n本文です。`);
  expect(performance.now() - t).toBeLessThan(500);
});

test('前置きのパンくず（リンクの並び）は、区切りがあってもなくても節にしない', () => {
  expect(parseMarkdownSections('[ホーム](/) > [ニュース](/news)\n\n# 見出し\n\n本文です。').map((s) => s.fullText)).toEqual(['本文です。']);
  expect(parseMarkdownSections('[ホーム](/x)[会社概要](/about)\n\n# 見出し\n\n本文です。').map((s) => s.fullText)).toEqual(['本文です。']);
});
