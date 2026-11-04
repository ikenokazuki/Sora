# v4.0.0（本文の取り出し・ハイライトの直しと引数の整理）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v3.0.0 の scrape・search_deep の不具合（rs-trafilatura の経路の画像と removeSelectors、相対リンク、formats の html、ハイライトの選び方）を直し、効いていない・使われていない引数を消して、v4.0.0 を出す。

**Architecture:** 直す PR（パート A）と消す PR（パート B）に分ける。rs-trafilatura の経路の画像は、私用領域の 1 字の目印を入れた HTML で 2 回目を走らせ、本文が 1 回目と同じときだけ目印を画像に戻す（`src/extractor/rs_images.ts`）。ハイライトは、maxChars で切る前の全文（上限 200,000 字）から選ぶ。

**Tech Stack:** Bun（CI は 1.4.2）・TypeScript・zod 4・cheerio・linkedom・@mozilla/readability・Turndown・bun:test・rs-trafilatura（rev 2a4f56e の `extract_stdin`、イメージでは `/usr/local/bin/rs-trafilatura`）

## Global Constraints

- 設計書は `docs/superpowers/specs/2026-11-04-v4-extraction-and-params-design.md`。この計画と食い違ったら、設計書に従う。
- 依存を足さない（cheerio は今も使っている）。Containerfile とイメージは変えない。
- 公開リポジトリなので、特定の利用者のサービスの名前を、コード・コメント・docs・コミット・PR に書かない。
- コミットの作者は `git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit` で付ける。Co-Authored-By などの行は付けない。メッセージに「skip ci」と書かない（否定文でも）。
- テストは `unset HTTPS_PROXY HTTP_PROXY` してから `bun test <ファイル>` で走らせる。全件は `setsid bun test --timeout 60000 > <ログ> 2>&1` で切り離して走らせ、`ps -eo pid,etimes,cmd | grep "[b]un test"` で終わりを確かめてから、ログの末尾を見る。
- 目印は私用領域 U+E000〜U+F8FF の 1 字で、6,400 枚まで。rs-trafilatura の時間切れは、1 回ごとに今と同じ 5 秒。
- ハイライトを選ぶ全文の上限は 200,000 字（`HIGHLIGHT_SOURCE_MAX_CHARS`）。
- キャッシュのキーは `scrape:v8` → `scrape:v9`、`search:integrated:v11` → `search:integrated:v12`。
- 評価では、WCXB を dev で確かめ、test は判断に 1 回だけ使う。ハイライトの評価は CI と同じ Bun 1.4.2 で測る。実際の search_deep は 40 問を 1 回だけ走らせ、問いの間を 10 秒あける。
- push・PR・マージ・リリース・本番反映は、その都度ユーザーに確かめてから行う。

---

## ファイルの構成

### パート A（直す PR。ブランチ `fix/v4-extraction-and-params`、worktree `~/.worktrees/Sora/v4-extraction`）

| ファイル | 役割 |
|---|---|
| Create `src/extractor/rs_images.ts` | 目印の置き方（`markImagesForRs`）と戻し方（`restoreRsImages`）。cheerio と `resolveImageUrl` だけを使う関数 |
| Create `src/extractor/rs_images.test.ts` | 上のテスト |
| Modify `src/extractor/rs_trafilatura.ts` | removeSelectors・includeMedia を受け取り、2 回目を走らせる |
| Modify `src/extractor/rs_trafilatura.test.ts` | 偽のコマンドで 2 回目の動きを確かめる |
| Modify `src/html_parser.ts` | 本文の URL の絶対化（`absolutizeContentUrls`）、formats の html を本文の HTML に、`fullMarkdown` を返す |
| Modify `src/html_parser.test.ts` | 上のテスト |
| Modify `src/pdf.ts` | `fullContent` を返す |
| Modify `src/types.ts` | `HIGHLIGHT_SOURCE_MAX_CHARS`、includeMedia（ScrapeRequestSchema・SCRAPE_BATCH_INPUT_SHAPE・CrawlRequestSchema） |
| Modify `src/scraper.ts` | rs-trafilatura への引数、`finalizeScrapeResult`（ハイライトの元・maskPii・注記・description・includeMedia）、キャッシュのキー |
| Modify `src/enrichment.ts` | `chooseBestDescription` を消し、`replaceMarkdownImages` を足す |
| Modify `src/extractor/markdown_sections.ts` | `isNavBlock` を移し、節の中のナビの段落を外す |
| Create `src/extractor/markdown_sections.test.ts` | 上のテスト |
| Modify `src/integrated_search_host_response.ts` | `isNavBlock` と `replaceMarkdownImages` を import して使う |
| Modify `scripts/eval-wcxb.ts` | 採点の `toText` で画像を alt ごと外し切る（A10a） |
| Modify `src/mcp/tools_web.ts`・`src/routes/scrape.ts` | includeMedia を受け取って渡す |
| Create `src/finalize_scrape_result.test.ts`・`src/scrape_media.test.ts` | finalize と includeMedia・配線のテスト |
| Modify `src/index.test.ts`・`src/cache_keys.test.ts`・`src/scrape_inputs.test.ts` | 消した関数のテスト、キーの版、includeMedia の転送 |
| Regenerate `client/` | `bun run gen:client` |
| Modify `README.md`・`docs/search-scrape-mechanics.md`・`docs/evaluations/main-content/results.md` | 説明と評価の記録 |
| Create `docs/evaluations/v4-highlights/results.md` | ハイライトの評価の記録 |

### パート B（消す PR。ブランチ `chore/v4-remove-params`、worktree `~/.worktrees/Sora/v4-remove-params`、パート A のブランチから作る）

`src/types.ts`・`src/mcp/tools_web.ts`・`src/routes/scrape.ts`・`src/routes/search.ts`・`src/scraper.ts`・`src/enrichment.ts`・`src/html_parser.ts`・`src/response_cleaner.ts`・`src/integrated_search_host_response.ts`・`scripts/eval-wcxb.ts` と、引数を使っているテスト・`client/`・`README.md`・`RELEASE_NOTES.md`・`package.json`。

---

# パート A: 直す PR

### Task A1: 画像の目印を置く（`markImagesForRs`）

**Files:**
- Create: `src/extractor/rs_images.ts`
- Test: `src/extractor/rs_images.test.ts`

**Interfaces:**
- Consumes: `resolveImageUrl(attrs: { src?; dataSrc?; srcset?; dataSrcset? }, baseUrl: string): string | undefined`（`src/html_parser.ts` にある）
- Produces: `interface MarkedImage { src: string; alt: string; title: string; caption: string }`、`const MAX_MARKED_IMAGES = 6400`、`markImagesForRs(html: string, pageUrl: string): { html: string; images: MarkedImage[] }`

- [ ] **Step 1: 失敗するテストを書く**

`src/extractor/rs_images.test.ts`:

```ts
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
```

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/extractor/rs_images.test.ts`
Expected: FAIL（`Cannot find module './rs_images.js'`）

- [ ] **Step 3: 実装する**

`src/extractor/rs_images.ts`:

```ts
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
```

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/extractor/rs_images.test.ts`
Expected: PASS（6 件）

- [ ] **Step 5: Commit**

```bash
git add src/extractor/rs_images.ts src/extractor/rs_images.test.ts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "feat(extract): rs-trafilatura に渡す HTML の画像の後ろに目印を置く関数を足す"
```

### Task A2: 目印を画像に戻す（`restoreRsImages`）

**Files:**
- Modify: `src/extractor/rs_images.ts`
- Test: `src/extractor/rs_images.test.ts`

**Interfaces:**
- Consumes: `MarkedImage`（Task A1）
- Produces: `rsComparableText(html: string): string`、`restoreRsImages(firstHtml: string, markedHtml: string, images: MarkedImage[]): string | undefined`

- [ ] **Step 1: 失敗するテストを書く**

`src/extractor/rs_images.test.ts` の import を `import { MAX_MARKED_IMAGES, markImagesForRs, restoreRsImages, rsComparableText } from './rs_images.js';` にし、末尾に足す:

```ts
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
```

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/extractor/rs_images.test.ts`
Expected: FAIL（`restoreRsImages` が export されていない）

- [ ] **Step 3: 実装する**

`src/extractor/rs_images.ts` の末尾に足す:

```ts
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
  return markedHtml.replace(PRIVATE_USE, (ch) => {
    const img = images[ch.charCodeAt(0) - MARK_BASE];
    if (!img) return '';
    const lost = img.caption !== '' && !firstText.includes(img.caption);
    const alt = img.alt || (lost ? img.caption : '');
    const title = [img.title, lost && img.alt ? img.caption : ''].filter(Boolean).join(' ');
    return `<img src="${escapeAttr(img.src)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ''}>`;
  });
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/extractor/rs_images.test.ts`
Expected: PASS（10 件）

- [ ] **Step 5: Commit**

```bash
git add src/extractor/rs_images.ts src/extractor/rs_images.test.ts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "feat(extract): 本文が 1 回目と同じときだけ、目印を画像に戻す関数を足す"
```

### Task A3: rs-trafilatura を 2 回走らせる（`extractMainContentWithRs`）

**Files:**
- Modify: `src/extractor/rs_trafilatura.ts`（全体を下のとおりに置き換える）
- Test: `src/extractor/rs_trafilatura.test.ts`

**Interfaces:**
- Consumes: `markImagesForRs`・`restoreRsImages`（Task A1・A2）
- Produces: `interface RsExtractOptions { removeSelectors?: string[]; includeMedia?: boolean }`、`extractMainContentWithRs(html: string, url: string, bin?: string, options?: RsExtractOptions): Promise<RsMainContent | undefined>`（`bin` の既定は今と同じ `process.env.RS_TRAFILATURA_PATH`）

- [ ] **Step 1: 失敗するテストを書く**

`src/extractor/rs_trafilatura.test.ts` の 2 行目の import に `readFileSync` を足し（`import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';`）、末尾に足す:

```ts
// 呼ばれた引数を <bin>.calls に 1 行ずつ書き、受け取った HTML を <bin>.stdin.<引数の数> に保存して、
// --page-type 付き（2 回目）なら second、なければ first を返すコマンド
const twoRuns = (name: string, first: string, second: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ncat > "${path}.stdin.$#"\necho "$*" >> "${path}.calls"\ncase "$*" in\n  *--page-type*) printf '%s' '${second}' ;;\n  *) printf '%s' '${first}' ;;\nesac\n`);
  chmodSync(path, 0o755);
  return path;
};
const calls = (bin: string) => readFileSync(`${bin}.calls`, 'utf8').trim().split('\n');

describe('extractMainContentWithRs の画像', () => {
  const page = '<html><body><p>本文<img src="/a.jpg" alt="写真"></p></body></html>';
  const first = '{"page_type":"listing","content_html":"<p>本文</p>"}';
  const second = '{"page_type":"listing","content_html":"<p>本文\uE000</p>"}';

  test('記事以外で画像があれば、目印を入れた HTML を種類付きで渡し、画像を戻す', async () => {
    const bin = twoRuns('images', first, second);
    expect(await extractMainContentWithRs(page, 'https://example.com/p', bin)).toEqual({
      pageType: 'listing',
      contentHtml: '<p>本文<img src="https://example.com/a.jpg" alt="写真"></p>',
    });
    expect(calls(bin)).toHaveLength(2);
    expect(calls(bin)[1]).toContain('--page-type listing');
    expect(readFileSync(`${bin}.stdin.6`, 'utf8')).toContain('\uE000');
  });

  test('2 回目の本文がずれたら 1 回目を返す', async () => {
    const bin = twoRuns('shifted', first, '{"page_type":"listing","content_html":"<p>別の本文\uE000</p>"}');
    expect(await extractMainContentWithRs(page, 'https://example.com/p', bin)).toEqual({ pageType: 'listing', contentHtml: '<p>本文</p>' });
  });

  test('2 回目が壊れた出力なら 1 回目を返す', async () => {
    const bin = twoRuns('second-broken', first, 'not json');
    expect((await extractMainContentWithRs(page, 'https://example.com/p', bin))?.contentHtml).toBe('<p>本文</p>');
  });

  test('記事・includeMedia: false・画像の無いページでは 2 回目を走らせない', async () => {
    const article = twoRuns('article', '{"page_type":"article","content_html":"<p>本文</p>"}', second);
    expect((await extractMainContentWithRs(page, 'https://example.com/p', article))?.contentHtml).toBe('<p>本文</p>');
    const noMedia = twoRuns('no-media', first, second);
    expect((await extractMainContentWithRs(page, 'https://example.com/p', noMedia, { includeMedia: false }))?.contentHtml).toBe('<p>本文</p>');
    const noImage = twoRuns('no-image', first, second);
    await extractMainContentWithRs('<html><body><p>本文</p></body></html>', 'https://example.com/p', noImage);
    for (const bin of [article, noMedia, noImage]) expect(calls(bin)).toHaveLength(1);
  });

  test('removeSelectors の要素を消してから渡す', async () => {
    const bin = twoRuns('remove', first, second);
    await extractMainContentWithRs('<html><body><div class="ad">広告</div><p>本文</p></body></html>', 'https://example.com/p', bin, { removeSelectors: ['.ad'] });
    const sent = readFileSync(`${bin}.stdin.4`, 'utf8');
    expect(sent).not.toContain('広告');
    expect(sent).toContain('本文');
  });

  test('正しくない removeSelectors は、今までどおりエラーにする', async () => {
    const bin = twoRuns('bad-selector', first, second);
    await expect(extractMainContentWithRs(page, 'https://example.com/p', bin, { removeSelectors: ['['] })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/extractor/rs_trafilatura.test.ts`
Expected: FAIL（画像が戻らない・2 回目が呼ばれない・removeSelectors が効かない。前からある 3 件は PASS）

- [ ] **Step 3: 実装する**

`src/extractor/rs_trafilatura.ts` を次に置き換える:

```ts
/**
 * rs-trafilatura（https://github.com/Murrough-Foley/rs-trafilatura、MIT OR Apache-2.0）のコマンドで、
 * ページの本文の HTML とページの種類（article・listing・forum など）を得る。
 * --markdown を付けないと、本文の HTML からリンクの href が落ちる（include_links が既定で無効のため）。
 * コマンドは RS_TRAFILATURA_PATH（イメージでは /usr/local/bin/rs-trafilatura）。未設定・失敗・時間切れのときは
 * undefined を返し、呼び出し側は Readability の経路に戻る。評価は docs/evaluations/main-content/results.md。
 * rs-trafilatura の本文の HTML には img が入らないので、記事以外のページで画像があるときは、画像の後ろに目印を置いた HTML で
 * もう一度取り出し、本文が 1 回目と同じときだけ目印を画像に戻す（rs_images.ts）。
 */
import { existsSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { incrementSecurityCounter } from '../security/metrics.js';
import { markImagesForRs, restoreRsImages } from './rs_images.js';

export interface RsMainContent {
  pageType?: string;
  contentHtml: string;
}

export interface RsExtractOptions {
  /** 渡す前に消す要素の CSS セレクタ（指定されたときだけ HTML を読み直す） */
  removeSelectors?: string[];
  /** false なら画像を戻さない（2 回目を走らせない） */
  includeMedia?: boolean;
}

/** 1 回の取り出しの上限。rs-trafilatura は 1 ページ数十 ms なので、これを超えるのは異常なページだけ */
const RS_TIMEOUT_MS = 5000;

/** コマンドを 1 回走らせる。本文が空なら undefined。起動の失敗・壊れた出力は例外 */
async function runRs(bin: string, html: string, url: string, pageType?: string): Promise<RsMainContent | undefined> {
  const args = [bin, '--url', url, '--hybrid', '--markdown', ...(pageType ? ['--page-type', pageType] : [])];
  const proc = Bun.spawn(args, { stdin: new TextEncoder().encode(html), stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => proc.kill(), RS_TIMEOUT_MS);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const out = code === 0 ? JSON.parse(stdout || '{}') : {};
    if (typeof out.content_html !== 'string' || !out.content_html.trim()) return undefined;
    return { contentHtml: out.content_html, ...(typeof out.page_type === 'string' ? { pageType: out.page_type } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

export async function extractMainContentWithRs(
  html: string,
  url: string,
  bin: string | undefined = process.env.RS_TRAFILATURA_PATH,
  options: RsExtractOptions = {},
): Promise<RsMainContent | undefined> {
  if (!bin || !html || !existsSync(bin)) return undefined;
  let input = html;
  if (options.removeSelectors && options.removeSelectors.length > 0) {
    // 正しくないセレクタは、今までどおりエラーにする（scrape の失敗として返る）
    const $ = cheerio.load(html);
    $(options.removeSelectors.join(', ')).remove();
    input = $.html();
  }
  let first: RsMainContent | undefined;
  try {
    first = await runRs(bin, input, url);
  } catch {
    try { incrementSecurityCounter('sora_main_content_rs_failed_total'); } catch {}
    return undefined;
  }
  if (!first) {
    try { incrementSecurityCounter('sora_main_content_rs_empty_total'); } catch {}
    return undefined;
  }
  // 記事のページは Readability の本文を使うので、画像を戻さない
  if (options.includeMedia === false || !first.pageType || first.pageType === 'article' || !/<img\b/i.test(input)) return first;
  try {
    const marked = markImagesForRs(input, url);
    if (marked.images.length === 0) return first;
    const second = await runRs(bin, marked.html, url, first.pageType);
    const restored = second ? restoreRsImages(first.contentHtml, second.contentHtml, marked.images) : undefined;
    return restored ? { ...first, contentHtml: restored } : first;
  } catch {
    return first;
  }
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/extractor/rs_trafilatura.test.ts src/extractor/rs_images.test.ts`
Expected: PASS（前からある 3 件と、足した 6 件）

- [ ] **Step 5: Commit**

```bash
git add src/extractor/rs_trafilatura.ts src/extractor/rs_trafilatura.test.ts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "feat(extract): 記事以外のページで rs-trafilatura をもう一度走らせ、本文の画像を戻す"
```

### Task A4: 本文の URL を絶対にし、formats の html を本文の HTML にする

**Files:**
- Modify: `src/html_parser.ts`（`resolveImageUrl` の後ろに関数を足す。`convertHtmlToMarkdown` の本文の決定の直後と、戻り値の `html`）
- Test: `src/html_parser.test.ts`

**Interfaces:**
- Produces: `absolutizeContentUrls(contentHtml: string, baseUrl: string): string`

- [ ] **Step 1: 失敗するテストを書く**

`src/html_parser.test.ts` の末尾に足す:

```ts
describe('本文の URL', () => {
  it('本文のリンクと画像を絶対 URL にし、# と javascript: のリンクを外す', () => {
    const html = '<html><head><title>t</title></head><body><p>Read <a href="/docs/a">docs</a>, <a href="#top">top</a>, <a href="javascript:void(0)">js</a> and <a href="mailto:a@example.com">mail</a>.</p><img src="img/b.png" alt="b"></body></html>';
    const result = convertHtmlToMarkdown(html, 'https://example.com/dir/page', 30000, false, false);
    expect(result.markdown).toContain('[docs](https://example.com/docs/a)');
    expect(result.markdown).toContain(' top,');
    expect(result.markdown).not.toContain('(#top)');
    expect(result.markdown).not.toContain('javascript:');
    expect(result.markdown).toContain('[mail](mailto:a@example.com)');
    expect(result.markdown).toContain('![b](https://example.com/dir/img/b.png)');
  });

  it('rs-trafilatura の本文のリンクも絶対 URL にする', () => {
    const result = convertHtmlToMarkdown(
      '<html><body><ul><li><a href="/e/1">公演 1</a></li></ul></body></html>', 'https://example.com/live', 30000, false, true,
      undefined, undefined, undefined, undefined, false, { pageType: 'listing', contentHtml: '<ul><li><a href="/e/1">公演 1</a></li></ul>' },
    );
    expect(result.markdown).toContain('[公演 1](https://example.com/e/1)');
  });

  it('formats の html は、ページ全体ではなく本文の HTML（URL は絶対）を返す', () => {
    const result = convertHtmlToMarkdown('<html><head><title>t</title><script>x()</script></head><body><p><a href="/a">a</a></p></body></html>', 'https://example.com/', 30000, false, false);
    expect(result.html).toContain('href="https://example.com/a"');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('<head');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/html_parser.test.ts`
Expected: FAIL（相対のまま・`#top` が残る・html に `<head` がある）

- [ ] **Step 3: 実装する**

1. `src/html_parser.ts` の `resolveImageUrl` の閉じ括弧の後ろ（`const STRUCTURED_CONTENT_SELECTOR` の前）に足す:

```ts
/**
 * 本文の HTML の a[href]・img[src] を、ページの URL を基準に絶対 URL にする（links の一覧と同じ基準）。
 * # だけのリンクと javascript: のリンクは、飛び先が無いのでリンクを外して文字だけにする。mailto:・tel: はそのまま。
 */
export function absolutizeContentUrls(contentHtml: string, baseUrl: string): string {
  if (!contentHtml) return contentHtml;
  const $ = cheerio.load(contentHtml, null, false);
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) {
      $a.replaceWith($a.contents());
      return;
    }
    try { $a.attr('href', new URL(href, baseUrl).href); } catch {}
  });
  $('img[src]').each((_, el) => {
    const $img = $(el);
    const src = ($img.attr('src') ?? '').trim();
    if (!src || src.startsWith('data:')) return;
    try { $img.attr('src', new URL(src, baseUrl).href); } catch {}
  });
  return $.html();
}
```

2. `convertHtmlToMarkdown` の「9. 本文の取り出し」の `if (onlyMainContent) { ... } else { contentHtml = $('body').html() || $.html() || ''; }` の直後に足す:

```ts
  // 本文の a・img の URL を絶対にし、飛び先の無いリンクを外す（formats の html もこの HTML を返す）
  contentHtml = absolutizeContentUrls(contentHtml, targetUrl);
```

3. 戻り値の `html: rawHtml,` を `html: contentHtml,` にする。

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/html_parser.test.ts src/scraper_selector.test.ts src/index.test.ts`
Expected: PASS（`index.test.ts` で、formats の html を生の HTML と比べるテストが落ちたら、そのテストを「本文の HTML を返す」期待に直す）

- [ ] **Step 5: Commit**

```bash
git add src/html_parser.ts src/html_parser.test.ts src/index.test.ts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "fix(scrape): 本文のリンクを絶対 URL にし、formats の html を本文の HTML にする"
```

### Task A5: 切る前の全文を返す（HTML と PDF）

**Files:**
- Modify: `src/types.ts`（`DEFAULT_MAX_CHARS` の下）
- Modify: `src/html_parser.ts`（import、戻り値の型、`truncatedMarkdown` の近く）
- Modify: `src/pdf.ts`
- Test: `src/html_parser.test.ts`

**Interfaces:**
- Produces: `export const HIGHLIGHT_SOURCE_MAX_CHARS = 200_000`（types.ts）、`convertHtmlToMarkdown(...).fullMarkdown: string`、`parsePdfToMarkdown(...): Promise<ScrapeResult & { fullContent: string }>`

- [ ] **Step 1: 失敗するテストを書く**

`src/html_parser.test.ts` の末尾に足す:

```ts
describe('切る前の全文', () => {
  it('maxChars で切る前の全文を fullMarkdown で返す', () => {
    const tail = '最後の段落に答えがある。';
    const html = `<html><body><p>${'前の段落。'.repeat(200)}</p><p>${tail}</p></body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://example.com/', 100, false, false);
    expect(result.markdown).not.toContain(tail);
    expect(result.fullMarkdown).toContain(tail);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/html_parser.test.ts`
Expected: FAIL（`fullMarkdown` が undefined）

- [ ] **Step 3: 実装する**

1. `src/types.ts` の `export const DEFAULT_MAX_CHARS = 30_000;` の次の行に足す:

```ts
/** ハイライトを選ぶ全文（maxChars で切る前の本文）の上限。docs/superpowers/specs/2026-11-04-v4-extraction-and-params-design.md の 4 */
export const HIGHLIGHT_SOURCE_MAX_CHARS = 200_000;
```

2. `src/html_parser.ts` の 5〜12 行目の `import type { ... } from './types.js';` の次に `import { HIGHLIGHT_SOURCE_MAX_CHARS } from './types.js';` を足す。戻り値の型の `markdown: string;` の次に `fullMarkdown: string;` を足す。`const truncatedMarkdown = safeTruncateMarkdown(markdown, maxChars);` の次に足す:

```ts
  // ハイライトは、切る前の全文（上限まで）から選ぶ（finalizeScrapeResult）
  const fullMarkdown = safeTruncateMarkdown(markdown, HIGHLIGHT_SOURCE_MAX_CHARS);
```

戻り値の `markdown: truncatedMarkdown,` の次に `fullMarkdown,` を足す。

3. `src/pdf.ts`: import を `import { type ScrapeResult, DEFAULT_MAX_CHARS, HIGHLIGHT_SOURCE_MAX_CHARS } from './types.js';` にし、戻り値の型を `Promise<ScrapeResult & { fullContent: string }>` にし、返す object の `estimatedTokens,` の次に `fullContent: safeTruncateMarkdown(markdown, HIGHLIGHT_SOURCE_MAX_CHARS),` を足す。

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/html_parser.test.ts && bun run typecheck`
Expected: PASS・型の誤りなし（scraper.ts で `parsePdfToMarkdown` の戻り値をそのまま渡しても、余分な項目は型の誤りにならない。使い方は Task A6 で直す）

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/html_parser.ts src/html_parser.test.ts src/pdf.ts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "feat(scrape): maxChars で切る前の全文（上限 20 万字）も返す"
```

### Task A6: ハイライトを全文から選び、注記を付け、description を置き換えない

**Files:**
- Modify: `src/scraper.ts`（`finalizeScrapeResult`、`scrapeUrl` の 4 か所の呼び出し、import）
- Modify: `src/enrichment.ts`（`chooseBestDescription` を消す）
- Modify: `src/index.test.ts`（`chooseBestDescription` のテストと import を消す）
- Test: Create `src/finalize_scrape_result.test.ts`

**Interfaces:**
- Consumes: `convertHtmlToMarkdown(...).fullMarkdown`・`parsePdfToMarkdown(...).fullContent`（Task A5）
- Produces: `finalizeScrapeResult` の options に `highlightSource?: string`

- [ ] **Step 1: 失敗するテストを書く**

`src/finalize_scrape_result.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { finalizeScrapeResult } from './scraper.js';
import type { ScrapeResult } from './types.js';

const base = (content: string, extra: Partial<ScrapeResult> = {}): ScrapeResult => ({
  url: 'https://example.com/p', title: 't', content, isTruncated: true, contentType: 'text/html', source: 'web', ...extra,
});
const opts = (extra: Record<string, unknown> = {}) => ({
  query: '開場時間',
  shouldExtractHighlights: true,
  shouldExtractSummary: false,
  shouldExtractCitations: false,
  shouldChunkMarkdown: false,
  chunkSize: 1000,
  shouldValidateLinks: false,
  shouldFormatAsPrompt: false,
  shouldHighlightMatches: false,
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
    expect(decodeURIComponent(result.textFragmentUrl ?? '')).not.toContain('2026-11-05');
  });

  test('description はハイライトで置き換えない', async () => {
    expect((await finalizeScrapeResult(base(tail, { description: 'サイトの説明' }), opts())).description).toBe('サイトの説明');
    expect((await finalizeScrapeResult(base(tail), opts())).description).toBeUndefined();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/finalize_scrape_result.test.ts`
Expected: FAIL（全文から選ばない・注記が無い・description がハイライトになる）

- [ ] **Step 3: 実装する**

1. `finalizeScrapeResult` の options の型（`snippet?: string;` の次）に足す:

```ts
    /** ハイライトを選ぶ元（maxChars で切る前の全文。HTML・PDF の経路が渡す。無ければ content） */
    highlightSource?: string;
```

2. `if (options.shouldExtractHighlights && options.query) {` のブロックの先頭（`const supplemental: string[] = [];` の前）に足す（ハイライトを作らない呼び出しでは、全文を加工しない）:

```ts
    // ハイライトの元。content と同じ加工（maskPii・safeNormalize）をする
    let highlightSource = result.content;
    if (options.highlightSource !== undefined) {
      highlightSource = options.shouldMaskPii ? maskPiiInText(options.highlightSource) : options.highlightSource;
      if (options.safeNormalize) highlightSource = normalizeSafeNumeric(highlightSource).normalizedText;
    }
```

3. `const picked = extractQueryHighlightDetails(result.content, options.query, { maxHighlights: options.highlightMaxCount });` を次に置き換える:

```ts
    const picked = extractQueryHighlightDetails(highlightSource, options.query, {
      maxHighlights: options.highlightMaxCount,
      ...(options.annotateTemporal ? { annotateTemporal: true, publishedTime: result.publishedTime } : {}),
    });
```

3b. 同じブロックの `result.textFragmentUrl = generateTextFragmentUrl(result.url, result.highlights[0]);` を次にする（注記はページに無い文字なので、ページの中の位置を指すときは外す）:

```ts
      result.textFragmentUrl = generateTextFragmentUrl(result.url, result.highlights[0].replace(/ \[\d{4}-\d{2}-\d{2}\]/g, ''));
```

4. 次のブロックを消す:

```ts
  if (options.query) {
    const topHighlight = result.highlights?.[0];
    result.description = chooseBestDescription(result.description, topHighlight, options.query);
  }
```

5. import の `chooseBestDescription,` を消す。`src/enrichment.ts` の `chooseBestDescription`（「Meta Description vs Dynamic Snippet Arbiter」の doc コメントから関数の終わりまで）を消す。`src/index.test.ts` の import の `chooseBestDescription,` と、`it('chooseBestDescription should replace generic boilerplate meta with dynamic query snippet', ...)` のテストを消す。

6. `scrapeUrl` の中で、全文を渡す:
   - 静的取得: `result = markHttpError(await finalizeScrapeResult(result, finalizeOpts), response.status);` を `result = markHttpError(await finalizeScrapeResult(result, { ...finalizeOpts, highlightSource: parsed.fullMarkdown }), response.status);` にする。
   - 最初の HTTP の結果の救済: `let initialHttpStatus: number | undefined;` の次に `let initialHttpFull: string | undefined;` を足し、`initialHttpStatus = response.status;` の次に `initialHttpFull = parsed.fullMarkdown;` を足し、`await finalizeScrapeResult(initialHttpResult, finalizeOpts)` を `await finalizeScrapeResult(initialHttpResult, { ...finalizeOpts, highlightSource: initialHttpFull })` にする。
   - ブラウザ: `result = markHttpError(await finalizeScrapeResult(result, finalizeOpts), browserRes.status);` を `result = markHttpError(await finalizeScrapeResult(result, { ...finalizeOpts, highlightSource: parsed.fullMarkdown }), browserRes.status);` にする。
   - PDF: 次の 2 行を

     ```ts
                 const pdfResult = await parsePdfToMarkdown(buf, finalUrl, maxChars);
                 result = await finalizeScrapeResult(pdfResult, finalizeOpts);
     ```

     次にする:

     ```ts
                 const { fullContent, ...pdfResult } = await parsePdfToMarkdown(buf, finalUrl, maxChars);
                 result = await finalizeScrapeResult(pdfResult, { ...finalizeOpts, highlightSource: fullContent });
     ```

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/finalize_scrape_result.test.ts src/index.test.ts src/highlight_surface.test.ts && bun run typecheck`
Expected: PASS・型の誤りなし

- [ ] **Step 5: Commit**

```bash
git add src/scraper.ts src/enrichment.ts src/index.test.ts src/finalize_scrape_result.test.ts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "fix(highlights): 切る前の全文からハイライトを選び、注記を付け、description を置き換えない"
```

### Task A7: 節の中のナビの段落をハイライトの候補から外す

**Files:**
- Modify: `src/extractor/markdown_sections.ts`
- Modify: `src/integrated_search_host_response.ts`（140〜175 行目の定義を消して import する）
- Modify: `src/html_parser.ts`（838 行目のコメントの参照先）
- Test: Create `src/extractor/markdown_sections.test.ts`

**Interfaces:**
- Produces: `export function isNavBlock(block: string): boolean`（markdown_sections.ts。中身は今の integrated_search_host_response.ts のもの）

- [ ] **Step 1: 失敗するテストを書く**

`src/extractor/markdown_sections.test.ts`:

```ts
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
```

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/extractor/markdown_sections.test.ts`
Expected: FAIL（`isNavBlock` が export されていない）

- [ ] **Step 3: 実装する**

1. `src/integrated_search_host_response.ts` の `const NAV_LABEL_MAX_CHARS = 16;` から `function isNavBlock(...)` の閉じ括弧までを切り取り、`src/extractor/markdown_sections.ts` の `export interface ParsedSection` の前に貼る。`function isNavBlock` を `export function isNavBlock` にする。`integrated_search_host_response.ts` の import に `import { isNavBlock } from './extractor/markdown_sections.js';` を足す。

2. `src/extractor/markdown_sections.ts` の `parseMarkdownSections` の前に足す:

```ts
/**
 * 空行で区切った段落のうち、短いラベルのリンクだけの段落（2 行以上。グローバルナビ・言語の一覧など）を外す。
 * 1 行だけのリンク（「申し込み」など）は外さない。コードブロックの中は区切らない。
 */
function dropNavParagraphs(lines: string[]): string[] {
  const out: string[] = [];
  let block: string[] = [];
  let inCode = false;
  const end = () => {
    const nonEmpty = block.filter((l) => l.trim() !== '').length;
    if (block.length > 0 && !(nonEmpty >= 2 && isNavBlock(block.join('\n')))) out.push(...block);
    block = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith('```')) inCode = !inCode;
    if (!inCode && line.trim() === '') {
      end();
      out.push(line);
    } else {
      block.push(line);
    }
  }
  end();
  return out;
}
```

3. `flush` の `const fullText = currentParagraphs.join('\n').trim();` を次に置き換える:

```ts
    // 節の中の、短いラベルのリンクだけの段落は、ハイライトの候補にも書き出しにもしない
    const keptLines = dropNavParagraphs(currentParagraphs);
    const fullText = keptLines.join('\n').trim();
```

同じ関数の `paragraphs: currentParagraphs.slice(),` を `paragraphs: keptLines,` にする。

4. `src/html_parser.ts` の `/** これ以下の長さの項目はナビのラベルとみなす（integrated_search_host_response の NAV_LABEL_MAX_CHARS と同じ考え）。 */` の括弧の中を `extractor/markdown_sections の NAV_LABEL_MAX_CHARS と同じ考え` にする。

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/extractor/markdown_sections.test.ts src/integrated_search_host_response.test.ts src/extractor/hierarchical_bm25.test.ts src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extractor/markdown_sections.ts src/extractor/markdown_sections.test.ts src/integrated_search_host_response.ts src/html_parser.ts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "fix(highlights): 節の中のリンクだけの段落（言語の一覧など）をハイライトの候補から外す"
```

### Task A8: includeMedia を scrape 系に足し、rs-trafilatura に引数を渡す

**Files:**
- Modify: `src/enrichment.ts`（`cleanMarkdownTokens` の後ろに関数を足す）
- Modify: `src/integrated_search_host_response.ts`（`stripMedia`）
- Modify: `src/types.ts`（ScrapeRequestSchema・SCRAPE_BATCH_INPUT_SHAPE・CrawlRequestSchema）
- Modify: `src/mcp/tools_web.ts`（scrape・scrape_batch・crawl_site）
- Modify: `src/routes/scrape.ts`（/crawl と /crawl/stream）
- Modify: `src/scraper.ts`（scrapeUrl・buildScrapeCacheKey・finalizeScrapeResult・scrapeBatchUrls・crawlSiteUrl・integratedSearch のキー）
- Test: Create `src/scrape_media.test.ts`; Modify `src/cache_keys.test.ts`・`src/scrape_inputs.test.ts`

**Interfaces:**
- Consumes: `extractMainContentWithRs(html, url, bin?, { removeSelectors, includeMedia })`（Task A3）
- Produces: `replaceMarkdownImages(markdown: string): string`（enrichment.ts）、`scrapeUrl` の options に `includeMedia?: boolean`、`finalizeScrapeResult` の options に `includeMedia?: boolean`

- [ ] **Step 1: 失敗するテストを書く**

`src/scrape_media.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrapeUrl } from './scraper.js';

describe('scrape の includeMedia と rs-trafilatura への引数（手元のサーバー）', () => {
  let server: ReturnType<typeof Bun.serve>;
  const prev = { allow: process.env.ALLOW_LOCAL_FETCH, rs: process.env.RS_TRAFILATURA_PATH };
  beforeAll(() => {
    process.env.ALLOW_LOCAL_FETCH = 'true';
    delete process.env.RS_TRAFILATURA_PATH;
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(
        `<!doctype html><html><head><title>Live</title><meta property="og:image" content="https://example.com/og.jpg"></head><body><main><h1>公演</h1><p>${'公演の案内の文です。'.repeat(30)}<img src="/flyer.jpg" alt="フライヤー"></p></main></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    });
  });
  afterAll(() => {
    server.stop(true);
    for (const [key, value] of [['ALLOW_LOCAL_FETCH', prev.allow], ['RS_TRAFILATURA_PATH', prev.rs]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('includeMedia: false なら本文の画像を [画像: alt] にし、ogImage を省く', async () => {
    const url = `http://127.0.0.1:${server.port}/media`;
    const off = await scrapeUrl({ url, mode: 'fast', includeMedia: false, noCache: true });
    expect(off.content).toContain('[画像: フライヤー]');
    expect(off.content).not.toContain('flyer.jpg');
    expect(off.ogImage).toBeUndefined();
    const on = await scrapeUrl({ url, mode: 'fast', noCache: true });
    expect(on.content).toContain('flyer.jpg');
    expect(on.ogImage).toBe('https://example.com/og.jpg');
  });

  test('removeSelectors の要素は rs-trafilatura に渡す前に消える', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sora-rs-wire-'));
    const bin = join(dir, 'rs');
    writeFileSync(bin, `#!/bin/sh\ncat > "${bin}.stdin"\nprintf '%s' '{"page_type":"listing","content_html":"<p>一覧</p>"}'\n`);
    chmodSync(bin, 0o755);
    process.env.RS_TRAFILATURA_PATH = bin;
    try {
      await scrapeUrl({ url: `http://127.0.0.1:${server.port}/rs-wire`, mode: 'fast', removeSelectors: ['h1'], noCache: true });
      expect(readFileSync(`${bin}.stdin`, 'utf8')).not.toContain('<h1>');
    } finally {
      delete process.env.RS_TRAFILATURA_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

`src/cache_keys.test.ts` の `describe('buildScrapeCacheKey', ...)` の中（`keyOf` を使っているテストの並び）に足す:

```ts
  test('includeMedia: false は別のキー（既定の true と同じ値は同じキー）、キーの版は v9', () => {
    expect(keyOf({ includeMedia: false })).not.toBe(keyOf({}));
    expect(keyOf({ includeMedia: true })).toBe(keyOf({}));
    expect(keyOf({})).toStartWith('scrape:v9:');
  });
```

`src/scrape_inputs.test.ts` の `describe('scrape inputs reach the implementation', ...)` の中に、`MCP scrape forwards fullPage` と同じ形で足す:

```ts
  test('MCP scrape forwards includeMedia', async () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue({ url: 'https://example.com', title: 't', content: 'c', isTruncated: false, contentType: 'text/html', source: 'web' } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'scrape-inputs', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      await client.callTool({ name: 'scrape', arguments: { url: 'https://example.com', includeMedia: false } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(spy.mock.calls[0][0]).toMatchObject({ includeMedia: false });
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/scrape_media.test.ts src/cache_keys.test.ts src/scrape_inputs.test.ts`
Expected: FAIL（includeMedia が効かない・キーが v8・MCP が includeMedia を渡さない・removeSelectors が rs-trafilatura に届かない）

- [ ] **Step 3: 実装する**

1. `src/enrichment.ts` の `cleanMarkdownTokens` の後ろに足す:

```ts
/** Markdown の画像を「[画像: alt]」に置き換える（alt が無ければ消す）。includeMedia: false の応答で使う。ponytail: URL に ')' を含む画像記法は対象外 */
export function replaceMarkdownImages(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt.trim() ? `[画像: ${alt.trim()}]` : ''));
}
```

2. `src/integrated_search_host_response.ts`: `// ponytail: URL に ')' を含む画像記法は対象外` と `const MARKDOWN_IMAGE = ...;` を消し、`stripMedia` の `rest.markdown = rest.markdown.replace(MARKDOWN_IMAGE, ...)` を `rest.markdown = replaceMarkdownImages(rest.markdown);` にする。import を `import { replaceMarkdownImages, safeTruncateMarkdown } from './enrichment.js';` にする。

3. `src/types.ts`: 次の項目を、ScrapeRequestSchema（`keepDataImages` の次）、SCRAPE_BATCH_INPUT_SHAPE（`verbose` の前）、CrawlRequestSchema（`noCache` の前）に足す:

```ts
  includeMedia: z.boolean().optional().describe('画像・動画の URL（本文中の画像、ogImage と media）を応答に含めるか (デフォルト: true)。false で省き、本文の画像は [画像: alt] にする。formats に images を指定したときの images は省かない').meta({ default: true }),
```

4. `src/mcp/tools_web.ts`:
   - scrape の入力に、`keepDataImages` の次に同じ項目を足す（`z.boolean().optional().describe(<上と同じ文>).meta({ default: true })`）。ハンドラーの引数の分割代入に `includeMedia` を足し、`scrapeUrl({ ... })` に `includeMedia` を足す。
   - scrape_batch: ハンドラーの分割代入と `scrapeBatchUrls({ ... })` に `includeMedia` を足す（入力の形は types.ts で足した）。
   - crawl_site: 入力の `highlightMaxCount` の後ろに同じ項目を足し、分割代入と `crawlSiteUrl({ ... })` に `includeMedia` を足す。

5. `src/routes/scrape.ts` の `/crawl` と `/crawl/stream` の `crawlSiteUrl({ ... })` に `includeMedia: body.includeMedia,` を足す。

6. `src/scraper.ts`:
   - `scrapeUrl` の options の型の `keepDataImages?: boolean;` の次に `includeMedia?: boolean;` を足す。
   - `buildScrapeCacheKey` の `keepDataImages: options.keepDataImages === true,` の次に `includeMedia: options.includeMedia !== false,` を足し、`return \`scrape:v8:...` を `scrape:v9` にする。
   - `finalizeOpts` の `snippet: options.snippet,` の次に `includeMedia: options.includeMedia,` を足す。
   - `finalizeScrapeResult` の options の型に `includeMedia?: boolean;` を足し、`if (options.webhookUrl) {` の前に足す:

     ```ts
       // includeMedia: false は search_deep と同じく、本文の画像を [画像: alt] にし、ogImage と media を省く（images・highlights は触らない）
       if (options.includeMedia === false) {
         result.content = replaceMarkdownImages(result.content);
         delete result.ogImage;
         delete result.media;
         const stats = calculateContentStats(result.content);
         result.characterCount = stats.characterCount;
         result.wordCount = stats.wordCount;
         result.readingTimeMin = stats.readingTimeMin;
         result.estimatedTokens = estimateTokens(result.content);
       }
     ```

     import の enrichment の並びに `replaceMarkdownImages,` を足す。
   - rs-trafilatura の 2 か所の呼び出しに引数を渡す:
     - `const rsMain = onlyMainContent ? await extractMainContentWithRs(html, finalUrl) : undefined;` を `const rsMain = onlyMainContent ? await extractMainContentWithRs(html, finalUrl, undefined, { removeSelectors: options.removeSelectors, includeMedia: options.includeMedia }) : undefined;` にする。
     - `onlyMainContent ? await extractMainContentWithRs(browserRes.html, browserRes.finalUrl) : undefined,` を `onlyMainContent ? await extractMainContentWithRs(browserRes.html, browserRes.finalUrl, undefined, { removeSelectors: options.removeSelectors, includeMedia: options.includeMedia }) : undefined,` にする。
   - `scrapeBatchUrls` の options の型に `includeMedia?: boolean;` を足す（`...scrapeOpts` で scrapeUrl に渡る）。
   - `crawlSiteUrl` の options の型に `includeMedia?: boolean;` を足し、分割代入に `includeMedia,` を足し、中の `scrapeUrl({ ... })` に `includeMedia,` を足す。
   - `integratedSearch` の `const cacheKey = \`search:integrated:v11:...` を `v12` にする（画像とハイライトが変わるため）。

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/scrape_media.test.ts src/cache_keys.test.ts src/scrape_inputs.test.ts src/integrated_search_host_response.test.ts src/integrated_search_cache.test.ts && bun run typecheck`
Expected: PASS・型の誤りなし（`integrated_search_cache.test.ts` などでキーの版 v11 を直に書いているところがあれば、v12 に直す）

- [ ] **Step 5: Commit**

```bash
git add src/enrichment.ts src/integrated_search_host_response.ts src/types.ts src/mcp/tools_web.ts src/routes/scrape.ts src/scraper.ts src/scrape_media.test.ts src/cache_keys.test.ts src/scrape_inputs.test.ts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "feat(scrape): includeMedia を scrape・scrape_batch・crawl_site に足し、rs-trafilatura に removeSelectors を渡す"
```

### Task A9: 生成するクライアント・説明文を直し、全体を確かめる

**Files:**
- Regenerate: `client/`
- Modify: `README.md`、`docs/search-scrape-mechanics.md`

- [ ] **Step 1: クライアントを作り直す**

Run: `bun run gen:client && git status --short client/`
Expected: `client/servers/sora/scrape.ts`・`scrape_batch.ts`・`crawl_site.ts` などに includeMedia が入る

- [ ] **Step 2: README を直す**

`README.md` の `scrape` の行（`| \`scrape\` | **★ CORE** |` で始まる行）の引数の並びで、`<br>- \`maskPii\` (boolean, 任意): 個人情報自動マスキング` の後ろに次を足す:

```
<br>- `includeMedia` (boolean, 任意, デフォルト: true): `false` で本文の画像を `[画像: alt]` にし、`ogImage` と `media` を省く（`formats` の `images` は残す）
```

同じ行の `formats` の説明 `` `["markdown", "html", "rawHtml", "links", "screenshot", "jsonLd", "images", "tables"]` `` の後ろに `（\`html\` は本文の HTML、\`rawHtml\` は取得したそのままの HTML）` を足す。`scrape_batch` と `crawl_site` の行にも、同じ includeMedia の項目を足す。

「最も高精度な LLM 活用のベストプラクティス」の 5 番（`> 5. **Google 流 説明文自動選定器 (Meta vs Body Dynamic Arbiter)**: …` の行。Task A6 で無くした動き）を、番号はそのままで次に置き換える:

```
> 5. **説明文（`description`）**: meta の説明文（og:description・meta description・JSON-LD）をそのまま返します。ハイライトで置き換えません（v4.0.0 から）。ページに meta の説明文が無いときは返しません。
```

- [ ] **Step 3: 仕組みの説明を直す**

`docs/search-scrape-mechanics.md` の 128 行目「コマンドには、取得した HTML をそのまま渡します。」を次に置き換える:

```
  - コマンドには、取得した HTML を渡します。`removeSelectors` を指定したときだけ、その要素を消してから渡します（隠し要素は消しません。消すと本文の取り出しの精度が下がるため。`docs/superpowers/specs/2026-11-04-v4-extraction-and-params-design.md`）。
```

132 行目の「rs-trafilatura の本文には画像が入りません。画像の一覧（`images`）は、今までどおりページ全体から取ります。」を次に置き換える:

```
  - rs-trafilatura の本文の HTML には画像が入りません。記事以外の種類で画像のあるページでは、画像の後ろに目印の 1 字を置いた HTML でもう一度取り出し、本文の文字が 1 回目と同じときだけ、目印を画像に戻します（`src/extractor/rs_images.ts`）。`includeMedia: false` のときは戻しません。画像の一覧（`images`）は、今までどおりページ全体から取ります。
```

- [ ] **Step 4: 型・lint・表記・全件のテスト**

Run:

```bash
unset HTTPS_PROXY HTTP_PROXY
bun run typecheck && bun run lint && bun run schema:notation
export CHROME_PATH=$(ls -d /nix/store/*-chromium-*/bin/chromium | head -1)
setsid bun test --timeout 60000 > /tmp/v4-a9-test.log 2>&1
```

`ps -eo pid,etimes,cmd | grep "[b]un test"` が空になってから `tail -6 /tmp/v4-a9-test.log` を見る。
Expected: typecheck・lint・schema:notation が通り、テストは `0 fail`（作業前は 2,333 pass・29 skip・0 fail）

- [ ] **Step 5: Commit**

```bash
git add client README.md docs/search-scrape-mechanics.md
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "docs: includeMedia と formats の html、rs-trafilatura の経路の画像の説明を直し、クライアントを作り直す"
```

### Task A10a: 画像の記法の掃除・外したリンクの区切り・採点の画像

A10 の 1 回目の評価で見つかった不具合を直す（WCXB dev が base 0.8400 対 branch 0.8387 で止まった）。
- `cleanMarkdownTokens` は空のリンクを空の画像より先に消すので、`![](url)` の `[](url)` だけが消えて `!` が残る。後ろが `[text](url)` だと `![text](url)`（画像の記法）になり、リンクの文が alt に見える。画像の URL に括弧があると（`filters:format(webp)` など）、URL の残りが本文に出る。base にもある不具合だが、rs-trafilatura の経路に画像が戻ると多く出る（WCXB dev の `!` の残り 1,145 → 4,121）。
- `replaceMarkdownImages` と data URI の画像の置き換えも、URL の中の括弧と alt の `\]` で止まる。
- `#`・`javascript:` のリンクを外すと（A4）、隣のリンクの文字とくっつく（`1990` `1991` → `19901991`）。
- 採点（`scripts/eval-wcxb.ts` の `toText`）も、画像の URL の中の括弧・alt の `\]`・`[画像: alt]` を外せず、画像の語を本文の語に数える。設計書の 7 の「画像の行を外した本文が今と同じであること」を確かめられるよう、採点でも画像を外し切る。

**Files:**
- Modify: `src/enrichment.ts`（`cleanMarkdownTokens` の手順 1〜3.1、`replaceMarkdownImages`）
- Modify: `src/html_parser.ts`（`absolutizeContentUrls`）
- Modify: `scripts/eval-wcxb.ts`（`toText`）
- Test: `src/index.test.ts`、`src/html_parser.test.ts`

**Interfaces:**
- Consumes: なし（関数の形は変えない）
- Produces: なし

- [ ] **Step 1: 落ちるテストを書く**

`src/index.test.ts` の `import { extractQueryHighlightDetails } from './enrichment.js';` を `import { extractQueryHighlightDetails, replaceMarkdownImages } from './enrichment.js';` にし、`it('cleanMarkdownTokens should replace base64 inline images with [画像: alt] …` のテストの後ろに足す:

```ts
  it('cleanMarkdownTokens は alt の無い画像を ! を残さずに消し、URL の中の括弧も読む', () => {
    expect(cleanMarkdownTokens('商品 ![](https://example.com/a.png) 説明')).toBe('商品  説明');
    expect(cleanMarkdownTokens('- ![](https://example.com/a.png) [名前](https://example.com/p)')).toBe('-  [名前](https://example.com/p)');
    expect(cleanMarkdownTokens('[![](https://example.com/a.png)](https://example.com/p)')).toBe('');
    expect(cleanMarkdownTokens('![](https://example.com/i/filters:format(webp)/a.jpg) 本文')).toBe('本文');
    expect(cleanMarkdownTokens('![](https://example.com/a.png "Skill verified")本文')).toBe('本文');
    expect(cleanMarkdownTokens('[A](https://example.com/a)![](https://example.com/logo.png)[\n\nB は取引所\n\n](https://example.com/b)'))
      .toBe('[A](https://example.com/a)[\n\nB は取引所\n\n](https://example.com/b)');
    expect(cleanMarkdownTokens('[Click](javascript:void(0)) です')).toBe('Click です');
    expect(cleanMarkdownTokens('![図 \\[1\\]](data:image/svg+xml;utf8,<svg fill="rgb(0,0,0)"></svg>) 本文')).toBe('[画像: 図 \\[1\\]] 本文');
    // 長い data URI でも置き換える（1 字ごとに選ぶ正規表現は 100 万字ほどで黙って一致しなくなった）
    expect(cleanMarkdownTokens('前 ![図](data:image/png;base64,' + 'A'.repeat(2_000_000) + ') 後')).toBe('前 [画像: 図] 後');
  });

  it('replaceMarkdownImages は alt の逃がした括弧と URL の中の括弧を読む', () => {
    expect(replaceMarkdownImages('![Apple Watch \\[GPS\\]](https://example.com/w.png) と ![](https://example.com/i/filters:format(webp)/a.jpg) と ![図](https://example.com/b.png "t")'))
      .toBe('[画像: Apple Watch \\[GPS\\]] と  と [画像: 図]');
    expect(replaceMarkdownImages('前 ![図](https://example.com/' + 'a'.repeat(2_000_000) + '.png) 後')).toBe('前 [画像: 図] 後');
  });
```

`src/html_parser.test.ts` の 2 行目の import に `absolutizeContentUrls` を足し（`import { absolutizeContentUrls, convertHtmlToMarkdown, parseTimestampChapters, parseYouTubeChannelRef, parseYouTubeUrl } from './html_parser.js';`）、`describe('本文の URL', () => {` の中の最初の `it` の後ろに足す:

```ts
  it('並んだ # と javascript: のリンクを外すとき、隣の要素の文字とくっつけない', () => {
    const html = '<p>年: <a href="javascript:void(0)">1990</a><a href="javascript:void(0)">1991</a><a href="#x">1992</a><a href="/y">1993</a></p><p>見出し<a href="#">リンク</a>です</p><p><a href="/z">Z</a><a href="#">B</a></p>';
    expect(absolutizeContentUrls(html, 'https://example.com/dir/page')).toBe(
      '<p>年: 1990 1991 1992 <a href="https://example.com/y">1993</a></p><p>見出しリンクです</p><p><a href="https://example.com/z">Z</a> B</p>',
    );
  });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/index.test.ts -t 'cleanMarkdownTokens|replaceMarkdownImages'; bun test src/html_parser.test.ts -t '並んだ'`
Expected: 足した 3 件が FAIL（`商品 ! 説明`・`Click) です` など）。もとからある cleanMarkdownTokens のテストは PASS

- [ ] **Step 3: 直す**

`src/enrichment.ts` の `/** 不要な空リンク、無効な JavaScript リンク、…` の行（`cleanMarkdownTokens` の説明）のすぐ上に足す:

```ts
// Markdown の飛び先 (url "title") の中身と、画像の alt。URL の中の括弧は 1 段まで読み（filters:format(webp) など）、alt は \] のような逃がした字も読む。
// どちらも「ほどいたループ」で書く（1 字ごとに選ぶループ (?:a|b)* は、JSC が 100 万字ほどの data URI で戻りの記録を使い切り、黙って一致しなくなる）
const MD_DEST = String.raw`[^()]*(?:\([^()]*\)[^()]*)*`;
const MD_ALT = String.raw`([^\]\\]*(?:\\.[^\]\\]*)*)`;
const EMPTY_IMAGE_RE = new RegExp(String.raw`!\[(?:\s|&nbsp;)*\]\s*\(${MD_DEST}\)`, 'g');
const EMPTY_LINK_RE = new RegExp(String.raw`\[(?:\s|&nbsp;)*\]\(${MD_DEST}\)`, 'g');
const JS_LINK_RE = new RegExp(String.raw`\[([^\]]+)\]\(javascript:${MD_DEST}\)`, 'gi');
const DATA_IMAGE_RE = new RegExp(String.raw`!\[${MD_ALT}\]\(data:image\/${MD_DEST}\)`, 'g');
const MARKDOWN_IMAGE_RE = new RegExp(String.raw`!\[${MD_ALT}\]\(${MD_DEST}\)`, 'g');
```

`cleanMarkdownTokens` の最初の 3 つの置き換えを、空の画像が先になるように差し替える:

```ts
  let cleaned = markdown
    // 1. 空の画像タグの除去: ![](url), ![] (url)。空のリンクより先に消す（先に [](url) を消すと ! だけが残り、後ろのリンクと画像の記法になる）
    .replace(EMPTY_IMAGE_RE, '')
    // 2. 空の Markdown リンクの除去: [](url), [ ](url), [&nbsp;](url)
    .replace(EMPTY_LINK_RE, '')
    // 3. javascript: 疑似リンクのテキスト化: [Click](javascript:void(0)) -> Click
    .replace(JS_LINK_RE, '$1');
```

同じ関数の 3.1 の `cleaned.replace(/!\[([^\]]*)\]\(data:image\/[^)]+\)/g, (_, alt) => {` を `cleaned.replace(DATA_IMAGE_RE, (_, alt) => {` にする（中身は変えない）。

`replaceMarkdownImages` を差し替える:

```ts
/** Markdown の画像を「[画像: alt]」に置き換える（alt が無ければ消す）。includeMedia: false の応答で使う */
export function replaceMarkdownImages(markdown: string): string {
  return markdown.replace(MARKDOWN_IMAGE_RE, (_m, alt: string) => (alt.trim() ? `[画像: ${alt.trim()}]` : ''));
}
```

`src/html_parser.ts` の `absolutizeContentUrls` の説明の 2 行目を `* # だけのリンクと javascript: のリンクは、飛び先が無いのでリンクを外して文字だけにする（隣が要素なら空白を挟む）。mailto:・tel: はそのまま。` にし、リンクを外す分岐を差し替える:

```ts
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) {
      // 隣が要素（並んだリンクなど）のときは空白を挟み、外した文字が隣の文字とくっつかないようにする
      if (el.prev?.type === 'tag') $a.before(' ');
      if (el.next?.type === 'tag') $a.after(' ');
      $a.replaceWith($a.contents());
      return;
    }
```

`scripts/eval-wcxb.ts` の `toText` を差し替える（説明の行も）:

```ts
/** frontmatter・Markdown の記号・URL を外す（採点は \w+ の語で数えるので、URL の語を残さない）。
 * 画像は alt ごと外し、data URI の画像の置き換え「[画像: alt]」も外す。alt の \] のような逃がした字と、URL の中の 1 段の括弧（format(webp) など）を読む。 */
const toText = (md: string) => md
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .replace(/!\[[^\]\\]*(?:\\.[^\]\\]*)*\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, ' ').replace(/\[画像: [^\]\\]*(?:\\.[^\]\\]*)*\]/g, ' ')
  .replace(/\[([^\]\\]*(?:\\.[^\]\\]*)*)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ')
  .replace(/^#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
  .replace(/^\|?[\s:|-]+\|[\s:|-]*$/gm, '').replace(/\|/g, ' ').replace(/[*_`~]{1,3}/g, '');
```

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/index.test.ts -t 'cleanMarkdownTokens|replaceMarkdownImages' && bun test src/html_parser.test.ts src/scrape_media.test.ts src/integrated_search_host_response.test.ts && bun run typecheck && bun run lint`
Expected: PASS・型の誤りなし・lint の指摘なし

全件も走らせる（Global Constraints の手順）。落ちたテストがあれば、期待が直した不具合（`!` の残り・`)` の残り・くっついた文字）をそのまま書いていたものかを確かめ、そうなら期待を直す。そうでなければ直さずに報告する。

- [ ] **Step 5: Commit**

```bash
git add src/enrichment.ts src/html_parser.ts scripts/eval-wcxb.ts src/index.test.ts src/html_parser.test.ts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "fix(markdown): 画像の記法の掃除で ! を残さず、URL の中の括弧を読む" -m "空の画像を空のリンクより先に消す（![](url) の [](url) だけが消えて ! が残り、後ろのリンクが画像の記法になっていた）。replaceMarkdownImages と data URI の画像の置き換えも、URL の中の 1 段の括弧と alt の逃がした字を読む。# と javascript: のリンクを外すときは、隣の要素との間に空白を挟む。scripts/eval-wcxb.ts の採点でも、画像を alt ごと外し切る。"
```

### Task A10: 本文の取り出しの評価（WCXB・Bevendorff らの評価集・日本語のページ）

1 回目（A10a の前）は、cleanMarkdownTokens の不具合と採点の取りこぼしで止まった。A10a のあとに、下の手順で測り直す。1 回目の報告（`.superpowers/sdd/2026-11-04-v4-extraction-and-params/task-A10-report.md`）の `<OUT>` のスクリプト（`run-eval.sh`・`ja-length.py` など）は使い回してよい。

コンテナには `--name v4eval-…` を付け、止めるときはその名前で止める。`podman ps -q` の全部や名前の無いものに `podman kill` を打たない（同じユーザーのほかのコンテナを止めてしまう）。

**Files:**
- Modify: `docs/evaluations/main-content/results.md`（節を足す）

データ（リポジトリの外）: WCXB（https://github.com/Murrough-Foley/web-content-extraction-benchmark を clone した場所）、Bevendorff らの評価集（`combined/`）、日本語の 72 ページ（`results.md` の 38 + 34 ページを保存した JSON。`{url, query, html}`）、JQaRA の JSONL。下では、データの場所を `<DATA>`、測った結果を置く場所を `<OUT>` と書く。比べる相手（今の origin/main）は、別の worktree `~/.worktrees/Sora/v4-base` に置く。

- [ ] **Step 1: 比べる相手を用意する**

```bash
git -C ~/Sora worktree add --detach ~/.worktrees/Sora/v4-base origin/main
cd ~/.worktrees/Sora/v4-base && unset HTTPS_PROXY HTTP_PROXY && bun install --frozen-lockfile
```

（Task A12 の後に `git -C ~/Sora worktree remove ~/.worktrees/Sora/v4-base` で消す）

- [ ] **Step 2: WCXB と Bevendorff らの評価集を、両方で測る**

rs-trafilatura の入ったイメージ（`localhost/sora-rs-test:dev`、`/usr/local/bin/rs-trafilatura`）の bun で、両方を同じ版で走らせる:

採点（`scripts/eval-wcxb.ts` の `toText`）は、base でも branch のもの（A10a で画像を外し切るようにした）を重ねて使う:

```bash
scorer="-v $HOME/.worktrees/Sora/v4-extraction/scripts/eval-wcxb.ts:/work/scripts/eval-wcxb.ts:ro"
for side in base branch; do
  src=$([ $side = base ] && echo ~/.worktrees/Sora/v4-base || echo ~/.worktrees/Sora/v4-extraction)
  for split in dev test; do
    podman run --rm --name v4eval-$side-$split --network none --entrypoint /usr/local/bin/bun \
      -v $src:/work:ro $scorer -v <DATA>:/data:ro -v <OUT>:/out -e RS_TRAFILATURA_PATH=/usr/local/bin/rs-trafilatura -w /work \
      localhost/sora-rs-test:dev scripts/eval-wcxb.ts --data /data/wcxb --split $split --out /out/$side-$split.json
    python3 -I <DATA>/wcxb/evaluate.py --split $split --results <OUT>/$side-$split.json --per-type > <OUT>/$side-$split.txt
  done
  podman run --rm --name v4eval-$side-bev --network none --entrypoint /usr/local/bin/bun \
    -v $src:/work:ro $scorer -v <DATA>:/data:ro -e RS_TRAFILATURA_PATH=/usr/local/bin/rs-trafilatura -w /work \
    localhost/sora-rs-test:dev scripts/eval-wcxb.ts --bevendorff /data/wceb/combined > <OUT>/$side-bev.txt
done
```

（dev を先に走らせ、下の基準を確かめてから test を 1 回だけ走らせる）

Expected: dev で、全体の F1 の差が 0.001 未満、種類ごとの差が 0.005 未満。Bevendorff らの評価集も、全ページの平均の差が 0.001 未満。F1 が 0.05 以上変わったページは、ページと原因を報告に書く。原因が、リンクの URL の絶対化・`#` と `javascript:` のリンクを外したこと（A4）・`!` の残りが消えたこと・外したリンクの間の空白（A10a）のどれでもなければ、BLOCKED で止める。test は、dev で確かめてから 1 回だけ見る（同じ基準で記録する）。

- [ ] **Step 3: 日本語の 72 ページで、本文と画像を比べる**

`<OUT>/ja-compare.ts`（リポジトリには入れない）:

```ts
// 日本語の 72 ページで、base と branch の Markdown を比べる: 画像の行を外した文字が同じか、画像が何枚増えたか
import { readdirSync, readFileSync } from 'node:fs';
const [dataDir, side] = [process.argv[2], process.argv[3]];
const { extractMainContentWithRs } = await import('/work/src/extractor/rs_trafilatura.ts');
const { convertHtmlToMarkdown } = await import('/work/src/html_parser.ts');
const out: Record<string, { text: string; images: number }> = {};
for (const set of ['ja-pages', 'ja-news']) {
  for (const f of readdirSync(`${dataDir}/${set}`).filter((x) => x.endsWith('.json')).sort()) {
    const d = JSON.parse(readFileSync(`${dataDir}/${set}/${f}`, 'utf8'));
    if (typeof d.html !== 'string' || !d.html) continue;
    const rsMain = await extractMainContentWithRs(d.html, d.url);
    const md: string = convertHtmlToMarkdown(d.html, d.url, 10_000_000, false, true, undefined, undefined, undefined, undefined, false, rsMain).markdown;
    // 本文の文字の比べ: 画像（[画像: …] も）を外し、リンクを文字だけにし、URL を外したあと、文字と数字だけを残す
    // （相対・絶対のリンク、外した # のリンク、! の残り、空白の違いでは変わらない）
    const IMAGE = /!\[[^\]\\]*(?:\\.[^\]\\]*)*\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g;
    const text = md.replace(IMAGE, ' ').replace(/\[画像: [^\]\\]*(?:\\.[^\]\\]*)*\]/g, ' ')
      .replace(/\[([^\]\\]*(?:\\.[^\]\\]*)*)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, '');
    out[`${set}/${f}`] = { text, images: (md.match(IMAGE) ?? []).length };
  }
}
console.log(JSON.stringify(out));
```

base と branch の両方で走らせ、ページごとに比べる:

```bash
for side in base branch; do
  src=$([ $side = base ] && echo ~/.worktrees/Sora/v4-base || echo ~/.worktrees/Sora/v4-extraction)
  podman run --rm --name v4eval-$side-ja --network none --entrypoint /usr/local/bin/bun \
    -v $src:/work:ro -v <DATA>:/data:ro -v <OUT>:/out -e RS_TRAFILATURA_PATH=/usr/local/bin/rs-trafilatura -w /work \
    localhost/sora-rs-test:dev /out/ja-compare.ts /data $side > <OUT>/$side-ja.json
done
python3 -I - <OUT>/base-ja.json <OUT>/branch-ja.json <<'EOF'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
diff = [k for k in a if a[k]['text'] != b[k]['text']]
more = [k for k in a if b[k]['images'] > a[k]['images']]
print('pages', len(a), 'text differs', diff, 'pages with more images', len(more), 'images', sum(a[k]['images'] for k in a), '->', sum(b[k]['images'] for k in b))
EOF
```

Expected: `text differs` は空。画像が増えるのは、記事以外の種類のページ。違うページがあれば、ページと原因を報告に書き、原因が Step 2 の基準のどれでもなければ BLOCKED で止める。

あわせて、Markdown 全体（URL を含む）の字数と推定トークン（`estimateTokens`）を base と branch で比べ、増えた内訳（画像の記法・リンクの飛び先・そのほか）、`%XX` の数、増えた幅の大きい 5 ページを書く（1 回目の `<OUT>/ja-length.py` を使ってよい）。

- [ ] **Step 4: 時間とメモリを確かめる**

A10a は rs-trafilatura の経路（`src/extractor/`）に触れないので、A10a の前に下の手順で測った `<OUT>/base-cost.json`・`<OUT>/branch-cost.json`（と、同じプロセスの中で 2 回目の有無を数えた補助の `<OUT>/branch-cost2.json`）をそのまま使い、測り直さない。

`<OUT>/rs-cost.ts`（リポジトリには入れない）:

```ts
// 日本語の 72 ページと WCXB の dev の 4 ページおきで、extractMainContentWithRs の時間を測る。
// branch では、2 回目に渡す HTML での rs-trafilatura 自身の最大メモリ（/proc/<pid>/status の VmHWM）も測る
// （Bun の resourceUsage().maxRSS には起動元の最大メモリが入るので使わない）
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const [dataDir, side] = [process.argv[2], process.argv[3]];
const { extractMainContentWithRs } = await import('/work/src/extractor/rs_trafilatura.ts');
const marker = side === 'branch' ? await import('/work/src/extractor/rs_images.ts') : undefined;
const pages: Array<{ id: string; url: string; html: string }> = [];
for (const set of ['ja-pages', 'ja-news']) for (const f of readdirSync(`${dataDir}/${set}`).filter((x) => x.endsWith('.json')).sort()) {
  const d = JSON.parse(readFileSync(`${dataDir}/${set}/${f}`, 'utf8'));
  if (typeof d.html === 'string' && d.html) pages.push({ id: `${set}/${f}`, url: d.url, html: d.html });
}
readdirSync(`${dataDir}/wcxb/dev/ground-truth`).filter((x) => x.endsWith('.json')).sort().forEach((f, i) => {
  if (i % 4) return;
  const id = f.replace('.json', '');
  const url = JSON.parse(readFileSync(`${dataDir}/wcxb/dev/ground-truth/${f}`, 'utf8')).url || 'https://example.com/';
  pages.push({ id: `wcxb/${id}`, url, html: new TextDecoder().decode(gunzipSync(readFileSync(`${dataDir}/wcxb/dev/html/${id}.html.gz`))) });
});
async function peakMb(html: string, url: string): Promise<number> {
  await Bun.write('/tmp/in.html', html);
  const p = Bun.spawn([process.env.RS_TRAFILATURA_PATH!, '--url', url, '--hybrid', '--markdown'], { stdin: Bun.file('/tmp/in.html'), stdout: Bun.file('/tmp/out.json'), stderr: 'ignore' });
  let peak = 0;
  for (;;) {
    let s: string;
    try { s = readFileSync(`/proc/${p.pid}/status`, 'utf8'); } catch { break; }
    if (/^State:\s+Z/m.test(s)) break;
    const m = s.match(/^VmHWM:\s+(\d+) kB/m);
    if (m) peak = Math.max(peak, Number(m[1]));
  }
  await p.exited;
  return peak / 1024;
}
const rows: any[] = [];
for (const pg of pages) {
  const t = performance.now();
  await extractMainContentWithRs(pg.html, pg.url);
  const row: any = { id: pg.id, ms: performance.now() - t };
  if (marker && /<img\b/i.test(pg.html)) row.markedPeakMb = await peakMb(marker.markImagesForRs(pg.html, pg.url).html, pg.url);
  rows.push(row);
}
console.log(JSON.stringify(rows));
```

```bash
for side in base branch; do
  src=$([ $side = base ] && echo ~/.worktrees/Sora/v4-base || echo ~/.worktrees/Sora/v4-extraction)
  podman run --rm --name v4eval-$side-cost --network none --entrypoint /usr/local/bin/bun \
    -v $src:/work:ro -v <DATA>:/data:ro -v <OUT>:/out -e RS_TRAFILATURA_PATH=/usr/local/bin/rs-trafilatura -w /work \
    localhost/sora-rs-test:dev /out/rs-cost.ts /data $side > <OUT>/$side-cost.json
done
python3 -I - <OUT>/base-cost.json <OUT>/branch-cost.json <<'EOF'
import json, sys, statistics as st
a, b = ({r['id']: r for r in json.load(open(p))} for p in sys.argv[1:3])
added = sorted(b[k]['ms'] - a[k]['ms'] for k in a if b[k]['ms'] - a[k]['ms'] > 5)
peaks = sorted(r['markedPeakMb'] for r in b.values() if 'markedPeakMb' in r)
print('pages', len(a), 'pages with a 2nd run (added > 5 ms)', len(added), 'added median ms', round(st.median(added), 1) if added else 0, 'p99', round(added[int(len(added) * 0.99) - 1], 1) if added else 0)
print('marked rs peak MB median', round(st.median(peaks), 1), 'max', round(peaks[-1], 1))
EOF
```

Expected: 2 回目を走らせたページで増える時間が中央値 100 ms 以下、目印入りの HTML での rs-trafilatura のメモリの最大が 60 MB 以下（設計書の値は中央値 80 ms・最大およそ 50 MB）。大きく外れたら、原因を調べてから進む。

- [ ] **Step 5: 記録して Commit**

`docs/evaluations/main-content/results.md` の「## 既知の限界」の前に「## rs-trafilatura の経路の画像（v4.0.0）」の節を足し、Step 2〜4 の数字（F1 が同じこと、日本語で画像が戻ったページ数と枚数、Markdown の字数と推定トークンの増え方、時間とメモリ）と、「既知の限界」の「rs-trafilatura の本文には画像が入りません」の行を「記事以外の種類で、本文が 1 回目と同じときだけ画像を戻す」形に直したことを書く。節には次も書く:
- 採点の `toText` は v4.0.0 から画像を alt ごと（URL の中の括弧・alt の `\]`・`[画像: alt]` まで）外す。base も同じ採点で測り直したので、表の base の値は前の節の値と少し違う（前の採点での値も並べる）。
- alt の無い画像は、Markdown では消える（`cleanMarkdownTokens` の手順 1、前から同じ）。`formats: ["html"]` の本文には残る。

```bash
git add docs/evaluations/main-content/results.md
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "docs(eval): rs-trafilatura の経路の画像を戻しても本文の点が変わらないことを記録する"
```

### Task A11: ハイライトの評価（JQaRA・全文の上限の時間・長いページ）

**Files:**
- Create: `docs/evaluations/v4-highlights/results.md`

- [ ] **Step 1: Bun 1.4.2 を用意する**

```bash
npm install --no-save --prefix <OUT>/bun142 bun@1.4.2
<OUT>/bun142/node_modules/.bin/bun --version
```

Expected: `1.4.2`

- [ ] **Step 2: JQaRA で、選んだ段落の精度を比べる**

```bash
cd ~/.worktrees/Sora/v4-base
<OUT>/bun142/node_modules/.bin/bun scripts/eval-jqara.ts --data <DATA>/jqara --split dev --select > <OUT>/base-jqara-dev.txt
cd ~/.worktrees/Sora/v4-extraction
<OUT>/bun142/node_modules/.bin/bun scripts/eval-jqara.ts --data <DATA>/jqara --split dev --select > <OUT>/branch-jqara-dev.txt
```

（`--data` に渡す形は `scripts/eval-jqara.ts` の先頭の説明に従う）

Expected: 選んだ段落の精度が下がらない（JQaRA の候補は Wikipedia の段落で、ナビの段落も 30,000 字を超える本文も無いので、同じになるはず）。同じなら、test を 1 回だけ同じ形で測る。

- [ ] **Step 3: 全文の上限（200,000 字）の時間を測る**

`<OUT>/highlight-time.ts`:

```ts
// 200,000 字の Markdown で、extractQueryHighlightDetails の時間を測る（同じ文書で 10 回の中央値）
import { readFileSync } from 'node:fs';
import { extractQueryHighlightDetails } from '/home/ikeno/.worktrees/Sora/v4-extraction/src/enrichment.ts';
const md = readFileSync(process.argv[2], 'utf8').slice(0, 200_000);
for (const q of ['開場時間 チケット', '収容人数 球場', 'release date version']) {
  const times: number[] = [];
  for (let i = 0; i < 10; i++) { const t = performance.now(); extractQueryHighlightDetails(md, q); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  console.log(q, md.length, 'median ms', times[5].toFixed(1), 'max ms', times[9].toFixed(1));
}
```

200,000 字の Markdown は、日本語の 72 ページを Markdown にしてつなげて作る（`<OUT>/make-200k.ts`）:

```ts
// 日本語の 72 ページを Markdown にしてつなげ、200,000 字の文書を作る
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { convertHtmlToMarkdown } from '/home/ikeno/.worktrees/Sora/v4-extraction/src/html_parser.ts';
const parts: string[] = [];
let total = 0;
for (const set of ['ja-pages', 'ja-news']) for (const f of readdirSync(`${process.argv[2]}/${set}`).filter((x) => x.endsWith('.json')).sort()) {
  const d = JSON.parse(readFileSync(`${process.argv[2]}/${set}/${f}`, 'utf8'));
  if (typeof d.html !== 'string' || !d.html || total >= 200_000) continue;
  const md = convertHtmlToMarkdown(d.html, d.url, 10_000_000, false, true).markdown;
  parts.push(md);
  total += md.length;
}
writeFileSync(process.argv[3], parts.join('\n\n').slice(0, 200_000));
```

```bash
cd ~/.worktrees/Sora/v4-extraction
<OUT>/bun142/node_modules/.bin/bun <OUT>/make-200k.ts <DATA> <OUT>/200k.md
<OUT>/bun142/node_modules/.bin/bun <OUT>/highlight-time.ts <OUT>/200k.md
```

Expected: 中央値 200 ms 以下。超えたら `HIGHLIGHT_SOURCE_MAX_CHARS` を 100,000 にして測り直し、設計書と計画の値を直す。

- [ ] **Step 4: 長いページで、後ろのほうの答えが選ばれるかを見る**

次の 10 ページ（ja.wikipedia.org の長い記事）で、記事の後ろの 3 分の 1 にある事実を 1 つずつ読んで、それを問う検索語を作り、base と branch の `scrape`（`query` 付き、`mode: 'fast'`）のハイライトに入るかを見る: 日本の歴史・東京都・第二次世界大戦・江戸時代・新幹線・宝塚歌劇団・富士山・日本の鉄道・大阪府・明治維新。
Expected: branch は 10 件中ほとんどで答えの節を選び、base（30,000 字で切った本文から選ぶ）より多い。言語の一覧がハイライトに入るページが無い。

- [ ] **Step 5: 記録して Commit**

`docs/evaluations/v4-highlights/results.md` に、Step 2〜4 の方法と数字（JQaRA の dev・test、時間、10 ページの結果を 1 ページ 1 行）を書く。

```bash
git add docs/evaluations/v4-highlights/results.md
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "docs(eval): ハイライトを全文から選ぶ直しと、ナビの段落を外す直しを測った記録を足す"
```

### Task A12: 実際の search_deep を 1 回だけ測る（40 問）

**Files:**
- Modify: `docs/evaluations/v4-highlights/results.md`（節を足す）

- [ ] **Step 1: 測るスクリプトを書く（リポジトリには入れない）**

`<OUT>/live40.ts`:

```ts
// JQaRA test の 40 問（q_id の順に 41 問おき）を、問い文の内容語（最大 5 つ）の検索語で、実際の integratedSearch に 1 回ずつ渡す。
// X の速報なし。問いの間は 10 秒あける。同じ結果を full と evidence で直列化し、答えが残るかを数える。
import { readFileSync, writeFileSync } from 'node:fs';
import { integratedSearch } from '/home/ikeno/.worktrees/Sora/v4-extraction/src/scraper.ts';
import { serializeIntegratedSearchMcpResponse } from '/home/ikeno/.worktrees/Sora/v4-extraction/src/integrated_search_host_response.ts';
const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byQ = new Map<string, any>();
for (const r of rows) if (!byQ.has(r.q_id)) byQ.set(r.q_id, r);
const qs = [...byQ.values()].sort((a, b) => String(a.q_id).localeCompare(String(b.q_id))).filter((_, i) => i % 41 === 0).slice(0, 40);
const contentWords = (q: string) => [...new Intl.Segmenter('ja', { granularity: 'word' }).segment(q)]
  .filter((s) => s.isWordLike && !/^[\p{Script=Hiragana}ー]+$/u.test(s.segment)).map((s) => s.segment).filter((w, i, a) => a.indexOf(w) === i).slice(0, 5).join(' ');
const out: any[] = [];
for (const q of qs) {
  const query = contentWords(q.question);
  const res = await integratedSearch({ query, includeRealtime: false, noCache: true });
  const answers: string[] = q.answers ?? [];
  const has = (s: string) => answers.some((a) => a && s.includes(a));
  const full = serializeIntegratedSearchMcpResponse(res, { responseMode: 'full' });
  const evidence = serializeIntegratedSearchMcpResponse(res, { responseMode: 'evidence' });
  out.push({ q_id: q.q_id, query, results: res.results?.length ?? 0, full: has(full), evidence: has(evidence) });
  console.error(q.q_id, query, out.at(-1));
  await new Promise((r) => setTimeout(r, 10_000));
}
writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
```

（JQaRA の JSONL の項目名が `q_id`・`question`・`answers` と違うときは、`scripts/eval-jqara.ts` の読み方に合わせる）

- [ ] **Step 2: 1 回だけ走らせる**

```bash
cd ~/.worktrees/Sora/v4-extraction && unset HTTPS_PROXY HTTP_PROXY
<OUT>/bun142/node_modules/.bin/bun <OUT>/live40.ts <DATA>/jqara/test.jsonl <OUT>/live40.json
```

Expected: 40 問を約 10 分で終える。`full` に答えがあった問いのうち `evidence` にも残った割合が、前回（`docs/evaluations/response-compression/results.md` の 2 回目: 29 問中 27 問、93%）より下がらない。

- [ ] **Step 3: 記録して Commit**

`docs/evaluations/v4-highlights/results.md` に「## 実際の search_deep（40 問）」の節を足し、方法と数字を書く。

```bash
git add docs/evaluations/v4-highlights/results.md
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "docs(eval): 実際の search_deep の 40 問で、evidence に答えが残ることを記録する"
```

- [ ] **Step 4: 比べる相手の worktree を消す**

Run: `git -C ~/Sora worktree remove ~/.worktrees/Sora/v4-base`

### Task A13: 直す PR を出す

- [ ] **Step 1: ユーザーに確かめる**

ここまでの結果（テストの全件・評価の数字）を伝え、push と PR の作成の許可をもらう。許可が無ければ止まる。

- [ ] **Step 2: push と PR**

```bash
git push -u origin fix/v4-extraction-and-params
gh pr create --base main --head fix/v4-extraction-and-params --title "fix: rs-trafilatura の経路の画像・removeSelectors、本文のリンク、formats の html、ハイライトの選び方を直す" --body-file <OUT>/pr-a-body.md
```

`<OUT>/pr-a-body.md` には、設計書へのリンク、直した不具合、評価の数字、破壊的な変更（formats の html の意味、description がハイライトで置き換わらないこと）を日本語で書く。利用側のサービスの名前と、作者の表示の行は書かない。

- [ ] **Step 3: CI を確かめる**

Run: `gh pr checks --watch`
Expected: すべて成功。マージはユーザーの許可を待つ。

---

# パート B: 消す PR

パート B は、パート A のブランチから作る:

```bash
git -C ~/Sora worktree add -b chore/v4-remove-params ~/.worktrees/Sora/v4-remove-params fix/v4-extraction-and-params
git -C ~/.worktrees/Sora/v4-remove-params branch --unset-upstream
cd ~/.worktrees/Sora/v4-remove-params && unset HTTPS_PROXY HTTP_PROXY && bun install --frozen-lockfile
```

パート A がマージされたら、`git rebase origin/main` してから PR を出す。

各タスクで消した項目は、最後に次で残りが無いことを確かめる（`docs/superpowers/` の昔の記録と、RELEASE_NOTES.md の昔の版の節は直さない）:

```bash
grep -rnw -- "<消した項目>" src scripts client README.md
```

テストの直し方の規則（各タスクに共通）:
- 消した引数を渡しているだけのテストは、その引数を消す。
- 消した引数の働きを確かめるテストは、テストごと消す。
- 引数の一覧（契約）を並べたテストは、一覧から消し、「無いこと」を確かめる一覧（`Forbidden stale fields` など）に足す。

### Task B1: 効いていない引数を消す（includeDiagnostics・includeDiscrepancies・diversityWeight・minimizeTables・reorderUFlat）

**Files:**
- Modify: `src/types.ts`・`src/mcp/tools_web.ts`・`src/routes/scrape.ts`・`src/routes/search.ts`・`src/scraper.ts`・`src/enrichment.ts`・`src/response_cleaner.ts`
- Test: `src/llm_contract_sync.test.ts`・`src/cache_keys.test.ts`・`src/search_adaptive_contract.test.ts`・`src/extractor/information_retrieval.test.ts`

**Interfaces:**
- Produces: `extractQueryHighlightDetails` の options から `reorderUFlat`・`diversityWeight` が無くなる（MMR の重みは 0.7 に固定）。`ScrapeResult` から `evidenceDiagnostics`・`discrepancies` が無くなる。

- [ ] **Step 1: 失敗するテストを書く**

`src/llm_contract_sync.test.ts` の search の `requiredFields` から `'reorderUFlat'`・`'diversityWeight'`・`'minimizeTables'` を消し、`// Forbidden stale fields` の並びに足す:

```ts
      for (const field of ['reorderUFlat', 'diversityWeight', 'minimizeTables']) {
        expect((shape as any)[field]).toBeUndefined();
      }
```

同じファイルに、scrape の REST の形も確かめるテストを足す:

```ts
  test('scrape・batch・crawl の REST の形に、効いていない引数が無い', () => {
    for (const schema of [ScrapeRequestSchema, BatchScrapeRequestSchema, CrawlRequestSchema]) {
      for (const field of ['includeDiagnostics', 'includeDiscrepancies', 'diversityWeight', 'minimizeTables', 'reorderUFlat']) {
        expect((schema.shape as any)[field]).toBeUndefined();
      }
    }
  });
```

（import に `ScrapeRequestSchema, BatchScrapeRequestSchema, CrawlRequestSchema` を `./types.js` から足す）

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/llm_contract_sync.test.ts`
Expected: FAIL（まだ項目がある）

- [ ] **Step 3: 消す**

- `src/types.ts`: ScrapeRequestSchema から `includeDiagnostics`・`includeDiscrepancies`・`reorderUFlat`・`diversityWeight`・`minimizeTables`。SCRAPE_BATCH_INPUT_SHAPE から同じ 5 つ。CrawlRequestSchema から `reorderUFlat`・`diversityWeight`・`minimizeTables`。INTEGRATED_SEARCH_INPUT_SHAPE から `reorderUFlat`・`diversityWeight`・`minimizeTables`。`ScrapeResult` から `evidenceDiagnostics`・`discrepancies`。ScrapeResponseSchema から `evidenceDiagnostics`・`discrepancies`。
- `src/mcp/tools_web.ts`: scrape の入力から 5 つと、分割代入と `scrapeUrl({...})` の同じ名前。scrape_batch の分割代入と `scrapeBatchUrls({...})` の 5 つ。crawl_site の入力・分割代入・`crawlSiteUrl({...})` の 3 つ。search_deep の分割代入と `integratedSearch({...})` の 3 つ。
- `src/routes/scrape.ts`: `/crawl` と `/crawl/stream` の `reorderUFlat`・`diversityWeight`・`minimizeTables` の行。
- `src/routes/search.ts`: `reorderUFlat: body?.reorderUFlat,`・`diversityWeight: body?.diversityWeight,`・`minimizeTables: body?.minimizeTables,` の行。
- `src/scraper.ts`:
  - `finalizeScrapeResult` の options から `includeDiagnostics`・`includeDiscrepancies`・`reorderUFlat`・`diversityWeight`。
  - `buildScrapeCacheKey` の `includeDiagnostics`・`includeDiscrepancies`・`reorderUFlat`・`diversityWeight`・`minimizeTables` の 5 行。
  - `scrapeUrl` の options の型の 5 つと、`finalizeOpts` の `includeDiagnostics`・`includeDiscrepancies`・`reorderUFlat`・`diversityWeight`。
  - `scrapeBatchUrls` の options の型の 5 つ。
  - `crawlSiteUrl` の options の型・分割代入・中の `scrapeUrl({...})` の 3 つと、`if (reorderUFlat && pages.length > 2) { pages = reorderLostInTheMiddle(pages); }` のブロック。
  - `integratedSearch` の options の型、`const reorderUFlat = ...`・`const diversityWeight = ...`・`const minimizeTables = ...`、キーの digest の 3 行、中の `scrapeUrl({...})` の呼び出し（`grep -n "reorderUFlat\|diversityWeight\|minimizeTables" src/scraper.ts` で全部を出す）の 3 つと、`if (reorderUFlat && enrichedResults.length > 2) { enrichedResults = reorderLostInTheMiddle(enrichedResults); }` のブロック。
  - import の `reorderLostInTheMiddle,`（ほかに使っていなければ）。
- `src/enrichment.ts`: `QueryHighlightDetailsOptions` の `reorderUFlat`・`diversityWeight`。`extractQueryHighlightDetails` の `const diversityWeight = options.diversityWeight ?? 0.7;` を `const diversityWeight = 0.7;` に、`const finalCandidates = options.reorderUFlat ? reorderLostInTheMiddle(merged) : merged;` を `const finalCandidates = merged;` にする。`reorderLostInTheMiddle` の import・再 export は、`grep -rn "reorderLostInTheMiddle" src --include=*.test.ts` でテストが enrichment から使っていれば残す。
- `src/response_cleaner.ts`: `evidenceDiagnostics` と `discrepancies` の 2 行。

- [ ] **Step 4: テストを直して通す**

`grep -rln "includeDiagnostics\|includeDiscrepancies\|diversityWeight\|minimizeTables\|reorderUFlat" src --include=*.test.ts` に出るファイルを、上の規則で直す（`search_adaptive_contract.test.ts` の `expect(properties.diversityWeight.type).toBe('number');` は消す。`information_retrieval.test.ts` の live のテストは、`reorderUFlat`・`enablePrf` を確かめる部分ごと消す）。

Run: `unset HTTPS_PROXY HTTP_PROXY; bun run typecheck && bun test src/llm_contract_sync.test.ts src/cache_keys.test.ts src/search_adaptive_contract.test.ts src/extractor/information_retrieval.test.ts src/index.test.ts`
Expected: PASS・型の誤りなし

- [ ] **Step 5: Commit**

```bash
git add -A src
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "chore!: 効いていない引数 includeDiagnostics・includeDiscrepancies・diversityWeight・minimizeTables・reorderUFlat を消す"
```

### Task B2: 使われていない加工の引数を消す（extractSummary・extractCitations・chunkMarkdown・chunkSize・validateLinks・formatAsPrompt・highlightMatches・filterLinkDensity・safeNormalize）

**Files:**
- Modify: `src/types.ts`・`src/mcp/tools_web.ts`・`src/scraper.ts`・`src/enrichment.ts`・`src/html_parser.ts`・`src/response_cleaner.ts`・`scripts/eval-wcxb.ts`
- Test: `src/index.test.ts`・`src/cache_keys.test.ts`・`src/scrape_inputs.test.ts`・`src/finalize_scrape_result.test.ts`・`src/llm_contract_sync.test.ts`

**Interfaces:**
- Produces: `convertHtmlToMarkdown(rawHtml, targetUrl, maxChars, _isRendered?, onlyMainContent?, selectors?, removeSelectors?, stripLinks?, keepDataImages?, rsMain?)`（`filterLinkDensity` の位置引数が無くなり、後ろが 1 つ前に詰まる）。`finalizeScrapeResult` の options から `shouldExtractSummary`・`shouldExtractCitations`・`shouldChunkMarkdown`・`chunkSize`・`shouldValidateLinks`・`shouldFormatAsPrompt`・`shouldHighlightMatches`・`safeNormalize` が無くなる。

- [ ] **Step 1: 失敗するテストを書く**

`src/llm_contract_sync.test.ts` の Task B1 で足したテストの項目の並びに、`'extractSummary', 'extractCitations', 'chunkMarkdown', 'chunkSize', 'validateLinks', 'formatAsPrompt', 'highlightMatches', 'filterLinkDensity', 'safeNormalize'` を足す（`CrawlRequestSchema` には元から無いので、ScrapeRequestSchema と BatchScrapeRequestSchema だけを確かめる別の for にする）。

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/llm_contract_sync.test.ts`
Expected: FAIL

- [ ] **Step 3: 消す**

- `src/types.ts`: ScrapeRequestSchema と SCRAPE_BATCH_INPUT_SHAPE から 9 つ。`ScrapeResult` から `summary`・`citations`・`chunks`・`promptContext`・`highlightedContent`・`linksWithStatus`・`derivations`。ScrapeResponseSchema から同じ 7 つ。`Citation`・`MarkdownChunk`・`LinkStatus`・`DerivationTrace` の interface と、`CitationSchema`・`MarkdownChunkSchema`・`LinkStatusSchema`・`DerivationTraceSchema` は、`grep -rnw "<名前>" src` でほかに使っていなければ消す。
- `src/mcp/tools_web.ts`: scrape の入力から 9 つと、分割代入と `scrapeUrl({...})` の同じ名前。scrape_batch の分割代入と `scrapeBatchUrls({...})` の 9 つ。
- `src/scraper.ts`:
  - `finalizeScrapeResult` の options から `safeNormalize`・`shouldExtractSummary`・`shouldExtractCitations`・`shouldChunkMarkdown`・`chunkSize`・`shouldValidateLinks`・`shouldFormatAsPrompt`・`shouldHighlightMatches`。本体の「決定論的安全正規化」の if と、Task A6 で足した `if (options.safeNormalize) highlightSource = ...` の行、`shouldExtractSummary`・`shouldExtractCitations`・`shouldChunkMarkdown`・`shouldValidateLinks`・`shouldHighlightMatches`・`shouldFormatAsPrompt` の 6 つの if。
  - `buildScrapeCacheKey` の 9 行、`scrapeUrl` の options の型の 9 つ、`finalizeOpts` の 8 つ、`scrapeBatchUrls` の options の型の 9 つ。
  - `convertHtmlToMarkdown` の 3 か所の呼び出し（静的取得・`isContentReady`・ブラウザ）から `options.filterLinkDensity,` を消す。
  - import の `chunkMarkdownContent`・`extractCitationsFromMarkdown`・`normalizeSafeNumeric`・`generateExtractiveSummary`・`generatePromptContext`・`highlightQueryMatchesInMarkdown`・`validateExtractedLinks`。
- `src/enrichment.ts`: `generateExtractiveSummary`・`generatePromptContext`・`highlightQueryMatchesInMarkdown`・`extractCitationsFromMarkdown`・`chunkMarkdownContent`・`validateExtractedLinks` の関数（doc コメントごと）。使わなくなった import を消す。`normalizeSafeNumeric` の再 export は、ほかで使っていなければ消す（`src/extractor/accessibility_compiler.ts` の関数とテストは残す）。
- `src/html_parser.ts`: `convertHtmlToMarkdown` の引数 `filterLinkDensity?: boolean,` と、`if (filterLinkDensity) { ... }` のブロック。
- `src/response_cleaner.ts`: `derivations`・`summary`・`citations`・`chunks`・`linksWithStatus`・`promptContext`・`highlightedContent` の行。
- `scripts/eval-wcxb.ts`: `convertHtmlToMarkdown(html, url, 10_000_000, false, true, undefined, undefined, undefined, undefined, false, rsMain)` を `convertHtmlToMarkdown(html, url, 10_000_000, false, true, undefined, undefined, undefined, false, rsMain)` にする。ほかに `grep -rn "convertHtmlToMarkdown(" src scripts` で 9 個以上の位置引数を渡しているところがあれば、同じく `filterLinkDensity` の位置を詰める（Task A4 で足したテストの rs-trafilatura の呼び出しも直す）。

- [ ] **Step 4: テストを直して通す**

- `src/index.test.ts`: import の `generateExtractiveSummary`・`generatePromptContext`・`highlightQueryMatchesInMarkdown`・`extractCitationsFromMarkdown`・`chunkMarkdownContent`・`validateExtractedLinks` と、その関数のテスト（`it('generateExtractiveSummary should ...'`・`it('generatePromptContext should ...'`・`it('highlightQueryMatchesInMarkdown should ...'`・`it('extractCitationsFromMarkdown should ...'`（2 つ）・`it('chunkMarkdownContent should ...'`・`it('validateExtractedLinks should ...'`）を消す。`filterLinkDensity` を渡しているテストは、上の規則で直す。
- `src/finalize_scrape_result.test.ts`: `opts` から `shouldExtractSummary`・`shouldExtractCitations`・`shouldChunkMarkdown`・`chunkSize`・`shouldValidateLinks`・`shouldFormatAsPrompt`・`shouldHighlightMatches` を消す。
- `src/scrape_inputs.test.ts`: `BatchScrapeRequestSchema.parse({ ..., chunkMarkdown: true, ... })` の `chunkMarkdown: true` を、期待の `toMatchObject` からも消す。
- そのほか `grep -rln "extractSummary\|extractCitations\|chunkMarkdown\|chunkSize\|validateLinks\|formatAsPrompt\|highlightMatches\|filterLinkDensity\|safeNormalize" src --include=*.test.ts` に出るファイルを、規則で直す。

Run: `unset HTTPS_PROXY HTTP_PROXY; bun run typecheck && bun test src/index.test.ts src/llm_contract_sync.test.ts src/cache_keys.test.ts src/scrape_inputs.test.ts src/finalize_scrape_result.test.ts src/html_parser.test.ts`
Expected: PASS・型の誤りなし

- [ ] **Step 5: Commit**

```bash
git add -A src scripts
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "chore!: 使われていない加工の引数（要約・出典・分割・リンクの検証・プロンプト・一致語の強調・リンク密度・数の正規化）を消す"
```

### Task B3: search_deep の dedup・enablePrf、scrape の webhookUrl、retries・retryDelayMs を消す

**Files:**
- Modify: `src/types.ts`・`src/mcp/tools_web.ts`・`src/routes/search.ts`・`src/scraper.ts`・`src/enrichment.ts`
- Test: `src/llm_contract_sync.test.ts`・`src/index.test.ts`・`src/cache_keys.test.ts`・`src/scrape_inputs.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/llm_contract_sync.test.ts`: search の `requiredFields` から `'dedup'`・`'enablePrf'` を消し、Task B1 で足した「無いこと」の並びに足す。scrape の REST の形を確かめるテストに、ScrapeRequestSchema の `webhookUrl`・`retries`・`retryDelayMs`、BatchScrapeRequestSchema の `retries` が無いことを足す（BatchScrapeRequestSchema の `webhookUrl` は残す）。

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/llm_contract_sync.test.ts`
Expected: FAIL

- [ ] **Step 3: 消す**

- `src/types.ts`: INTEGRATED_SEARCH_INPUT_SHAPE から `dedup`・`enablePrf`。ScrapeRequestSchema から `webhookUrl`・`retries`・`retryDelayMs`。SCRAPE_BATCH_INPUT_SHAPE から `retries`。
- `src/mcp/tools_web.ts`: scrape の入力から `webhookUrl`・`retries` と、分割代入と `scrapeUrl({...})` の同じ名前。scrape_batch の分割代入と `scrapeBatchUrls({...})` の `retries`。search_deep の分割代入と `integratedSearch({...})` の `dedup`・`enablePrf`。
- `src/routes/search.ts`: `dedup: body?.dedup,`・`enablePrf: body?.enablePrf,` の行。
- `src/scraper.ts`:
  - `finalizeScrapeResult` の options の `webhookUrl` と、`if (options.webhookUrl) { sendWebhookNotification(options.webhookUrl, result); }`。
  - `ScrapeKeyIgnored` の `'retries' | 'retryDelayMs'` と `'webhookUrl'`（行ごと）。`scrapeUrl` の options の型の `webhookUrl`・`retries`・`retryDelayMs`、`finalizeOpts` の `webhookUrl`。
  - `scrapeUrl` の再試行: `const retries = ...`・`const retryDelayMs = ...`・`let attempt = 0;`・`let lastError: any = null;` を消し、`while (attempt <= retries) { try { <本体> } catch (err) { lastError = err; attempt++; ... } }` と `throw lastError || new Error(...)` を外して、本体だけを残す（本体の字下げを 2 段戻す。本体の例外はそのまま投げられる）。
  - `scrapeBatchUrls`: options の型から `retries`・`retryDelayMs`。`const { urls, concurrency = 3, ...scrapeOpts } = options;` を `const { urls, concurrency = 3, webhookUrl, ...scrapeOpts } = options;` にし、最後の `if (options.webhookUrl) { sendWebhookNotification(options.webhookUrl, batchResult); }` を `if (webhookUrl) { sendWebhookNotification(webhookUrl, batchResult); }` にする（ページごとの scrape には渡さない）。
  - `integratedSearch`: options の型の `dedup`・`enablePrf`、`const dedup = ...`・`const enablePrf = ...`、digest の `dedup`・`enablePrf`、`if (dedup && searchResults.length > 0) { ... }`、`// P2: PRF retrieval` の `if (enablePrf && ...) { ... }`、`// 擬似適合フィードバック (PRF) によるクエリ拡張` の `prfInfo` の宣言と if（`let effectiveQuery = evidenceQuery;` は残す）、`if (dedup && merged.length > 0) { ... }`、`if (prfInfo) { ... }` のブロック。
  - import の `dedupSearchResults`・`expandQueryWithPseudoRelevanceFeedback`（ほかで使っていなければ）。
- `src/enrichment.ts`: `dedupSearchResults`（ほかで使っていなければ）。

- [ ] **Step 4: テストを直して通す**

`src/index.test.ts` の `dedupSearchResults` の import とテストを消す。`grep -rln "dedup\b\|enablePrf\|webhookUrl\|retries\|retryDelayMs" src --include=*.test.ts` に出るファイルのうち、scrape・search_deep のものを規則で直す（監視・住所・歌詞などのほかの機能の `retries`・`webhookUrl` は触らない）。`src/scrape_inputs.test.ts` の `BatchScrapeRequestSchema.parse({ ..., retries: 1, ... })` は `retries` を消す。

Run: `unset HTTPS_PROXY HTTP_PROXY; bun run typecheck && bun test src/llm_contract_sync.test.ts src/index.test.ts src/cache_keys.test.ts src/scrape_inputs.test.ts src/integrated_search_cache.test.ts src/integrated_search_latency.test.ts`
Expected: PASS・型の誤りなし

- [ ] **Step 5: Commit**

```bash
git add -A src
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "chore!: search_deep の dedup・enablePrf と、scrape の webhookUrl・retries・retryDelayMs を消す"
```

### Task B4: onlyHighlights・evidenceMode・extractHighlights を responseMode にまとめる

**Files:**
- Modify: `src/types.ts`・`src/mcp/tools_web.ts`・`src/routes/scrape.ts`・`src/routes/search.ts`・`src/scraper.ts`・`src/enrichment.ts`・`src/integrated_search_host_response.ts`
- Test: `src/scrape_inputs.test.ts`・`src/finalize_scrape_result.test.ts`・`src/integrated_search_host_response.test.ts`・`src/llm_contract_sync.test.ts` と、`grep` に出るテスト

**Interfaces:**
- Produces: scrape・scrape_batch・crawl_site・REST の scrape・batch・crawl に `responseMode?: 'full' | 'evidence'`（既定 `full`）。`scrapeUrl` の options は `responseMode` を持ち、`extractHighlights` は内部用として残す（search_web の formats と国の情報の取得が false を渡す）。`integratedSearch` と `IntegratedSearchHostResponseOptions` から `extractHighlights` が無くなる。

- [ ] **Step 1: 失敗するテストを書く**

`src/finalize_scrape_result.test.ts` に足す:

```ts
test('scrape 系の responseMode: evidence は、ハイライトがあれば content をハイライトに置き換える', async () => {
  const text = '## 当日の案内\n\n開場時間は 17:00、開演は 18:00 です。\n\n## ほか\n\n関係のない文。';
  const result = await finalizeScrapeResult(base(text), opts({ shouldOnlyHighlights: true }));
  expect(result.content).toContain('開場時間は 17:00');
  expect(result.content).not.toContain('関係のない文');
});
```

`src/scrape_inputs.test.ts` に、`MCP scrape forwards includeMedia` と同じ形で `responseMode: 'evidence'` が scrapeUrl に届くテストを足す。`src/llm_contract_sync.test.ts` の「無いこと」の並びに、ScrapeRequestSchema・BatchScrapeRequestSchema・CrawlRequestSchema の `onlyHighlights`・`evidenceMode`・`extractHighlights` と、INTEGRATED_SEARCH_INPUT_SHAPE の `extractHighlights` を足し、3 つの REST の形に `responseMode` があることを足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/scrape_inputs.test.ts src/llm_contract_sync.test.ts src/finalize_scrape_result.test.ts`
Expected: FAIL（responseMode が無い・まだ古い項目がある）

- [ ] **Step 3: 置き換える**

- `src/types.ts`: ScrapeRequestSchema・SCRAPE_BATCH_INPUT_SHAPE・CrawlRequestSchema から `extractHighlights`・`onlyHighlights`・`evidenceMode`（Crawl に evidenceMode は無い）を消し、代わりに足す（`IntegratedSearchResponseModeSchema` は 622 行目の `z.enum(['full', 'evidence'])`。足す場所より前で定義されていなければ、定義を ScrapeRequestSchema の前に移す）:

  ```ts
  responseMode: IntegratedSearchResponseModeSchema.optional().describe('返却モード (デフォルト: "full")。"evidence": query に合うハイライトがあれば、content をハイライトに置き換える').meta({ default: 'full' }),
  ```

  INTEGRATED_SEARCH_INPUT_SHAPE から `extractHighlights`。
- `src/mcp/tools_web.ts`: scrape の入力から `extractHighlights`・`onlyHighlights`・`evidenceMode` を消して `responseMode`（上と同じ）を足し、分割代入と `scrapeUrl({...})` を合わせる。scrape_batch の分割代入と呼び出しも同じ。crawl_site の入力の `extractHighlights`・`onlyHighlights` を `responseMode` に替え、分割代入と呼び出しを合わせる。search_deep の分割代入・`integratedSearch({...})`・`serializeIntegratedSearchMcpResponse(...)` の options から `extractHighlights` を消す。
- `src/routes/scrape.ts`: `/crawl` と `/crawl/stream` の `extractHighlights: body.extractHighlights,`・`onlyHighlights: body.onlyHighlights,` を `responseMode: body.responseMode === 'evidence' ? 'evidence' : 'full',` にする。
- `src/routes/search.ts`: `const extractHighlights = body?.extractHighlights;` と、`integratedSearch({...})`・`formatIntegratedSearchHostResponse(...)` に渡している `extractHighlights` を消す。
- `src/scraper.ts`:
  - `scrapeUrl` の options の型: `onlyHighlights`・`evidenceMode` を消して `responseMode?: 'full' | 'evidence';` を足し、`extractHighlights?: boolean;` に `/** 内部用（search_web の formats・国の情報）。公開の引数ではない */` を付ける。
  - `buildScrapeCacheKey`: `onlyHighlights: ...`・`evidenceMode: ...` を消して `responseMode: options.responseMode ?? 'full',` を足す。
  - `finalizeOpts`: `shouldExtractHighlights: shouldExtractHighlights ?? (!!options.onlyHighlights),` を `shouldExtractHighlights,` に、`shouldOnlyHighlights: options.onlyHighlights ?? false,` を `shouldOnlyHighlights: options.responseMode === 'evidence',` にし、`evidenceMode: options.evidenceMode,` を消す。
  - `finalizeScrapeResult`: options の型の `evidenceMode` を消し、`const isHighlightOnlyMode = options.shouldOnlyHighlights || options.evidenceMode === 'highlights' || options.evidenceMode === 'contextual_highlights';` を `const isHighlightOnlyMode = options.shouldOnlyHighlights === true;` にする。
  - `scrapeBatchUrls`: options の型の `extractHighlights`・`onlyHighlights`・`evidenceMode` を `responseMode?: 'full' | 'evidence';` に替える。
  - `crawlSiteUrl`: options の型・分割代入・中の `scrapeUrl({...})` の `extractHighlights`・`onlyHighlights` を `responseMode` に替える。
  - `integratedSearch`: options の型の `extractHighlights` を消し、`const extractHighlights = options.extractHighlights ?? Boolean(evidenceQuery.trim());` を `const extractHighlights = Boolean(evidenceQuery.trim());` にし、digest の `extractHighlights,` を消す（中の `scrapeUrl({...})` に渡す `extractHighlights` はそのまま）。
- `src/enrichment.ts`: `QueryHighlightDetailsOptions` の `evidenceMode` と、`extractQueryHighlightDetails` の `const evidenceMode = ...`・`anchorHeader`（2 か所。`const anchorHeader = evidenceMode === 'contextual_highlights' ? ... : '';` は消して、`prefix` は `headingPrefix` だけにする）。
- `src/integrated_search_host_response.ts`: `IntegratedSearchHostResponseOptions` の `extractHighlights` と、`projectIntegratedSearchEvidenceItem` の `highlightExtractionWasExplicitlyDisabled`（定義と `mayElideMarkdown` の条件）。

- [ ] **Step 4: テストを直して通す**

`grep -rln "extractHighlights\|onlyHighlights\|evidenceMode" src --include=*.test.ts` に出るファイルを規則で直す。`extractHighlights: false` で「本文を省かない」ことを確かめていたテストは、`responseMode: 'full'` で同じことを確かめる形に直す。`onlyHighlights: true` を渡していたテストは `responseMode: 'evidence'` にする。

Run: `unset HTTPS_PROXY HTTP_PROXY; bun run typecheck && bun test src/scrape_inputs.test.ts src/llm_contract_sync.test.ts src/finalize_scrape_result.test.ts src/integrated_search_host_response.test.ts src/integrated_search_cache.test.ts src/url_in_query.test.ts src/scrape_deadline_integration.test.ts src/index.test.ts src/search_web_formats.test.ts`
Expected: PASS・型の誤りなし

- [ ] **Step 5: Commit**

```bash
git add -A src
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "chore!: onlyHighlights・evidenceMode・extractHighlights を responseMode にまとめる"
```

### Task B5: MCP からだけ外す（renderJs・fastOnly・removeSelectors・selectors・clipSelector）

**Files:**
- Modify: `src/mcp/tools_web.ts`・`src/types.ts`（BatchScrapeRequestSchema）
- Test: Create `src/mcp_tool_params.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/mcp_tool_params.test.ts`:

```ts
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import * as scraper from './scraper.js';
import { BatchScrapeRequestSchema, ScrapeRequestSchema } from './types.js';

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

// v4.0.0 の MCP の引数（docs/superpowers/specs/2026-11-04-v4-extraction-and-params-design.md の 5）
const expected: Record<string, string[]> = {
  scrape: ['url', 'maxChars', 'mode', 'formats', 'fullPage', 'stripLinks', 'maskPii', 'query', 'onlyMainContent', 'headers', 'verbose', 'keepDataImages', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
  scrape_batch: ['urls', 'concurrency', 'maxChars', 'mode', 'formats', 'headers', 'query', 'stripLinks', 'maskPii', 'webhookUrl', 'onlyMainContent', 'verbose', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
  crawl_site: ['url', 'maxPages', 'maxChars', 'includePatterns', 'excludePatterns', 'formats', 'query', 'annotateTemporal', 'highlightMaxCount', 'includeMedia', 'responseMode'],
};

describe('MCP のツールの引数', () => {
  test('scrape・scrape_batch・crawl_site の引数が決めたとおり、search_deep は 26 個', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'tool-params', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const { tools } = await client.listTools();
      const props = (name: string) => Object.keys((tools.find((t) => t.name === name)?.inputSchema as any)?.properties ?? {});
      for (const [name, keys] of Object.entries(expected)) expect(props(name).sort()).toEqual([...keys].sort());
      expect(props('search_deep')).toHaveLength(26);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('REST の scrape と batch には、CSS セレクタの引数と renderJs・fastOnly が残る', () => {
    for (const field of ['selectors', 'clipSelector', 'removeSelectors']) {
      expect((ScrapeRequestSchema.shape as any)[field]).toBeDefined();
      expect((BatchScrapeRequestSchema.shape as any)[field]).toBeDefined();
    }
    expect((ScrapeRequestSchema.shape as any).renderJs).toBeDefined();
    expect((ScrapeRequestSchema.shape as any).fastOnly).toBeDefined();
  });

  test('消した引数を REST に送っても通り、その項目は捨てられる', () => {
    const parsed = ScrapeRequestSchema.parse({ url: 'https://example.com', onlyHighlights: true, safeNormalize: true, retries: 2 }) as Record<string, unknown>;
    expect(parsed.url).toBe('https://example.com');
    for (const field of ['onlyHighlights', 'safeNormalize', 'retries']) expect(parsed[field]).toBeUndefined();
  });

  test('消した引数・MCP から外した引数を MCP に送っても通り、scrapeUrl には届かない', async () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue({ url: 'https://example.com', title: 't', content: 'c', isTruncated: false, contentType: 'text/html', source: 'web' } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'tool-params', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const res = await client.callTool({ name: 'scrape', arguments: { url: 'https://example.com', onlyHighlights: true, renderJs: true, selectors: { a: 'h1' } } });
      expect(res.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
    const args = spy.mock.calls[0][0] as Record<string, unknown>;
    for (const field of ['onlyHighlights', 'renderJs', 'selectors']) expect(args[field]).toBeUndefined();
  });
});
```

（`createMcpServer({ deferTools: false })` で scrape_batch・crawl_site が一覧に出ないときは、`src/scrape_inputs.test.ts` で scrape_batch を呼んでいるところの書き方に合わせて、ツールを有効にする）

- [ ] **Step 2: 失敗を確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/mcp_tool_params.test.ts`
Expected: FAIL（scrape に renderJs などが残っている）

- [ ] **Step 3: 外す**

- `src/mcp/tools_web.ts` の scrape: 入力から `fastOnly`・`renderJs`・`selectors`・`clipSelector`・`removeSelectors` を消し、分割代入と `scrapeUrl({...})` からも消す。scrape_batch: 分割代入と `scrapeBatchUrls({...})` から `selectors`・`clipSelector`・`removeSelectors` を消す。
- `src/types.ts`: SCRAPE_BATCH_INPUT_SHAPE から `selectors`・`clipSelector`・`removeSelectors` を切り取り、`BatchScrapeRequestSchema` の `...SCRAPE_BATCH_INPUT_SHAPE,` の次に貼る（REST だけに残す）。

- [ ] **Step 4: 通ることを確かめる**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun run typecheck && bun test src/mcp_tool_params.test.ts src/scrape_inputs.test.ts src/tool_contracts.test.ts src/openapi_schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A src
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "chore!: MCP の scrape・scrape_batch から renderJs・fastOnly と CSS セレクタの引数を外す（REST には残す）"
```

### Task B6: クライアント・説明文を直し、全体を確かめる

**Files:**
- Regenerate: `client/`
- Modify: `README.md`・`src/mcp/instructions.ts`（消した引数を挙げていれば）・`docs/code-execution.md`（`extractHighlights` の記述）

- [ ] **Step 1: クライアントを作り直す**

Run: `bun run gen:client && git status --short client/`

- [ ] **Step 2: README を直す**

- `scrape` の行の説明の「U字型配置（Lost in the Middle対策）、MMR多様性選択、Temporal Context Anchor（相対日時の絶対解決）、Block Provenance出所追跡（`[S1:P4]`）・Contextual Highlights（文脈保持パッセージ）・客観的証拠診断量・不一致候補対比・決定論的数値正規化、RAGチャンキング・出典抽出・読了時間・PII保護・要約生成を完備。」を「MMR 多様性選択、Temporal Context Anchor（相対日時の絶対解決）、Block Provenance 出所追跡（`[S1:P4]`）、読了時間、PII 保護に対応。」にする。
- `scrape` の行の引数から `extractHighlights`（`- \`extractHighlights\` / \`query\` (任意)` は `- \`query\` (string, 任意): ハイライトの検索語` にする）・`reorderUFlat`・`diversityWeight`・`minimizeTables`・`evidenceMode`・`includeDiagnostics`・`includeDiscrepancies`・`safeNormalize`・`chunkMarkdown`・`selectors` の項目を消し、`- \`responseMode\` (string, 任意): \`"full"\` (デフォルト) または \`"evidence"\`（ハイライトがあれば content をハイライトに置き換える）` を足す。`selectors` などは「REST だけ」と書いて、REST の説明の節（`grep -n "POST /scrape" README.md`）に移す。
- `search_deep` の行の説明の「インメモリ PRF、U字型配置、MMR多様性選択、Temporal Context Anchor、Smart Table Minimizer、」を「MMR 多様性選択、Temporal Context Anchor、Smart Table Minimizer、」にし、引数の `- \`reorderUFlat\` / \`enablePrf\` / \`diversityWeight\` / \`annotateTemporal\` / \`minimizeTables\` (任意)` を `- \`annotateTemporal\` (boolean, 任意): 相対日時の絶対解決注記 [YYYY-MM-DD]` にする。
- そのほか `grep -n "extractSummary\|extractCitations\|chunkMarkdown\|validateLinks\|formatAsPrompt\|highlightMatches\|filterLinkDensity\|safeNormalize\|includeDiagnostics\|includeDiscrepancies\|diversityWeight\|minimizeTables\|reorderUFlat\|contextual_highlights\|onlyHighlights\|evidenceMode\|enablePrf\|retryDelayMs" README.md` に出る行を、消した引数が無い形に直す。

- [ ] **Step 3: そのほかの説明**

`grep -rn "extractHighlights\|onlyHighlights\|evidenceMode\|reorderUFlat\|enablePrf" src/mcp/instructions.ts docs/code-execution.md docs/search-scrape-mechanics.md` に出る行を、responseMode の形に直す。

- [ ] **Step 4: 型・lint・表記・全件のテスト**

Task A9 の Step 4 と同じ。
Expected: すべて通る。

- [ ] **Step 5: Commit**

```bash
git add client README.md src/mcp/instructions.ts docs
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "docs: 消した引数を説明から外し、responseMode と REST だけの引数を書き、クライアントを作り直す"
```

### Task B7: 消す PR を出す

- [ ] **Step 1: パート A のマージを待ち、rebase する**

パート A がマージされたら:

```bash
git fetch origin && git rebase origin/main
```

衝突したら直し、Task B6 の Step 4 をもう一度走らせる。

- [ ] **Step 2: ユーザーに確かめてから push と PR**

```bash
git push -u origin chore/v4-remove-params
gh pr create --base main --head chore/v4-remove-params --title "chore!: 効いていない・使われていない引数を消し、responseMode にまとめる" --body-file <OUT>/pr-b-body.md
gh pr checks --watch
```

`<OUT>/pr-b-body.md` には、消した引数の表（設計書の 5 の節）、互換（知らない項目は無視されること）、MCP の引数の数を書く。

### Task B8: v4.0.0 のリリースの準備（両方の PR のマージ後、ユーザーに確かめてから）

**Files:**
- Modify: `package.json`（`"version": "4.0.0"`）、`src/types.ts`（`export const SORA_VERSION = '4.0.0';`）、`RELEASE_NOTES.md`（先頭に節を足す）

- [ ] **Step 1: 版を上げ、リリースノートを書く**

`RELEASE_NOTES.md` の先頭に、v3.0.0 の節と同じ形で足す。【】の中は、Task A10〜A12 で記録した数字（`docs/evaluations/main-content/results.md` の「rs-trafilatura の経路の画像（v4.0.0）」と `docs/evaluations/v4-highlights/results.md`）に置き換えてから commit する:

```
# Sora v4.0.0 — rs-trafilatura の経路の画像・本文のリンク・ハイライトの選び方を直し、効いていない・使われていない引数を消した

- **破壊的変更: 効いていない引数を消しました。** `includeDiagnostics`・`includeDiscrepancies`・`diversityWeight`・`minimizeTables`（表は今までどおり縮めます）・`reorderUFlat`、`evidenceMode` の `contextual_highlights`。
- **破壊的変更: 使われていない加工の引数を消しました。** `extractSummary`・`extractCitations`・`chunkMarkdown`・`chunkSize`・`validateLinks`・`formatAsPrompt`・`highlightMatches`・`filterLinkDensity`・`safeNormalize`（本文の数と単位を書き換え、引用元と文字が合わなくなるため）。応答の `summary`・`citations`・`chunks`・`linksWithStatus`・`promptContext`・`highlightedContent`・`derivations` も無くなります。
- **破壊的変更: `search_deep` の `dedup`・`enablePrf`（どちらも既定の false のまま固定）、`scrape` の `webhookUrl`、`retries`・`retryDelayMs`（再試行しない今の既定のまま）を消しました。** `scrape_batch`・巡回・監視の `webhookUrl` は残します。
- **破壊的変更: `onlyHighlights`・`evidenceMode`・`extractHighlights` を `responseMode` にまとめました。** `scrape`・`scrape_batch`・`crawl_site` の既定は `"full"`、`search_deep` の既定は今までどおり `"evidence"` です。scrape 系の `"evidence"` は、ハイライトがあれば content をハイライトに置き換えます（今までの `onlyHighlights: true` と同じ）。
- **破壊的変更: MCP の `scrape`・`scrape_batch` から `renderJs`・`fastOnly` と CSS セレクタの引数（`removeSelectors`・`selectors`・`clipSelector`）を外しました。** REST には残します。MCP の引数は、`scrape` が 38 から 16、`scrape_batch` が 35 から 16、`crawl_site` が 14 から 11、`search_deep` が 32 から 26 になりました。
- 消した引数を送っても、REST も MCP もその項目を無視するだけで、エラーにはなりません。
- **破壊的変更: `formats` の `html` は、ページ全体ではなく本文の HTML（URL は絶対）を返します。** `rawHtml` は今までどおり、取得したそのままの HTML です。
- **破壊的変更: `description` を、ハイライトの 1 件目で置き換えなくなりました。** meta の説明文（og:description・meta description・JSON-LD）だけを返します。
- **rs-trafilatura の経路でも、本文に画像が入るようにしました。** rs-trafilatura が返す本文の HTML には img が入らないため、記事以外の種類で画像のあるページでは、画像の後ろに目印の 1 字を置いた HTML でもう一度取り出し、本文の文字が 1 回目と同じときだけ目印を画像に戻します。本文の点（WCXB・Bevendorff らの評価集）は変わらず、【日本語の 72 ページで画像が戻ったページ数と枚数】。2 回目を走らせるページでは、時間が【中央値】増えます。
- **`removeSelectors` が rs-trafilatura の経路でも効くようにしました。** 指定された要素を、rs-trafilatura に渡す前に消します。
- **本文のリンクを絶対 URL にしました。** `#` だけのリンクと `javascript:` のリンクは、文字だけにします。
- **ハイライトを、`maxChars` で切る前の全文（上限 200,000 字）から選ぶようにしました。** 【長いページ 10 件の結果】。
- **節の中のリンクだけの段落（言語の一覧など）を、ハイライトの候補から外しました。**
- **`annotateTemporal` がハイライトにも効くようにしました。** `search_deep` の `evidence` でも注記が残ります。
- **`includeMedia` を `scrape`・`scrape_batch`・`crawl_site` にも足しました。** `false` で本文の画像を `[画像: alt]` にし、`ogImage` と `media` を省きます。
```

- [ ] **Step 2: 確かめて Commit**

Run: `unset HTTPS_PROXY HTTP_PROXY; bun test src/version_contract.test.ts`
Expected: PASS

```bash
git add package.json src/types.ts RELEASE_NOTES.md
git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit -m "chore(release): v4.0.0"
```

- [ ] **Step 3: タグとリリース・本番反映**

タグ・GitHub のリリース・イメージの公開・本番反映は、いつもの手順で、それぞれユーザーに確かめてから行う（本番反映の手順はこのリポジトリには書かない）。
