import { describe, expect, test } from 'bun:test';
import { MAX_MARKED_IMAGES, markImagesForRs, restoreRsImages, rsComparableText } from './rs_images.js';

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

describe('restoreRsImages', () => {
  const images = [
    { src: 'https://example.com/a.jpg', alt: '写真', title: '', caption: '' },
    { src: 'https://example.com/b.png?x=1&y="2"', alt: '', title: '', caption: 'タイムテーブル' },
  ];

  test('本文の文字が 1 回目と同じなら、目印を画像に置き換える', () => {
    expect(restoreRsImages('<p>本文</p><p>次</p>', `<p>本文${mark(0)}</p><p>次${mark(1)}</p>`, images)).toBe(
      '<p>本文<img src="https://example.com/a.jpg" alt="写真"></p><p>次<img src="https://example.com/b.png?x=1&amp;y=&quot;2&quot;" alt="タイムテーブル"></p>',
    );
  });

  test('本文の文字が違えば undefined（呼び出し側は 1 回目を使う）', () => {
    expect(restoreRsImages('<p>本文</p>', `<p>別の本文${mark(0)}</p>`, images)).toBeUndefined();
  });

  test('説明文が 1 回目の本文にあれば足さず、alt があれば消えた説明文は title に入れる', () => {
    const kept = [{ src: 'https://example.com/c.jpg', alt: '', title: '', caption: '説明' }];
    expect(restoreRsImages('<p>説明</p>', `<p>説明${mark(0)}</p>`, kept)).toBe('<p>説明<img src="https://example.com/c.jpg" alt=""></p>');
    const withAlt = [{ src: 'https://example.com/d.jpg', alt: '図', title: '', caption: 'グラフの説明' }];
    expect(restoreRsImages('<p>本文</p>', `<p>本文${mark(0)}</p>`, withAlt)).toBe('<p>本文<img src="https://example.com/d.jpg" alt="図" title="グラフの説明"></p>');
    const withTitle = [{ src: 'https://example.com/e.jpg', alt: '図', title: '元の題', caption: '消えた説明' }];
    expect(restoreRsImages('<p>本文</p>', `<p>本文${mark(0)}</p>`, withTitle)).toBe('<p>本文<img src="https://example.com/e.jpg" alt="図" title="元の題 消えた説明"></p>');
  });

  test('比べる文字は、タグ・私用領域の文字・空白の違いを無視する', () => {
    expect(rsComparableText('<p>本文\uE123</p>\n<div>次</div>')).toBe('本文 次');
  });
});

test('1 つの figure に画像が多いページや、深い入れ子でも、目印を置くのに時間がかからない', () => {
  let t = performance.now();
  const many = markImagesForRs(`<figure>${'<img src="/a.jpg">'.repeat(6_400)}<figcaption>説明</figcaption></figure>`, 'https://example.com/');
  expect(many.images).toHaveLength(6_400);
  expect(many.images[6_399].caption).toBe('説明');
  expect(performance.now() - t).toBeLessThan(500);
  t = performance.now();
  const deep = markImagesForRs(`${'<div>'.repeat(3_000)}${'<img src="/a.jpg">'.repeat(6_400)}${'</div>'.repeat(3_000)}`, 'https://example.com/');
  expect(deep.images).toHaveLength(6_400);
  // 単体では約 0.2 秒だが、全件の実行では約 0.7 秒かかる（旧コードは単体で約 18 秒）。500 ms だと全件の実行で落ちるので 2 秒にする
  expect(performance.now() - t).toBeLessThan(2_000);
});

test('属性の値の私用領域の文字も消す（戻すときに属性の中の字を img に置き換えないように）', () => {
  const pua = String.fromCharCode(0xe000);
  const { html } = markImagesForRs(`<p title="a${pua}b">x</p><img src="/a.jpg">`, 'https://example.com/');
  expect(html).toContain('title="ab"');
});

test('図の入れ子が深くても、説明文を探すのに時間がかからない', () => {
  const t = performance.now();
  const nested = markImagesForRs(`${'<figure><img src="/a.jpg"><figcaption>説明</figcaption>'.repeat(1_500)}${'</figure>'.repeat(1_500)}`, 'https://example.com/');
  expect(nested.images).toHaveLength(1_500);
  expect(nested.images[1_499].caption).toBe('説明');
  expect(performance.now() - t).toBeLessThan(500);
});
