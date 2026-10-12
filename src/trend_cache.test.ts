import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { app } from './index.js';
import * as httpFetcher from './http_fetcher.js';
import { clearCache, fetchRealtimeTrends, resolveTrendLimit } from './scraper.js';

// search_trend のキャッシュ。以前は固定キー（trends:realtime）に、件数で切ったあとの配列を保存していた。
// limit=5 で呼んだ直後に limit=50 で呼ぶと 5 件しか返らず、REST では limit に負数や文字列を渡すだけで
// 他の利用者の結果も 2 分間おかしくなった（負数は slice(0, -n) で末尾を落とし、文字列の NaN は 0 件になる）。

const trendHtml = (n: number) =>
  `<html><body><section><ol>${Array.from({ length: n }, (_, i) => `<li><a href="/realtime/search?p=${i + 1}">トレンド${i + 1}語</a></li>`).join('')}</ol></section></body></html>`;

let fetchSpy: ReturnType<typeof spyOn> | undefined;

function stubTrends(available: number) {
  fetchSpy = spyOn(httpFetcher, 'fetchWithSafeRedirects').mockImplementation(
    async () => ({ response: new Response(trendHtml(available)), finalUrl: 'https://search.yahoo.co.jp/realtime' }) as never,
  );
  return fetchSpy;
}

beforeEach(() => {
  clearCache();
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  clearCache();
});

describe('resolveTrendLimit', () => {
  test('1〜50 の整数に収める。数として読めない値と 1 未満は既定の 20', () => {
    const cases: Array<[unknown, number]> = [
      [undefined, 20], [null, 20], ['', 20], [0, 20], [-5, 20], ['abc', 20], [Number.NaN, 20], [Number.POSITIVE_INFINITY, 20],
      [1, 1], [7, 7], ['7', 7], [7.9, 7], [50, 50], [51, 50], [1000, 50],
    ];
    for (const [raw, expected] of cases) expect(resolveTrendLimit(raw), String(raw)).toBe(expected);
  });
});

describe('fetchRealtimeTrends', () => {
  test('少ない件数で呼んだ直後に多い件数で呼んでも、その件数が返る（取得は 1 回）', async () => {
    const spy = stubTrends(60);

    const few = await fetchRealtimeTrends(5);
    const many = await fetchRealtimeTrends(50);

    expect(few.count).toBe(5);
    expect(few.items.map((i) => i.keyword)).toEqual(['トレンド1語', 'トレンド2語', 'トレンド3語', 'トレンド4語', 'トレンド5語']);
    expect(many.count).toBe(50);
    expect(many.items).toHaveLength(50);
    expect(many.items.slice(0, 5)).toEqual(few.items);
    expect((many as { cached?: boolean }).cached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('多い件数のあとに少ない件数で呼ぶと、その件数に切って返す', async () => {
    stubTrends(60);

    const many = await fetchRealtimeTrends(50);
    const few = await fetchRealtimeTrends(3);

    expect(many.count).toBe(50);
    expect(few.count).toBe(3);
    expect(few.items).toHaveLength(3);
    expect(few.items).toEqual(many.items.slice(0, 3));
  });

  test('取得できた件数より多く求められたら、取得できた分だけ返す', async () => {
    stubTrends(12);

    const first = await fetchRealtimeTrends(50);
    const second = await fetchRealtimeTrends(50);

    expect(first.count).toBe(12);
    expect(second.count).toBe(12);
    expect(second.items).toHaveLength(12);
  });

  test('不正な件数（負数・文字列）で呼んでも、あとの呼び出しの結果を壊さない', async () => {
    const spy = stubTrends(60);

    const negative = await fetchRealtimeTrends(-5);
    const garbage = await fetchRealtimeTrends('abc' as unknown as number);
    const normal = await fetchRealtimeTrends(10);

    expect(negative.count).toBe(20);
    expect(garbage.count).toBe(20);
    expect(normal.count).toBe(10);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('POST /search/trend', () => {
  const post = async (body: unknown) => {
    const res = await app.request('/search/trend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { count: number; items: unknown[] } };
  };

  test('limit に負数や文字列を渡しても 200 で、キャッシュを汚さない', async () => {
    stubTrends(60);

    const negative = await post({ limit: -5 });
    const garbage = await post({ limit: 'abc' });
    const three = await post({ limit: 3 });
    const numericString = await post({ limit: '4' });
    const none = await post({});

    expect(negative.status).toBe(200);
    expect(negative.json.count).toBe(20);
    expect(garbage.json.count).toBe(20);
    expect(three.json.count).toBe(3);
    expect(three.json.items).toHaveLength(3);
    expect(numericString.json.count).toBe(4);
    expect(none.json.count).toBe(20);
  });
});
