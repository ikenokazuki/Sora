/** ABR（公共データ利用規約 第1.0版）の出典と加工の明記。 */
export const ADDRESS_ATTRIBUTION =
  '出典: デジタル庁「アドレス・ベース・レジストリ」（公共データ利用規約 第1.0版）を加工して作成（加工: Sora）。郵便番号: 日本郵便株式会社「郵便番号データ」を加工して作成。';

/**
 * 地番マスター・地番マスター位置参照は、法務省の登記所備付地図データに基づき、デジタル庁の利用規約に加えて
 * 「登記所備付地図データ利用規約」（出典の記載、加工した旨の明記、国が作成したかのような公表の禁止）が適用される。
 */
export const PARCEL_ATTRIBUTION =
  '地番・地番の座標: 出典「登記所備付地図データ」（法務省）（https://front.geospatial.jp/moj-chizu-xml-readme/）を加工して作成（デジタル庁「アドレス・ベース・レジストリ」の地番マスター・地番マスター位置参照を通じて利用。加工: Sora）。地図は作成時期等によって精度が異なります。';

/** 街区符号の点は、国土交通省の位置参照情報の利用約款に従い、出典と編集・加工した旨を明記する。 */
export const MLIT_ATTRIBUTION =
  '街区符号の点: 出典「位置参照情報ダウンロードサービス（国土交通省）」（https://nlftp.mlit.go.jp/isj/index.html）を加工して作成（街区レベル位置参照情報。加工: Sora）。公共測量や各種証明には使えません。';

/**
 * 結果に添える出典。地番のデータ（numberSource: "chiban"）を使った結果には法務省の、
 * 国土交通省の街区データ（numberSource: "mlit"）を使った結果には国土交通省の出典と加工の明記を足す。
 */
export function addressAttribution(usesParcel: boolean, usesMlit = false): string {
  return [ADDRESS_ATTRIBUTION, usesParcel ? PARCEL_ATTRIBUTION : '', usesMlit ? MLIT_ATTRIBUTION : ''].filter(Boolean).join(' ');
}
