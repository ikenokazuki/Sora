import { afterEach, describe, expect, test } from 'bun:test';
import { findOfficialXHandle, searchYahooRealtime, type RealtimeAnchorHints } from './yahoo.js';

function post(id: string, text: string, handle = 'fan') {
  return { id, author_handle: handle, author_name: handle, text, url: `https://x.com/${handle}/status/${id}`, created_at: 1758000000 };
}

function mockMcp(handler: (query: string) => any[], calls: string[]) {
  return async (_tool: string, args: Record<string, any>) => {
    calls.push(args.query);
    return { content: [{ text: JSON.stringify({ items: handler(args.query) }) }] };
  };
}

function hints(webTitles: string[], officialPosts: Array<{ text: string }>, used: string[] = []): RealtimeAnchorHints {
  return {
    webTitles: async () => { used.push('webTitles'); return webTitles; },
    officialPosts: async (anchor) => { used.push(`officialPosts:${anchor}`); return officialPosts; },
  };
}

const LOVE_TITLES = [
  '=LOVE（イコールラブ）オフィシャルサイト',
  'SCHEDULE | =LOVE（イコールラブ）公式サイト',
  '=LOVE 全国ツアー2026 ライブ日程 - チケットぴあ',
];
const LOVE_OFFICIAL = [
  { text: '新曲MV公開 #イコラブ #イコラブ_ニューシングル' },
  { text: '本日のライブありがとうございました #イコラブ' },
  { text: 'チケット情報はこちら #イコラブ' },
];
// Yahoo は「=」を無視するため、=LOVE を含む検索は LOVE 一般の投稿を返す
const loveNoise = Array.from({ length: 8 }, (_, i) => post(`9${i}`, `LOVE ライブ 予定 ${i}`));
const loveProvider = (q: string) =>
  q.includes('イコラブ')
    ? [post('101', 'イコラブ ライブ 予定発表！'), post('102', 'イコラブの予定まとめ')]
    : q.includes('=LOVE')
      ? [...loveNoise, post('100', '=LOVE 最高')]
      : loveNoise;

const OPT = { detailEnrichment: false } as const;
const totals = (map: Record<string, number>) => async (terms: string[]) =>
  Object.fromEntries(terms.filter((t) => t in map).map((t) => [t, map[t]]));

afterEach(() => {
  delete process.env.SORA_REALTIME_ANCHOR;
});

describe('Realtime anchor (v2.36.0)', () => {
  test('固有名詞が壊れていれば公式ハッシュタグの別名で検索し、無関係な投稿を除く', async () => {
    const calls: string[] = [];
    const used: string[] = [];
    const res: any = await searchYahooRealtime({
      query: '=LOVE ライブ 予定',
      ...OPT,
      anchorHints: hints(LOVE_TITLES, LOVE_OFFICIAL, used),
      _termTotals: totals({ '=LOVE': 5000, 'ライブ': 900000 }),
      _callMcp: mockMcp(loveProvider, calls),
    } as any);
    expect(calls[0]).toBe('=LOVE ライブ 予定');
    expect(calls).toContain('イコラブ ライブ 予定');
    expect(calls).not.toContain('ライブ 予定');
    expect(used).toEqual(['webTitles', 'officialPosts:=LOVE']);
    expect(res.anchorTerm).toBe('=LOVE');
    expect(res.aliasTerms).toEqual(['イコラブ']);
    expect(res.anchorFiltered).toBe(8);
    expect(res.stopReason).toBe('full_coverage');
    expect(res.missingTerms).toEqual([]);
    expect(res.items.map((i: any) => String(i.id)).sort()).toEqual(['100', '101', '102']);
  });

  test('別名が無くても、壊れた固有名詞を含まない投稿は除く', async () => {
    const calls: string[] = [];
    const res: any = await searchYahooRealtime({
      query: '=LOVE ライブ 予定',
      ...OPT,
      anchorHints: hints(LOVE_TITLES, []),
      _termTotals: totals({ '=LOVE': 5000, 'ライブ': 900000 }),
      _callMcp: mockMcp(loveProvider, calls),
    } as any);
    expect(calls).not.toContain('ライブ 予定');
    expect(calls).toContain('=LOVE');
    expect(res.aliasTerms).toBeUndefined();
    expect(res.items.map((i: any) => String(i.id))).toEqual(['100']);
    expect(res.missingTerms).toEqual(['ライブ', '予定']);
  });

  test('固有名詞が末尾でも落とさずに緩和し、最後に固有名詞だけで検索する', async () => {
    const calls: string[] = [];
    const used: string[] = [];
    const res: any = await searchYahooRealtime({
      query: 'チケット 料金 君と見るそら',
      ...OPT,
      anchorHints: hints(['君と見るそら チケット情報 | 君と見るそら公式サイト', 'チケット料金の比較 | 価格.com'], [], used),
      _termTotals: totals({ 'チケット': 2000000, '君と見るそら': 3000 }),
      _callMcp: mockMcp((q) => (q.includes('君と見るそら') && q !== 'チケット 料金 君と見るそら' ? [post('1', '君と見るそら 最高')] : []), calls),
    } as any);
    expect(calls).toEqual(['チケット 料金 君と見るそら', '料金 君と見るそら', 'チケット 君と見るそら', '君と見るそら']);
    expect(res.anchorTerm).toBe('君と見るそら');
    expect(res.anchorFiltered).toBeUndefined();
    expect(used).toEqual(['webTitles']);
  });

  test('呼び出し側が固有名詞を指定すれば、推定の材料を取りに行かずにその語を守る', async () => {
    const calls: string[] = [];
    const used: string[] = [];
    let totalsCalled = false;
    const res: any = await searchYahooRealtime({
      query: '架空アイドルほげぴよ 出演時間 楽屋',
      ...OPT,
      anchor: '架空アイドルほげぴよ',
      anchorHints: hints([], [], used),
      _termTotals: async () => { totalsCalled = true; return {}; },
      _callMcp: mockMcp(() => [], calls),
    } as any);
    expect(res.anchorTerm).toBe('架空アイドルほげぴよ');
    expect(totalsCalled).toBe(false);
    expect(used).toEqual([]);
    expect(calls).not.toContain('出演時間 楽屋');
    expect(calls).toContain('架空アイドルほげぴよ');
  });

  test('指定した固有名詞がクエリの語に無ければ、従来どおり推定する', async () => {
    const used: string[] = [];
    const res: any = await searchYahooRealtime({
      query: 'チケット 料金 君と見るそら',
      ...OPT,
      anchor: '別のグループ',
      anchorHints: hints(['君と見るそら チケット情報 | 君と見るそら公式サイト'], [], used),
      _termTotals: totals({ 'チケット': 2000000, '君と見るそら': 3000 }),
      _callMcp: mockMcp(() => [], []),
    } as any);
    expect(used).toEqual(['webTitles']);
    expect(res.anchorTerm).toBe('君と見るそら');
  });

  test('判定材料が無ければ従来どおり（固有名詞を落とす候補も実行）', async () => {
    const calls: string[] = [];
    const res: any = await searchYahooRealtime({
      query: 'チケット 料金 君と見るそら',
      ...OPT,
      _callMcp: mockMcp(() => [], calls),
    } as any);
    expect(calls).toContain('チケット 料金');
    expect(res.anchorTerm).toBeUndefined();
  });

  test('SORA_REALTIME_ANCHOR=off なら判定しない', async () => {
    process.env.SORA_REALTIME_ANCHOR = 'off';
    const calls: string[] = [];
    const used: string[] = [];
    const res: any = await searchYahooRealtime({
      query: 'チケット 料金 君と見るそら',
      ...OPT,
      anchorHints: hints(['君と見るそら公式サイト'], [], used),
      _termTotals: totals({}),
      _callMcp: mockMcp(() => [], calls),
    } as any);
    expect(used).toEqual([]);
    expect(calls).toContain('チケット 料金');
    expect(res.anchorTerm).toBeUndefined();
  });

  test('wave1 で網羅できれば判定材料を取りに行かない', async () => {
    const calls: string[] = [];
    const used: string[] = [];
    let totalsCalled = false;
    const res: any = await searchYahooRealtime({
      query: '乃木坂46 ライブ 予定',
      ...OPT,
      anchorHints: hints([], [], used),
      _termTotals: async () => { totalsCalled = true; return {}; },
      _callMcp: mockMcp(() => [post('1', '乃木坂46 ライブ 予定 発表')], calls),
    } as any);
    expect(res.stopReason).toBe('full_coverage');
    expect(calls.length).toBe(1);
    expect(used).toEqual([]);
    expect(totalsCalled).toBe(false);
  });

  test('判定材料の取得に失敗しても検索は続く', async () => {
    const calls: string[] = [];
    const res: any = await searchYahooRealtime({
      query: 'チケット 料金 君と見るそら',
      ...OPT,
      anchorHints: {
        webTitles: async () => { throw new Error('web down'); },
        officialPosts: async () => { throw new Error('web down'); },
      },
      _termTotals: async () => { throw new Error('rt down'); },
      _callMcp: mockMcp(() => [post('1', '君と見るそら')], calls),
    } as any);
    expect(res.anchorTerm).toBeUndefined();
    expect(calls.length).toBeGreaterThan(1);
  });

  test('1件だけ全語を含む投稿があっても、大半が全語を含まなければ網羅できたとみなさず別名で検索する', async () => {
    const calls: string[] = [];
    const noise = Array.from({ length: 9 }, (_, i) => post(`9${i}`, `LOVE ライブ 予定 ${i}`));
    // 全角で「＝LOVE」と書いた1件だけが、全語（=LOVE・ライブ・予定）に一致する
    const oneMatch = post('100', '＝LOVE ライブ 予定のお知らせ');
    const res: any = await searchYahooRealtime({
      query: '=LOVE ライブ 予定',
      ...OPT,
      anchorHints: hints(LOVE_TITLES, LOVE_OFFICIAL),
      _termTotals: totals({ '=LOVE': 5000, 'ライブ': 900000 }),
      _callMcp: mockMcp((q) => (q.includes('イコラブ') ? [post('101', 'イコラブ ライブ 予定発表！')] : [...noise, oneMatch]), calls),
    } as any);
    expect(calls).toContain('イコラブ ライブ 予定');
    expect(res.aliasTerms).toEqual(['イコラブ']);
    expect(res.items.map((i: any) => String(i.id)).sort()).toEqual(['100', '101']);
  });

  test('全語を含む投稿が多い（半数以上）か、件数が少ない時は、従来どおり網羅とみなして判定材料を取りに行かない', async () => {
    const used: string[] = [];
    const many = Array.from({ length: 10 }, (_, i) => post(`m${i}`, `乃木坂46 ライブ 予定 ${i}`));
    const calls: string[] = [];
    const res: any = await searchYahooRealtime({
      query: '乃木坂46 ライブ 予定',
      ...OPT,
      anchorHints: hints([], [], used),
      _callMcp: mockMcp((q) => (q === '乃木坂46 ライブ 予定' ? [...many, post('x', 'ライブ 予定の雑談')] : []), calls),
    } as any);
    expect(res.stopReason).toBe('full_coverage');
    expect(used).toEqual([]);
    // 件数が少ない（1件だけ全語に一致、他は2件）時も判定しない
    const calls2: string[] = [];
    const res2: any = await searchYahooRealtime({
      query: '乃木坂46 ライブ 予定',
      ...OPT,
      anchorHints: hints([], [], used),
      _callMcp: mockMcp(() => [post('a', '乃木坂46 ライブ 予定'), post('b', 'ライブ'), post('c', '予定')], calls2),
    } as any);
    expect(res2.stopReason).toBe('full_coverage');
    expect(used).toEqual([]);
  });

  test('全語を含む投稿が少なくても、固有名詞が壊れていなければ追加の検索はしない', async () => {
    const calls: string[] = [];
    // 固有名詞（君と見るそら）は全件にあるが、「出演時間」を書いた投稿は1件だけ
    const items = [...Array.from({ length: 9 }, (_, i) => post(`s${i}`, `君と見るそら 最高 ${i}`)), post('t', '君と見るそら 出演時間 18:00 チケット')];
    const res: any = await searchYahooRealtime({
      query: '君と見るそら チケット 出演時間',
      ...OPT,
      anchorHints: hints(['君と見るそら チケット情報 | 君と見るそら公式サイト', '出演時間の見方 | 音楽ナタリー'], []),
      _termTotals: totals({ '君と見るそら': 3000, 'チケット': 2000000 }),
      _callMcp: mockMcp(() => items, calls),
    } as any);
    expect(calls).toEqual(['君と見るそら チケット 出演時間']);
    expect(res.stopReason).toBe('full_coverage');
    expect(res.aliasTerms).toBeUndefined();
  });

  test('語が1つだけでも、記号を無視されて固有名詞が1件も含まれなければ別名で検索する', async () => {
    const calls: string[] = [];
    const used: string[] = [];
    const res: any = await searchYahooRealtime({
      query: '=LOVE',
      ...OPT,
      anchorHints: hints(LOVE_TITLES, LOVE_OFFICIAL, used),
      _termTotals: totals({}),
      _callMcp: mockMcp((q) => (q === 'イコラブ' ? [post('101', 'イコラブ ライブ決定'), post('102', 'イコラブ新曲')] : loveNoise), calls),
    } as any);
    expect(calls).toContain('イコラブ');
    expect(used).toEqual(['officialPosts:=LOVE']);
    expect(res.aliasTerms).toEqual(['イコラブ']);
    expect(res.items.map((i: any) => String(i.id)).sort()).toEqual(['101', '102']);
  });

  test('公式アカウントは、タイトルが固有名詞を含む Web 結果からだけ取る', async () => {
    // 「ライブ 予定 =LOVE」の Web 結果には、先にラブライブ!の公式が出る
    const webItems = [
      { url: 'https://x.com/LoveLive_staff', title: 'ラブライブ！シリーズ公式 (@LoveLive_staff) / X' },
      { url: 'https://x.com/Equal_LOVE_12', title: '＝LOVE_official (@Equal_LOVE_12) / X' },
    ];
    expect(await findOfficialXHandle('=LOVE', webItems)).toBe('Equal_LOVE_12');
  });

  test('全角・半角の違いで網羅判定を誤らない（NFKC）', async () => {
    const calls: string[] = [];
    const res: any = await searchYahooRealtime({
      query: '=LOVE ライブ',
      ...OPT,
      _callMcp: mockMcp(() => [post('1', '＝ＬＯＶＥ ライブ決定')], calls),
    } as any);
    expect(res.stopReason).toBe('full_coverage');
    expect(calls).toEqual(['=LOVE ライブ']);
  });
});
