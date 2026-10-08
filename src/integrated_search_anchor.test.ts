import { expect, spyOn, test } from 'bun:test';
import * as yahoo from './services/yahoo.js';
import { integratedSearch } from './scraper.js';

// 「ライブ 予定 =LOVE」の Web 結果には、先にラブライブ!の公式アカウントが出る。
// X 検索で固有名詞 =LOVE が分かったら、公式枠も =LOVE の公式にそろえる。
test('deep search の公式枠は、X 検索で判定した固有名詞の公式にそろえる', async () => {
  const web = [
    { title: 'ラブライブ！シリーズ公式 (@LoveLive_staff) / X', url: 'https://x.com/LoveLive_staff' },
    { title: '＝LOVE_official (@Equal_LOVE_12) / X', url: 'https://x.com/Equal_LOVE_12' },
  ];
  const webSpy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: web, count: web.length } as any);
  const officialFetches: string[] = [];
  const realtimeSpy = spyOn(yahoo, 'searchYahooRealtime').mockImplementation(async (opts: any) => {
    if (opts.accountId) {
      officialFetches.push(opts.accountId);
      return { items: [{ id: `${opts.accountId}-1`, text: `${opts.accountId} のお知らせ #イコラブ`, url: `https://x.com/${opts.accountId}/status/1` }] } as any;
    }
    // 固有名詞が壊れている時の別名検出（公式の投稿を取りに行く）を模す
    await opts.anchorHints.officialPosts('=LOVE');
    return { items: [{ id: '2', text: 'イコラブ ライブ 予定', url: 'https://x.com/fan/status/2' }], anchorTerm: '=LOVE', aliasTerms: ['イコラブ'], missingTerms: [] } as any;
  });
  try {
    const result: any = await integratedSearch({ query: 'ライブ 予定 =LOVE', limit: 1, scrapeContent: false, noCache: true });
    expect(result.realtime.officialAccountId).toBe('Equal_LOVE_12');
    expect(result.realtime.aliasTerms).toEqual(['イコラブ']);
    expect(result.realtime.items.filter((i: any) => i.isOfficial).map((i: any) => i.id)).toEqual(['Equal_LOVE_12-1']);
    expect('missingTerms' in result.realtime).toBe(false);
    // 別名検出で取得した公式の投稿を公式枠でも使い回す（=LOVE の公式は1回だけ取得）
    expect(officialFetches.filter((h) => h === 'Equal_LOVE_12')).toHaveLength(1);
  } finally {
    webSpy.mockRestore();
    realtimeSpy.mockRestore();
  }
});
