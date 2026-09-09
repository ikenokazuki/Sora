import { describe, expect, it } from 'bun:test';
import {
  ancestorBonus,
  bm25BodyScore,
  extractBestPassage,
  extractTermsWithBigrams,
  HeadingBlock,
  idf,
  parseBlocks,
  scorePassage,
  splitSentences,
  dinkelbachOptimalPassage,
} from './hierarchical_bm25';

describe('Hierarchical BM25 Passage Extractor', () => {
  const DOC_MULTIGROUP = `
# アイドルグループ楽曲まとめ
## 星風エトワール
### シングル表題曲一覧
#### 星屑のレシピ
2作目のシングル。この楽曲ではメンバーがセンターを務め、透明感のある歌声が話題となった。
## 月光ハミングバード
### シングル表題曲一覧
#### 夢見るトワイライト
3作目のシングル。この楽曲でもメンバーがセンターを務め、透明感のある歌声が話題となった。
`;

  const DOC_SINGLEGROUP = `
# 星風エトワール
## シングル表題曲一覧
### 星屑のレシピ
2作目のシングル。この楽曲ではメンバーがセンターを務め、透明感のある歌声が話題となった。
### 花柄のパスポート
3作目のシングル。この楽曲でも新メンバーがセンターを務め、力強いパフォーマンスが評価された。
`;

  const DOC_FAQ = `
# よくある質問
## Q&A
### グッズの購入方法について
公式オンラインストアでは会員登録をすると先行販売に参加できます。店頭販売は東京と大阪の直営店のみで実施しています。
### ライブチケットの申し込み方法
チケットはファンクラブ会員限定の抽選先行で申し込みでき、一般発売は各プレイガイドで行われます。
`;

  const DOC_MEMBERS = `
# 光のシルエット オフィシャルサイト
## メンバー紹介
### 七海るい
七海るいは元気いっぱいのムードメーカー。推し活、推し活、とにかく推し活という言葉が七海るいの口癖で、日々のブログでも推し活について語ることが多い。
### 桃井このみ
桃井このみは新加入メンバーで特技はダンス。推し活イベントでファンと交流した際、余興でバック転を披露して会場を沸かせた。
`;

  const REGRESSION_CASES: [string, string[], string][] = [
    [DOC_MULTIGROUP, ['星風エトワール', 'センター'], '星屑のレシピ'],
    [DOC_MULTIGROUP, ['月光ハミングバード', 'センター'], '夢見るトワイライト'],
    [DOC_SINGLEGROUP, ['星屑のレシピ', 'センター'], '星屑のレシピ'],
    [DOC_SINGLEGROUP, ['花柄のパスポート', 'センター'], '花柄のパスポート'],
    [DOC_FAQ, ['会員登録', '先行販売'], 'グッズの購入方法について'],
    [DOC_FAQ, ['抽選', 'プレイガイド'], 'ライブチケットの申し込み方法'],
    [DOC_MEMBERS, ['推し活', 'バック転'], '桃井このみ'],
  ];

  it.each(REGRESSION_CASES)(
    'regression test: query %j should extract nearestHeading %s',
    (doc, terms, expectedNearestHeading) => {
      const best = extractBestPassage(doc, terms);
      expect(best.nearestHeading).toBe(expectedNearestHeading);
    }
  );

  it('parseBlocks should correctly extract heading hierarchy and breadcrumbs', () => {
    const blocks = parseBlocks(DOC_MULTIGROUP);
    expect(blocks.length).toBe(2);

    expect(blocks[0].headingPath).toEqual([
      'アイドルグループ楽曲まとめ',
      '星風エトワール',
      'シングル表題曲一覧',
      '星屑のレシピ',
    ]);
    expect(blocks[0].nearestHeading).toBe('星屑のレシピ');
    expect(blocks[0].depth).toBe(4);
    expect(blocks[0].body).toContain('2作目のシングル');

    expect(blocks[1].headingPath).toEqual([
      'アイドルグループ楽曲まとめ',
      '月光ハミングバード',
      'シングル表題曲一覧',
      '夢見るトワイライト',
    ]);
    expect(blocks[1].nearestHeading).toBe('夢見るトワイライト');
    expect(blocks[1].depth).toBe(4);
    expect(blocks[1].body).toContain('3作目のシングル');
  });

  it('idf should return higher value for rare terms across blocks', () => {
    const blocks = parseBlocks(DOC_MULTIGROUP);
    // "センター" は両方のブロックに存在
    const idfCommon = idf('センター', blocks, 'body');
    // "レシピ" はブロック0にのみ存在
    const idfRare = idf('レシピ', blocks, 'body');

    expect(idfRare).toBeGreaterThan(idfCommon);
  });

  it('ancestorBonus should decay with heading distance from leaf', () => {
    const blocks = parseBlocks(DOC_MULTIGROUP);
    const block0 = blocks[0]; // headingPath: ['アイドルグループ楽曲まとめ', '星風エトワール', 'シングル表題曲一覧', '星屑のレシピ']

    // 直近見出し（距離0）の一致ボーナス
    const bonusLeaf = ancestorBonus(block0, ['星屑のレシピ'], blocks, 0.6);
    // 親見出し（距離2）の一致ボーナス
    const bonusParent = ancestorBonus(block0, ['星風エトワール'], blocks, 0.6);

    expect(bonusLeaf).toBeGreaterThan(bonusParent);
  });

  it('extractTermsWithBigrams should generate adjacent word bigrams for compound words', () => {
    const terms = extractTermsWithBigrams('星風 エトワール センター');
    expect(terms).toContain('星風');
    expect(terms).toContain('エトワール');
    expect(terms).toContain('センター');
    expect(terms).toContain('星風エトワール');
    expect(terms).toContain('エトワールセンター');
  });

  it('parseBlocks should fallback to paragraphs when document has no headings', () => {
    const plainMarkdown = '第一段落です。東京ドームでのライブ情報について解説します。\n\n第二段落です。チケット発売日と先行抽選予約のスケジュールです。\n\n第三段落です。会場へのアクセスとグッズ販売情報です。';
    const blocks = parseBlocks(plainMarkdown);
    expect(blocks.length).toBe(3);
    expect(blocks[0].body).toContain('第一段落');
    expect(blocks[1].body).toContain('第二段落');
    expect(blocks[2].body).toContain('第三段落');
    expect(blocks[0].headingPath.length).toBe(0);
  });

  it('extractBestPassage should find the most relevant paragraph from headingless markdown', () => {
    const plainMarkdown = '一般的な挨拶文です。本日は晴天なり。\n\nチケット発売日は2026年9月6日午前10時より開始されます。\n\n終了後のアンケートにご協力ください。';
    const terms = extractTermsWithBigrams('チケット 発売日');
    const best = extractBestPassage(plainMarkdown, terms);
    expect(best.body).toContain('チケット発売日');
  });

  it('splitSentences should split text into individual sentences while preserving punctuation', () => {
    const text = 'こんにちは！今日は良い天気ですね。明日も晴れるでしょうか？はい、晴れます。';
    const sentences = splitSentences(text);
    expect(sentences.length).toBe(4);
    expect(sentences[0]).toBe('こんにちは！');
    expect(sentences[1]).toBe('今日は良い天気ですね。');
    expect(sentences[2]).toBe('明日も晴れるでしょうか？');
    expect(sentences[3]).toBe('はい、晴れます。');
  });

  it('dinkelbachOptimalPassage should overcome local score valleys and extract global optimal passage', () => {
    // 文0: 背景説明（スコア0）
    // 文1: キーワードを含む高スコア文
    // 文2: 接続文（スコア0、尺取り法だとここでウィンドウを閉じがち）
    // 文3: キーワードを強く含む最高スコア文
    // 文4: 無関係な締めくくり文（スコア0）
    const longBody = [
      '昨今のエンターテインメント業界は急速に進化しています。',
      '星風エトワールは圧倒的な歌唱力と洗練されたダンスで注目を集める次世代グループです。',
      'メンバー全員が厳しいオーディションを勝ち抜いて結成されました。',
      '代表曲である星風エトワールの新曲シングルはチャート1位を記録しました。',
      '今後の活動スケジュールは公式サイトにて随時更新される予定です。',
    ].join('\n');

    const terms = extractTermsWithBigrams('星風エトワール');
    const blocks = parseBlocks(longBody);
    const optimal = dinkelbachOptimalPassage(longBody, terms, blocks, { minChars: 40, maxChars: 200 });

    // 文1と文3の両方を含む最大密度の最適区間が切り出されていること
    expect(optimal).toContain('星風エトワールは圧倒的な歌唱力');
    expect(optimal).toContain('代表曲である星風エトワール');
  });
});
