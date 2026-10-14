import type { AddressContext } from './address_context.js';
import { addressAttribution } from './address_attribution.js';
import { lookupZip, normalizeZip } from './address_postal.js';

/** 局所ジオコーダーの結果。geocoding.ts の GeocodingResult と同じ形（循環を避けるためここで定義する）。 */
export interface LocalGeocodingResult {
  address: string;
  lat: number;
  lon: number;
  source: 'abr';
  needsVerification: boolean;
  /** 既定の出典では足りない結果（地番を使った住所）の出典表示。 */
  attribution?: string;
}

const ZIP_ONLY = /^[\s　]*(?:〒[\s　]*)?[0-9０-９]{3}[-‐‑–—―−－ー]?[0-9０-９]{4}[\s　]*$/;

/**
 * 住所らしい入力と郵便番号を、取得済みのローカルデータだけで座標にする。
 * 地名・駅名・施設名や、データが無い地域は null（呼び出し側が従来の経路へ進む）。
 *
 * 待たない。データが無いとき、lazy では何も頼まず、eager では裏で取得を頼むだけ。
 */
export async function localGeocode(ctx: AddressContext, query: string): Promise<LocalGeocodingResult | null> {
  const { data } = ctx;
  if (!data.enabled) return null;
  const policy = data.config.mode === 'eager' ? 'background' : 'never';
  // 全国マスターが無ければ、住所かどうかも判定できない。ライブラリも読み込まない。
  if (!data.peek('master')) {
    if (policy === 'background') void data.request({ kind: 'master' });
    return null;
  }
  try {
    return await data.withoutWaiting(policy, () => (ZIP_ONLY.test(query) ? zipGeocode(ctx, query) : addressGeocode(ctx, query)));
  } catch {
    // 入力不正・データ不足・取得失敗は、すべて「ローカルでは解決しない」として扱う。
    return null;
  }
}

async function zipGeocode(ctx: AddressContext, query: string): Promise<LocalGeocodingResult | null> {
  const zipcode = normalizeZip(query);
  const lookup = await lookupZip(ctx, zipcode, { waitMs: 0 });
  const located = lookup.candidates.filter((c) => c.lat !== undefined && c.lon !== undefined);
  const first = located[0];
  if (!first || first.lat === undefined || first.lon === undefined) return null;
  const towns = new Set(lookup.candidates.map((c) => `${c.prefecture}${c.city}${c.town}`));
  // 複数の町にまたがる番号、または町ではなく市区町村の代表点しか得られない場合は、確認を促す。
  const needsVerification = towns.size > 1 || (first.locationLevel ?? 0) < 3;
  return {
    address: `${first.prefecture}${first.city}${first.town}`,
    lat: first.lat, lon: first.lon, source: 'abr', needsVerification,
  };
}

/** ライブラリは番地・号の表記（9番9号、９－９、九の九など）をどれも 9-9 の形にして other に残す。建物名は原文のまま。 */
const LEFTOVER_NUMBER = /^[0-9０-９]/;

async function addressGeocode(ctx: AddressContext, query: string): Promise<LocalGeocodingResult | null> {
  const result = await ctx.normalizer.normalize(query, { waitMs: 0 });
  // 町字（level 3）に届いて座標がある入力だけ。市区町村止まりは地名として従来の経路に任せる。
  if (result.level < 3 || !result.point) return null;
  // 番地・号が入力にあるのに照合できなかった（データに無い番地、段B が未取得）ときは、町字の代表点を番地の座標として返さない。
  if (result.level < 8 && LEFTOVER_NUMBER.test(result.other)) return null;
  return {
    address: result.normalized, lat: result.point.lat, lon: result.point.lon, source: 'abr', needsVerification: false,
    // 地番の座標は法務省の登記所備付地図データに基づくので、その出典と加工の明記を添える。
    ...(result.numberSource === 'chiban' ? { attribution: addressAttribution(true) } : {}),
  };
}
