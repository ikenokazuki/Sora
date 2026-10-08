import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  anchorCandidates,
  detectAliasFromOfficialPosts,
  detectRealtimeAnchor,
  isAnchorBroken,
  postMentions,
  termHits,
} from './realtime_anchor.js';

describe('termHits', () => {
  test('カタカナ・英数字の語は、同じ文字種に挟まれた一致を数えない（空白・中黒は境界）', () => {
    expect(termHits('ライブ', 'ライブ情報まとめ')).toBe(true);
    expect(termHits('ライブ', 'ライブラリの使い方')).toBe(false);
    expect(termHits('API', 'Web API 一覧')).toBe(true);
    expect(termHits('API', 'RAPID 公式')).toBe(false);
    expect(termHits('ChatGPT', 'ChatGPT Plus の料金')).toBe(true);
    expect(termHits('Snow', 'Snow・Man')).toBe(true);
  });

  test('NFKC・大小文字・空白と中黒を無視する', () => {
    expect(termHits('=LOVE', '＝ＬＯＶＥ（イコールラブ）公式サイト')).toBe(true);
    expect(termHits('渋谷VIDENT', '渋谷 vident へのアクセス')).toBe(true);
  });

  test('漢字の語は部分一致で数える', () => {
    expect(termHits('デジタル庁', 'デジタル庁ウェブサイト')).toBe(true);
  });
});

describe('detectRealtimeAnchor', () => {
  const titles = [
    '=LOVE（イコールラブ）オフィシャルサイト',
    'SCHEDULE | =LOVE（イコールラブ）公式サイト',
    '=LOVE 全国ツアー2026 ライブ日程 - チケットぴあ',
    'ライブ予定の立て方 | 音楽ナタリー',
  ];

  test('固有名詞が先頭・末尾・中央のどこにあっても同じ語を選ぶ', () => {
    expect(detectRealtimeAnchor(['=LOVE', 'ライブ', '予定'], titles)).toBe('=LOVE');
    expect(detectRealtimeAnchor(['ライブ', '予定', '=LOVE'], titles)).toBe('=LOVE');
    expect(detectRealtimeAnchor(['ライブ', '=LOVE', '予定'], titles)).toBe('=LOVE');
  });

  test('意図語・予定系の語・数値は候補にしない', () => {
    expect(anchorCandidates(['架空アイドルほげぴよ', '出演時間', '14:10'])).toEqual(['架空アイドルほげぴよ']);
    expect(anchorCandidates(['ライブ', '予定'])).toEqual(['ライブ']);
    // 全部が汎用語なら全語を候補に残す
    expect(anchorCandidates(['今日', '予定'])).toEqual(['今日', '予定']);
  });

  test('候補が1語ならタイトルが無くても決まる', () => {
    expect(detectRealtimeAnchor(['黒氏萌楓', '生年月日'], [])).toBe('黒氏萌楓');
  });

  test('候補が2語以上で判定材料が無ければ決めない（従来の緩和に任せる）', () => {
    expect(detectRealtimeAnchor(['=LOVE', 'ライブ'], [])).toBeUndefined();
    expect(detectRealtimeAnchor(['=LOVE', 'ライブ'], ['天気予報 | 気象協会'])).toBeUndefined();
  });

  test('サイト名部分の一致を加点する', () => {
    const t = ['デジタル庁のAPI一覧', 'Web API 設計ガイド', 'API カタログ | デジタル庁', '組織 | デジタル庁', 'API とは'];
    // タイトル一致は API 4 / デジタル庁 3 だが、サイト名一致を足すと デジタル庁 5 > API 4
    expect(detectRealtimeAnchor(['Web', 'API', 'デジタル庁'], t)).toBe('デジタル庁');
  });

  test('評価セット（保存済みの Web タイトル・総ヒット数）で設計時の判定精度を保つ', () => {
    const data = JSON.parse(readFileSync(join(import.meta.dir, '../../eval/realtime_anchor_cases.json'), 'utf8'));
    const ok: Record<string, number> = { dev: 0, held: 0 };
    for (const c of data.cases) {
      for (const q of c.queries) {
        if (c.anchors.includes(detectRealtimeAnchor(q.terms, q.webTitles, q.totals))) ok[c.split]++;
      }
    }
    expect(ok).toEqual({ dev: 24, held: 24 });
  });

  test('総ヒット数が分かれば、ありふれた語を下げる（同点の解消）', () => {
    const t = ['渋谷VIDENTへの行き方'];
    expect(detectRealtimeAnchor(['行き方', '渋谷VIDENT'], t)).toBe('行き方');
    expect(detectRealtimeAnchor(['行き方', '渋谷VIDENT'], t, { '行き方': 346, '渋谷VIDENT': 159 })).toBe('渋谷VIDENT');
    // 一部の語しか分からないときは総ヒット数を使わない
    expect(detectRealtimeAnchor(['行き方', '渋谷VIDENT'], t, { '渋谷VIDENT': 159 })).toBe('行き方');
  });
});

describe('detectAliasFromOfficialPosts', () => {
  const posts = [
    { text: '【お知らせ】新曲MV公開 #イコラブ #イコラブ_ニューシングル' },
    { text: '本日のライブありがとうございました #イコラブ #齊藤なぎさ' },
    { text: 'チケット情報はこちら #イコラブ' },
    { text: 'ラジオに出演します' },
  ];

  test('公式投稿のハッシュタグ先頭の日本語部分から別名を取る', () => {
    expect(detectAliasFromOfficialPosts(posts, ['=LOVE', 'ライブ', '予定'])).toBe('イコラブ');
  });

  test('2件未満・30%未満のタグは別名にしない', () => {
    expect(detectAliasFromOfficialPosts([posts[0], ...Array(6).fill({ text: '告知' })], ['=LOVE'])).toBeUndefined();
    expect(detectAliasFromOfficialPosts([posts[0], posts[2], ...Array(6).fill({ text: '告知' })], ['=LOVE'])).toBeUndefined();
    expect(detectAliasFromOfficialPosts([], ['=LOVE'])).toBeUndefined();
  });

  test('クエリ語と重なる語・汎用語を含む語は別名にしない', () => {
    const tagged = (tag: string) => [{ text: `#${tag}` }, { text: `#${tag} 告知` }];
    expect(detectAliasFromOfficialPosts(tagged('ライブ'), ['=LOVE', 'ライブ'])).toBeUndefined();
    expect(detectAliasFromOfficialPosts(tagged('日向坂'), ['日向坂46', 'ライブ'])).toBeUndefined();
    expect(detectAliasFromOfficialPosts(tagged('イコラブ公式'), ['=LOVE'])).toBeUndefined();
  });
});

describe('postMentions / isAnchorBroken', () => {
  const post = (text: string, author_name = 'fan') => ({ text, author_name });

  test('本文か表示名に語があれば含むとみなす', () => {
    expect(postMentions(post('＝LOVE 最高'), ['=LOVE'])).toBe(true);
    expect(postMentions(post('今日も最高', '=LOVE公式'), ['=LOVE'])).toBe(true);
    expect(postMentions(post('LOVE ソング'), ['=LOVE', 'イコラブ'])).toBe(false);
    expect(postMentions(post('イコラブのライブ'), ['=LOVE', 'イコラブ'])).toBe(true);
  });

  test('固有名詞を含む投稿が半数未満なら壊れているとみなす（0件は判断しない）', () => {
    const noise = Array.from({ length: 8 }, () => post('LOVE ライブ 予定'));
    expect(isAnchorBroken('=LOVE', [...noise, post('=LOVE ライブ'), post('=LOVE 予定')])).toBe(true);
    expect(isAnchorBroken('=LOVE', [post('=LOVE ライブ'), post('LOVE')])).toBe(false);
    expect(isAnchorBroken('=LOVE', [])).toBe(false);
  });
});
