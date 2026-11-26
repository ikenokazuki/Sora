import { describe, expect, test } from 'bun:test';
import { convertHtmlToMarkdown, turndown } from './html_parser.js';

// 表の colspan・rowspan と大きさは、ページの側が決める。上限が無いと、セル 1 つの小さなページで、サーバーが止まる・メモリを使い切る
// （前は colspan と rowspan の積の回数だけ配列を埋めた。1,000,000,000 ずつなら終わらない）

const page = (table: string) => `<html><head><title>t</title></head><body><main><h1>表</h1><p>${'ふつうの本文の段落です。'.repeat(10)}</p>${table}</main></body></html>`;
const convert = (table: string) => convertHtmlToMarkdown(page(table), 'https://x.example/', 100_000, false, false);
const widths = (result: ReturnType<typeof convert>) => (result.tables ?? []).map((t) => t.headers.length);

describe('結合（colspan・rowspan）の上限', () => {
  test('大きな結合は広げない（セル 1 つのページで、出力が膨らまない）', () => {
    const result = convert('<table><tr><td colspan="3000" rowspan="3000">x</td></tr><tr><td>y</td></tr></table>');
    expect(result.markdown.length).toBeLessThan(2000);
    for (const width of widths(result)) expect(width).toBeLessThanOrEqual(2);
  });

  test('結合の値が 10 億でも、すぐ終わる', () => {
    const started = performance.now();
    const result = convert('<table><tr><th colspan="1000000000" rowspan="1000000000">x</th></tr><tr><td>y</td></tr></table>');
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.markdown).toContain('y');
  });

  test('colspan は HTML の仕様の上限（1000）で切る', () => {
    // 見出しと中身の両方を結合する（片方だけだと、空の列の削除や、見出しの行の幅で、切れたかが見えない）
    const result = convert('<table><tr><th colspan="5000">名前</th></tr><tr><td colspan="5000">z</td></tr></table>');
    expect(widths(result)).toEqual([1000]);
  });

  test('結合の多い表をいくつ並べても、増える量は 1 回の変換で上限まで', () => {
    const started = performance.now();
    const table = `<table><tr>${'<td colspan="1000" rowspan="1000">長い文字の入ったセル</td>'.repeat(20)}</tr><tr><td>y</td></tr></table>`;
    const result = convert(table.repeat(50));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.markdown).toContain('y');
  });

  test('結合で増える量は、表ごとではなく 1 回の変換の合計で数え、次の変換では元に戻る', () => {
    const small = '<table><tr><th colspan="2">bb</th></tr><tr><td>c</td><td>d</td></tr></table>';
    // 1 つ目の表の結合（増える量は 999 × 1001 字）で予算をほぼ使い切ると、2 つ目の表の小さな結合は広げない
    const both = turndown.turndown(`<table><tr><th colspan="1000">${'a'.repeat(1000)}</th></tr></table>${small}`);
    expect(both).toContain('| bb |  |\n| --- | --- |\n| c | d |');
    expect(turndown.turndown(small)).toContain('| bb | bb |\n| --- | --- |\n| c | d |');
  });

  test('ふつうの結合は、今までどおり広げる', () => {
    const result = convert('<table><tr><th colspan="2">売上</th><th>年</th></tr><tr><td rowspan="2">東</td><td>1</td><td>2025</td></tr><tr><td>2</td><td>2026</td></tr></table>');
    expect(result.tables).toEqual([{ id: undefined, caption: undefined, headers: ['売上', '売上_2', '年'], rows: [{ 売上: '東', 売上_2: '1', 年: '2025' }, { 売上: '東', 売上_2: '2', 年: '2026' }] }]);
    expect(result.markdown).toContain('| 売上 | 売上 | 年 |\n| --- | --- | --- |\n| 東 | 1 | 2025 |\n| 東 | 2 | 2026 |');
  });
});

describe('入れ子の表', () => {
  test('深い入れ子の表でも時間がかからない（前は行を探す所が三乗の時間で、36KB の 800 段が 17 秒）', () => {
    const started = performance.now();
    const result = convert(`${'<table><tr><td>'.repeat(800)}${'x '.repeat(5000)}${'</td></tr></table>'.repeat(800)}`);
    expect(performance.now() - started).toBeLessThan(6000);
    expect(result.markdown).toContain('x x x');
  });

  test('外の表の tables は、自分の行と見出しだけを使う（入れ子の表の行・見出しは使わない）', () => {
    const result = convert('<table><tr><th>外の列</th></tr><tr><td>外の値<table><caption>中の見出し</caption><tr><th>中の列</th></tr><tr><td>中の値</td></tr></table></td></tr></table>');
    expect(result.tables).toEqual([
      { id: undefined, caption: undefined, headers: ['外の列'], rows: [{ 外の列: '外の値中の見出し中の列中の値' }] },
      { id: undefined, caption: '中の見出し', headers: ['中の列'], rows: [{ 中の列: '中の値' }] },
    ]);
  });
});

describe('行×列の大きい表', () => {
  test('横に長い行と多くの行の表は、列の削除と空欄の埋め込みをせずに書き出し、tables には入れない（中身は残る）', () => {
    const wide = `<tr>${Array.from({ length: 3000 }, (_, i) => `<td>w${i}</td>`).join('')}</tr>`;
    const tall = Array.from({ length: 3000 }, (_, i) => `<tr><td>r${i}</td></tr>`).join('');
    const started = performance.now();
    const result = convert(`<table>${wide}${tall}</table>`);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.tables ?? []).toEqual([]);
    expect(result.markdown).toContain('| r0 |');
    expect(result.markdown).toContain('| w0 | w1 | w2 |');
  });
});
