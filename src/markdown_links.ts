// Markdown のリンクと画像の記法を探す正規表現。ページの本文に当てるので、`[` や `![` が大量に並んでも、時間が長さに比例する形にする。
//
// `\[ラベル\]…` の正規表現は、素直に書くと二乗になる（閉じ括弧の無い `[` が並ぶと、どの `[` からも、ラベルを次の `]` まで読み直す）。
// 当たらないときは、そのラベルを丸ごと読み飛ばす枝を足す。同じ `]` で終わる開き位置は、`]` の後ろが同じなので結果も同じで、
// いちばん左の 1 つだけ試せば足りる（結果は、素直な正規表現と同じ。markdown_links.test.ts が、乱数の入力で突き合わせる）

/** リンク先 (url "title") の中身。URL の中の括弧は 1 段まで読む（filters:format(webp) など） */
export const MD_DEST = String.raw`[^()]*(?:\([^()]*\)[^()]*)*`;
// 画像の alt。\] のような逃がした字も読む。「ほどいたループ」で書く（1 字ごとに選ぶループ (?:a|b)* は、JSC が 100 万字ほどの data URI で
// 戻りの記録を使い切り、黙って一致しなくなる）
const MD_ALT = String.raw`[^\]\\]*(?:\\.[^\]\\]*)*`;

// javascript: のリンク。Turndown が逃がした `\[`（地の文の [。直前の `\` が奇数個）からは始めない。直前の `\` が偶数個なら、`\\` が字の `\` で、
// 続く `[a](javascript:x)` は生きたリンクなので外す。先頭の (?=\[) は、後読みを `[` の位置でだけ評価するため（無いと、`\` の長い並びで
// JSC が途中で諦める）。後読みは、読み飛ばす枝にも掛かる（逃がした `[` からは、読み飛ばしもしない）
const JS_LINK_RE = new RegExp(String.raw`(?=\[)(?<!(?<!\\)(?:\\\\)*\\)(?:\[([^\]]+)\]\(javascript:${MD_DEST}\)|\[[^\]]*)`, 'gi');
const DATA_IMAGE_RE = new RegExp(String.raw`!\[(?:(${MD_ALT})\]\(data:image\/${MD_DEST}\)|${MD_ALT})`, 'g');
const IMAGE_RE = new RegExp(String.raw`!\[(?:(${MD_ALT})\]\(${MD_DEST}\)|${MD_ALT})`, 'g');
// `[文字](飛び先)`。文字があって飛び先が閉じないときは、飛び先の終わりまで読み飛ばす（`[a](` が並ぶと、どの `[` からも最後まで読むため）。
// 文字が空の `[](` は、`[` だけを進める（飛び先の中の `[` からは、当たることがある）
const LINK_OR_SKIP = String.raw`\[(?:([^\]]+)\]\([^)]+\)|(?:[^\]]+(?:\]\([^)]*)?)?)`;
const STRIP_LINK_RE = new RegExp(`(?<!!)${LINK_OR_SKIP}`, 'g');
const COUNT_LINK_RE = new RegExp(LINK_OR_SKIP, 'g');

/** javascript: の疑似リンクを、リンクの文字にする: [Click](javascript:void(0)) → Click */
export function removeJsLinks(markdown: string): string {
  return markdown.replace(JS_LINK_RE, (match, text: string | undefined) => text ?? match);
}

const imageAlt = (alt: string) => (alt.trim() ? `[画像: ${alt.trim()}]` : '');

/** data: の画像を「[画像: alt]」にする（alt が無ければ消す） */
export function replaceDataImages(markdown: string): string {
  return markdown.replace(DATA_IMAGE_RE, (match, alt: string | undefined) => (alt === undefined ? match : imageAlt(alt)));
}

/** Markdown の画像を「[画像: alt]」に置き換える（alt が無ければ消す）。includeMedia: false の応答で使う */
export function replaceMarkdownImages(markdown: string): string {
  return markdown.replace(IMAGE_RE, (match, alt: string | undefined) => (alt === undefined ? match : imageAlt(alt)));
}

/** リンクを、リンクの文字にする（画像は残す） */
export function stripMarkdownLinks(markdown: string): string {
  return markdown.replace(STRIP_LINK_RE, (match, text: string | undefined) => text ?? match);
}

/** リンクの記法の字数の合計（本文がほぼリンクの並びかを調べる） */
export function markdownLinkChars(markdown: string): number {
  let total = 0;
  for (const match of markdown.matchAll(COUNT_LINK_RE)) if (match[1] !== undefined) total += match[0].length;
  return total;
}
