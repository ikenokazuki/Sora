import { checkCoordinates, type CoordinatesCheckStatus } from './address_checks.js';
import type { AddressContext } from './address_context.js';
import { AddressDisabledError } from './address_errors.js';
import { Gaps, type Incomplete } from './address_gaps.js';
import type { AddressKeys } from './address_normalize.js';
import { toPostalEntry, zipsForAddress, type PostalCodeEntry } from './address_postal.js';

/** 施設の住所を正規化して座標と突き合わせた結果。 */
export interface PoiAddressInfo {
  normalized: string;
  level: number;
  numberSource: 'rsdt' | 'chiban' | null;
  keys: AddressKeys;
  postalCodes: PostalCodeEntry[];
  check: { status: CoordinatesCheckStatus; distanceMeters?: number };
}

/**
 * 施設ごとの結果。info が無いのは、住所または座標が無い、住所を解釈できない、または調べきれなかったとき。
 * incomplete は、住所データが揃う前に調べた（info があっても町字止まりなど暫定）、または調べきれなかったこと。
 * 「解釈できなかった」と「時間切れ」は、この印で区別する。
 */
export interface PoiAddressResult {
  info: PoiAddressInfo | null;
  incomplete?: true;
}

export interface PoiAddressAnnotation {
  /** 入力と同じ順。 */
  results: PoiAddressResult[];
  /** 全体で待てなかった・取得に失敗したデータ。 */
  gaps: Incomplete;
}

interface PoiLike {
  address?: string;
  lat?: number;
  lng?: number;
}

/**
 * 施設ごとに、住所を正規化し、郵便番号を付け、施設の座標と突き合わせる。
 * 住所または座標が無い施設、解釈できない施設は付けない。データの取得は全体で ctx の待ち時間までしか待たず、
 * 間に合わなかった施設は incomplete にして、足りないデータを gaps に集める。
 */
export async function annotatePoiAddresses(ctx: AddressContext, pois: readonly PoiLike[]): Promise<PoiAddressAnnotation> {
  if (!ctx.data.enabled) {
    return { results: pois.map(() => ({ info: null })), gaps: { incomplete: true, unavailable: [{ artifact: 'address', message: new AddressDisabledError().message }] } };
  }
  const deadline = Date.now() + ctx.data.config.waitMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const gaps = new Gaps();
  const results: PoiAddressResult[] = [];
  for (const poi of pois) {
    results.push(await annotateOne(ctx, poi, remaining, gaps));
  }
  return { results, gaps: gaps.result() };
}

async function annotateOne(ctx: AddressContext, poi: PoiLike, remaining: () => number, total: Gaps): Promise<PoiAddressResult> {
  if (!poi.address || poi.lat === undefined || poi.lng === undefined) return { info: null };
  const own = new Gaps();
  let info: PoiAddressInfo | null = null;
  try {
    const normalized = await ctx.normalizer.normalize(poi.address, { waitMs: remaining() });
    own.add(normalized);
    if (normalized.level >= 2) {
      const check = await checkCoordinates(ctx, poi.lat, poi.lng, normalized, { waitMs: remaining() });
      own.add(check);
      let postalCodes: PostalCodeEntry[] = [];
      try {
        postalCodes = (await zipsForAddress(ctx, normalized, { waitMs: remaining() })).map(toPostalEntry);
      } catch (error) {
        // 郵便番号が引けなくても、正規化と突き合わせは返す。
        note(own, error);
      }
      info = {
        normalized: normalized.normalized, level: normalized.level, numberSource: normalized.numberSource, keys: normalized.keys,
        postalCodes,
        check: { status: check.status, ...(check.distanceMeters !== undefined && Number.isFinite(check.distanceMeters) ? { distanceMeters: Math.round(check.distanceMeters) } : {}) },
      };
    }
  } catch (error) {
    note(own, error);
  }
  const found = own.result();
  total.add(found);
  return { info, ...(found.incomplete ? { incomplete: true as const } : {}) };
}

/** データの取得に絡む例外は記録する。それ以外（入力の誤りなど）は、その施設の住所を解釈できなかったものとして黙って扱う。 */
function note(gaps: Gaps, error: unknown): void {
  try {
    gaps.absorb(error);
  } catch {
    // 解釈できない施設は付けない。
  }
}
