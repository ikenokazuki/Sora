import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  anchorCandidates,
  detectAliasFromOfficialPosts,
  detectRealtimeAnchor,
  detectRealtimeFocus,
  isAnchorBroken,
  isPublicFocusTerm,
  isSearchExcludedTerm,
  officialAccountMatches,
  postMentions,
  selectRealtimeItems,
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

  const evalQueries = () => {
    const data = JSON.parse(readFileSync(join(import.meta.dir, '../../eval/realtime_anchor_cases.json'), 'utf8'));
    return data.cases.flatMap((c: any) => c.queries.map((q: any) => ({ ...q, split: c.split as string, anchors: c.anchors as string[] })));
  };

  test('評価セット（保存済みの Web タイトル・総ヒット数）で、誤った固有名詞を選ばない', () => {
    const count: Record<string, { ok: number; none: number; wrong: string[] }> = {};
    for (const q of evalQueries()) {
      const c = (count[q.split] ??= { ok: 0, none: 0, wrong: [] });
      const anchor = detectRealtimeAnchor(q.terms, q.webTitles, q.totals);
      if (anchor === undefined) c.none++;
      else if (q.anchors.includes(anchor)) c.ok++;
      else c.wrong.push(`${q.terms.join(' ')} → ${anchor}`);
    }
    // 誤りは 0。決めないのは、固有名詞が無いクエリ（アイドルフェス 持ち物 注意点 の語順 3 通り）だけ
    expect(count.dev).toEqual({ ok: 26, none: 3, wrong: [] });
    expect(count.held).toEqual({ ok: 24, none: 0, wrong: [] });
  });

  test('サイト名の枠に出る語を固有名詞にする（Web API デジタル庁 は API ではなくデジタル庁）', () => {
    const q = evalQueries().find((x: any) => x.terms.join(' ') === 'Web API デジタル庁');
    expect(detectRealtimeAnchor(q.terms, q.webTitles, q.totals)).toBe('デジタル庁');
  });

  test('一般語だけが全タイトルに出るクエリでは決めない（アイドルフェス 持ち物 注意点）', () => {
    for (const q of evalQueries().filter((x: any) => [...x.terms].sort().join(' ') === ['アイドルフェス', '持ち物', '注意点'].sort().join(' '))) {
      expect(detectRealtimeAnchor(q.terms, q.webTitles, q.totals)).toBeUndefined();
    }
  });

  test('得点がほぼ同点なら、総ヒット数が明らかに少ない語を選ぶ（ライブ 予定 =LOVE の実データ）', () => {
    const q = evalQueries().find((x: any) => x.collectedAt === '2026-10-10');
    // タイトルの得点はライブがわずかに上（ライブ 0.75・=LOVE 0.74）だが、総ヒット数は =LOVE が約 11 分の 1
    expect(detectRealtimeAnchor(q.terms, q.webTitles, q.totals)).toBe('=LOVE');
    // 総ヒット数の差が小さければ選び直さない（同じタイトルで =LOVE を 2 分の 1 程度にする）
    expect(detectRealtimeAnchor(q.terms, q.webTitles, { 'ライブ': 30000, '=LOVE': 13719 })).not.toBe('=LOVE');
  });

  test('同点は語順で決めず、決めない', () => {
    const t = ['渋谷VIDENTへの行き方'];
    expect(detectRealtimeAnchor(['行き方', '渋谷VIDENT'], t)).toBeUndefined();
    expect(detectRealtimeAnchor(['渋谷VIDENT', '行き方'], t)).toBeUndefined();
  });

  test('総ヒット数が分かれば、ありふれた語を下げる（同点の解消）', () => {
    const t = ['渋谷VIDENTへの行き方'];
    expect(detectRealtimeAnchor(['行き方', '渋谷VIDENT'], t, { '行き方': 346, '渋谷VIDENT': 159 })).toBe('渋谷VIDENT');
    // 一部の語しか分からないときは総ヒット数を使わない（同点なので決めない）
    expect(detectRealtimeAnchor(['行き方', '渋谷VIDENT'], t, { '渋谷VIDENT': 159 })).toBeUndefined();
  });

  test('最高得点の語が他の語より明らかにありふれているなら決めない', () => {
    const t = ['フェスの持ち物', '持ち物リスト', '持ち物まとめ'];
    // 持ち物が全タイトルに出るが、総ヒット数は最少の語の 1.25 倍を超え、少ない側の半分にも入らない
    expect(detectRealtimeAnchor(['フェス', '持ち物', '注意点'], t, { 'フェス': 900, '持ち物': 1282, '注意点': 782 })).toBeUndefined();
    // ほぼ同じ希少さなら、タイトルの一致で決める
    expect(detectRealtimeAnchor(['フェス', '持ち物'], t, { 'フェス': 1200, '持ち物': 1282 })).toBe('持ち物');
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

describe('focus（誰の投稿が一次情報か）', () => {
  test('評判系の目印があれば第三者優先、無ければ公式優先', () => {
    expect(detectRealtimeFocus('内山優花 評判')).toBe('public');
    expect(detectRealtimeFocus('内山優花 炎上')).toBe('public');
    expect(detectRealtimeFocus('内山優花 口コミ')).toBe('public');
    expect(detectRealtimeFocus('内山優花 叩かれてる')).toBe('public');
    expect(detectRealtimeFocus('=LOVE ライブ 予定')).toBe('official');
    expect(detectRealtimeFocus('みんなのうた 放送予定')).toBe('official');
    // カタカナの目印は長い語の一部なら数えない
    expect(detectRealtimeFocus('アンチョビ パスタ 店')).toBe('official');
  });

  test('投稿に書かれない目印だけを検索語から外す', () => {
    expect(isPublicFocusTerm('評判')).toBe(true);
    expect(isPublicFocusTerm('感想')).toBe(true);
    expect(isSearchExcludedTerm('評判')).toBe(true);
    expect(isSearchExcludedTerm('どう思われてる')).toBe(true);
    expect(isSearchExcludedTerm('感想')).toBe(false);
    expect(isSearchExcludedTerm('炎上')).toBe(false);
  });

  test('目印の語は固有名詞の候補にしない', () => {
    expect(anchorCandidates(['内山優花', '評判'])).toEqual(['内山優花']);
  });
});

describe('officialAccountMatches', () => {
  const posts = (name: string, texts: string[]) => texts.map((text) => ({ author_name: name, text }));

  test('表示名か、3割以上の投稿にクエリの語があれば公式として扱う', () => {
    expect(officialAccountMatches(posts('内山 優花 【君と見るそら】', ['アイコン嬉しい']), ['内山優花'])).toBe(true);
    expect(officialAccountMatches(posts('Pokémon GO Japan', ['#ポケモンGO イベント開催', '#ポケモンGO 新機能', 'お知らせ']), ['ポケモンGO'])).toBe(true);
  });

  test('クエリと関係の無いアカウントは公式にしない', () => {
    expect(officialAccountMatches(posts('TimeTree', ['カレンダーの新機能', '共有の使い方']), ['=LOVE'])).toBe(false);
    expect(officialAccountMatches([], ['=LOVE'])).toBe(false);
  });
});

describe('selectRealtimeItems', () => {
  const p = (id: string, q: number, author: string, text = '') => ({ id, retrievalQueryIndex: q, author_handle: author, text });

  test('上限以下ならそのまま返す', () => {
    const items = [p('1', 0, 'a'), p('2', 0, 'b')];
    expect(selectRealtimeItems(items, { cap: 5, focus: 'official', terms: [] })).toEqual({ items, omitted: 0 });
  });

  test('検索ごとに交互に選び、元の順序で返す', () => {
    const items = [p('1', 0, 'a'), p('2', 0, 'b'), p('3', 0, 'c'), p('4', 1, 'd'), p('5', 1, 'e')];
    const res = selectRealtimeItems(items, { cap: 3, focus: 'official', terms: [] });
    expect(res.items.map((i) => i.id)).toEqual(['1', '2', '4']);
    expect(res.omitted).toBe(2);
  });

  test('第三者優先では同じ投稿者を後回しにする', () => {
    const items = [p('1', 0, 'a'), p('2', 0, 'a'), p('3', 0, 'a'), p('4', 0, 'b'), p('5', 0, 'c')];
    const res = selectRealtimeItems(items, { cap: 3, focus: 'public', terms: [] });
    expect(res.items.map((i) => i.id)).toEqual(['1', '4', '5']);
  });

  test('上限内のどの投稿にも無い語を含む投稿は、上限を超えて残す', () => {
    const items = [p('1', 0, 'a', '=LOVE ライブ'), p('2', 0, 'b', '=LOVE ライブ'), p('3', 0, 'c', '=LOVE 開場は17時')];
    const res = selectRealtimeItems(items, { cap: 2, focus: 'official', terms: ['=LOVE', '開場'] });
    expect(res.items.map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(res.omitted).toBe(0);
  });

  test('別名で含む投稿も、その語を含むとみなす', () => {
    const items = [p('1', 0, 'a', 'イコラブ ライブ'), p('2', 0, 'b', 'ライブ'), p('3', 0, 'c', 'ライブ')];
    const res = selectRealtimeItems(items, { cap: 1, focus: 'official', terms: ['=LOVE', 'ライブ'], aliases: { '=LOVE': ['イコラブ'] } });
    expect(res.items.map((i) => i.id)).toEqual(['1']);
  });
});
