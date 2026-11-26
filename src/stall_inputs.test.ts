import { afterAll, describe, expect, test } from 'bun:test';
import { calculateContentQuality, cleanMarkdownTokens, computeAnswerability, extractQueryHighlightDetails, replaceMarkdownImages } from './enrichment.js';
import { rsComparableText } from './extractor/rs_images.js';
import { convertHtmlToMarkdown, splitQueryUrls } from './html_parser.js';
import { canonicalHost, isBlockedHostname } from './net/ip_policy.js';
import { setHtsModelForTest } from './services/hts_model.js';
import { predictHtsCode } from './services/trade.js';

// 全員の要求は 1 本のスレッドで処理するので、1 つの重い入力が、全員を止める。長い繰り返しの入力でも、時間が長さに比例すること
// （前はどれも長さの二乗で、上限の何倍もかかった。数は Bun 1.4.4 の実測。上限は、全件の実行で遅くなる分の余裕を入れて、直したあとの数倍）

const within = (limitMs: number, work: () => unknown) => {
  const started = performance.now();
  work();
  expect(performance.now() - started).toBeLessThan(limitMs);
};

describe('Markdown の掃除', () => {
  test('[ の長い並び（コードの欄）でも時間がかからない（前は javascript: のリンクを外す所で、10 万字が 9 秒）', () => {
    within(1000, () => cleanMarkdownTokens(`\`\`\`\n${'['.repeat(100_000)}\n\`\`\``));
  });

  test('![ の長い並びでも時間がかからない（前は画像の記法の掃除で、二乗の時間）', () => {
    within(1000, () => cleanMarkdownTokens('!['.repeat(60_000)));
    within(1000, () => replaceMarkdownImages('!['.repeat(60_000)));
  });

  test('本文の品質の判定の、リンクの数え上げも同じ（前は [ 20 万字が 30 秒ほど）', () => {
    within(1000, () => calculateContentQuality({ markdown: '['.repeat(200_000) }));
  });
});

describe('HTML の変換', () => {
  const page = (body: string, head = '') => `<html><head><title>t</title>${head}</head><body><main><article><h1>見出し</h1><p>${'ふつうの本文の段落です。'.repeat(10)}</p>${body}</article></main></body></html>`;
  const convert = (html: string, stripLinks = false) => convertHtmlToMarkdown(html, 'https://x.example/', 100_000, false, true, undefined, undefined, stripLinks);

  test('コードの欄の [ の長い並びと stripLinks でも時間がかからない', () => {
    within(3000, () => convert(page(`<pre><code>${'['.repeat(100_000)}x</code></pre>`), true));
  });

  test('コードの欄の改行の長い並びでも時間がかからない（前は末尾の改行を取る所で、10 万字が 7 秒）', () => {
    within(3000, () => convert(page(`<pre><code>${'\n'.repeat(100_000)}x</code></pre>`)));
  });

  test('空白の長い並び（全角の空白・コードの欄）でも時間がかからない（前は turndown の仕上げで、10 万字が 10 秒以上。patches/ で直した）', () => {
    within(3000, () => convert(page(`<p>${'　'.repeat(100_000)}x</p>`)));
    within(3000, () => convert(page(`<pre><code>${' '.repeat(100_000)}x</code></pre>`)));
  });

  test('meta の名前の長い空白でも時間がかからない（前は Readability の正規表現で、10 万字が 10 秒以上）', () => {
    within(3000, () => convert(page('', `<meta property="${' '.repeat(100_000)}x" content="v"><meta name="${'\r\n'.repeat(50_000)}x" content="v">`)));
  });

  test('要素の深い入れ子でも時間がかからない（前は Readability が深さ × 要素の数の時間で、50KB の 512 段が 21 秒）。本文は残る', () => {
    const deep = page(`${'<div>'.repeat(512)}${'<span>x </span>'.repeat(3000)}<p>底の段落の文です。</p>${'</div>'.repeat(512)}`);
    let result!: ReturnType<typeof convert>;
    within(3000, () => {
      result = convert(deep);
    });
    expect(result.markdown).toContain('底の段落の文です。');
  });

  test('60 段くらいの入れ子のページは、今までどおり Readability で本文を取る（ナビゲーションは入らない）', () => {
    const nav = `<nav>${'<a href="/menu">メニューの項目</a>'.repeat(30)}</nav>`;
    const body = `${'<div>'.repeat(60)}<article><p>${'本文の長い段落の文章です。'.repeat(40)}</p></article>${'</div>'.repeat(60)}`;
    const result = convert(`<html><head><title>t</title></head><body>${nav}${body}</body></html>`);
    expect(result.markdown).toContain('本文の長い段落の文章です。');
    expect(result.markdown).not.toContain('メニューの項目');
  });

  test('深すぎるページに rs-trafilatura の本文があれば、記事と判定されていても、そちらを使う', () => {
    const nav = `<nav>${'<a href="/menu">メニューの項目</a>'.repeat(30)}</nav>`;
    const html = `<html><head><title>t</title></head><body>${nav}${'<div>'.repeat(150)}<p>${'本文の段落の文章です。'.repeat(40)}</p>${'</div>'.repeat(150)}</body></html>`;
    const result = convertHtmlToMarkdown(html, 'https://x.example/', 100_000, false, true, undefined, undefined, undefined, false, { pageType: 'article', contentHtml: '<p>rs が取り出した本文です。</p>' });
    expect(result.markdown).toContain('rs が取り出した本文です。');
    expect(result.markdown).not.toContain('メニューの項目');
  });

  test('長すぎる meta の名前を除いても、ふつうの meta は読む', () => {
    const result = convert(page('', '<meta property="og:title" content="OG の題名"><meta name="author" content="書いた人"><meta property="article:published_time" content="2026-11-01">'));
    expect(result.author).toBe('書いた人');
    expect(result.publishedTime).toBe('2026-11-01');
  });
});

describe('仕上げと検索', () => {
  test('短い行が大量に並ぶ本文でも、ハイライトの区間の選び方に時間がかからない（前は 20 万字が 3.5 秒）', () => {
    // 検索語のある段落が少しだけで、短い行が大量に並ぶ本文（区間の選び直しが多く回る、実測で最も重い形）
    const body = `これはふつうの本文の段落です。price 10 の案内があります。明日の予定です。\n${'x\n'.repeat(100_000)}`;
    // 直した後は手元で約 0.6 秒、前は 3.5 秒。CI の遅い機械の分の余裕を入れる
    within(2500, () => extractQueryHighlightDetails(body, '明日 price 10 円 料金'));
  });

  test('数字の長い並びの本文でも、答えがあるかの判定に時間がかからない（前は 10 万字が 10 秒以上）', () => {
    within(1000, () => computeAnswerability({ markdown: '1'.repeat(100_000) }, '料金'));
    expect(computeAnswerability({ markdown: '料金は 1,200 円です' }, '料金').signals).toContain('price');
    expect(computeAnswerability({ markdown: '開催は 11/26 です' }, '日程').signals).toContain('concrete');
  });

  test('検索語の点の長い並びでも、URL の切り出しに時間がかからない（前は 10 万字が 7 秒）', () => {
    within(1000, () => splitQueryUrls(`http://example.test/${'.'.repeat(100_000)}a`));
    expect(splitQueryUrls('(http://example.test/a).…。 の内容').urls).toEqual(['http://example.test/a']);
  });

  test('比べる文字を作る処理は、閉じない < の長い並びでも時間がかからない（前は 20 万字が数秒）', () => {
    within(1000, () => rsComparableText('<'.repeat(200_000)));
    expect(rsComparableText('<p>a</p><br/><div title="x<y">b</div>')).toBe('a b');
  });

  test('ホスト名の末尾の点の長い並びでも時間がかからない', () => {
    within(500, () => canonicalHost(`a${'.'.repeat(100_000)}a`));
    within(500, () => isBlockedHostname(`a${'.'.repeat(100_000)}a`));
    expect(canonicalHost('Example.COM...')).toBe('example.com');
  });
});

describe('HTS の推測の入力', () => {
  afterAll(() => setHtsModelForTest(undefined));

  test('説明の長い空白でも、モデルに渡す文を作るのに時間がかからない（前は 10 万字が 10 秒）', async () => {
    setHtsModelForTest(() => {
      throw new Error('stub');
    });
    const started = performance.now();
    await expect(predictHtsCode({ productName: '積み木', description: `a${' '.repeat(100_000)}a` })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
