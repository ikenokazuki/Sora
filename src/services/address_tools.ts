import { ADDRESS_ATTRIBUTION } from './address_attribution.js';
import { checkCoordinates, compareAddresses, checkZip, type AddressComparison, type CoordinatesCheck, type ZipCheck } from './address_checks.js';
import { getAddressContext, type AddressContext } from './address_context.js';
import { AddressInputError } from './address_errors.js';
import { Gaps, type Incomplete } from './address_gaps.js';
import type { NormalizedAddress } from './address_normalize.js';
import { lookupZip, normalizeZip, toPostalEntry, zipsForAddress, type PostalCandidate, type PostalCodeEntry } from './address_postal.js';
import { reverseGeocode, type ReverseInput, type ReverseResult } from './address_reverse.js';

export { ADDRESS_ATTRIBUTION };
const DATASET_SOURCE = 'デジタル庁 アドレス・ベース・レジストリ / 日本郵便 郵便番号データ';

export interface DatasetField {
  source: string;
  /** 使ったデータのうち最も古い取得元の更新日（YYYY-MM-DD）。 */
  updatedAt: string | null;
  /** 確認日時が期限の 2 倍を超えたデータを使っている。 */
  stale: boolean;
}

/**
 * 答えに使ったデータ（郵便番号・市区町村）の新しさ。全国マスターは名称とコードの対応だけで、
 * 更新日が古くても答えの古さを表さないので、使ったデータが他に無いときだけ数える。
 */
function datasetField(ctx: AddressContext, ids: Iterable<string>): DatasetField {
  let info = ctx.data.datasetInfo([...new Set(ids)]);
  if (info.updatedAt === null) info = ctx.data.datasetInfo(['master']);
  return { source: DATASET_SOURCE, updatedAt: info.updatedAt, stale: info.stale };
}


// ---------- search_postal_code ----------

export interface SearchPostalCodeByZip extends Incomplete {
  zipcode: string;
  count: number;
  candidates: PostalCandidate[];
  dataset: DatasetField;
  attribution: string;
}

export interface SearchPostalCodeByAddress extends Incomplete {
  address: string;
  normalized: string;
  level: number;
  postalCodes: PostalCodeEntry[];
  dataset: DatasetField;
  attribution: string;
}

export type SearchPostalCodeResult = SearchPostalCodeByZip | SearchPostalCodeByAddress;

/** 郵便番号 → 住所の候補、または住所 → 郵便番号。どちらか一方を指定する。 */
export async function searchPostalCode(
  input: { zipcode?: string; address?: string },
  ctx: AddressContext = getAddressContext(),
): Promise<SearchPostalCodeResult> {
  const zipcode = input.zipcode?.trim() || undefined;
  const address = input.address?.trim() || undefined;
  if ((zipcode === undefined) === (address === undefined)) throw new AddressInputError('zipcode と address のどちらか一方を指定してください');

  if (zipcode !== undefined) {
    const lookup = await lookupZip(ctx, zipcode);
    const cities = lookup.candidates.flatMap((candidate) => (candidate.lgCode ? [`city:${candidate.lgCode}`] : []));
    const gaps = new Gaps();
    gaps.add(lookup);
    return {
      zipcode: lookup.zipcode,
      count: lookup.candidates.length,
      candidates: lookup.candidates,
      ...gaps.result(),
      dataset: datasetField(ctx, ['postal', ...cities]),
      attribution: ADDRESS_ATTRIBUTION,
    };
  }

  const normalized = await ctx.normalizer.normalize(address as string);
  const postalCodes = (await zipsForAddress(ctx, normalized)).map(toPostalEntry);
  const gaps = new Gaps();
  gaps.add(normalized);
  return {
    address: address as string,
    normalized: normalized.normalized,
    level: normalized.level,
    postalCodes,
    ...gaps.result(),
    dataset: datasetField(ctx, ['postal', ...(normalized.keys.lgCode ? [`city:${normalized.keys.lgCode}`] : [])]),
    attribution: ADDRESS_ATTRIBUTION,
  };
}

// ---------- normalize_address ----------

export interface NormalizeAddressInput {
  address: string;
  /** 正規化する最大の階層（1〜8、既定 8）。 */
  level?: number;
  /** 住所との突き合わせをする郵便番号。 */
  zipcode?: string;
  /** 名寄せの相手の住所。 */
  compareAddress?: string;
  /** 突き合わせの相手の緯度。lon と組で指定する。 */
  lat?: number;
  /** 突き合わせの相手の経度。lat と組で指定する。 */
  lon?: number;
}

export interface NormalizeAddressResult extends NormalizedAddress {
  postalCodes: PostalCodeEntry[];
  checks?: {
    zipcode?: ZipCheck;
    coordinates?: CoordinatesCheck;
    compare?: AddressComparison & { other: { input: string; normalized: string; level: number } };
  };
  dataset: DatasetField;
  attribution: string;
}

/** 住所の正規化と、郵便番号・座標の付与、郵便番号 × 住所と住所 × 住所の突き合わせ。 */
export async function normalizeAddressTool(input: NormalizeAddressInput, ctx: AddressContext = getAddressContext()): Promise<NormalizeAddressResult> {
  const level = input.level ?? 8;
  if (!Number.isInteger(level) || level < 1 || level > 8) throw new AddressInputError('level は 1〜8 の整数で指定してください');
  const zipcode = input.zipcode?.trim() ? normalizeZip(input.zipcode) : undefined;

  const normalized = await ctx.normalizer.normalize(input.address, { level });
  const gaps = new Gaps();
  gaps.add(normalized);

  let postalCodes: PostalCodeEntry[] = [];
  try {
    postalCodes = (await zipsForAddress(ctx, normalized)).map(toPostalEntry);
  } catch (error) {
    gaps.absorb(error);
  }

  const checks: NonNullable<NormalizeAddressResult['checks']> = {};
  const zipToCheck = zipcode ?? normalized.postalCode;
  if (zipToCheck) {
    try {
      checks.zipcode = await checkZip(ctx, zipToCheck, normalized);
    } catch (error) {
      gaps.absorb(error);
    }
  }
  const { lat, lon } = input;
  if (lat !== undefined || lon !== undefined) {
    if (lat === undefined || lon === undefined) throw new AddressInputError('lat と lon は組で指定してください');
    try {
      checks.coordinates = await checkCoordinates(ctx, lat, lon, normalized);
    } catch (error) {
      gaps.absorb(error);
    }
  }
  const cities = new Set<string>(normalized.keys.lgCode ? [`city:${normalized.keys.lgCode}`] : []);
  if (input.compareAddress?.trim()) {
    const other = await ctx.normalizer.normalize(input.compareAddress, { level });
    gaps.add(other);
    if (other.keys.lgCode) cities.add(`city:${other.keys.lgCode}`);
    checks.compare = { ...compareAddresses(normalized, other), other: { input: other.input, normalized: other.normalized, level: other.level } };
  }

  const { incomplete: _incomplete, pending: _pending, unavailable: _unavailable, ...base } = normalized;
  const result: NormalizeAddressResult = {
    ...base,
    postalCodes,
    ...gaps.result(),
    dataset: datasetField(ctx, ['postal', ...cities]),
    attribution: ADDRESS_ATTRIBUTION,
  };
  if (Object.keys(checks).length > 0) result.checks = checks;
  return result;
}

// ---------- reverse_geocode ----------

export type ReverseGeocodeInput = Omit<ReverseInput, 'waitMs'>;
export type ReverseGeocodeResult = ReverseResult & { dataset: DatasetField; attribution: string };

/** 座標から番地・号または町字の住所を引く。 */
export async function reverseGeocodeTool(input: ReverseGeocodeInput, ctx: AddressContext = getAddressContext()): Promise<ReverseGeocodeResult> {
  const reversed = await reverseGeocode(ctx, input);
  const used = new Set<string>(['index', 'postal']);
  if (reversed.keys.lgCode) {
    used.add(`city:${reversed.keys.lgCode}`);
    used.add(`num:${reversed.keys.lgCode}`);
  }
  for (const id of reversed.pending ?? []) used.add(id);
  for (const item of reversed.unavailable ?? []) used.add(item.artifact);
  return {
    ...reversed,
    dataset: datasetField(ctx, used),
    attribution: ADDRESS_ATTRIBUTION,
  };
}
