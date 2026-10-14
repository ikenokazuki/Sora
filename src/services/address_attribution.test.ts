import { describe, expect, test } from 'bun:test';
import { ADDRESS_ATTRIBUTION, MLIT_ATTRIBUTION, PARCEL_ATTRIBUTION, addressAttribution } from './address_attribution.js';

describe('addressAttribution', () => {
  test('地番を使っていなければ、ABR と日本郵便の出典と加工の明記だけを返す', () => {
    const text = addressAttribution(false);
    expect(text).toBe(ADDRESS_ATTRIBUTION);
    expect(text).toContain('アドレス・ベース・レジストリ');
    expect(text).toContain('公共データ利用規約');
    expect(text).toContain('加工');
    expect(text).not.toContain('登記所備付地図データ');
  });

  test('地番を使った結果には、法務省の出典と加工の明記、精度の注意を足す（登記所備付地図データ利用規約）', () => {
    const text = addressAttribution(true);
    expect(text.startsWith(ADDRESS_ATTRIBUTION)).toBe(true);
    expect(text).toContain(PARCEL_ATTRIBUTION);
    expect(PARCEL_ATTRIBUTION).toContain('登記所備付地図データ');
    expect(PARCEL_ATTRIBUTION).toContain('法務省');
    expect(PARCEL_ATTRIBUTION).toContain('https://front.geospatial.jp/moj-chizu-xml-readme/');
    expect(PARCEL_ATTRIBUTION).toContain('を加工して作成');
    expect(PARCEL_ATTRIBUTION).toContain('精度');
  });

  test('国土交通省の街区データを使った結果には、国土交通省の出典と加工の明記を足す。両方使えば両方', () => {
    const text = addressAttribution(false, true);
    expect(text.startsWith(ADDRESS_ATTRIBUTION)).toBe(true);
    expect(text).toContain(MLIT_ATTRIBUTION);
    expect(text).not.toContain('登記所備付地図データ');
    expect(MLIT_ATTRIBUTION).toContain('位置参照情報ダウンロードサービス（国土交通省）');
    expect(MLIT_ATTRIBUTION).toContain('加工');
    expect(addressAttribution(true, true)).toContain(PARCEL_ATTRIBUTION);
    expect(addressAttribution(true, true)).toContain(MLIT_ATTRIBUTION);
  });
});
