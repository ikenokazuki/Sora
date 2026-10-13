import { describe, expect, test } from 'bun:test';
import { buildJaJson, buildTownJson, chomeToKanji, toPoint, type Row } from './address_abr.js';

const pos = (lg: string, lon: string, lat: string, srid = 'EPSG:6668'): Row => ({ lg_code: lg, rep_lon: lon, rep_lat: lat, rep_srid: srid });

describe('toPoint', () => {
  test('対応する座標参照系だけ [経度, 緯度] にする', () => {
    expect(toPoint(pos('1', '139.7', '35.6'))).toEqual([139.7, 35.6]);
    expect(toPoint(pos('1', '139.7', '35.6', 'EPSG:4326'))).toEqual([139.7, 35.6]);
    expect(toPoint(pos('1', '139.7', '35.6', 'EPSG:3857'))).toBeNull();
    expect(toPoint(pos('1', '', ''))).toBeNull();
  });
});

describe('buildJaJson', () => {
  const prefs: Row[] = [
    { lg_code: '010006', pref: '北海道', pref_kana: 'ホッカイドウ', pref_roma: 'Hokkaido' },
    { lg_code: '130001', pref: '東京都', pref_kana: 'トウキョウト', pref_roma: 'Tokyo' },
  ];
  const prefPos = [pos('010006', '141.347906782', '43.0639406375'), pos('130001', '139.691717', '35.689568')];
  const city = (lg: string, prefName: string, name: string, ward = '', county = ''): Row => ({
    lg_code: lg, pref: prefName, county, county_kana: '', county_roma: '', city: name, city_kana: `${name}カナ`, city_roma: `${name}-roma`,
    ward, ward_kana: ward ? `${ward}カナ` : '', ward_roma: ward ? `${ward}-roma` : '',
  });
  const cities: Row[] = [
    city('011002', '北海道', '札幌市'),
    city('011011', '北海道', '札幌市', '中央区'),
    city('012025', '北海道', '函館市'),
    city('131016', '東京都', '千代田区'),
    city('132012', '東京都', '八王子市'),
    city('133019', '東京都', '中井町', '', '足柄上郡'),
  ];
  const cityPos = [
    pos('011002', '141.354374', '43.061972'), pos('011011', '141.35389', '43.061414'), pos('012025', '140.728', '41.768'),
    pos('131016', '139.753634', '35.694003'), pos('133019', '139.2', '35.3'),
  ];

  test('都道府県ごとに市区町村を並べ、code は数値、空の項目は省く', () => {
    const ja = buildJaJson({ prefs, prefPos, cities, cityPos }, 1_700_000_000);
    expect(ja.meta.updated).toBe(1_700_000_000);
    expect(ja.data.map((p) => [p.code, p.pref])).toEqual([[10006, '北海道'], [130001, '東京都']]);
    const hokkaido = ja.data[0]!;
    expect(hokkaido).toMatchObject({ pref_k: 'ホッカイドウ', pref_r: 'Hokkaido', point: [141.347906782, 43.0639406375] });
    expect(JSON.parse(JSON.stringify(hokkaido.cities[1]))).toEqual({
      code: 12025, city: '函館市', city_k: '函館市カナ', city_r: '函館市-roma', point: [140.728, 41.768],
    });
  });

  test('区のある政令市の親行は除き、位置参照が無い市区町村は捨てる', () => {
    const ja = buildJaJson({ prefs, prefPos, cities, cityPos }, 0);
    expect(ja.data[0]!.cities.map((c) => [c.code, c.city, c.ward])).toEqual([[11011, '札幌市', '中央区'], [12025, '函館市', undefined]]);
    expect(ja.data[1]!.cities.map((c) => c.city)).toEqual(['千代田区', '中井町']);
    expect(ja.data[1]!.cities[1]!.county).toBe('足柄上郡');
    expect(ja.data[1]!.cities[1]!.county_k).toBeUndefined();
  });

  test('都道府県の代表点が無ければ失敗する', () => {
    expect(() => buildJaJson({ prefs, prefPos: [], cities, cityPos }, 0)).toThrow('代表点');
  });
});

describe('chomeToKanji', () => {
  test('算用数字（全角を含む）の丁目を漢数字にする', () => {
    expect(chomeToKanji('１４丁目')).toBe('十四丁目');
    expect(chomeToKanji('2丁目')).toBe('二丁目');
    expect(chomeToKanji('一丁目')).toBe('一丁目');
    expect(chomeToKanji('')).toBeUndefined();
  });
});

describe('buildTownJson', () => {
  const town = (id: string, extra: Partial<Row> = {}): Row => ({
    lg_code: '131016', machiaza_id: id, oaza_cho: '', oaza_cho_kana: '', oaza_cho_roma: '', chome: '', chome_number: '',
    koaza: '', koaza_kana: '', koaza_roma: '', rsdt_addr_flg: '0', ...extra,
  });

  test('町字の項目を Geolonia 形式にし、位置参照を結合する', () => {
    const json = buildTownJson(
      [
        town('0005001', { oaza_cho: '永田町', oaza_cho_kana: 'ナガタチョウ', oaza_cho_roma: 'Nagatacho', chome: '１丁目', chome_number: '1', rsdt_addr_flg: '1' }),
        town('0000104', { koaza: '半蔵門', koaza_kana: 'ハンゾウモン' }),
        town('0006000', { oaza_cho: '千代田' }),
      ],
      [
        { lg_code: '131016', machiaza_id: '0005001', rep_lon: '139.746306', rep_lat: '35.675895', rep_srid: 'EPSG:6668' },
        { lg_code: '131016', machiaza_id: '0005001', rep_lon: '1', rep_lat: '1', rep_srid: 'EPSG:6668' }, // 重複キーは最初の行を使う
        { lg_code: '131016', machiaza_id: '0000104', rep_lon: '139.745856', rep_lat: '35.683737', rep_srid: 'EPSG:3857' }, // 対応外の座標参照系は点なし
      ],
      1_700_000_000,
    );
    expect(json.meta.updated).toBe(1_700_000_000);
    expect(JSON.parse(JSON.stringify(json.data))).toEqual([
      { machiaza_id: '0005001', oaza_cho: '永田町', oaza_cho_k: 'ナガタチョウ', oaza_cho_r: 'Nagatacho', chome: '一丁目', chome_n: 1, rsdt: true, point: [139.746306, 35.675895] },
      { machiaza_id: '0000104', koaza: '半蔵門', koaza_k: 'ハンゾウモン' },
      { machiaza_id: '0006000', oaza_cho: '千代田' },
    ]);
  });
});
