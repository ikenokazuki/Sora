import { checkCoordinates, type CoordinatesCheckStatus } from './address_checks.js';
import type { AddressContext } from './address_context.js';
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

interface PoiLike {
  address?: string;
  lat?: number;
  lng?: number;
}

/**
 * 施設ごとに、住所を正規化し、郵便番号を付け、施設の座標と突き合わせる。
 * 住所または座標が無い施設、解釈できない施設、データが間に合わなかった施設は付けない（null）。
 * データの取得は全体で ctx の待ち時間までしか待たない。
 */
export async function annotatePoiAddresses(ctx: AddressContext, pois: readonly PoiLike[]): Promise<Array<PoiAddressInfo | null>> {
  const deadline = Date.now() + ctx.data.config.waitMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const results: Array<PoiAddressInfo | null> = [];
  for (const poi of pois) {
    results.push(await annotateOne(ctx, poi, remaining));
  }
  return results;
}

async function annotateOne(ctx: AddressContext, poi: PoiLike, remaining: () => number): Promise<PoiAddressInfo | null> {
  if (!poi.address || poi.lat === undefined || poi.lng === undefined) return null;
  try {
    const normalized = await ctx.normalizer.normalize(poi.address, { waitMs: remaining() });
    if (normalized.level < 2) return null;
    const check = await checkCoordinates(ctx, poi.lat, poi.lng, normalized, { waitMs: remaining() });
    let postalCodes: PostalCodeEntry[] = [];
    try {
      postalCodes = (await zipsForAddress(ctx, normalized, { waitMs: remaining() })).map(toPostalEntry);
    } catch {
      // 郵便番号が引けなくても、正規化と突き合わせは返す。
    }
    return {
      normalized: normalized.normalized, level: normalized.level, numberSource: normalized.numberSource, keys: normalized.keys,
      postalCodes,
      check: { status: check.status, ...(check.distanceMeters !== undefined && Number.isFinite(check.distanceMeters) ? { distanceMeters: Math.round(check.distanceMeters) } : {}) },
    };
  } catch {
    return null;
  }
}
