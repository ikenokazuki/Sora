/** 市区町村・町字の名前とコードの共通関数、および Geolonia 形式のデータの型。 */

export type LngLat = [number, number];

export interface JaCity {
  code: number;
  county?: string;
  county_k?: string;
  county_r?: string;
  city: string;
  city_k: string;
  city_r: string;
  ward?: string;
  ward_k?: string;
  ward_r?: string;
  point: LngLat;
}

export interface JaPref {
  code: number;
  pref: string;
  pref_k: string;
  pref_r: string;
  point: LngLat;
  cities: JaCity[];
}

export interface JaJson {
  meta: { updated: number };
  data: JaPref[];
}

export interface TownEntry {
  machiaza_id: string;
  oaza_cho?: string;
  oaza_cho_k?: string;
  oaza_cho_r?: string;
  chome?: string;
  chome_n?: number;
  koaza?: string;
  koaza_k?: string;
  koaza_r?: string;
  rsdt?: true;
  point?: LngLat;
  csv_ranges?: Partial<Record<'住居表示' | '地番', { start: number; length: number }>>;
}

export interface TownJson {
  meta: { updated: number };
  data: TownEntry[];
}

/** Geolonia 形式の code（数値）を、ABR の 6 桁の全国地方公共団体コードに戻す。 */
export function lgCode6(code: number | string): string {
  return String(code).padStart(6, '0');
}

/** ライブラリが `ja/<都道府県>/<市区町村>.json` の名前に使う市区町村名（郡 + 市 + 区）。 */
export function cityNameOf(city: { county?: string; city: string; ward?: string }): string {
  return `${city.county ?? ''}${city.city}${city.ward ?? ''}`;
}
