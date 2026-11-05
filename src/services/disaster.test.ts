import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fetchRecentEarthquakes, fetchWeatherWarnings } from './disaster.js';
import { clearCache } from '../cache.js';
import { app } from '../index.js';
import { createMcpServer } from '../mcp.js';
import { ElevationRequestSchema } from '../types.js';

// 送り先を差し替え、要求した URL を記録する。handler が undefined を返したら 404。
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});
function stubFetch(handler: (url: URL) => unknown): string[] {
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
/** 気象台ごとの警報の JSON（実際と同じく areaTypes[0] は一次細分区域、[1] は市町村。欄に名前は無い）。 */
const WARNING_JSON: Record<string, { class10: Record<string, string[]>; towns: Record<string, string[]> }> = {
  '130000': {
    class10: { '130010': ['14'], '130020': ['15', '16'], '130030': ['07'] },
    towns: { '1310100': ['14'], '1310400': ['10'], '1336100': ['16'] },
  },
  '016000': { class10: { '016010': ['14'] }, towns: { '0110000': ['03'] } },
  '017000': { class10: { '017010': ['20'] }, towns: { '0134500': ['21'] } },
  '140000': { class10: { '140010': ['14'] }, towns: { '1410011': ['18'], '1410012': ['19'] } },
  '230000': { class10: { '230010': ['14'] }, towns: { '2310000': ['15'] } },
  '280000': { class10: { '280010': ['14'] }, towns: { '2810100': ['14'], '2811000': ['16'] } },
  '270000': { class10: { '270000': ['14'] }, towns: { '2710000': ['10'] } },
};
function warningJson(url: URL) {
  const office = url.pathname.match(/\/warning\/data\/warning\/(\d+)\.json$/)?.[1];
  const data = office ? WARNING_JSON[office] : undefined;
  if (!data) return undefined;
  const areas = (m: Record<string, string[]>) => Object.entries(m).map(([code, codes]) => ({ code, warnings: w(...codes) }));
  return { reportDatetime: '2026-11-06T05:00:00+09:00', areaTypes: [{ areas: areas(data.class10) }, { areas: areas(data.towns) }] };
}
const names = (items: Array<{ name: string }>) => items.map((i) => i.name);

describe('search_disaster_warnings の地名の解決', () => {
  it('市区町村はその市町村の欄だけを返す（新宿区に伊豆諸島の注意報を混ぜない）', async () => {
    const calls = stubFetch(warningJson);
    const r = await fetchWeatherWarnings({ city: '新宿区', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/warning/130000.json']);
    expect(r).toMatchObject({ areaCode: '1310400', areaName: '新宿区', prefecture: '東京都' });
    expect(names(r.advisories)).toEqual(['大雨注意報']);
    expect(r.warnings).toEqual([]);
  });

  it('札幌は市町村 0110000 を、気象台 016000 の JSON から引く', async () => {
    const calls = stubFetch(warningJson);
    const r = await fetchWeatherWarnings({ city: '札幌', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/warning/016000.json']);
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
    expect(names(yokohama.advisories)).toEqual(['洪水注意報', '高潮注意報']);
    expect(await fetchWeatherWarnings({ city: '横浜市', noCache: true })).toMatchObject({ areaCode: '1410011,1410012', areaName: '横浜市' });
    // 区ごとの区域の市（神戸市）: 区はその区、市は全部の区を合わせる
    expect(await fetchWeatherWarnings({ city: '神戸市中央区', noCache: true })).toMatchObject({ areaCode: '2811000', areaName: '神戸市中央区' });
    const kobe = await fetchWeatherWarnings({ city: '神戸市', noCache: true });
    expect(kobe).toMatchObject({ areaName: '神戸市', prefecture: '兵庫県' });
    expect(kobe.areaCode.split(',')).toHaveLength(9);
    expect(names(kobe.advisories).sort()).toEqual(['波浪注意報', '雷注意報'].sort());
    // 市・町を省いた名前が市と町の両方に当たれば、候補を挙げる（青森県横浜町を黙って選ばない）
    await expect(fetchWeatherWarnings({ city: '横浜', noCache: true })).rejects.toThrow(/神奈川県横浜市、青森県横浜町/);
    expect(calls.some((u) => u.endsWith('/020000.json'))).toBe(false);
  });

  it('同じ名前の町は候補を挙げたエラーにし、都道府県名があれば絞る', async () => {
    const calls = stubFetch(warningJson);
    await expect(fetchWeatherWarnings({ city: '森町', noCache: true })).rejects.toThrow(/北海道森町.*静岡県森町/);
    expect(calls).toEqual([]);
    const r = await fetchWeatherWarnings({ city: '北海道森町', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/warning/017000.json']);
    expect(r).toMatchObject({ areaCode: '0134500', areaName: '森町', prefecture: '北海道' });
    expect(names(r.advisories)).toEqual(['乾燥注意報']);
  });

  it('市町村で無い名前は予報区の欄を返す', async () => {
    stubFetch(warningJson);
    const r = await fetchWeatherWarnings({ city: '東京', noCache: true });
    expect(r).toMatchObject({ areaCode: '130010', areaName: '東京地方', prefecture: '東京都' });
    expect(names(r.advisories)).toEqual(['雷注意報']);
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
    const first = await fetchWeatherWarnings({ city: '東京' });
    const second = await fetchWeatherWarnings({ city: '東京都' });
    expect(second).toMatchObject({ cached: true, areaCode: '130010', areaName: '東京地方', prefecture: '東京都' });
    expect(first.prefecture).toBe('東京都');
  });
});

describe('search_disaster_warnings の areaCode', () => {
  it('2 桁は XX0000 の気象台に補い、その範囲を合わせて返す', async () => {
    const calls = stubFetch(warningJson);
    const osaka = await fetchWeatherWarnings({ areaCode: '27', noCache: true });
    expect(calls).toEqual(['https://www.jma.go.jp/bosai/warning/data/warning/270000.json']);
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

describe('search_earthquake', () => {
  it('minIntensity が既定より大きいときは 100 件取り、絞ってから limit 件に切る', async () => {
    const calls = stubFetch(p2pQuakes([10, 10, 10, 10, 10, 30, 10, 40]));
    const r = await fetchRecentEarthquakes({ limit: 1, minIntensity: 30, noCache: true });
    expect(new URL(calls[0]).searchParams.get('limit')).toBe('100');
    expect(r.count).toBe(1);
    expect(r.earthquakes[0].hypocenter.name).toBe('震源5');
  });

  it('既定の震度では今までどおり limit×2 件を取る', async () => {
    const calls = stubFetch(p2pQuakes([10, 20, 30, 40, 10, 10, 10]));
    const r = await fetchRecentEarthquakes({ limit: 3, noCache: true });
    expect(new URL(calls[0]).searchParams.get('limit')).toBe('6');
    expect(r.count).toBe(3);
  });

  it('取得に失敗したら 0 件ではなくエラーにし、失敗はキャッシュしない', async () => {
    clearCache();
    stubFetch(() => new Response('unavailable', { status: 503 }));
    await expect(fetchRecentEarthquakes({ limit: 2 })).rejects.toThrow('503');
    restore?.();
    stubFetch(p2pQuakes([20, 20]));
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

describe('get_elevation の緯度・経度の範囲', () => {
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
      const tool = (await client.listTools()).tools.find((t) => t.name === 'get_elevation');
      const props = tool?.inputSchema.properties as any;
      expect([props.lat.minimum, props.lat.maximum, props.lon.minimum, props.lon.maximum]).toEqual([-90, 90, -180, 180]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
