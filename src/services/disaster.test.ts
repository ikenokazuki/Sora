import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fetchRecentEarthquakes, fetchWeatherWarnings } from './disaster.js';
import { clearCache } from '../cache.js';
import { app } from '../index.js';
import { createMcpServer } from '../mcp.js';
import { JMA_CLASS10, JMA_CLASS20, JMA_OFFICES } from '../jma_areas.js';
import { ElevationRequestSchema } from '../types.js';
import R8_TOKYO from '../test_fixtures/jma_warning_r8_excerpt.json';
import QUAKE from '../test_fixtures/jma_quake_excerpt.json';

// 送り先を差し替え、要求した URL を記録する。handler が undefined を返したら 404。
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});
function stubFetch(handler: (url: URL) => unknown): string[] {
  restore?.(); // 1 つのテストで続けて差し替えても、元の fetch に戻せるように（前の差し替えを残さない）
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    const body = handler(url);
    if (body instanceof Response) return body;
    return body === undefined ? new Response('Not Found', { status: 404 }) : Response.json(body);
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return calls;
}

const w = (...codes: string[]) => codes.map((code) => ({ code, status: '発表' }));
/** 気象台ごとの警報（予報区の欄と市町村の欄に置く警報の番号）。warningJson が r8 の形にする */
const WARNING_JSON: Record<string, { class10: Record<string, string[]>; towns: Record<string, string[]> }> = {
  '130000': {
    class10: { '130010': ['14'], '130020': ['15', '16'], '130030': ['07'] },
    towns: { '1310100': ['14'], '1310400': ['10'], '1336100': ['16'] },
  },
  '016000': { class10: { '016010': ['14'] }, towns: { '0110000': ['03'] } },
  '017000': { class10: { '017010': ['20'] }, towns: { '0134500': ['21'] } },
  '140000': { class10: { '140010': ['14'] }, towns: { '1410011': ['10', '14'], '1410012': ['19', '14'] } },
  '170000': { class10: { '170010': ['14'], '170020': ['07'] }, towns: { '1720100': ['15'] } },
  '220000': { class10: { '220010': ['14'], '220020': ['16'], '220030': ['15'], '220040': ['07'] }, towns: {} },
  '030000': { class10: { '030010': ['14'] }, towns: { '0320100': ['15'] } },
  '080000': { class10: { '080010': ['14'] }, towns: { '0820100': ['15'] } },
  '060000': { class10: { '060010': ['14'] }, towns: { '0620100': ['15'] } },
  '400000': { class10: { '400020': ['14'] }, towns: { '4010000': ['15'] } },
  '230000': { class10: { '230010': ['14'] }, towns: { '2310000': ['15'] } },
  '280000': { class10: { '280010': ['14'] }, towns: { '2810100': ['14'], '2811000': ['16'] } },
  '270000': { class10: { '270000': ['14'] }, towns: { '2710000': ['10'] } },
};
/** 気象台ごとの警報の JSON（r8）。実際と同じく報の配列で、欄は予報区（class10Items）と市町村（class20Items）。欄に名前は無い */
function warningJson(url: URL) {
  const office = url.pathname.match(/\/warning\/data\/r8\/(\d+)\.json$/)?.[1];
  const data = office ? WARNING_JSON[office] : undefined;
  if (!data) return undefined;
  const items = (m: Record<string, string[]>) => Object.entries(m).map(([areaCode, codes]) => ({ areaCode, kinds: w(...codes) }));
  return [{ reportDatetime: '2026-11-06T05:00:00+09:00', dataTypeCode: 'VPWW61', warning: { class10Items: items(data.class10), class20Items: items(data.towns) } }];
}
const names = (items: Array<{ name: string }>) => items.map((i) => i.name);
/** どの気象台の JSON（r8）にも、その気象台のすべての予報区と市町村の欄に雷注意報を置く */
function anyOfficeWarningJson(url: URL) {
  const office = url.pathname.match(/\/warning\/data\/r8\/(\d+)\.json$/)?.[1];
  const areas = Object.keys(JMA_CLASS10).filter((c) => JMA_CLASS10[c].office === office);
  if (areas.length === 0) return undefined;
  const towns = Object.values(JMA_CLASS20).flat().filter((t) => JMA_CLASS10[t.class10].office === office);
  return [{
    reportDatetime: '2026-11-06T05:00:00+09:00',
    warning: { class10Items: areas.map((areaCode) => ({ areaCode, kinds: w('14') })), class20Items: towns.map((t) => ({ areaCode: t.code, kinds: w('14') })) },
  }];
}

describe('search_disaster_warnings の地名の解決', () => {
  it('市区町村はその市町村の欄だけを返す（新宿区に伊豆諸島の注意報を混ぜない）', async () => {
    const calls = stubFetch(warningJson);
    const r = await fetchWeatherWarnings({ city: '新宿区', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/r8/130000.json']);
    expect(r).toMatchObject({ areaCode: '1310400', areaName: '新宿区', prefecture: '東京都' });
    expect(names(r.advisories)).toEqual(['大雨注意報']);
    expect(r.warnings).toEqual([]);
  });

  it('札幌は市町村 0110000 を、気象台 016000 の JSON から引く', async () => {
    const calls = stubFetch(warningJson);
    const r = await fetchWeatherWarnings({ city: '札幌', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/r8/016000.json']);
    expect(r).toMatchObject({ areaCode: '0110000', areaName: '札幌市', prefecture: '北海道' });
    expect(names(r.warnings)).toEqual(['大雨警報']);
  });

  it('政令指定都市の区は市全体に当て、区域に分かれた市は区域の欄を合わせる', async () => {
    const calls = stubFetch(warningJson);
    expect(await fetchWeatherWarnings({ city: '札幌市中央区', noCache: true })).toMatchObject({ areaCode: '0110000', areaName: '札幌市' });
    expect(await fetchWeatherWarnings({ city: '名古屋市中区', noCache: true })).toMatchObject({ areaCode: '2310000', areaName: '名古屋市' });
    // 気象庁は横浜市を北部・南部に分ける。区からはどちらか決められないので、市全体（両方）を合わせる
    const yokohama = await fetchWeatherWarnings({ city: '横浜市中区', noCache: true });
    expect(yokohama).toMatchObject({ areaCode: '1410011,1410012', areaName: '横浜市', prefecture: '神奈川県' });
    // 両方の区域にある雷注意報は 1 つにまとめる
    expect(names(yokohama.advisories)).toEqual(['大雨注意報', '雷注意報', '高潮注意報']);
    expect(await fetchWeatherWarnings({ city: '横浜市', noCache: true })).toMatchObject({ areaCode: '1410011,1410012', areaName: '横浜市' });
    // 区ごとの区域の市（神戸市）: 区はその区、市は全部の区を合わせる
    expect(await fetchWeatherWarnings({ city: '神戸市中央区', noCache: true })).toMatchObject({ areaCode: '2811000', areaName: '神戸市中央区' });
    const kobe = await fetchWeatherWarnings({ city: '神戸市', noCache: true });
    expect(kobe).toMatchObject({ areaName: '神戸市', prefecture: '兵庫県' });
    expect(kobe.areaCode.split(',')).toHaveLength(9);
    expect(names(kobe.advisories).sort()).toEqual(['波浪注意報', '雷注意報'].sort());
    expect(calls.some((u) => u.endsWith('/020000.json'))).toBe(false);
  });

  it('都道府県名（正式名・略称）は、予報区の 1 つにせず県全体の予報区を合わせる（ほかの予報区の警報を落とさない）', async () => {
    const calls = stubFetch(warningJson);
    const shizuoka = await fetchWeatherWarnings({ city: '静岡県', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/r8/220000.json']);
    expect(shizuoka).toMatchObject({ areaCode: '220000', areaName: '静岡県', prefecture: '静岡県' });
    // 中部・伊豆・東部・西部の 4 つの予報区の警報が入る
    expect(names(shizuoka.warnings)).toEqual(['波浪警報']);
    expect(names(shizuoka.advisories).sort()).toEqual(['強風注意報', '波浪注意報', '雷注意報'].sort());
    // 石川県は加賀と能登。能登の波浪警報も落とさない
    const ishikawa = await fetchWeatherWarnings({ city: '石川', noCache: true });
    expect(ishikawa).toMatchObject({ areaCode: '170000', areaName: '石川県', prefecture: '石川県' });
    expect(names(ishikawa.warnings)).toEqual(['波浪警報']);
    expect(names(ishikawa.advisories)).toEqual(['雷注意報']);
    // 略称が同じ予報区の市と同じ名前でも、市ではなく県全体（山形 → 山形市にしない）
    expect(await fetchWeatherWarnings({ city: '山形', noCache: true })).toMatchObject({ areaCode: '060000', areaName: '山形県', prefecture: '山形県' });
    expect(await fetchWeatherWarnings({ city: '岩手', noCache: true })).toMatchObject({ areaCode: '030000', areaName: '岩手県' });
    expect(await fetchWeatherWarnings({ city: '茨城', noCache: true })).toMatchObject({ areaCode: '080000', areaName: '茨城県' });
    for (const city of ['東京', '東京都']) expect(await fetchWeatherWarnings({ city, noCache: true })).toMatchObject({ areaCode: '130000', areaName: '東京都' });
    expect(await fetchWeatherWarnings({ city: '大阪', noCache: true })).toMatchObject({ areaCode: '270000', areaName: '大阪府' });
  });

  it('気象台が複数ある北海道・鹿児島・沖縄の都道府県名は、気象台を挙げたエラー', async () => {
    const calls = stubFetch(warningJson);
    await expect(fetchWeatherWarnings({ city: '北海道', noCache: true })).rejects.toThrow(/016000（石狩・空知・後志地方）/);
    await expect(fetchWeatherWarnings({ city: '鹿児島', noCache: true })).rejects.toThrow(/460040（奄美地方）/);
    await expect(fetchWeatherWarnings({ city: '沖縄県', noCache: true })).rejects.toThrow(/471000（沖縄本島地方）/);
    expect(calls).toEqual([]);
    const res = await app.request('/disaster/warnings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: '北海道' }),
    });
    expect(res.status).toBe(400);
  });

  it('気象台が複数ある県のエラーは、気象台の番号のほか市町村名・地方名でも引けることを書く', async () => {
    const calls = stubFetch(warningJson);
    for (const input of [{ city: '北海道' }, { areaCode: '01' }, { city: '鹿児島県' }, { areaCode: '47' }]) {
      await expect(fetchWeatherWarnings({ ...input, noCache: true })).rejects.toThrow('6 桁の気象台の番号か、市町村名・地方名で指定してください');
    }
    expect(calls).toEqual([]);
    expect(await fetchWeatherWarnings({ city: '石狩地方', noCache: true })).toMatchObject({ areaCode: '016010', areaName: '石狩地方', prefecture: '北海道' });
  });

  it('エラーが挙げる気象台の名前（北海道・鹿児島・沖縄の 14 件）は、その気象台の範囲を返す', async () => {
    const calls = stubFetch(anyOfficeWarningJson);
    const offices = Object.entries(JMA_OFFICES).filter(([c]) => /^(01|46|47)/.test(c));
    expect(offices).toHaveLength(14);
    for (const [office, name] of offices) {
      expect(await fetchWeatherWarnings({ city: name, noCache: true })).toMatchObject({ areaCode: office, areaName: name });
      expect(calls.at(-1)).toBe(`https://www.jma.go.jp/bosai/warning/data/r8/${office}.json`);
    }
    expect(calls).toHaveLength(14);
    // 予報区が複数の気象台は、そのすべての予報区の欄を合わせる
    expect(names((await fetchWeatherWarnings({ city: '上川・留萌地方', noCache: true })).advisories)).toEqual(['雷注意報']);
  });

  it('大東島地方・大東島は大東島地方の予報区（大阪府の大東市にしない）。大東は大東市のまま', async () => {
    stubFetch(anyOfficeWarningJson);
    for (const city of ['大東島地方', '大東島']) expect(await fetchWeatherWarnings({ city, noCache: true })).toMatchObject({ areaCode: '472000', areaName: '大東島地方', prefecture: '沖縄県' });
    expect(await fetchWeatherWarnings({ city: '大東', noCache: true })).toMatchObject({ areaName: '大東市', prefecture: '大阪府' });
  });

  it('一部の一致でほかの県にしない（「〜島」・ほかの地名の途中）。入力の中の空白は都道府県名・候補のエラーでも無視する', async () => {
    const calls = stubFetch(anyOfficeWarningJson);
    await expect(fetchWeatherWarnings({ city: '能美島', noCache: true })).rejects.toThrow('地名「能美島」が見つかりません');
    await expect(fetchWeatherWarnings({ city: '上 野', noCache: true })).rejects.toThrow('地名「上野」は、市町村（群馬県上野村）と気象庁の予報区（240010');
    expect(calls).toEqual([]);
    expect(await fetchWeatherWarnings({ city: '小浜島', noCache: true })).toMatchObject({ areaCode: '474010', prefecture: '沖縄県' });
    expect(await fetchWeatherWarnings({ city: '江東区大島', noCache: true })).toMatchObject({ areaCode: '130010', prefecture: '東京都' });
    expect(await fetchWeatherWarnings({ city: '沖縄 石垣島', noCache: true })).toMatchObject({ areaCode: '474010', prefecture: '沖縄県' });
    expect(await fetchWeatherWarnings({ city: '日光市中宮祠', noCache: true })).toMatchObject({ areaCode: '090020', prefecture: '栃木県' });
    // 区域に分かれた日光市は、今市を含むすべての区域
    expect((await fetchWeatherWarnings({ city: '日光市', noCache: true })).areaCode.split(',').sort()).toEqual(['0920601', '0920602', '0920603', '0920604', '0920605']);
    expect(await fetchWeatherWarnings({ city: '静岡 県', noCache: true })).toMatchObject({ areaCode: '220000', areaName: '静岡県' });
    expect(await fetchWeatherWarnings({ city: '上川・留萌 地方', noCache: true })).toMatchObject({ areaCode: '012000' });
  });

  it('予報区の 2 つ目以降の気温の地点で、ほかの予報区の市町村の名前にも当たるものは、市町村と予報区を挙げたエラー', async () => {
    const calls = stubFetch(anyOfficeWarningJson);
    await expect(fetchWeatherWarnings({ city: '上野', noCache: true })).rejects.toThrow('地名「上野」は、市町村（群馬県上野村）と気象庁の予報区（240010: 三重県北中部の気温の地点）に当たります');
    await expect(fetchWeatherWarnings({ city: '池田', noCache: true })).rejects.toThrow(/大阪府池田市.*360010: 徳島県北部の気温の地点/);
    expect(calls).toEqual([]);
    // 都道府県名を付ければ引ける
    expect(await fetchWeatherWarnings({ city: '群馬県上野', noCache: true })).toMatchObject({ areaName: '上野村', prefecture: '群馬県' });
  });

  it('都道府県名でない city_map の地名は、同じ予報区の「地名+市・区」の市町村ならその市町村、ほかは予報区', async () => {
    stubFetch(warningJson);
    // 気温の地点の名前
    expect(await fetchWeatherWarnings({ city: '横浜', noCache: true })).toMatchObject({ areaCode: '1410011,1410012', areaName: '横浜市' });
    // 八幡市（京都府）は別の予報区なので、気温の地点の八幡は北九州地方のまま
    expect(await fetchWeatherWarnings({ city: '八幡', noCache: true })).toMatchObject({ areaCode: '400020', areaName: '北九州地方' });
    // 地点でも都道府県でもなく、複数の市町村に当たる名前は候補を挙げる
    await expect(fetchWeatherWarnings({ city: '川崎', noCache: true })).rejects.toThrow(/神奈川県川崎市、宮城県川崎町、福岡県川崎町/);
  });

  it('同じ名前の町は候補を挙げたエラーにし、都道府県名があれば絞る', async () => {
    const calls = stubFetch(warningJson);
    await expect(fetchWeatherWarnings({ city: '森町', noCache: true })).rejects.toThrow(/北海道森町.*静岡県森町/);
    expect(calls).toEqual([]);
    const r = await fetchWeatherWarnings({ city: '北海道森町', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/r8/017000.json']);
    expect(r).toMatchObject({ areaCode: '0134500', areaName: '森町', prefecture: '北海道' });
    expect(names(r.advisories)).toEqual(['乾燥注意報']);
  });

  it('市町村でも都道府県でもない名前は予報区の欄を返す', async () => {
    stubFetch(warningJson);
    const r = await fetchWeatherWarnings({ city: '八丈島', noCache: true });
    expect(r).toMatchObject({ areaCode: '130030', areaName: '伊豆諸島南部', prefecture: '東京都' });
    expect(names(r.warnings)).toEqual(['波浪警報']);
  });

  it('郡の付いた住所は、郡を外した町村で引く', async () => {
    stubFetch(anyOfficeWarningJson);
    expect(await fetchWeatherWarnings({ city: '北海道茅部郡森町', noCache: true })).toMatchObject({ areaCode: '0134500', areaName: '森町', prefecture: '北海道' });
    // 郡の名前の中の上郡（足柄上郡）を兵庫県の上郡町にしない。市の名前の後ろの郡元は町名
    expect(await fetchWeatherWarnings({ city: '足柄上郡中井町', noCache: true })).toMatchObject({ areaCode: '1436100', areaName: '中井町', prefecture: '神奈川県' });
    expect(await fetchWeatherWarnings({ city: '鹿児島市郡元', noCache: true })).toMatchObject({ areaCode: '460010', prefecture: '鹿児島県' });
  });

  it('空白だけの city は、areaCode が無ければ東京にせず入力の誤り（REST は 400、MCP はエラー）', async () => {
    const calls = stubFetch(warningJson);
    await expect(fetchWeatherWarnings({ city: ' ', noCache: true })).rejects.toThrow('city が空白です');
    const res = await app.request('/disaster/warnings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: ' ' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('INVALID_INPUT');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'warning-blank-city', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      expect((await client.callTool({ name: 'search_disaster_warnings', arguments: { city: ' ' } })).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
    expect(calls).toEqual([]);
  });

  it('areaCode があれば、空白だけの city は誤りにしない（areaCode が先。REST・MCP とも）', async () => {
    clearCache();
    stubFetch(warningJson);
    expect(await fetchWeatherWarnings({ city: ' ', areaCode: '13', noCache: true })).toMatchObject({ areaCode: '130000' });
    const res = await app.request('/disaster/warnings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: ' ', areaCode: '13', noCache: true }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).areaCode).toBe('130000');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'warning-blank-city-area-code', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const out = await client.callTool({ name: 'search_disaster_warnings', arguments: { city: '', areaCode: '1310400' } });
      expect(out.isError).toBeFalsy();
      expect(JSON.parse((out.content as Array<{ text: string }>)[0].text)).toMatchObject({ areaCode: '1310400', areaName: '新宿区' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('知らない地名は東京にせずエラー。city も areaCode も無ければ東京', async () => {
    const calls = stubFetch(warningJson);
    await expect(fetchWeatherWarnings({ city: 'ほげほげ', noCache: true })).rejects.toThrow('地名「ほげほげ」が見つかりません');
    expect(calls).toEqual([]);
    expect(await fetchWeatherWarnings({ noCache: true })).toMatchObject({ areaCode: '130010', areaName: '東京地方' });
  });

  it('キャッシュから返しても、ラベルは今の解決結果から作る', async () => {
    clearCache();
    stubFetch(warningJson);
    const first = await fetchWeatherWarnings({ city: '横浜市中区' });
    const second = await fetchWeatherWarnings({ city: '横浜' });
    expect(second).toMatchObject({ cached: true, areaCode: '1410011,1410012', areaName: '横浜市', prefecture: '神奈川県' });
    expect(first.areaName).toBe('横浜市');
  });
});

describe('search_disaster_warnings の areaCode', () => {
  it('2 桁は XX0000 の気象台に補い、その範囲を合わせて返す', async () => {
    const calls = stubFetch(warningJson);
    const osaka = await fetchWeatherWarnings({ areaCode: '27', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/r8/270000.json']);
    expect(osaka).toMatchObject({ areaCode: '270000', areaName: '大阪府', prefecture: '大阪府' });
    const tokyo = await fetchWeatherWarnings({ areaCode: '13', noCache: true });
    expect(tokyo).toMatchObject({ areaCode: '130000', areaName: '東京都', prefecture: '東京都' });
    expect(names(tokyo.warnings)).toEqual(['波浪警報']);
    expect(names(tokyo.advisories).sort()).toEqual(['強風注意報', '波浪注意報', '雷注意報'].sort());
  });

  it('気象台が複数ある県の 2 桁は、気象台の番号と名前を挙げたエラーにする', async () => {
    const calls = stubFetch(warningJson);
    await expect(fetchWeatherWarnings({ areaCode: '01' })).rejects.toThrow(/016000（石狩・空知・後志地方）/);
    await expect(fetchWeatherWarnings({ areaCode: '47' })).rejects.toThrow(/471000（沖縄本島地方）/);
    await expect(fetchWeatherWarnings({ areaCode: '46' })).rejects.toThrow(/460040（奄美地方）/);
    expect(calls).toEqual([]);
  });

  it('区域に分かれた市の areaCode（カンマでつないだ 7 桁）をそのまま受ける', async () => {
    stubFetch(warningJson);
    const city = await fetchWeatherWarnings({ city: '横浜市', noCache: true });
    const again = await fetchWeatherWarnings({ areaCode: city.areaCode, noCache: true });
    expect(again).toMatchObject({ areaCode: city.areaCode, areaName: '横浜市', prefecture: '神奈川県' });
    expect(again.advisories).toEqual(city.advisories);
    // 同じ市の区域の一部だけなら、その区域の名前
    expect(await fetchWeatherWarnings({ areaCode: '2811000,2810100', noCache: true })).toMatchObject({ areaCode: '2810100,2811000', areaName: '神戸市東灘区・神戸市中央区' });
    await expect(fetchWeatherWarnings({ areaCode: '1410011,2811000', noCache: true })).rejects.toThrow('同じ市');
  });

  it('気象台の範囲を合わせるときも、同じ警報は 1 つにまとめる', async () => {
    stubFetch((url) => url.pathname.endsWith('/130000.json')
      ? [{ reportDatetime: '2026-11-06T05:00:00+09:00', warning: { class10Items: [{ areaCode: '130010', kinds: w('14') }, { areaCode: '130020', kinds: w('14', '16') }], class20Items: [] } }]
      : undefined);
    expect(names((await fetchWeatherWarnings({ areaCode: '130000', noCache: true })).advisories)).toEqual(['雷注意報', '波浪注意報']);
  });

  it('合わせた警報は種類（code）ごとに 1 つにし、状態は発表を継続より先にする', async () => {
    const kinds = (status: string) => [{ code: '14', status }];
    stubFetch((url) => url.pathname.endsWith('/130000.json')
      ? [{
        reportDatetime: '2026-11-06T05:00:00+09:00',
        warning: { class10Items: [{ areaCode: '130010', kinds: kinds('継続') }, { areaCode: '130020', kinds: kinds('発表') }, { areaCode: '130030', kinds: kinds('継続') }], class20Items: [] },
      }]
      : undefined);
    expect((await fetchWeatherWarnings({ areaCode: '130000', noCache: true })).advisories).toEqual([{ code: '14', name: '雷注意報', level: 'advisory', status: '発表' }]);
  });

  it('7 桁は市町村、6 桁は予報区。city が無くてもラベルは表から作る', async () => {
    stubFetch(warningJson);
    expect(await fetchWeatherWarnings({ areaCode: '1310400', noCache: true })).toMatchObject({ areaCode: '1310400', areaName: '新宿区', prefecture: '東京都' });
    const area = await fetchWeatherWarnings({ areaCode: '130020', noCache: true });
    expect(area).toMatchObject({ areaCode: '130020', areaName: '伊豆諸島北部', prefecture: '東京都' });
    expect(names(area.advisories)).toEqual(['強風注意報', '波浪注意報']);
    await expect(fetchWeatherWarnings({ areaCode: '999999', noCache: true })).rejects.toThrow('999999');
  });

  it('REST は知らない地名・番号を 400 で返す', async () => {
    stubFetch(warningJson);
    const res = await app.request('/disaster/warnings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'ほげほげ' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('INVALID_INPUT');
  });
});

/**
 * 気象庁 warning/data/r8/130000.json（2026-11-06 取得）から削った偽物。報は種類（dataTypeCode）ごとで、
 * 予報区の欄は 4 つとも、市町村の欄は新宿区・新島村・八丈町・小笠原村だけを残した（ほかはそのまま）
 */
const tokyoR8 = (reports: unknown[] = R8_TOKYO) => (url: URL) => (url.pathname === '/bosai/warning/data/r8/130000.json' ? reports : undefined);

describe('search_disaster_warnings は気象庁の新しいデータ（r8）を読む', () => {
  const advisory = (code: string, name: string, status = '継続') => ({ code, name, level: 'advisory' as const, status });

  it('市町村は市町村の欄、予報区は予報区の欄、気象台はその範囲の予報区の欄を、すべての報から合わせる', async () => {
    const calls = stubFetch(tokyoR8());
    // 八丈町: 大雨・土砂災害の報では解除、風・波・雷の報では継続
    const town = await fetchWeatherWarnings({ city: '八丈町', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/r8/130000.json']);
    expect(town).toMatchObject({ areaCode: '1340100', areaName: '八丈町', specialWarnings: [], warnings: [], hasActiveAlerts: true });
    expect(town.advisories).toEqual([advisory('15', '強風注意報'), advisory('16', '波浪注意報'), advisory('14', '雷注意報')]);
    // 伊豆諸島南部（八丈町を含む予報区）の欄は、ほかの町村の土砂災害注意報も入る
    const area = await fetchWeatherWarnings({ areaCode: '130030', noCache: true });
    expect(area.advisories).toEqual([
      { ...advisory('29', '土砂災害注意報'), alertLevel: 2 }, advisory('15', '強風注意報'), advisory('16', '波浪注意報'), advisory('14', '雷注意報'),
    ]);
    // 気象台は 4 つの予報区を合わせる。伊豆諸島北部にない雷注意報も、小笠原諸島の解除と重ならずに残る
    const office = await fetchWeatherWarnings({ areaCode: '130000', noCache: true });
    expect(office).toMatchObject({ areaCode: '130000', areaName: '東京都' });
    expect(office.advisories).toEqual(area.advisories);
    expect(names((await fetchWeatherWarnings({ areaCode: '130020', noCache: true })).advisories)).toEqual(['土砂災害注意報', '強風注意報', '波浪注意報']);
  });

  it('「解除」と「発表警報・注意報はなし」は返さない', async () => {
    stubFetch(tokyoR8());
    // 新宿区・東京地方は全部の報で「発表警報・注意報はなし」
    for (const input of [{ city: '新宿区' }, { areaCode: '130010' }]) {
      expect(await fetchWeatherWarnings({ ...input, noCache: true })).toMatchObject({ specialWarnings: [], warnings: [], advisories: [], hasActiveAlerts: false });
    }
    // 小笠原村: 強風・雷は解除、波浪だけ継続
    expect((await fetchWeatherWarnings({ city: '小笠原村', noCache: true })).advisories).toEqual([advisory('16', '波浪注意報')]);
  });

  it('レベル５と特別警報は specialWarnings、警報と危険警報は warnings、注意報は advisories。段階のある種類は alertLevel を付ける', async () => {
    // 八丈町の欄を報の種類ごとに替える。高潮の報（VPWW57）は東京の抜粋に無いので、大雨の報を写して作る
    const reports = structuredClone(R8_TOKYO) as any[];
    reports.push({ ...structuredClone(reports[0]), dataTypeCode: 'VPWW57' });
    const kinds: Record<string, unknown[]> = {
      VPWW55: [{ code: '33', status: '発表' }], VPWW56: [{ code: '49', status: '発表' }], VPWW57: [{ code: '08', status: '発表' }],
      VPWW58: [{ code: '05', status: '継続' }], VPWW59: [{ code: '37', status: '発表' }],
    };
    for (const r of reports) {
      if (kinds[r.dataTypeCode]) r.warning.class20Items.find((i: any) => i.areaCode === '1340100').kinds = kinds[r.dataTypeCode];
    }
    stubFetch(tokyoR8(reports));
    const r = await fetchWeatherWarnings({ city: '八丈町', noCache: true });
    expect(r.specialWarnings).toEqual([
      { code: '33', name: '大雨特別警報', level: 'special', alertLevel: 5, status: '発表' },
      { code: '37', name: '波浪特別警報', level: 'special', status: '発表' },
    ]);
    expect(r.warnings).toEqual([
      { code: '49', name: '土砂災害危険警報', level: 'warning', alertLevel: 4, status: '発表' },
      { code: '05', name: '暴風警報', level: 'warning', status: '継続' },
      { code: '08', name: '高潮警報', level: 'warning', alertLevel: 3, status: '発表' },
    ]);
    expect(r.advisories).toEqual([advisory('14', '雷注意報')]);
    expect(r.specialWarnings.concat(r.warnings, r.advisories).filter((i) => 'alertLevel' in i).map((i) => i.code)).toEqual(['33', '49', '08']);
  });

  it('reportTime は、使った報のうち最も新しい reportDatetime', async () => {
    // 抜粋の報は 13:45・21:10・19:02・16:11・19:02。その地域の欄が無い報は使わない
    const other = { ...structuredClone(R8_TOKYO[0]), reportDatetime: '2026-11-06T09:00:00+09:00', warning: { class10Items: [], class20Items: [] } };
    stubFetch(tokyoR8([...R8_TOKYO, other]));
    expect((await fetchWeatherWarnings({ city: '新宿区', noCache: true })).reportTime).toBe('2026-11-05T21:10:00+09:00');
    expect((await fetchWeatherWarnings({ areaCode: '130000', noCache: true })).reportTime).toBe('2026-11-05T21:10:00+09:00');
  });

  it('読める reportDatetime が無ければ reportTime は今の時刻、status が無ければ「発表」（前と同じ）', async () => {
    const before = Date.now();
    const report = (reportDatetime: unknown, kinds: unknown[]) => ({ reportDatetime, warning: { class10Items: [], class20Items: [{ areaCode: '1310400', kinds }] } });
    stubFetch(tokyoR8([report(undefined, [{ code: '14' }]), report('不明', [])]));
    const r = await fetchWeatherWarnings({ city: '新宿区', noCache: true });
    expect(Date.parse(r.reportTime)).toBeGreaterThanOrEqual(before);
    expect(r.advisories).toEqual([advisory('14', '雷注意報', '発表')]);
  });

  it('MCP の説明に、河川の氾濫を含まないことを書く（警報なしと読まれないように）', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'warning-description', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'search_disaster_warnings');
      expect(tool?.description).toContain('河川の氾濫は含まない');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('気象庁のデータにその地域の欄が無ければ、警報なしとせずエラー（REST は 500）', async () => {
    stubFetch(tokyoR8([]));
    await expect(fetchWeatherWarnings({ city: '新宿区', noCache: true })).rejects.toThrow('新宿区（1310400）の欄がありません');
    const res = await app.request('/disaster/warnings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: '新宿区', noCache: true }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).code).toBe('DISASTER_ERROR');
  });
});

/** P2P地震情報の history。実際と同じく limit 件までを新しい順に返す。 */
function p2pQuakes(scales: number[]) {
  return (url: URL) => {
    if (url.hostname !== 'api.p2pquake.net') return undefined;
    const limit = Number(url.searchParams.get('limit'));
    return scales.slice(0, limit).map((maxScale, i) => ({
      id: `q${i}`, code: 551, time: `2026/11/0${(i % 9) + 1} 00:00:00.000`,
      earthquake: { time: `2026/11/0${(i % 9) + 1} 00:00:00`, maxScale, domesticTsunami: 'None', hypocenter: { name: `震源${i}`, magnitude: 3, depth: 10 } },
      points: [],
    }));
  };
}

/** 気象庁が落ちている間の退避先（P2P地震情報）だけが答える状況。 */
function jmaDownP2pUp(scales: number[]) {
  const p2p = p2pQuakes(scales);
  return (url: URL) => (url.hostname === 'www.jma.go.jp' ? new Response('unavailable', { status: 503 }) : p2p(url));
}

type QuakeEntry = (typeof QUAKE.list)[number];
/** 気象庁の地震情報（bosai/quake/data）。list.json と各報の JSON は、2026-11-11 に取った実データの抜粋。 */
function jmaQuakes(options: { list?: QuakeEntry[]; failDetail?: boolean } = {}) {
  return (url: URL) => {
    if (url.hostname !== 'www.jma.go.jp' || !url.pathname.startsWith('/bosai/quake/data/')) return undefined;
    const name = url.pathname.split('/').pop()!;
    if (name === 'list.json') return options.list ?? QUAKE.list;
    if (options.failDetail) return new Response('unavailable', { status: 503 });
    return (QUAKE.details as Record<string, unknown>)[name];
  };
}
const quakeCalls = (calls: string[]) => calls.filter((c) => c.includes('/bosai/quake/data/'));

describe('search_earthquake', () => {
  describe('気象庁の公式データ', () => {
    it('震源・震度情報を新しい順に返す（震源、深さ、津波、観測点つき。遠地地震は含めない）', async () => {
      const calls = stubFetch(jmaQuakes());
      const r = await fetchRecentEarthquakes({ limit: 20, noCache: true });
      expect(r.earthquakes.map((e) => e.id)).toEqual(['20261111125704', '20261108105319', '20261108010441', '20261106193937']);
      expect(r.count).toBe(4);
      expect(r.earthquakes.every((e) => e.source === 'jma')).toBe(true);
      expect(calls.some((c) => c.includes('p2pquake'))).toBe(false);

      const [ibaraki, kumamoto, shizuoka, kanto] = r.earthquakes;
      expect(ibaraki).toMatchObject({
        time: '2026/11/11 12:57:00', maxScale: '震度1', maxScaleRaw: 10, tsunami: '津波の心配なし',
        hypocenter: { name: '茨城県沖', magnitude: 4.6, depthKm: 20, latitude: 36.3, longitude: 141.7 },
      });
      expect(ibaraki.points).toBeUndefined();
      expect(kumamoto).toMatchObject({ maxScale: '震度4', maxScaleRaw: 40, hypocenter: { name: '熊本県天草・芦北地方', magnitude: 4.3, depthKm: 10 } });
      // 震度3以上の観測点だけを、強い順に最大 10 件
      expect(kumamoto.points?.length).toBeGreaterThan(0);
      expect(kumamoto.points!.length).toBeLessThanOrEqual(10);
      expect(kumamoto.points![0]).toMatchObject({ pref: '熊本県', scale: '震度4' });
      expect(kumamoto.points!.every((p) => p.scale === '震度4' || p.scale === '震度3')).toBe(true);
      const order = kumamoto.points!.map((p) => (p.scale === '震度4' ? 4 : 3));
      expect(order).toEqual([...order].sort((a, b) => b - a));
      expect(shizuoka).toMatchObject({ maxScale: '震度5強', maxScaleRaw: 50, tsunami: '津波の心配なし', hypocenter: { name: '静岡県西部', magnitude: 5.7, depthKm: 40 } });
      expect(kanto).toMatchObject({ maxScale: '震度3', tsunami: '若干の海面変動の可能性あり' });
    });

    it('minIntensity で絞ってから limit 件に切り、詳細は返す件数だけ取る', async () => {
      const calls = stubFetch(jmaQuakes());
      const strong = await fetchRecentEarthquakes({ limit: 5, minIntensity: 45, noCache: true });
      expect(strong.earthquakes.map((e) => e.id)).toEqual(['20261108010441']);
      expect(quakeCalls(calls)).toHaveLength(2); // list.json と 1 件の詳細

      const calls2 = stubFetch(jmaQuakes());
      const two = await fetchRecentEarthquakes({ limit: 2, noCache: true });
      expect(two.earthquakes.map((e) => e.id)).toEqual(['20261111125704', '20261108105319']);
      expect(quakeCalls(calls2)).toHaveLength(3);
    });

    it('震源・震度情報が出る前の地震も、あるぶんの情報で返す（震源に関する情報、震度速報）', async () => {
      const withoutFull = QUAKE.list.filter((x) => !(x.eid === '20261106193937' && x.ttl === '震源・震度情報'));
      stubFetch(jmaQuakes({ list: withoutFull }));
      const early = (await fetchRecentEarthquakes({ limit: 20, noCache: true })).earthquakes.find((e) => e.id === '20261106193937')!;
      expect(early).toMatchObject({ source: 'jma', maxScale: '震度3', tsunami: '若干の海面変動の可能性あり', hypocenter: { name: '関東東方沖', magnitude: 6.1 } });
      expect(early.points).toBeUndefined();

      const onlyScale = QUAKE.list.filter((x) => !(x.eid === '20261106193937' && x.ttl !== '震度速報'));
      stubFetch(jmaQuakes({ list: onlyScale }));
      const first = (await fetchRecentEarthquakes({ limit: 20, noCache: true })).earthquakes.find((e) => e.id === '20261106193937')!;
      expect(first).toMatchObject({ maxScale: '震度3', tsunami: '津波の有無は調査中', hypocenter: { name: '震源地不明', magnitude: -1 } });
      expect(first.hypocenter.latitude).toBeUndefined();
    });

    it('座標の深さが 0 なら 0 km、高度の欄が無ければ深さなし', async () => {
      const base = QUAKE.list.find((x) => x.eid === '20261111125704')!;
      stubFetch(jmaQuakes({ list: [{ ...base, cod: '+32.8+130.8+0/' }] }));
      expect((await fetchRecentEarthquakes({ noCache: true })).earthquakes[0].hypocenter).toMatchObject({ latitude: 32.8, longitude: 130.8, depthKm: 0 });
      stubFetch(jmaQuakes({ list: [{ ...base, cod: '+32.8+130.8/' }] }));
      const noDepth = (await fetchRecentEarthquakes({ noCache: true })).earthquakes[0].hypocenter;
      expect(noDepth).toMatchObject({ latitude: 32.8, longitude: 130.8 });
      expect(noDepth.depthKm).toBeUndefined();
    });

    it('各報の詳細が取れなくても地震は返し、津波は「不明」と正直に書く', async () => {
      stubFetch(jmaQuakes({ failDetail: true }));
      const r = await fetchRecentEarthquakes({ limit: 2, noCache: true });
      expect(r.count).toBe(2);
      expect(r.earthquakes[0].source).toBe('jma');
      expect(r.earthquakes[0].tsunami).toBe('津波の有無は不明（詳細を取得できませんでした）');
      expect(r.earthquakes[1].points).toBeUndefined();
    });

    it('津波の文が知らない種類なら、気象庁の文をそのまま返す', async () => {
      const entry = QUAKE.list.find((x) => x.eid === '20261024113820')!; // 遠地地震（0226 0230）
      stubFetch(jmaQuakes({ list: [{ ...entry, ttl: '震源・震度情報', maxi: '1' }] }));
      const r = await fetchRecentEarthquakes({ noCache: true });
      expect(r.earthquakes[0].tsunami).toBe('震源の近傍で津波発生の可能性があります。 この地震による日本への津波の影響はありません。');
    });
  });

  describe('気象庁が使えないときの退避先（P2P地震情報）', () => {
    it('気象庁の一覧が落ちていたら P2P 地震情報から返す', async () => {
      const calls = stubFetch(jmaDownP2pUp([30, 20]));
      const r = await fetchRecentEarthquakes({ limit: 2, noCache: true });
      expect(r.count).toBe(2);
      expect(r.earthquakes.every((e) => e.source === 'p2pquake')).toBe(true);
      expect(calls[0]).toContain('www.jma.go.jp/bosai/quake/data/list.json');
    });

    it('気象庁の一覧が想定と違う形でも P2P 地震情報から返す', async () => {
      stubFetch((url) => (url.hostname === 'www.jma.go.jp' ? { not: 'a list' } : p2pQuakes([30])(url)));
      expect((await fetchRecentEarthquakes({ limit: 1, noCache: true })).earthquakes[0].source).toBe('p2pquake');
    });

    it('minIntensity が既定より大きいときは 100 件取り、絞ってから limit 件に切る', async () => {
      const calls = stubFetch(jmaDownP2pUp([10, 10, 10, 10, 10, 30, 10, 40]));
      const r = await fetchRecentEarthquakes({ limit: 1, minIntensity: 30, noCache: true });
      expect(new URL(calls.find((c) => c.includes('p2pquake'))!).searchParams.get('limit')).toBe('100');
      expect(r.count).toBe(1);
      expect(r.earthquakes[0].hypocenter.name).toBe('震源5');
    });

    it('既定の震度では今までどおり limit×2 件を取る', async () => {
      const calls = stubFetch(jmaDownP2pUp([10, 20, 30, 40, 10, 10, 10]));
      const r = await fetchRecentEarthquakes({ limit: 3, noCache: true });
      expect(new URL(calls.find((c) => c.includes('p2pquake'))!).searchParams.get('limit')).toBe('6');
      expect(r.count).toBe(3);
    });
  });

  it('どちらも取得に失敗したら 0 件ではなくエラーにし（両方の理由を書く）、失敗はキャッシュしない', async () => {
    clearCache();
    stubFetch(() => new Response('unavailable', { status: 503 }));
    await expect(fetchRecentEarthquakes({ limit: 2 })).rejects.toThrow(/気象庁.*503.*P2P.*503/s);
    restore?.();
    stubFetch(jmaQuakes());
    expect((await fetchRecentEarthquakes({ limit: 2 })).count).toBe(2);
  });

  it('失敗は REST では今のルートのエラーの形、MCP ではエラーの応答', async () => {
    clearCache();
    stubFetch(() => new Response('unavailable', { status: 503 }));
    const res = await app.request('/disaster/earthquake', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 2, noCache: true }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).code).toBe('EARTHQUAKE_ERROR');

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'quake-error', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const out = await client.callTool({ name: 'search_earthquake', arguments: { limit: 2 } });
      expect(out.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('get_place_info（REST は /geo/elevation）の緯度・経度の範囲', () => {
  it('REST のスキーマは緯度 -90〜90・経度 -180〜180 だけを受ける', () => {
    expect(ElevationRequestSchema.safeParse({ lat: 35.68, lon: 139.76 }).success).toBe(true);
    expect(ElevationRequestSchema.safeParse({ lat: -90, lon: 180 }).success).toBe(true);
    for (const [lat, lon] of [[999, 999], [91, 0], [0, -181]]) expect(ElevationRequestSchema.safeParse({ lat, lon }).success).toBe(false);
  });

  it('REST の POST・GET は範囲外を 400 で返す', async () => {
    const calls = stubFetch(() => undefined);
    const post = await app.request('/geo/elevation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: 999, lon: 999 }),
    });
    expect(post.status).toBe(400);
    expect((await app.request('/geo/elevation?lat=999&lon=999')).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('MCP の定義にも範囲がある', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'elevation-range', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'get_place_info');
      const props = tool?.inputSchema.properties as any;
      expect([props.lat.minimum, props.lat.maximum, props.lon.minimum, props.lon.maximum]).toEqual([-90, 90, -180, 180]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('MCP で範囲外を渡して呼ぶと拒まれ、標高の取得に進まない', async () => {
    const calls = stubFetch(() => undefined);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'elevation-range-call', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      for (const args of [{ lat: 999, lon: 999 }, { lat: 35.68, lon: 999 }, { lat: -91, lon: 139.76 }]) {
        const out = await client.callTool({ name: 'get_place_info', arguments: args });
        expect(out.isError).toBe(true);
        expect((out.content as Array<{ text: string }>)[0].text).toMatch(/Input validation error/);
      }
      expect(calls).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
