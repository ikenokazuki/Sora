import { describe, expect, test } from 'bun:test';
import { MAX_MARKED_IMAGES, markImagesForRs } from './rs_images.js';

const mark = (i: number) => String.fromCharCode(0xe000 + i);

describe('markImagesForRs', () => {
  test('画像の後ろに番号の目印を置き、画像の URL を絶対 URL で覚える', () => {
    const { html, images } = markImagesForRs('<html><body><p>前<img src="/a.jpg" alt="写真">後</p></body></html>', 'https://example.com/dir/page');
    expect(html).toContain(`<img src="/a.jpg" alt="写真">${mark(0)}後`);
    expect(images).toEqual([{ src: 'https://example.com/a.jpg', alt: '写真', title: '', caption: '' }]);
  });

  test('画像を包む一番外の a・figure・picture の後ろに置く', () => {
    const { html } = markImagesForRs(
      '<html><body><figure><a href="/x"><picture><img src="b.png"></picture></a><figcaption>説明</figcaption></figure><p>次</p></body></html>',
      'https://example.com/',
    );
    expect(html).toContain(`</figure>${mark(0)}<p>次</p>`);
  });

  test('同じ入れ物の画像は、文書の順に目印が並ぶ', () => {
    const { html } = markImagesForRs('<html><body><a href="/g"><img src="1.jpg"><img src="2.jpg"></a></body></html>', 'https://example.com/');
    expect(html).toContain(`</a>${mark(0)}${mark(1)}`);
  });

  test('遅延読み込みの data-src を使い、figcaption の文を覚える', () => {
    const { images } = markImagesForRs(
      '<html><body><figure><img src="data:image/gif;base64,R0lGOD" data-src="/real.jpg" alt=""><figcaption> タイム テーブル </figcaption></figure></body></html>',
      'https://example.com/',
    );
    expect(images[0]).toEqual({ src: 'https://example.com/real.jpg', alt: '', title: '', caption: 'タイム テーブル' });
  });

  test('もとからある私用領域の文字を消し、src の無い画像には目印を置かない', () => {
    const { html, images } = markImagesForRs('<html><body><p>\uE001アイコン<img alt="空"></p></body></html>', 'https://example.com/');
    expect(images).toEqual([]);
    expect(html).not.toMatch(/[\uE000-\uF8FF]/);
    expect(html).toContain('アイコン');
  });

  test(`目印は ${MAX_MARKED_IMAGES} 枚まで`, () => {
    const many = '<img src="x.jpg">'.repeat(MAX_MARKED_IMAGES + 5);
    expect(markImagesForRs(`<html><body>${many}</body></html>`, 'https://example.com/').images).toHaveLength(MAX_MARKED_IMAGES);
  });
});
