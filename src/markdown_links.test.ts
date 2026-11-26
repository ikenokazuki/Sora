import { describe, expect, test } from 'bun:test';
import { MD_DEST, markdownLinkChars, removeJsLinks, replaceDataImages, replaceMarkdownImages, stripMarkdownLinks } from './markdown_links.js';

// 前の正規表現（二乗の時間）。今の形は、当たらないときにラベルを読み飛ばすだけで、結果は同じになるはず
const MD_ALT = String.raw`([^\]\\]*(?:\\.[^\]\\]*)*)`;
const OLD = {
  jsLink: new RegExp(String.raw`(?=\[)(?<!(?<!\\)(?:\\\\)*\\)\[([^\]]+)\]\(javascript:${MD_DEST}\)`, 'gi'),
  dataImage: new RegExp(String.raw`!\[${MD_ALT}\]\(data:image\/${MD_DEST}\)`, 'g'),
  image: new RegExp(String.raw`!\[${MD_ALT}\]\(${MD_DEST}\)`, 'g'),
};
const alt = (_m: string, a: string) => (a.trim() ? `[画像: ${a.trim()}]` : '');
const oldStripLinks = (s: string) => s.replace(/(?<!!)\[([^\]]+)\]\([^)]+\)/g, '$1');
const oldLinkChars = (s: string) => (s.match(/\[([^\]]+)\]\([^)]+\)/g) || []).reduce((n, m) => n + m.length, 0);

// 記法の部品を乱数で並べる（種を固定して、同じ入力を毎回作る）
const PIECES = ['[', ']', '(', ')', '!', '![', '](', '\\', '\\[', '\\]', '\\\\', 'a', ' ', '\n', '　', 'x y', 'javascript:', 'JavaScript:', 'data:image/', 'http://u', '"t"', '[a](b)', '![c](d)'];
function* inputs(count: number): Generator<string> {
  let seed = 20261126;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x1_0000_0000);
  for (let i = 0; i < count; i++) {
    const length = 1 + Math.floor(random() * 24);
    yield Array.from({ length }, () => PIECES[Math.floor(random() * PIECES.length)]).join('');
  }
}

describe('前の正規表現と同じ結果', () => {
  test('乱数の 40,000 通りで、5 つとも同じ', () => {
    let changed = 0;
    for (const s of inputs(40_000)) {
      const pairs: Array<[string, unknown, unknown]> = [
        ['removeJsLinks', removeJsLinks(s), s.replace(OLD.jsLink, '$1')],
        ['replaceDataImages', replaceDataImages(s), s.replace(OLD.dataImage, alt)],
        ['replaceMarkdownImages', replaceMarkdownImages(s), s.replace(OLD.image, alt)],
        ['stripMarkdownLinks', stripMarkdownLinks(s), oldStripLinks(s)],
        ['markdownLinkChars', markdownLinkChars(s), oldLinkChars(s)],
      ];
      for (const [name, now, before] of pairs) {
        if (now !== before) throw new Error(`食い違い（${name}）: 入力=${JSON.stringify(s)} 今=${JSON.stringify(now)} 前=${JSON.stringify(before)}`);
      }
      if (removeJsLinks(s) !== s || replaceMarkdownImages(s) !== s || stripMarkdownLinks(s) !== s) changed++;
    }
    // 入力が、記法の当たる形を十分に含む（どれにも当たらない入力ばかりだと、比べる意味がない）
    expect(changed).toBeGreaterThan(5000);
  });

  test('入れ子の括弧・逃がした字・閉じない記法', () => {
    expect(removeJsLinks('[a[b](javascript:x(1)) \\[c](javascript:y) \\\\[d](JAVASCRIPT:z)')).toBe('a[b \\[c](javascript:y) \\\\d');
    expect(replaceDataImages('![x [y](data:image/png;base64,AA) ![開いたまま')).toBe('[画像: x [y] ![開いたまま');
    expect(replaceMarkdownImages('![a\\]b](u(1).png) ![](v)')).toBe('[画像: a\\]b] ');
    expect(stripMarkdownLinks('![img](i) [t](u) [[1]](#n) [x](')).toBe('![img](i) t [[1]](#n) [x](');
  });
});

describe('前の正規表現が黙って当たらなくなる長い入力でも、正しく置き換える', () => {
  // JavaScriptCore は、戻り直しが多すぎると打ち切る。前の画像の正規表現は、`![` が 2 万個ほど並ぶと、後ろの本物の画像にも当たらなかった
  test('![ が 5 万個並んだ後ろの画像', () => {
    const s = `${'!['.repeat(50_000)}x](nothing ![本物](data:image/png;base64,AA) 末尾`;
    for (const replaced of [replaceDataImages(s), replaceMarkdownImages(s)]) {
      expect(replaced.endsWith('x](nothing [画像: 本物] 末尾')).toBe(true);
    }
  });
});

describe('長い並びでも、時間が長さに比例する', () => {
  const shapes = ['[', '![', '\\[', '\\\\[', '[a](', '[a](javascript:', '![a](data:image/', '![a](', '[a](javascript:()', '](', '[](', '!['];
  test.each(shapes)('%j の並び', (unit) => {
    const s = unit.repeat(Math.ceil(100_000 / unit.length));
    const started = performance.now();
    removeJsLinks(s);
    replaceDataImages(s);
    replaceMarkdownImages(s);
    stripMarkdownLinks(s);
    markdownLinkChars(s);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
