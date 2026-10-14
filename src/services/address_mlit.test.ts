import { describe, expect, test } from 'bun:test';
import { buildMlitIndex, lookupMlit, mlitCityUrl, type MlitRow } from './address_mlit.js';

const row = (town: string, block: string, lat: string, lon: string, over: Partial<MlitRow> = {}): MlitRow => ({
  '大字・丁目名': town, '小字・通称名': '', '街区符号・地番': block, 緯度: lat, 経度: lon, 代表フラグ: '1', 更新前履歴フラグ: '0', ...over,
});

const index = buildMlitIndex([
  row('芝大門一丁目', '10', '35.658751', '139.752938'),
  row('芝大門一丁目', '10', '35.7', '139.8', { 代表フラグ: '0' }),
  row('芝大門一丁目', '12', '35.6', '139.7', { 更新前履歴フラグ: '1' }),
  row('（大字なし）', '1', '34.463559', '135.739283'),
  row('高浜町', 'マ17', '36.997878', '136.779913'),
  row('高浜町', 'ｹ8', '36.99', '136.77'),
  row('上町', 'A', '34.677468', '135.521152'),
  row('久太郎町四丁目', '渡辺', '34.680827', '135.498693'),
  row('大字南長野', '477', '36.654148', '138.18377', { '小字・通称名': '県町' }),
  row('壊れた', '1', '', ''),
]);

describe('lookupMlit', () => {
  test('町と街区符号で点を引く。代表の行を採り、更新前の履歴の行は使わない', () => {
    expect(lookupMlit(index, '芝大門一丁目', '10-18-3F')).toEqual({ block: '10', rest: '18-3F', lat: 35.658751, lon: 139.752938 });
    expect(lookupMlit(index, '芝大門一丁目', '12')).toBeNull();
  });

  test('長い順に試す。番号のあとの建物名や号は rest に残す', () => {
    expect(lookupMlit(index, '芝大門一丁目', '10')).toMatchObject({ block: '10', rest: '' });
    expect(lookupMlit(index, '芝大門 一丁目'.replace(' ', ''), '10-18')?.rest).toBe('18');
  });

  test('大字なしの町、仮名や英字や名前の街区符号を引ける', () => {
    expect(lookupMlit(index, '', '1-3')).toMatchObject({ block: '1', rest: '3' });
    expect(lookupMlit(index, '上町', 'A-12')).toMatchObject({ block: 'A', rest: '12' });
    expect(lookupMlit(index, '久太郎町四丁目', '渡辺3')).toMatchObject({ block: '渡辺', rest: '3' });
  });

  test('町字が街区符号の仮名を含む入力（高浜町マ17-7）も引ける。半角カナは全角にそろえる', () => {
    expect(lookupMlit(index, '高浜町マ', '17-7')).toMatchObject({ block: '17', rest: '7', lat: 36.997878 });
    expect(lookupMlit(index, '高浜町ケ', '8')).toMatchObject({ block: '8' });
  });

  test('大字と小字を合わせた町名でも引ける。町が違う、街区が無い、座標が壊れた行は引けない', () => {
    expect(lookupMlit(index, '大字南長野県町', '477-1')).toMatchObject({ block: '477', rest: '1' });
    expect(lookupMlit(index, '南長野県町', '477-1')).toMatchObject({ block: '477', rest: '1' });
    expect(lookupMlit(index, '別の町', '10')).toBeNull();
    expect(lookupMlit(index, '壊れた', '1')).toBeNull();
    expect(lookupMlit(index, '芝大門一丁目', 'ビル')).toBeNull();
    expect(lookupMlit(index, '芝大門一丁目', '')).toBeNull();
  });
});

describe('mlitCityUrl', () => {
  test('市区町村単位の zip の URL は 5 桁のコード', () => {
    expect(mlitCityUrl('131016', '24.0a')).toBe('https://nlftp.mlit.go.jp/isj/dls/data/24.0a/13101-24.0a.zip');
  });
});
