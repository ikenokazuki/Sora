import { describe, expect, test } from 'bun:test';
import { extractQueryHighlightDetails } from '../enrichment.js';
import { NAV_MIN_DISTINCT_HOSTS, isNavBlock, parseMarkdownSections } from './markdown_sections.js';

// 言語ごとに別のホスト（Wikipedia の言語の一覧と同じ形）
const langs = ['English', 'Français', 'Deutsch', '中文', '한국어', 'Español'].map((l) => `- [${l}](https://${encodeURIComponent(l)}.example.org/wiki/Tokyo_Dome)`).join('\n');
// SNS の行（別々のホストへのリンク）。n 個ぶん
const snsAll: Array<[string, string]> = [
  ['X', 'https://x.com/artist'],
  ['Instagram', 'https://www.instagram.com/artist'],
  ['YouTube', 'https://www.youtube.com/@artist'],
  ['TikTok', 'https://www.tiktok.com/@artist'],
  ['Facebook', 'https://www.facebook.com/artist'],
  ['LINE', 'https://line.me/R/ti/p/@artist'],
  ['note', 'https://note.com/artist'],
  ['Threads', 'https://www.threads.net/@artist'],
];
const sns = (n: number) => snsAll.slice(0, n).map(([label, url]) => `- [${label}](${url})`).join('\n');

describe('parseMarkdownSections のナビの段落', () => {
  test('節の中の、短いラベルのリンクだけの段落（2 行以上。言語ごとに別のホストの一覧）を外す', () => {
    expect(langs.split('\n').length).toBeGreaterThanOrEqual(NAV_MIN_DISTINCT_HOSTS);
    const [sec] = parseMarkdownSections(`# 東京ドーム\n\n${langs}\n\n東京ドームは東京都文京区にある球場です。収容人数は約 5 万人です。`);
    expect(sec.fullText).not.toContain('English');
    expect(sec.fullText).toContain('収容人数は約 5 万人');
  });

  test('リンク先のホストが下限以上あるときだけ外す（SNS の行）', () => {
    expect(snsAll.length).toBeGreaterThanOrEqual(NAV_MIN_DISTINCT_HOSTS);
    const doc = (links: string) => `# 歌手A\n\n## 公式リンク\n\n${links}\n\n## 概要\n\n歌手Aは日本のシンガーソングライターです。`;
    // 下限と同じ数のホスト: 外れる（SNS の行だけの節は無くなる）
    expect(parseMarkdownSections(doc(sns(NAV_MIN_DISTINCT_HOSTS))).map((s) => s.heading)).toEqual(['歌手A > 概要']);
    // 下限より 1 つ少ない: 残る
    const kept = parseMarkdownSections(doc(sns(NAV_MIN_DISTINCT_HOSTS - 1)));
    expect(kept.map((s) => s.heading)).toEqual(['歌手A > 公式リンク', '歌手A > 概要']);
    expect(kept[0].fullText).toContain('[X](https://x.com/artist)');
  });

  test('同じホストへのリンクだけの一覧（曲名・作品名・カテゴリ）は、行がいくつあっても外さない', () => {
    const songs = Array.from({ length: Math.max(8, NAV_MIN_DISTINCT_HOSTS * 2) }, (_, i) => `- [曲${i}](https://example.com/songs/${i})`).join('\n');
    const md = `# 歌手A\n\n歌手Aは日本のシンガーソングライターです。2015 年にデビューしました。\n\n## シングル\n\n${songs}\n\n## 受賞歴\n\n2020 年に新人賞を受賞しました。`;
    const single = parseMarkdownSections(md).find((s) => s.heading === '歌手A > シングル');
    expect(single?.fullText).toContain('[曲0](https://example.com/songs/0)');
    expect(single?.fullText).toContain('[曲7](https://example.com/songs/7)');
    // 検索語に合うその節が、1 番目のハイライトに選ばれる
    const { highlights } = extractQueryHighlightDetails(md, 'シングル 曲');
    expect(highlights[0]).toContain('## 歌手A > シングル');
    expect(highlights[0]).toContain('[曲0](https://example.com/songs/0)');
  });

  test('ホストに数えないもの（相対のリンク・メール・電話・読めない URL）と、同じホストの重なり', () => {
    // 絶対 URL のホストは下限より 1 つ少ない。各ホストに 2 行ずつ書く（パスが違っても同じホスト）
    const absolute = Array.from({ length: NAV_MIN_DISTINCT_HOSTS - 1 }, (_, i) => [
      `- [サイト${i}の料金](https://site${i}.example.com/price)`,
      `- [サイト${i}の採用](https://site${i}.example.com/recruit)`,
    ]).flat();
    const others = ['- [ホーム](/)', '- [会社概要](../about)', '- [お問い合わせ](mailto:info@example.com)', '- [電話](tel:0312345678)', '- [壊れた](http://:80)'];
    const [sec] = parseMarkdownSections(`# 会社\n\n${[...absolute, ...others].join('\n')}\n\n本文です。`);
    // どれも数えないので下限に届かず、段落は残る
    expect(sec.fullText).toContain('[ホーム](/)');
    expect(sec.fullText).toContain('[サイト0の料金](https://site0.example.com/price)');
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
  // 行全体が 1 つのリンクか（最後の `](` の後ろの最初の `)` が行の末尾か）の境目: URL が空でも閉じていれば真、URL の後ろに文字と `)` があれば偽
  expect(isNavBlock('[a]()\n[b](c)')).toBe(true);
  expect(isNavBlock('[a](b) c)\n[d](e)')).toBe(false);
});

test('細工した入力でも、リンク行と前置きのパンくずの判定に時間がかからない', () => {
  // リンク行の判定: `](` の多い 1 行（前の正規表現は長さの二乗の時間で、200,000 字で 7〜18 秒止まった）
  let t = performance.now();
  expect(isNavBlock(`[${']('.repeat(50_000)}))\n[a](b)`)).toBe(false);
  expect(performance.now() - t).toBeLessThan(500);
  // 前置きのパンくずの判定: リンクの並びの後ろに別の字（前の正規表現は組み合わせが指数で増え、121 字で 2 秒止まった）
  t = performance.now();
  const sections = parseMarkdownSections(`${'[a](b)'.repeat(20)}x\n\n# 見出し\n\n本文です。`);
  expect(performance.now() - t).toBeLessThan(500);
  // 「x」があるのでリンクの並びだけではなく、前置きは節に残る
  expect(sections.map((s) => s.fullText)).toEqual([`${'[a](b)'.repeat(20)}x`, '本文です。']);
});

test('リンク先のホストを数える処理も、長い段落で時間がかからない', () => {
  // 同じホストへのリンクだけの 200,000 字の段落（下限に届かないので最後まで数える）と、読めない絶対 URL だけの段落（new URL が毎回例外を投げる）
  for (const row of ['- [a](https://example.com/x)', '[a](http://:80)']) {
    const doc = `# 見出し\n\n${`${row}\n`.repeat(Math.floor(200_000 / (row.length + 1)))}`;
    const t = performance.now();
    parseMarkdownSections(doc);
    expect(performance.now() - t).toBeLessThan(500);
  }
});

test('前置きのパンくず（リンクの並び）は、区切りがあってもなくても節にしない', () => {
  expect(parseMarkdownSections('[ホーム](/) > [ニュース](/news)\n\n# 見出し\n\n本文です。').map((s) => s.fullText)).toEqual(['本文です。']);
  expect(parseMarkdownSections('[ホーム](/x)[会社概要](/about)\n\n# 見出し\n\n本文です。').map((s) => s.fullText)).toEqual(['本文です。']);
});

test('パンくずの行から最後の節を取る（区切りが多くても、行が並んでも時間がかからない）', () => {
  expect(parseMarkdownSections('> 📍 **階層**: ホーム > ニュース > 記事の題\n\n本文です。').map((s) => s.heading)).toEqual(['記事の題']);
  // 行が区切りで終わるときは、次の行の字を見出しにしない（前の正規表現は改行をまたいで「本文です。」を取った）
  expect(parseMarkdownSections('> 📍 **階層**: ホーム >\n\n本文です。').map((s) => s.heading)).toEqual(['']);
  let t = performance.now();
  parseMarkdownSections(`# 見出し\n\n本文です。\n\n> 📍 **階層**: ${'>'.repeat(30)}`);
  expect(performance.now() - t).toBeLessThan(500);
  t = performance.now();
  parseMarkdownSections(`# 見出し\n\n本文です。\n\n${'> 📍 **階層**: >\n'.repeat(5000)}`);
  expect(performance.now() - t).toBeLessThan(500);
});

describe('パンくずの行から最後の節を取る（行の区切り・区切りの文字・最後の区間が空の行）', () => {
  const headings = (doc: string) => parseMarkdownSections(doc).map((s) => s.heading);
  const crumb = '> 📍 **階層**: ホーム > ニュース > 記事の題';

  test('CRLF の文書でも最後の節を取る', () => {
    expect(headings(`${crumb}\r\n\r\n本文です。`)).toEqual(['記事の題']);
    // 行が区切りで終わるときは、CRLF でも次の行の字を見出しにしない
    expect(headings('> 📍 **階層**: ホーム >\r\n\r\n本文です。')).toEqual(['']);
  });

  test('区切りが › でも、最後の節を取る', () => {
    expect(headings('> 📍 **階層**: ホーム › ニュース › 記事の題\n\n本文です。')).toEqual(['記事の題']);
  });

  test('最後の区間が空の行は飛ばして、後ろの別のパンくずの行から取る', () => {
    expect(headings(`> 📍 **階層**: ホーム >\n${crumb}\n\n本文です。`)).toEqual(['記事の題']);
    expect(headings(`> 📍 **階層**: ホーム >\r\n${crumb}\r\n\r\n本文です。`)).toEqual(['記事の題']);
  });

  test('単独の \\r・U+2028・U+2029 で区切った文書でも、最後の節を取る', () => {
    // JSON-LD の BreadcrumbList の名前に、これらの字が入りうる。前は \r?\n でしか行を分けず、行全体が 1 行のまま読めなかった
    for (const [label, sep] of [['\\r', '\r'], ['U+2028', String.fromCharCode(0x2028)], ['U+2029', String.fromCharCode(0x2029)]] as const) {
      expect(headings(`${crumb}${sep}${sep}本文です。`), label).toEqual(['記事の題']);
      expect(headings(`> 📍 **階層**: ホーム >${sep}${crumb}${sep}${sep}本文です。`), `${label}: 最後の区間が空の行のあと`).toEqual(['記事の題']);
    }
  });
});
