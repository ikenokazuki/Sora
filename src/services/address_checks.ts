import type { AddressContext } from './address_context.js';
import { AddressInputError } from './address_errors.js';
import { Gaps, type Incomplete } from './address_gaps.js';
import type { NormalizedAddress } from './address_normalize.js';
import { normalizeZip, zipsForAddress, type ZipForAddress } from './address_postal.js';
import { reverseGeocode, type ReverseResult } from './address_reverse.js';

// ---------- 住所 × 住所（名寄せ） ----------

export type CompareRelation = 'identical' | 'same-block' | 'same-town' | 'same-city' | 'same-prefecture' | 'different';

export interface AddressComparison {
  relation: CompareRelation;
  /** キーが一致した最も深い階層（0 / 1 / 2 / 3 / 8）。番地・号を照合できていないときは 3 までになる。 */
  sameLevel: number;
  /** 違いのある部分。 */
  differences: string[];
}

const compact = (text: string): string => text.normalize('NFKC').replace(/\s/g, '');
const NUMBER_HEAD = /^\d+(?:-\d+){0,2}/;

interface NumberView {
  /** 番地・号を表すキー（7-1 など）。無ければ undefined。 */
  key?: string;
  /** 街区符号または地番の本番。照合できているときだけ。 */
  block?: string;
  /** 番地・号を住居表示・地番のデータで照合できている。 */
  verified: boolean;
  /** 番地・号の後ろの建物名・部屋番号など。 */
  rest: string;
}

function viewOf(address: NormalizedAddress): NumberView {
  if (address.numberSource === 'rsdt') {
    return { key: [address.keys.blk, address.keys.rsdt, address.keys.rsdt2].filter(Boolean).join('-'), block: address.keys.blk, verified: true, rest: compact(address.other) };
  }
  if (address.numberSource === 'chiban') {
    const prc = address.keys.prc ?? [];
    return { key: prc.join('-'), block: prc[0], verified: true, rest: compact(address.other) };
  }
  const other = address.other.normalize('NFKC').trim();
  const head = other.match(NUMBER_HEAD)?.[0];
  return head ? { key: head, verified: false, rest: compact(other.slice(head.length)) } : { verified: false, rest: compact(other) };
}

/**
 * 2 つの正規化した住所を、キーで比べる。都道府県 → 市区町村 → 町字 → 番地・号の順に見て、最初に違う階層で止める。
 * 番地・号を住居表示・地番で照合できていないときは、正規化した番地の文字列で比べる（名寄せの目安）。
 */
export function compareAddresses(a: NormalizedAddress, b: NormalizedAddress): AddressComparison {
  if (a.level === 0 || b.level === 0) return { relation: 'different', sameLevel: 0, differences: ['住所を解釈できませんでした'] };
  if (!a.keys.prefCode || a.keys.prefCode !== b.keys.prefCode) return { relation: 'different', sameLevel: 0, differences: ['都道府県'] };
  if (!a.keys.lgCode || a.keys.lgCode !== b.keys.lgCode) return { relation: 'same-prefecture', sameLevel: 1, differences: ['市区町村'] };
  if (!a.keys.machiazaId || a.keys.machiazaId !== b.keys.machiazaId) return { relation: 'same-city', sameLevel: 2, differences: ['町字'] };

  const x = viewOf(a);
  const y = viewOf(b);
  const verified = x.verified && y.verified && a.numberSource === b.numberSource;
  const buildingDiffers = x.rest !== y.rest;
  if (x.key && x.key === y.key) {
    return buildingDiffers
      ? { relation: 'same-block', sameLevel: verified ? 8 : 3, differences: ['建物名・部屋番号'] }
      : { relation: 'identical', sameLevel: verified ? 8 : 3, differences: [] };
  }
  if (verified && x.block && x.block === y.block) {
    return { relation: 'same-block', sameLevel: 3, differences: [a.numberSource === 'rsdt' ? '住居番号' : '枝番'] };
  }
  if (!x.key && !y.key) return { relation: 'same-town', sameLevel: 3, differences: buildingDiffers ? ['建物名・部屋番号'] : [] };
  return { relation: 'same-town', sameLevel: 3, differences: ['番地・号'] };
}

// ---------- 郵便番号 × 住所 ----------

export type ZipCheckStatus = 'match' | 'partial' | 'mismatch' | 'unknown';

export interface ZipCheck {
  status: ZipCheckStatus;
  zipcode: string;
  /** この住所に当たる郵便番号。 */
  expected: ZipForAddress[];
  reason: string;
}

/**
 * 渡された郵便番号が、住所に当たるか。
 * match: 町域の番号に含まれる / partial: 同じ市区町村だが町が違う、または既定の番号だけ / mismatch: 市区町村が違う、または存在しない / unknown: 住所を解釈できない。
 */
export async function checkZip(ctx: AddressContext, zipcode: string, address: NormalizedAddress): Promise<ZipCheck> {
  const zip = normalizeZip(zipcode);
  const lgCode = address.keys.lgCode;
  if (address.level < 2 || !lgCode) {
    return { status: 'unknown', zipcode: zip, expected: [], reason: '住所を市区町村まで解釈できないため、突き合わせできません' };
  }
  const expected = await zipsForAddress(ctx, address);
  const own = expected.find((candidate) => candidate.zipcode === zip);
  if (own && !own.fallback) {
    return {
      status: 'match', zipcode: zip, expected,
      reason: own.exact ? '町域の郵便番号と一致しました' : '町域の郵便番号の候補に含まれます（番地までは確認していません）',
    };
  }
  if (own) {
    return { status: 'partial', zipcode: zip, expected, reason: '市区町村の既定の郵便番号です。この住所の町域に専用の番号は見つかりませんでした' };
  }
  const { reader } = await ctx.data.postal();
  const rows = reader.byZip(zip);
  const first = rows[0];
  if (!first) return { status: 'mismatch', zipcode: zip, expected, reason: '郵便番号データに存在しません' };
  if (rows.some((row) => row.lg5 === lgCode.slice(0, 5))) {
    return { status: 'partial', zipcode: zip, expected, reason: '同じ市区町村の郵便番号ですが、この住所の町域とは別です' };
  }
  return { status: 'mismatch', zipcode: zip, expected, reason: `別の市区町村の郵便番号です（${first.pref}${first.city}）` };
}

// ---------- 座標 × 住所 ----------

export type CoordinatesCheckStatus = 'match' | 'partial' | 'mismatch' | 'unknown';

/** incomplete / pending / unavailable: 突き合わせに使うデータ（逆ジオコーディング）が揃う前の答え。最寄りの住所が町字止まりなどになる。 */
export interface CoordinatesCheck extends Incomplete {
  status: CoordinatesCheckStatus;
  /** 座標の最寄りの住所。 */
  nearest: Pick<ReverseResult, 'normalized' | 'level' | 'numberSource' | 'keys' | 'point' | 'distanceMeters'> | null;
  /** 住所の代表点から、渡された座標までの距離。住所の点を特定できないときは undefined。 */
  distanceMeters?: number;
  reason: string;
}

/** 両方 level 8（番地・号まで照合済み）のときに match とする距離。 */
const LEVEL8_MATCH_METERS = 150;

/**
 * 渡された座標が、住所と一致するか。
 * match: 住所が主張する階層まで一致し、番地・号まで分かる場合は 150m 以内 / partial: 同じ町字だが番地・号が違う・離れている、または同じ市区町村で町が違う / mismatch: 市区町村が違う / unknown: 住所を解釈できない。
 */
export async function checkCoordinates(
  ctx: AddressContext,
  lat: number,
  lon: number,
  address: NormalizedAddress,
  options: { waitMs?: number; maxDistanceMeters?: number } = {},
): Promise<CoordinatesCheck> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new AddressInputError('lat は -90〜90 の数値で指定してください');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new AddressInputError('lon は -180〜180 の数値で指定してください');
  if (address.level < 2 || !address.keys.lgCode) {
    return { status: 'unknown', nearest: null, reason: '住所を市区町村まで解釈できないため、突き合わせできません' };
  }
  const reversed = await reverseGeocode(ctx, { lat, lon, ...options });
  const gaps = new Gaps();
  gaps.add(reversed);
  return { ...judgeCoordinates(address, reversed), ...gaps.result() };
}

function judgeCoordinates(address: NormalizedAddress, reversed: ReverseResult): CoordinatesCheck {
  const nearest: CoordinatesCheck['nearest'] = reversed.found
    ? {
      normalized: reversed.normalized as string, level: reversed.level, numberSource: reversed.numberSource, keys: reversed.keys,
      point: reversed.point, distanceMeters: reversed.distanceMeters,
    }
    : null;
  if (!nearest) {
    return { status: 'partial', nearest, reason: nearestAddressReason(reversed, '住所の代表点の近くに座標がありません') };
  }
  const comparison = compareAddresses(address, toComparisonAddress(reversed));
  const distance = nearest.distanceMeters ?? Number.POSITIVE_INFINITY;
  if (comparison.sameLevel <= 0) {
    return { status: 'mismatch', nearest, distanceMeters: distance, reason: `別の都道府県の座標です（${reversed.address?.pref ?? ''}${reversed.address?.city ?? ''}）` };
  }
  if (comparison.sameLevel === 1) {
    return { status: 'mismatch', nearest, distanceMeters: distance, reason: `別の市区町村の座標です（${reversed.address?.pref ?? ''}${reversed.address?.city ?? ''}）` };
  }
  if (comparison.relation === 'identical' || comparison.relation === 'same-block') {
    if (address.level >= 8 && reversed.level >= 8 && distance > LEVEL8_MATCH_METERS) {
      return { status: 'partial', nearest, distanceMeters: distance, reason: nearestAddressReason(reversed, '同じ番地・号ですが、点から離れています') };
    }
    return { status: 'match', nearest, distanceMeters: distance, reason: '住所の番地・号の点と一致しました' };
  }
  // 住所が主張する階層まで一致していれば match（例: 市区町村までの住所と、その市区町村内の座標）。
  if (comparison.sameLevel >= address.level) {
    return { status: 'match', nearest, distanceMeters: distance, reason: '住所の範囲内の座標です' };
  }
  if (comparison.sameLevel >= 3) {
    return { status: 'partial', nearest, distanceMeters: distance, reason: nearestAddressReason(reversed, '同じ町字ですが、番地・号が違います') };
  }
  return { status: 'partial', nearest, distanceMeters: distance, reason: '同じ市区町村ですが、町字が違います' };
}

/** 逆ジオコーディングの結果を、compareAddresses に渡せる住所の形にする。 */
function toComparisonAddress(reversed: ReverseResult): NormalizedAddress {
  return {
    input: reversed.normalized ?? '', other: '', normalized: reversed.normalized ?? '',
    level: reversed.level,
    numberSource: reversed.numberSource,
    keys: reversed.keys,
    pref: reversed.address?.pref, city: reversed.address?.city, town: reversed.address?.town, addr: reversed.address?.addr,
    point: reversed.point ? { lat: reversed.point.lat, lon: reversed.point.lon, level: reversed.point.level } : undefined,
  };
}

const nearestAddressReason = (reversed: ReverseResult, fallback: string): string =>
  reversed.normalized ? `最寄りは「${reversed.normalized}」です。${fallback}` : fallback;
