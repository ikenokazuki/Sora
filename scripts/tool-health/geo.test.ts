import { describe, expect, test } from 'bun:test';
import { TOOL_CASES } from './catalog.js';
import { LiveBlocked, LiveFail, LiveUnavailable, LiveUnverified, type CaseContext } from './types.js';

const OSM = '出典: © OpenStreetMap contributors (ODbL) https://www.openstreetmap.org/copyright';
const elevation = { lat: 35.669968, lon: 139.709008, elevationMeters: 34, geocodingSource: 'nominatim', geocodingAttribution: OSM };
const poi = {
  centerResolved: { input: '原宿', address: '東京都渋谷区神宮前 原宿', lat: 35.669968, lon: 139.709008, source: 'nominatim', attribution: OSM },
  count: 1, pois: [{ name: '原宿のラーメン店', lat: 35.67, lng: 139.709 }],
};

function context(result: unknown, restResult: unknown = result): CaseContext {
  return {
    mcp: { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(result) }] }), listTools: async () => [] },
    rest: { call: async () => ({ status: 200, json: restResult }) },
    secrets: { getCase: () => undefined, hasCase: () => false },
    signal: new AbortController().signal,
  };
}

describe('live geocoding checks', () => {
  test('elevation rejects numeric coordinates from the wrong city', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.elevation')!;
    await expect(check.run(context({ ...elevation, lat: 43.076111, lon: 141.363617 }))).rejects.toThrow();
  });

  test('elevation requires the attribution that matches the geocoding source', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.elevation')!;
    await expect(check.run(context(elevation))).resolves.toHaveProperty('sources');
    await expect(check.run(context({ ...elevation, geocodingAttribution: undefined }))).rejects.toThrow('attribution');
    await expect(check.run(context({ ...elevation, geocodingAttribution: '出典: 国土地理院' }))).rejects.toThrow('attribution');
  });

  test('station check requires Shibuya Station resolved by nominatim', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.station')!;
    const shibuya = { ...elevation, lat: 35.6584716, lon: 139.700401 };
    await expect(check.run(context(shibuya))).resolves.toHaveProperty('sources');
    await expect(check.run(context(elevation))).rejects.toThrow('Shibuya');
  });

  test('address check accepts the GSI fallback near Nagatacho', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.address')!;
    const nagatacho = { ...elevation, lat: 35.677414, lon: 139.744385, geocodingSource: 'gsi', geocodingAttribution: '出典: 国土地理院 (https://msearch.gsi.go.jp/address-search/AddressSearch)' };
    await expect(check.run(context(nagatacho))).resolves.toHaveProperty('sources');
    await expect(check.run(context({ ...nagatacho, geocodingAttribution: OSM }))).rejects.toThrow('attribution');
    await expect(check.run(context({ ...nagatacho, lat: 35.669968, lon: 139.709008 }))).rejects.toThrow('Nagatacho');
  });

  test('POI checks the center source, expected region, and each returned point', async () => {
    const check = TOOL_CASES.find((c) => c.id === 'geo.poi')!;
    await expect(check.run(context(poi))).resolves.toHaveProperty('sources');
    await expect(check.run(context({ ...poi, centerResolved: { ...poi.centerResolved, source: 'gsi' } }))).rejects.toThrow();
    await expect(check.run(context({ ...poi, pois: [{ name: '離れた店舗', lat: 35.67, lng: 139.74 }] }))).rejects.toThrow();
    await expect(check.run(context(poi, { ...poi, centerResolved: { ...poi.centerResolved, lat: 43.076111 } }))).rejects.toThrow();
    await expect(check.run(context({ ...poi, centerResolved: { ...poi.centerResolved, attribution: undefined } }))).rejects.toThrow('attribution');
  });
});

// 実データ（デジタル庁 ABR・日本郵便）での応答の形。永田町一丁目5-1 は住居表示の番地まで照合できる。
// 国会議事堂の 永田町1-7-1 は ABR に住居番号が無く、町字（level 3）止まりになる。
const ABR = '出典: デジタル庁「アドレス・ベース・レジストリ」（公共データ利用規約 第1.0版）を加工して作成（加工: Sora）。郵便番号: 日本郵便株式会社「郵便番号データ」を加工して作成。';
const nagatachoKeys = { prefCode: '13', lgCode: '131016', machiazaId: '0005001', blk: '5', rsdt: '1' };
const nagatachoZips = [{ zipcode: '1000014', town: '永田町', townRaw: '永田町（次のビルを除く）', exact: true, fallback: false }];
const zip = {
  zipcode: '1000014', count: 1, attribution: ABR,
  candidates: [{ kind: 'general', prefecture: '東京都', city: '千代田区', town: '永田町', townRaw: '永田町（次のビルを除く）', lgCode: '131016', lat: 35.675473, lon: 139.743767, locationLevel: 3 }],
};
const normalized = {
  input: '東京都千代田区永田町1-5-1', pref: '東京都', city: '千代田区', town: '永田町一丁目', addr: '5-1', other: '',
  normalized: '東京都千代田区永田町一丁目5-1', level: 8, numberSource: 'rsdt', keys: nagatachoKeys,
  point: { lat: 35.673766, lon: 139.746379, level: 8 }, postalCodes: nagatachoZips, attribution: ABR,
};
const reversed = {
  lat: 35.673766, lon: 139.746379, found: true, level: 8, numberSource: 'rsdt', approximate: true,
  normalized: '東京都千代田区永田町一丁目5-1', distanceMeters: 0.4, point: { lat: 35.673766, lon: 139.746379, level: 8 },
  keys: nagatachoKeys, postalCodes: nagatachoZips, alternatives: [], attribution: ABR,
};
const addressCase = (id: string) => TOOL_CASES.find((c) => c.id === id)!;

describe('live address checks', () => {
  test('the address cases retry once, because a cold start downloads the data from outside', () => {
    for (const id of ['geo.postal_code', 'geo.normalize_address', 'geo.reverse_geocode']) expect(addressCase(id).externalRequired).toBe(true);
  });

  test('postal code: 100-0014 must resolve to 永田町 in Chiyoda, over both MCP and REST', async () => {
    const check = addressCase('geo.postal_code');
    await expect(check.run(context(zip))).resolves.toHaveProperty('sources');
    await expect(check.run(context({ ...zip, zipcode: '1000001' }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...zip, count: 0, candidates: [] }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...zip, candidates: [{ ...zip.candidates[0], city: '新宿区' }] }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...zip, candidates: [{ ...zip.candidates[0], lgCode: '131041' }] }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context(zip, { ...zip, count: 0, candidates: [] }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...zip, attribution: undefined }))).rejects.toThrow('attribution');
    await expect(check.run(context({ ...zip, attribution: '出典: 国土地理院' }))).rejects.toThrow('attribution');
  });

  test('normalize: the sample address must reach the residential number with its keys, point and zip code', async () => {
    const check = addressCase('geo.normalize_address');
    await expect(check.run(context(normalized))).resolves.toHaveProperty('sources');
    // 番地・号に届かず町字で止まっている（段B を読めていない）
    await expect(check.run(context({ ...normalized, level: 3, numberSource: null, normalized: '東京都千代田区永田町一丁目', other: '5-1' }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...normalized, normalized: '東京都千代田区永田町一丁目9-9' }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...normalized, keys: { ...nagatachoKeys, lgCode: '131041' } }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...normalized, point: { lat: 43.06, lon: 141.35, level: 8 } }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...normalized, postalCodes: [] }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context(normalized, { ...normalized, level: 3, numberSource: null }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...normalized, attribution: undefined }))).rejects.toThrow('attribution');
  });

  test('reverse geocode: the point of the sample address must come back as that address', async () => {
    const check = addressCase('geo.reverse_geocode');
    await expect(check.run(context(reversed))).resolves.toHaveProperty('sources');
    await expect(check.run(context({ ...reversed, found: false, reason: '付近に町字がありません' }))).rejects.toBeInstanceOf(LiveFail);
    // 近くの番地の点を引けていない（level 3 の町字止まり）
    await expect(check.run(context({ ...reversed, level: 3, numberSource: null, normalized: '東京都千代田区永田町一丁目' }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...reversed, normalized: '東京都千代田区丸の内一丁目9-1' }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...reversed, distanceMeters: 250 }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context({ ...reversed, postalCodes: [] }))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(context(reversed, { ...reversed, found: false }))).rejects.toBeInstanceOf(LiveFail);
  });

  test('an answer given before the data was ready is classified, never passed or failed on content', async () => {
    const check = addressCase('geo.normalize_address');
    const early = { ...normalized, level: 3, numberSource: null, normalized: '東京都千代田区永田町一丁目', other: '5-1' };
    await expect(check.run(context({ ...early, incomplete: true, pending: ['num:131016'] }))).rejects.toBeInstanceOf(LiveUnverified);
    await expect(check.run(context({ ...early, incomplete: true, pending: ['num:131016'] }))).rejects.toThrow('num:131016');
    const blocked = { artifact: 'master', message: 'https://data.address-br.digital.go.jp/x.csv.zip: HTTP 403（国外 IP からの接続は拒否されます）' };
    await expect(check.run(context({ ...early, incomplete: true, unavailable: [blocked] }))).rejects.toBeInstanceOf(LiveBlocked);
    await expect(check.run(context({ ...early, incomplete: true, unavailable: [{ artifact: 'city:131016', message: 'city:131016 を取得できませんでした' }] }))).rejects.toBeInstanceOf(LiveUnavailable);
    // 出典が無い応答は、incomplete でも契約違反
    await expect(check.run(context({ ...early, incomplete: true, pending: ['master'], attribution: undefined }))).rejects.toBeInstanceOf(LiveFail);
  });

  test('error texts of the address tools are classified: pending is unverified, a foreign-IP refusal is blocked', async () => {
    const failing = (text: string): CaseContext => ({
      ...context({}),
      mcp: { callTool: async () => ({ isError: true, content: [{ type: 'text', text }] }), listTools: async () => [] },
    });
    const check = addressCase('geo.reverse_geocode');
    await expect(check.run(failing('Reverse geocode error: address data pending: index（データを取得中です。しばらくして再実行してください）'))).rejects.toBeInstanceOf(LiveUnverified);
    await expect(check.run(failing('Reverse geocode error: https://data.address-br.digital.go.jp/mt_town/city/mt_town_city131016.csv.zip: HTTP 403（国外 IP からの接続は拒否されます）'))).rejects.toBeInstanceOf(LiveBlocked);
    await expect(check.run(failing('Reverse geocode error: city:131016 の構築が 120 秒以内に終わりませんでした'))).rejects.toBeInstanceOf(LiveUnavailable);
    await expect(check.run(failing('Reverse geocode error: index を取得できませんでした'))).rejects.toBeInstanceOf(LiveUnavailable);
    // 機能の無効化や入力の誤りは、こちら側の契約違反
    await expect(check.run(failing('Reverse geocode error: 住所機能は SORA_ADDRESS=off で無効化されています'))).rejects.toBeInstanceOf(LiveFail);
    await expect(check.run(failing('Reverse geocode error: lat は -90〜90 の数値で指定してください'))).rejects.toBeInstanceOf(LiveFail);
  });
});
