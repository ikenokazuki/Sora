import {
  ABR_BASE, JAPANPOST_FALLBACK, JAPANPOST_JIGYOSYO_PAGE, JAPANPOST_KEN_ALL_PAGE, type FetchFn,
} from '../../services/address_http.js';
import { jigyosyoBytes } from './jigyosyo.js';
import { makeZip } from './zip.js';

export interface FakeRoute {
  body: Uint8Array<ArrayBuffer> | string;
  etag?: string;
  lastModified?: string;
  status?: number;
  /** リダイレクト後の URL（Response.url）。 */
  finalUrl?: string;
}

/** URL ごとの応答を返す偽の fetch。HEAD は本文なし。登録の無い URL は 404。 */
export class FakeUpstream {
  readonly routes = new Map<string, FakeRoute>();
  readonly requests: Array<{ method: string; url: string }> = [];

  set(url: string, route: FakeRoute): this {
    this.routes.set(url, route);
    return this;
  }

  setZip(url: string, entries: Record<string, string | Uint8Array>, meta: Omit<FakeRoute, 'body'> = {}): this {
    return this.set(url, { body: makeZip(entries), ...meta });
  }

  count(method: string, pattern?: string): number {
    return this.requests.filter((r) => r.method === method && (!pattern || r.url.includes(pattern))).length;
  }

  readonly fetchFn: FetchFn = async (url, init) => {
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url });
    const route = this.routes.get(url);
    if (!route) return new Response(null, { status: 404 });
    const status = route.status ?? 200;
    const body = typeof route.body === 'string' ? new TextEncoder().encode(route.body) : route.body;
    const headers: Record<string, string> = { 'content-length': String(body.length) };
    if (route.etag) headers.etag = route.etag;
    if (route.lastModified) headers['last-modified'] = route.lastModified;
    const response = new Response(method === 'HEAD' || status >= 400 ? null : body, { status, headers });
    Object.defineProperty(response, 'url', { value: route.finalUrl ?? url });
    return response;
  };
}

export function csv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const quote = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return `${[header, ...rows].map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
}

export const abrUrl = (path: string): string => `${ABR_BASE}/${path}.csv.zip`;

export const CHIYODA_LG = '131016';
export const SAPPORO_LG = '011011';
export const ABR_LAST_MODIFIED = 'Fri, 02 Oct 2026 15:40:53 GMT';
export const POSTAL_LAST_MODIFIED = 'Wed, 30 Sep 2026 07:46:52 GMT';
/** 固定データの大きさに合わせた、構築結果の最小値。 */
export const SMALL_MINIMUM = { prefs: 2, cities: 2, towns: 1, general: 3, office: 2 } as const;

const POS_HEADER = ['lg_code', 'rep_lon', 'rep_lat', 'rep_srid', 'rep_scale'];
const CITY_HEADER = ['lg_code', 'pref', 'pref_kana', 'pref_roma', 'county', 'county_kana', 'county_roma', 'city', 'city_kana', 'city_roma', 'ward', 'ward_kana', 'ward_roma'];
export const TOWN_HEADER = ['lg_code', 'machiaza_id', 'oaza_cho', 'oaza_cho_kana', 'oaza_cho_roma', 'chome', 'chome_number', 'koaza', 'koaza_kana', 'koaza_roma', 'rsdt_addr_flg'];
export const TOWN_POS_HEADER = ['lg_code', 'machiaza_id', 'rep_lon', 'rep_lat', 'rep_srid'];

const cityRow = (lg: string, pref: string, name: string, ward = ''): string[] =>
  [lg, pref, `${pref}カナ`, `${pref}-roma`, '', '', '', name, `${name}カナ`, `${name}-roma`, ward, ward ? `${ward}カナ` : '', ward ? `${ward}-roma` : ''];
export const townRow = (lg: string, id: string, oaza: string, chome: string, n: string, rsdt: string): string[] =>
  [lg, id, oaza, `${oaza}カナ`, `${oaza}-roma`, chome, n, '', '', '', rsdt];

/** 市区町村の町字の本体を差し替える（取得元の更新を再現する。署名が変わるよう etag を渡す）。 */
export function replaceTowns(up: FakeUpstream, lg: string, rows: readonly (readonly string[])[], etag: string): void {
  const path = `mt_town/city/mt_town_city${lg}`;
  up.setZip(abrUrl(path), { [`mt_town_city${lg}.csv`]: csv(TOWN_HEADER, rows) }, { etag, lastModified: ABR_LAST_MODIFIED });
}

/** 千代田区と札幌市中央区の町字。札幌は ABR と同じ全角数字の大字名（北１条西）にしてある。 */
export const CHIYODA_TOWNS = [
  townRow(CHIYODA_LG, '0006000', '千代田', '', '', '1'),
  townRow(CHIYODA_LG, '0005001', '永田町', '一丁目', '1', '1'),
  townRow(CHIYODA_LG, '0005002', '永田町', '二丁目', '2', '1'),
];
export const CHIYODA_POS = [
  [CHIYODA_LG, '0006000', '139.752145', '35.684052', 'EPSG:6668'],
  [CHIYODA_LG, '0005001', '139.746306', '35.675895', 'EPSG:6668'],
  [CHIYODA_LG, '0005002', '139.74317', '35.67412', 'EPSG:6668'],
];
export const SAPPORO_TOWNS = [
  townRow(SAPPORO_LG, '0013001', '北１条西', '１丁目', '1', '0'),
  townRow(SAPPORO_LG, '0013002', '北１条西', '２丁目', '2', '0'),
  townRow(SAPPORO_LG, '0013020', '北１条西', '２０丁目', '20', '0'),
  townRow(SAPPORO_LG, '0014001', '大通西', '１丁目', '1', '0'),
  townRow(SAPPORO_LG, '0014020', '大通西', '２０丁目', '20', '0'),
];
export const SAPPORO_POS = [
  [SAPPORO_LG, '0013001', '141.3544', '43.0630', 'EPSG:6668'],
  [SAPPORO_LG, '0013002', '141.3541', '43.0640', 'EPSG:6668'],
  [SAPPORO_LG, '0013020', '141.3010', '43.0650', 'EPSG:6668'],
  [SAPPORO_LG, '0014001', '141.3548', '43.0610', 'EPSG:6668'],
  [SAPPORO_LG, '0014020', '141.3020', '43.0620', 'EPSG:6668'],
];

// ---------- 段B（住居表示・地番）----------

export const RSDT_HEADER = ['lg_code', 'machiaza_id', 'blk_id', 'rsdt_id', 'rsdt2_id', 'city', 'ward', 'oaza_cho', 'chome', 'koaza', 'machiaza_dist', 'blk_num', 'rsdt_num', 'rsdt_num2', 'basic_rsdt_div', 'rsdt_addr_flg', 'rsdt_addr_mtd_code', 'status_flg', 'efct_date', 'ablt_date', 'src_code', 'remarks'];
export const RSDT_POS_HEADER = ['lg_code', 'machiaza_id', 'blk_id', 'rsdt_id', 'rsdt2_id', 'rsdt_addr_flg', 'rsdt_addr_mtd_code', 'rep_lon', 'rep_lat', 'rep_srid', 'rep_scale', 'rep_src_code', 'rsdt_addr_code_rdbl', 'rsdt_addr_data_mnt_date', 'basic_rsdt_div'];
export const PARCEL_HEADER = ['lg_code', 'machiaza_id', 'prc_id', 'city', 'ward', 'oaza_cho', 'chome', 'koaza', 'machiaza_dist', 'prc_num1', 'prc_num2', 'prc_num3', 'rsdt_addr_flg', 'prc_rec_flg', 'prc_area_code', 'efct_date', 'ablt_date', 'src_code', 'remarks', 'real_prop_num'];
export const PARCEL_POS_HEADER = ['lg_code', 'machiaza_id', 'prc_id', 'rep_lon', 'rep_lat', 'rep_srid', 'rep_scale', 'rep_src_code', 'plygn_fname', 'plygn_kcode', 'plygn_fmt', 'plygn_srid', 'plygn_scale', 'plygn_src_code', 'moj_map_city_code', 'moj_map_oaza_code', 'moj_map_chome_code', 'moj_map_koaza_code', 'moj_map_spare_code', 'moj_map_brushid'];

export const rsdtRow = (lg: string, machiaza: string, blkId: string, rsdtId: string, rsdt2Id: string, blk: string, no: string, no2: string): string[] =>
  [lg, machiaza, blkId, rsdtId, rsdt2Id, '千代田区', '', '', '', '', '', blk, no, no2, '0', '1', '1', '0', '1947-04-17', '', '0', ''];
export const rsdtPosRow = (lg: string, machiaza: string, blkId: string, rsdtId: string, rsdt2Id: string, lon: string, lat: string, srid = 'EPSG:6668'): string[] =>
  [lg, machiaza, blkId, rsdtId, rsdt2Id, '1', '1', lon, lat, srid, '2500', '1', 'http://gi.gsi.go.jp/jusho/x', '2017-08-04', '0'];
export const parcelRow = (lg: string, machiaza: string, prcId: string, n1: string, n2: string, n3: string): string[] =>
  [lg, machiaza, prcId, '札幌市', '中央区', '', '', '', '', n1, n2, n3, '0', '1', '', '1947-04-17', '', '1', '', ''];
export const parcelPosRow = (lg: string, machiaza: string, prcId: string, lon: string, lat: string, srid = 'EPSG:6668'): string[] =>
  [lg, machiaza, prcId, lon, lat, srid, '500', '1', '', '', '', srid, '500', '1', '01101', '001', '000', '0000', '00', 'H0001'];

/** 千代田区の住居表示。永田町一丁目の 6-5 は位置参照が無く、永田町二丁目の 1-1-1 は住居番号2を持つ。 */
export const CHIYODA_RSDT = [
  rsdtRow(CHIYODA_LG, '0005001', '007', '001', '', '7', '1', ''),
  rsdtRow(CHIYODA_LG, '0005001', '007', '002', '', '7', '2', ''),
  rsdtRow(CHIYODA_LG, '0005001', '006', '005', '', '6', '5', ''),
  rsdtRow(CHIYODA_LG, '0005002', '001', '001', '001', '1', '1', '1'),
  rsdtRow(CHIYODA_LG, '0006000', '001', '001', '', '1', '1', ''),
];
export const CHIYODA_RSDT_POS = [
  rsdtPosRow(CHIYODA_LG, '0005001', '007', '001', '', '139.7455123', '35.6759123'),
  rsdtPosRow(CHIYODA_LG, '0005001', '007', '002', '', '139.7457', '35.6761'),
  rsdtPosRow(CHIYODA_LG, '0005002', '001', '001', '001', '139.7433', '35.6741'),
  rsdtPosRow(CHIYODA_LG, '0006000', '001', '001', '', '139.7521', '35.684'),
];

/** 札幌市中央区の地番（住居表示でない町）。北１条西２丁目の 12-4 は位置参照が無い。 */
export const SAPPORO_PARCELS = [
  parcelRow(SAPPORO_LG, '0013002', '001300020001200030', '12', '3', ''),
  parcelRow(SAPPORO_LG, '0013002', '001300020001200040', '12', '4', ''),
  parcelRow(SAPPORO_LG, '0013002', '001300020001300000', '13', '', ''),
  parcelRow(SAPPORO_LG, '0013001', '001300010000100001', '1', '1', ''),
];
export const SAPPORO_PARCEL_POS = [
  parcelPosRow(SAPPORO_LG, '0013002', '001300020001200030', '141.3541', '43.0640'),
  parcelPosRow(SAPPORO_LG, '0013002', '001300020001300000', '141.3543', '43.0642'),
  parcelPosRow(SAPPORO_LG, '0013001', '001300010000100001', '141.3544', '43.0630'),
];

/** 千代田区または札幌市中央区に町字（と代表点）を 1 つ足す。取得元の更新として署名が変わるよう etag を渡す。 */
export function addTown(
  up: FakeUpstream,
  lg: string,
  town: { id: string; oaza: string; chome: string; n: string; rsdt: string; lon: number; lat: number },
  etag: string,
): void {
  const towns = lg === CHIYODA_LG ? CHIYODA_TOWNS : SAPPORO_TOWNS;
  const positions = lg === CHIYODA_LG ? CHIYODA_POS : SAPPORO_POS;
  replaceTowns(up, lg, [...towns, townRow(lg, town.id, town.oaza, town.chome, town.n, town.rsdt)], etag);
  up.setZip(
    abrUrl(`mt_town_pos/city/mt_town_pos_city${lg}`),
    { [`mt_town_pos_city${lg}.csv`]: csv(TOWN_POS_HEADER, [...positions, [lg, town.id, String(town.lon), String(town.lat), 'EPSG:6668']]) },
    { etag, lastModified: ABR_LAST_MODIFIED },
  );
}

const kenAllLine = (lg5: string, zip: string, pref: string, city: string, town: string): string =>
  `${lg5},"${zip.slice(0, 3)}  ","${zip}","カナ","カナ","カナ","${pref}","${city}","${town}",0,0,0,0,0,0`;

export const KEN_ALL_FIXTURE = `${[
  kenAllLine('13101', '1000001', '東京都', '千代田区', '千代田'),
  kenAllLine('13101', '1000014', '東京都', '千代田区', '永田町'),
  kenAllLine('13101', '1006801', '東京都', '千代田区', '大手町ＪＡビル（１階）'),
  kenAllLine('13101', '1000000', '東京都', '千代田区', '以下に掲載がない場合'),
  kenAllLine('01101', '0600000', '北海道', '札幌市中央区', '以下に掲載がない場合'),
  kenAllLine('01101', '0600001', '北海道', '札幌市中央区', '北一条西（１〜１９丁目）'),
  kenAllLine('01101', '0640821', '北海道', '札幌市中央区', '北一条西（２０〜２８丁目）'),
  kenAllLine('01101', '0600042', '北海道', '札幌市中央区', '大通西（１〜１９丁目）'),
  kenAllLine('01101', '0640820', '北海道', '札幌市中央区', '大通西（２０〜２８丁目）'),
].join('\r\n')}\r\n`;

const JP_BASE = 'https://www.post.japanpost.jp/service/search/zipcode/download';

/** 全国マスター、千代田区と札幌市中央区の町字、日本郵便の郵便番号データを持つ偽の取得元。 */
export function sampleUpstream(): FakeUpstream {
  const up = new FakeUpstream();
  const abr = (path: string, header: readonly string[], rows: readonly (readonly string[])[]): void => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    up.setZip(abrUrl(path), { [`${name}.csv`]: csv(header, rows) }, { etag: `"${path}"`, lastModified: ABR_LAST_MODIFIED });
  };
  abr('mt_pref/mt_pref_all', ['lg_code', 'pref', 'pref_kana', 'pref_roma'], [
    ['010006', '北海道', 'ホッカイドウ', 'Hokkaido'], ['130001', '東京都', 'トウキョウト', 'Tokyo'],
  ]);
  abr('mt_pref_pos/mt_pref_pos_all', POS_HEADER, [
    ['010006', '141.347906782', '43.0639406375', 'EPSG:6668', '0'], ['130001', '139.691717', '35.689568', 'EPSG:6668', '0'],
  ]);
  abr('mt_city/mt_city_all', CITY_HEADER, [
    cityRow('011002', '北海道', '札幌市'), cityRow('011011', '北海道', '札幌市', '中央区'), cityRow(CHIYODA_LG, '東京都', '千代田区'),
  ]);
  abr('mt_city_pos/mt_city_pos_all', POS_HEADER, [
    ['011002', '141.354374', '43.061972', 'EPSG:6668', '0'], ['011011', '141.35389', '43.061414', 'EPSG:6668', '0'], [CHIYODA_LG, '139.753634', '35.694003', 'EPSG:6668', '0'],
  ]);
  abr(`mt_town/city/mt_town_city${CHIYODA_LG}`, TOWN_HEADER, CHIYODA_TOWNS);
  abr(`mt_town_pos/city/mt_town_pos_city${CHIYODA_LG}`, TOWN_POS_HEADER, CHIYODA_POS);
  abr(`mt_town/city/mt_town_city${SAPPORO_LG}`, TOWN_HEADER, SAPPORO_TOWNS);
  abr(`mt_town_pos/city/mt_town_pos_city${SAPPORO_LG}`, TOWN_POS_HEADER, SAPPORO_POS);
  abr(`mt_rsdtdsp_rsdt/city/mt_rsdtdsp_rsdt_city${CHIYODA_LG}`, RSDT_HEADER, CHIYODA_RSDT);
  abr(`mt_rsdtdsp_rsdt_pos/city/mt_rsdtdsp_rsdt_pos_city${CHIYODA_LG}`, RSDT_POS_HEADER, CHIYODA_RSDT_POS);
  abr(`mt_parcel/city/mt_parcel_city${SAPPORO_LG}`, PARCEL_HEADER, SAPPORO_PARCELS);
  abr(`mt_parcel_pos/city/mt_parcel_pos_city${SAPPORO_LG}`, PARCEL_POS_HEADER, SAPPORO_PARCEL_POS);

  up.set(JAPANPOST_KEN_ALL_PAGE, { body: '<a href="utf/zip/utf_add_2609.zip">差分</a><a href="utf/zip/utf_ken_all.zip">全国</a>', finalUrl: `${JP_BASE}/utf-zip.html` });
  up.set(JAPANPOST_JIGYOSYO_PAGE, { body: '<a href="zip/jigyosyo.zip">全国</a>', finalUrl: `${JP_BASE}/office/index-zip.html` });
  up.setZip(JAPANPOST_FALLBACK.kenAll, { 'utf_ken_all.csv': KEN_ALL_FIXTURE }, { lastModified: POSTAL_LAST_MODIFIED });
  up.setZip(JAPANPOST_FALLBACK.jigyosyo, { 'JIGYOSYO.CSV': jigyosyoBytes() }, { lastModified: POSTAL_LAST_MODIFIED });
  return up;
}
