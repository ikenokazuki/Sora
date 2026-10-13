import { kanji2number, number2kanji } from '@geolonia/japanese-numeral';
import type { JaCity, JaJson, JaPref, LngLat, TownEntry, TownJson } from './address_names.js';

export type Row = Record<string, string>;

/** ABR の代表点の座標参照系。JGD2011 / JGD2000 / WGS84 は実質同じ値なので変換しない。 */
const SUPPORTED_SRID = new Set(['EPSG:6668', 'EPSG:4612', 'EPSG:4326']);

/** 経度・緯度をそのまま使える座標参照系か。 */
export const isSupportedSrid = (srid: string | undefined): boolean => srid !== undefined && SUPPORTED_SRID.has(srid);

const opt = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

export function toPoint(row: Row): LngLat | null {
  if (!SUPPORTED_SRID.has(row.rep_srid)) return null;
  const lon = Number.parseFloat(row.rep_lon);
  const lat = Number.parseFloat(row.rep_lat);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

export interface MasterRows {
  prefs: Row[];
  prefPos: Row[];
  cities: Row[];
  cityPos: Row[];
}

/** Geolonia 生成器の 01（都道府県・市区町村）の移植。 */
export function buildJaJson(rows: MasterRows, updated: number): JaJson {
  const prefPos = new Map(rows.prefPos.map((row) => [row.lg_code, row] as const));
  const cityPos = new Map(rows.cityPos.map((row) => [row.lg_code, row] as const));
  const data: JaPref[] = [];
  const byName = new Map<string, JaPref>();
  for (const row of rows.prefs) {
    const position = prefPos.get(row.lg_code);
    const point = position ? toPoint(position) : null;
    if (!point) throw new Error(`都道府県 ${row.lg_code} の代表点を使えません`);
    const pref: JaPref = {
      code: Number.parseInt(row.lg_code, 10), pref: row.pref, pref_k: row.pref_kana, pref_r: row.pref_roma, point, cities: [],
    };
    data.push(pref);
    byName.set(pref.pref, pref);
  }
  for (const row of rows.cities) {
    const pref = byName.get(row.pref);
    const position = cityPos.get(row.lg_code);
    const point = position ? toPoint(position) : null;
    if (!pref || !point) continue;
    const city: JaCity = {
      code: Number.parseInt(row.lg_code, 10),
      county: opt(row.county), county_k: opt(row.county_kana), county_r: opt(row.county_roma),
      city: row.city, city_k: row.city_kana, city_r: row.city_roma,
      ward: opt(row.ward), ward_k: opt(row.ward_kana), ward_r: opt(row.ward_roma),
      point,
    };
    pref.cities.push(city);
  }
  for (const pref of data) {
    const all = pref.cities;
    // 区のある政令市の「区名が無い」親行は出力しない（同じ市名で区のある行が他にあれば親）。
    pref.cities = all.filter((city) => city.ward !== undefined || all.filter((other) => other.city === city.city).every((other) => other.ward === undefined));
  }
  return { meta: { updated }, data };
}

const CHOME = /([０-９0-9]+)(丁目?)/;

/** `１４丁目` を `十四丁目` にする。漢数字のものはそのまま。 */
export function chomeToKanji(chome: string): string | undefined {
  if (chome === '') return undefined;
  const match = chome.match(CHOME);
  if (!match) return chome;
  return number2kanji(kanji2number(match[1] ?? '')) + (match[2] ?? '');
}

/** Geolonia 生成器の 02（町字）の移植。本体と位置参照を (lg_code, machiaza_id) で左結合する。 */
export function buildTownJson(towns: Row[], pos: Row[], updated: number): TownJson {
  const points = new Map<string, LngLat>();
  for (const row of pos) {
    const key = `${row.lg_code}|${row.machiaza_id}`;
    if (points.has(key)) continue;
    const point = toPoint(row);
    if (point) points.set(key, point);
  }
  const data = towns.map((row): TownEntry => ({
    machiaza_id: row.machiaza_id,
    oaza_cho: opt(row.oaza_cho), oaza_cho_k: opt(row.oaza_cho_kana), oaza_cho_r: opt(row.oaza_cho_roma),
    chome: chomeToKanji(row.chome ?? ''),
    chome_n: opt(row.chome_number) === undefined ? undefined : Number.parseInt(row.chome_number, 10),
    koaza: opt(row.koaza), koaza_k: opt(row.koaza_kana), koaza_r: opt(row.koaza_roma),
    rsdt: row.rsdt_addr_flg === '1' ? true : undefined,
    point: points.get(`${row.lg_code}|${row.machiaza_id}`),
  }));
  return { meta: { updated }, data };
}
