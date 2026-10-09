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

const xPost = (id: string, handle: string, name: string, text: string) => ({ id, author_handle: handle, author_name: name, text, url: `https://x.com/${handle}/status/${id}` });

test('評判を調べる時は本人以外の投稿を先に並べ、本人の投稿は後ろに最大2件', async () => {
  const web = [{ title: '内山 優花 【君と見るそら】 (@yuka_kimisora) / X', url: 'https://x.com/yuka_kimisora' }];
  const webSpy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: web, count: 1 } as any);
  const seen: any[] = [];
  const realtimeSpy = spyOn(yahoo, 'searchYahooRealtime').mockImplementation(async (opts: any) => {
    if (opts.accountId) return { items: [1, 2, 3, 4].map((n) => xPost(`o${n}`, 'yuka_kimisora', '内山 優花 【君と見るそら】', `日常の投稿${n}`)) } as any;
    seen.push(opts);
    return { items: [xPost('p1', 'fan1', 'fan1', '内山優花さん可愛い'), xPost('p2', 'fan2', 'fan2', '内山優花さんの歌が好き')], focus: opts.focus } as any;
  });
  try {
    const result: any = await integratedSearch({ query: '内山優花 評判', limit: 1, scrapeContent: false, noCache: true, realtimeLimit: 15 });
    expect(seen[0]).toMatchObject({ focus: 'public', maxItems: 15 });
    expect(result.realtime.focus).toBe('public');
    expect(result.realtime.items.map((i: any) => i.id)).toEqual(['p1', 'p2', 'o1', 'o2']);
  } finally {
    webSpy.mockRestore();
    realtimeSpy.mockRestore();
  }
});

test('自動で見つけた公式が、クエリと関係の無いアカウントなら公式として扱わない', async () => {
  const web = [{ title: 'TimeTree (@timetreeapp_jp) / X', url: 'https://x.com/timetreeapp_jp' }];
  const webSpy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: web, count: 1 } as any);
  const realtimeSpy = spyOn(yahoo, 'searchYahooRealtime').mockImplementation(async (opts: any) => {
    if (opts.accountId) return { items: [xPost('t1', 'timetreeapp_jp', 'TimeTree', 'カレンダーの新機能')] } as any;
    return { items: [xPost('p1', 'fan1', 'fan1', '=LOVE 予定')], focus: 'official' } as any;
  });
  try {
    const result: any = await integratedSearch({ query: '=LOVE 予定', limit: 1, scrapeContent: false, noCache: true });
    expect(result.realtime.officialAccountId).toBeUndefined();
    expect(result.realtime.items.map((i: any) => i.id)).toEqual(['p1']);
  } finally {
    webSpy.mockRestore();
    realtimeSpy.mockRestore();
  }
});

test('realtimeLimit を既定（20）より大きくした時だけ、X への取得件数も増やす', async () => {
  const webSpy = spyOn(yahoo, 'searchYahooWeb').mockResolvedValue({ items: [], count: 0 } as any);
  const seen: any[] = [];
  const realtimeSpy = spyOn(yahoo, 'searchYahooRealtime').mockImplementation(async (opts: any) => {
    if (!opts.accountId) seen.push(opts);
    return { items: [xPost('p1', 'fan1', 'fan1', '内山優花さん')], focus: 'official' } as any;
  });
  try {
    await integratedSearch({ query: '内山優花', limit: 1, scrapeContent: false, noCache: true });
    await integratedSearch({ query: '内山優花', limit: 1, scrapeContent: false, noCache: true, realtimeLimit: 30 });
    await integratedSearch({ query: '内山優花', limit: 1, scrapeContent: false, noCache: true, realtimeLimit: 100 });
    expect(seen[0].limit).toBeUndefined();
    expect(seen[1]).toMatchObject({ limit: 30, maxItems: 30 });
    // Yahoo の1回の取得は40件まで。上限だけ100にして、複数の検索の結果から選ぶ
    expect(seen[2]).toMatchObject({ limit: 40, maxItems: 100 });
  } finally {
    webSpy.mockRestore();
    realtimeSpy.mockRestore();
  }
});
