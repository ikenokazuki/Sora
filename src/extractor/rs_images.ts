/**
 * rs-trafilatura の本文に画像を戻すための目印（docs/superpowers/specs/2026-11-04-v4-extraction-and-params-design.md の 2）。
 * rs-trafilatura が返す本文の HTML は img を書き出さない（決まったタグだけを書き出す）。そこで、画像の後ろに私用領域の 1 字（目印）を
 * 置いた HTML でもう一度取り出し、返ってきた本文の目印を画像に置き換える。目印は、画像を包む一番外の a・figure・picture の後ろに置く
 * （リンクの中ではリンクの文字が増えて本文の選び方が変わり、figure の中では画像入りの figure ごと消えるため）。
 */
import * as cheerio from 'cheerio';
import { resolveImageUrl } from '../html_parser.js';

const MARK_BASE = 0xe000;
/** 目印に使う私用領域（U+E000〜U+F8FF）の字数 */
export const MAX_MARKED_IMAGES = 6400;
const PRIVATE_USE = /[\uE000-\uF8FF]/g;

export interface MarkedImage {
  /** 絶対 URL（決まらなければ src のまま） */
  src: string;
  alt: string;
  title: string;
  /** 画像を包む figure の説明文（figcaption の文字。空白はまとめる） */
  caption: string;
}

/** 画像ごとに目印を置いた HTML と、目印の番号順の画像。もとからある私用領域の文字（アイコンのフォントなど）は消す */
export function markImagesForRs(html: string, pageUrl: string): { html: string; images: MarkedImage[] } {
  const $ = cheerio.load(html);
  // 要素ごとに、子の文字の節点と属性の値から私用領域の字を消す（$('*').contents() は要素の数の 2 乗の時間がかかるので使わない）。
  // 属性に残すと、戻すときに属性の中の字まで img に置き換わる
  $.root().find('*').each((_, el) => {
    for (const node of el.children) if (node.type === 'text') node.data = node.data.replace(PRIVATE_USE, '');
    for (const name of Object.keys(el.attribs)) el.attribs[name] = el.attribs[name].replace(PRIVATE_USE, '');
  });
  const images: MarkedImage[] = [];
  const marksByWrap = new Map<unknown, string>();
  const captionByFigure = new Map<unknown, string>();
  const aboveByParent = new Map<unknown, { figure: unknown; wrap: unknown }>();
  // 図の中で文書の順に最初の figcaption の文字（空白はまとめる）。途中で止めて探す（cheerio の find は図の中を全部数えて並べ直すので、図が深く入れ子だと時間がかかった）
  // ponytail: 説明文の無い図が深く入れ子だと、図の中をたどる分だけ時間がかかる（深さ 3,000 で約 0.3 秒）。上げるなら、figcaption から上へ 1 回ずつたどる
  const captionOf = (figure: any): string => {
    const stack = [...figure.children].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.type !== 'tag') continue;
      if (node.name === 'figcaption') return $(node).text().replace(/\s+/g, ' ').trim();
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    return '';
  };
  $('img').each((_, el) => {
    if (images.length >= MAX_MARKED_IMAGES) return false;
    const $img = $(el);
    const src = resolveImageUrl({ src: $img.attr('src'), dataSrc: $img.attr('data-src'), srcset: $img.attr('srcset'), dataSrcset: $img.attr('data-srcset') }, pageUrl)
      ?? ($img.attr('src') ?? '').trim();
    if (!src) return;
    // 画像の親から上へたどり、一番近い figure と、画像を包む一番外の a・figure・picture を同時に見る。親ごとに覚え、同じ親の画像は 1 回で済む
    // （closest・parents をセレクタで画像ごとに呼ぶと、画像の多いページで時間がかかった）
    // ponytail: 親が違う画像が深い入れ子にあると、画像の数 × 深さの時間が残る（深さ 3,000・画像 3,000 で約 0.2 秒）。上げるなら、要素ごとに祖先の情報を覚える
    const parent = el.parent;
    let above = aboveByParent.get(parent);
    if (!above) {
      above = { figure: undefined, wrap: undefined };
      for (let p: any = parent; p?.type === 'tag'; p = p.parent) {
        if (p.name === 'figure') above.figure ??= p;
        if (p.name === 'a' || p.name === 'figure' || p.name === 'picture') above.wrap = p;
      }
      aboveByParent.set(parent, above);
    }
    const figure = above.figure;
    const wrap = above.wrap ?? el;
    // 説明文は figure ごとに 1 回だけ求める
    let caption = '';
    if (figure) {
      caption = captionByFigure.get(figure) ?? captionOf(figure);
      captionByFigure.set(figure, caption);
    }
    images.push({ src, alt: ($img.attr('alt') ?? '').trim(), title: ($img.attr('title') ?? '').trim(), caption });
    // 同じ入れ物の目印は文書の順につなぎ、最後に入れ物の後ろへ一度に入れる（cheerio の after() は文字の節点には効かないため）
    marksByWrap.set(wrap, (marksByWrap.get(wrap) ?? '') + String.fromCharCode(MARK_BASE + images.length - 1));
  });
  for (const [wrap, marks] of marksByWrap) $(wrap as any).after(marks);
  return { html: $.html(), images };
}

/** 1 回目と 2 回目の本文を比べる文字: タグと私用領域の文字を除き、空白をまとめる */
export function rsComparableText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(PRIVATE_USE, '').replace(/\s+/g, ' ').trim();
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 2 回目（目印入りの HTML）の本文が 1 回目と同じ文字なら、目印を img に置き換えた本文を返す。違えば undefined。
 * rs-trafilatura が説明文ごと消した figure の画像（説明文が 1 回目の本文に無いもの）は、説明文を alt（空のとき）か title（もとの title の後ろ）に入れる。
 */
export function restoreRsImages(firstHtml: string, markedHtml: string, images: MarkedImage[]): string | undefined {
  const firstText = rsComparableText(firstHtml);
  if (rsComparableText(markedHtml) !== firstText) return undefined;
  // 説明文が 1 回目の本文にあるかは、同じ説明文なら 1 回だけ調べる（画像ごとに本文全体を探すと、画像の多いページで時間がかかった）
  // ponytail: 説明文が全部違うと、説明文の数 × 本文の長さの時間が残る（本文 1 MB・説明文 6,400 種で約 0.75 秒）
  const lostByCaption = new Map<string, boolean>();
  return markedHtml.replace(PRIVATE_USE, (ch) => {
    const img = images[ch.charCodeAt(0) - MARK_BASE];
    if (!img) return '';
    let lost = false;
    if (img.caption !== '') {
      lost = lostByCaption.get(img.caption) ?? !firstText.includes(img.caption);
      lostByCaption.set(img.caption, lost);
    }
    const alt = img.alt || (lost ? img.caption : '');
    const title = [img.title, lost && img.alt ? img.caption : ''].filter(Boolean).join(' ');
    return `<img src="${escapeAttr(img.src)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ''}>`;
  });
}
