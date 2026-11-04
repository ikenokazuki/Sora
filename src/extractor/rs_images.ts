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
  // 要素ごとに、子の文字の節点を見る（$('*').contents() は要素の数の 2 乗の時間がかかるので使わない）
  $.root().find('*').each((_, el) => {
    for (const node of el.children) if (node.type === 'text') node.data = node.data.replace(PRIVATE_USE, '');
  });
  const images: MarkedImage[] = [];
  const marksByWrap = new Map<unknown, string>();
  $('img').each((_, el) => {
    if (images.length >= MAX_MARKED_IMAGES) return false;
    const $img = $(el);
    const src = resolveImageUrl({ src: $img.attr('src'), dataSrc: $img.attr('data-src'), srcset: $img.attr('srcset'), dataSrcset: $img.attr('data-srcset') }, pageUrl)
      ?? ($img.attr('src') ?? '').trim();
    if (!src) return;
    const $figure = $img.closest('figure');
    images.push({
      src,
      alt: ($img.attr('alt') ?? '').trim(),
      title: ($img.attr('title') ?? '').trim(),
      caption: $figure.length > 0 ? $figure.find('figcaption').first().text().replace(/\s+/g, ' ').trim() : '',
    });
    // 同じ入れ物の目印は文書の順につなぎ、最後に入れ物の後ろへ一度に入れる（cheerio の after() は文字の節点には効かないため）
    const wrap = $img.parents('a, figure, picture').last()[0] ?? el;
    marksByWrap.set(wrap, (marksByWrap.get(wrap) ?? '') + String.fromCharCode(MARK_BASE + images.length - 1));
  });
  for (const [wrap, marks] of marksByWrap) $(wrap as any).after(marks);
  return { html: $.html(), images };
}
