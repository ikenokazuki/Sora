import { describe, expect, test } from 'bun:test';
import { fetchRealtimeTermTotals, searchYahooRealtime } from './yahoo.js';

function post(id: string, text: string, handle = 'fan') {
  return { id, author_handle: handle, author_name: handle, text, url: `https://x.com/${handle}/status/${id}`, created_at: 1758000000 };
}

function mockMcp(handler: (query: string) => any[], calls: string[]) {
  return async (_tool: string, args: Record<string, any>) => {
    calls.push(args.query);
    return { content: [{ text: JSON.stringify({ items: handler(args.query) }) }] };
  };
}

const OPT = { detailEnrichment: false } as const;
const many = (prefix: string, n: number, text: string, author = (i: number) => `u${prefix}${i}`) =>
  Array.from({ length: n }, (_, i) => post(`${prefix}${i}`, text, author(i)));

describe('Realtime focus (v2.36.1)', () => {
  test('評判は投稿に書かれないので検索語から外し、必須語にもしない', async () => {
    const calls: string[] = [];
    const res: any = await searchYahooRealtime({
      query: '内山優花 評判',
      ...OPT,
      _callMcp: mockMcp((q) => (q === '内山優花' ? many('a', 3, '内山優花さん可愛い') : []), calls),
    } as any);
    expect(calls).toEqual(['内山優花']);
    expect(res.focus).toBe('public');
    expect(res.missingTerms).toEqual([]);
    expect(res.stopReason).toBe('full_coverage');
    expect(res.count).toBe(3);
  });

  test('感想は投稿にも書かれるので、目印つきと目印なしを並行して検索し、目印つきを先に並べる', async () => {
    const calls: string[] = [];
    const res: any = await searchYahooRealtime({
      query: '内山優花 感想',
      ...OPT,
      _callMcp: mockMcp((q) => (q === '内山優花 感想' ? [post('k1', '内山優花 ライブの感想')] : many('b', 3, '内山優花さん')), calls),
    } as any);
    expect(calls).toEqual(['内山優花 感想', '内山優花']);
    expect(res.items.map((i: any) => i.id)).toEqual(['k1', 'b0', 'b1', 'b2']);
    expect(res.isFallback).toBe(false);
  });

  test('focus を指定すれば自動判定より優先する', async () => {
    const calls: string[] = [];
    const res: any = await searchYahooRealtime({
      query: '内山優花 評判',
      focus: 'official',
      ...OPT,
      _callMcp: mockMcp(() => [], calls),
    } as any);
    expect(calls[0]).toBe('内山優花 評判');
    expect(res.focus).toBe('official');
  });

  test('limit を省略しても返す投稿は20件まで（省いた件数を返す）', async () => {
    const calls: string[] = [];
    const res: any = await searchYahooRealtime({
      query: 'SPARK id:kimisora_JPN',
      ...OPT,
      _callMcp: mockMcp((q) => many(q.startsWith('id:') ? 'c' : 'd', 15, 'SPARK 出演', () => 'kimisora_JPN'), calls),
    } as any);
    expect(calls.length).toBe(2);
    expect(res.count).toBe(20);
    expect(res.omittedCount).toBe(10);
  });

  test('第三者優先では、上限内で同じ投稿者を後回しにする', async () => {
    const calls: string[] = [];
    const items = [...many('e', 25, '内山優花さん', () => 'same'), ...many('f', 5, '内山優花さん')];
    const res: any = await searchYahooRealtime({
      query: '内山優花 評判',
      ...OPT,
      _callMcp: mockMcp(() => items, calls),
    } as any);
    const authors = new Set(res.items.map((i: any) => i.author_handle));
    expect(res.count).toBe(20);
    expect(authors.size).toBe(6);
  });
});

describe('fetchRealtimeTermTotals', () => {
  test('総ヒット数は既定の取得件数で問い合わせる（1件だと過少に返る語がある）', async () => {
    const seen: any[] = [];
    const totals = await fetchRealtimeTermTotals(['内山優花-test-' + Date.now()], async (opts: any) => {
      seen.push(opts);
      return { items: [], count: 0, page: 1, total: 250 };
    });
    expect(seen[0].limit).toBeUndefined();
    expect(Object.values(totals)).toEqual([250]);
  });
});
