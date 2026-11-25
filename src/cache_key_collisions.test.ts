import { describe, expect, spyOn, test } from 'bun:test';
import * as cache from './cache.js';
import { mapSiteUrl } from './scraper.js';
import { buildSearchWebCacheKey } from './search_web_formats.js';
import { searchDietMinutes } from './services/gov.js';
import { searchMusic } from './services/music.js';
import { fetchFlightStatus } from './services/traffic.js';
import { yahooWebSearchFlightKey } from './services/yahoo.js';
import type { SearchWebRequest } from './types.js';

// 自由な文字列の項目を `:` でつないだキーは、区切りの位置を変えると、違う指定が同じキーになる。キャッシュは利用者をまたいで使うので、
// 一方の指定で作った結果が、もう一方に返る。区切りの文字が値の中にあっても、違う指定は違うキーになることを確かめる（外への取得はしない）

/** 関数が最初にキャッシュを引くキー。当たった形で返すので、外への取得はしない */
async function firstCacheKey(run: () => Promise<unknown>): Promise<string> {
  const keys: string[] = [];
  const spy = spyOn(cache, 'getFromCache').mockImplementation(((key: string) => {
    keys.push(key);
    return {};
  }) as typeof cache.getFromCache);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  expect(keys.length).toBeGreaterThan(0);
  return keys[0]!;
}

/** [名前, 利用者の指定, 別の指定]。どちらも `:`（ドメインの一覧は `,`）の区切りの位置が違うだけ */
const webPairs: Array<[string, SearchWebRequest, SearchWebRequest]> = [
  ['検索語の中の : と、除外の一覧', { query: 'site:news.example tickets' }, { query: 'site', includeDomains: ['news.example tickets'], excludeDomains: [':'] }],
  ['ドメインの一覧の中の ,', { query: 'q', includeDomains: ['a.example', 'b.example'] }, { query: 'q', includeDomains: ['a.example,b.example'] }],
];

describe('ウェブ検索のキー（REST の /search/web と、Yahoo の取得のまとめ・共有の保存）', () => {
  for (const [name, mine, other] of webPairs) {
    test(name, () => {
      expect(buildSearchWebCacheKey(other)).not.toBe(buildSearchWebCacheKey(mine));
      expect(yahooWebSearchFlightKey(other)).not.toBe(yahooWebSearchFlightKey(mine));
    });
  }

  test('同じ指定は、同じキー', () => {
    const request: SearchWebRequest = { query: 'a:b', includeDomains: ['a.example', 'a.example'], updated: 'week' };
    expect(buildSearchWebCacheKey(request)).toBe(buildSearchWebCacheKey({ ...request, includeDomains: ['a.example'] }));
    expect(yahooWebSearchFlightKey(request)).toBe(yahooWebSearchFlightKey({ ...request }));
  });
});

describe('ほかの、自由な文字列が並ぶキー', () => {
  const pairs: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
    ['サイトの地図（since と until）',
      () => mapSiteUrl({ url: 'https://example.com/', tenantId: 'legacy', since: '2026-01-01T00:00', until: '00Z' }),
      () => mapSiteUrl({ url: 'https://example.com/', tenantId: 'legacy', since: '2026-01-01T00', until: '00:00Z' })],
    ['国会の議事録（検索語と発言者）', () => searchDietMinutes({ keyword: 'a:b' }), () => searchDietMinutes({ keyword: 'a', speaker: 'b:' })],
    ['空港の運航状況（便名とキーワード）', () => fetchFlightStatus({ airport: '羽田', flightNumber: '1:2' }), () => fetchFlightStatus({ airport: '羽田', flightNumber: '1', keyword: '2:' })],
    ['楽曲の検索（検索語と国）', () => searchMusic({ query: 'a:b', country: 'jp' }), () => searchMusic({ query: 'a', country: 'b:jp' })],
  ];
  for (const [name, mine, other] of pairs) {
    test(name, async () => {
      const key = await firstCacheKey(mine);
      expect(await firstCacheKey(other)).not.toBe(key);
      expect(await firstCacheKey(mine)).toBe(key);
    });
  }
});
