import type { AddressContext } from './address_context.js';
import type { AddressData } from './address_data.js';
import { AddressInputError, AddressPendingError, AddressUnavailableError } from './address_errors.js';
import type { NormalizedAddress } from './address_normalize.js';
import {
  linkPostalRows, refineByStreetNames, zipsForTown, type PostalKind, type PostalLink, type PostalRow, type ZipMatch,
} from './postal_code.js';

/** 7 桁の数字にそろえる（〒、ハイフン、空白、全角を許す）。 */
export function normalizeZip(raw: string): string {
  const text = raw.normalize('NFKC').replace(/[〒\s\-‐‑–—―−ー]/g, '');
  if (!/^\d{7}$/.test(text)) throw new AddressInputError('郵便番号は 7 桁の数字で指定してください（例: 100-0014）');
  return text;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

// ---------- 町字との結びつけのキャッシュ ----------

interface CityLinks {
  key: string;
  rows: PostalRow[];
  links: Map<number, PostalLink>;
  /** 町字 ID → [経度, 緯度]。 */
  points: Map<string, [number, number]>;
}

const LINK_CACHE_MAX = 30;
const linkCaches = new WeakMap<AddressData, Map<string, CityLinks>>();

/** 市区町村の一般の郵便番号の行を町字に結びつける。郵便番号と町字の版が変わらない間は使い回す。 */
async function cityLinks(ctx: AddressContext, lgCode: string, waitMs: number): Promise<CityLinks> {
  const towns = await ctx.data.towns(lgCode, waitMs);
  const postal = await ctx.data.postal(waitMs);
  const key = `${postal.ver}|${towns.ver}`;
  let cache = linkCaches.get(ctx.data);
  if (!cache) {
    cache = new Map();
    linkCaches.set(ctx.data, cache);
  }
  const hit = cache.get(lgCode);
  if (hit?.key === key) {
    cache.delete(lgCode);
    cache.set(lgCode, hit);
    return hit;
  }
  const rows = postal.reader.byLg5(lgCode.slice(0, 5));
  const links = linkPostalRows(rows, towns.json.data);
  const points = new Map<string, [number, number]>();
  for (const town of towns.json.data) if (town.point) points.set(town.machiaza_id, town.point);
  const entry: CityLinks = { key, rows, links, points };
  cache.delete(lgCode);
  cache.set(lgCode, entry);
  while (cache.size > LINK_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return entry;
}

// ---------- 順引き（郵便番号 → 住所候補） ----------

export interface PostalCandidate {
  kind: PostalKind;
  prefecture: string;
  city: string;
  town: string;
  townRaw: string;
  detail?: string;
  office?: string;
  /** 6 桁の全国地方公共団体コード。 */
  lgCode?: string;
  machiazaIds?: string[];
  lat?: number;
  lon?: number;
  /** 座標の細かさ。2 市区町村 / 3 町字 / 8 番地。 */
  locationLevel?: number;
}

export interface ZipLookup {
  zipcode: string;
  candidates: PostalCandidate[];
  /** 市区町村のデータが揃わず、座標を市区町村の代表点にしたものがある。 */
  incomplete?: true;
  pending?: string[];
  unavailable?: Array<{ artifact: string; message: string }>;
}

/** 事業所の住所の正規化は重いので、1 回の問い合わせで座標を付ける件数に上限を置く。 */
const MAX_OFFICE_GEOCODES = 20;

export async function lookupZip(ctx: AddressContext, input: string, options: { waitMs?: number } = {}): Promise<ZipLookup> {
  const zipcode = normalizeZip(input);
  const deadline = Date.now() + (options.waitMs ?? ctx.data.config.waitMs);
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const { reader } = await ctx.data.postal(remaining());
  const rows = reader.byZip(zipcode);
  const lookup: ZipLookup = { zipcode, candidates: [] };
  if (rows.length === 0) return lookup;

  const master = await ctx.data.master(remaining());
  const pending = new Set<string>();
  const unavailable = new Map<string, string>();
  const note = (error: unknown): void => {
    if (error instanceof AddressPendingError && error.pending.startsWith('city:')) pending.add(error.pending);
    else if (error instanceof AddressUnavailableError && error.artifact?.startsWith('city:')) unavailable.set(error.artifact, error.message);
    else throw error;
  };

  let officeGeocodes = 0;
  for (const row of rows) {
    const candidate: PostalCandidate = { kind: row.kind, prefecture: row.pref, city: row.city, town: row.town, townRaw: row.townRaw };
    if (row.detail) candidate.detail = row.detail;
    if (row.office) candidate.office = row.office;
    const city = master.byLg5.get(row.lg5);
    if (city) {
      candidate.lgCode = city.lgCode;
      const cityPoint = city.city.point;
      const place = (point: readonly [number, number], level: number): void => {
        candidate.lon = round6(point[0]);
        candidate.lat = round6(point[1]);
        candidate.locationLevel = level;
      };
      place(cityPoint, 2);
      if (row.kind === 'general' && row.town !== '') {
        try {
          const entry = await cityLinks(ctx, city.lgCode, remaining());
          const ids = entry.links.get(row.id)?.machiazaIds ?? [];
          if (ids.length > 0) candidate.machiazaIds = ids;
          const points = ids.map((id) => entry.points.get(id)).filter((point): point is [number, number] => point !== undefined);
          if (points.length > 0) {
            const count = points.length;
            place([points.reduce((sum, p) => sum + p[0], 0) / count, points.reduce((sum, p) => sum + p[1], 0) / count], 3);
          }
        } catch (error) {
          note(error);
        }
      } else if (row.kind !== 'general' && officeGeocodes < MAX_OFFICE_GEOCODES) {
        officeGeocodes += 1;
        const result = await ctx.normalizer.normalize(`${row.pref}${row.city}${row.town}${row.detail}`, { waitMs: remaining() });
        for (const artifact of result.pending ?? []) pending.add(artifact);
        for (const item of result.unavailable ?? []) unavailable.set(item.artifact, item.message);
        if (result.keys.machiazaId) candidate.machiazaIds = [result.keys.machiazaId];
        if (result.point && result.point.level >= 2) place([result.point.lon, result.point.lat], result.point.level);
      }
    }
    lookup.candidates.push(candidate);
  }
  if (pending.size > 0 || unavailable.size > 0) {
    lookup.incomplete = true;
    if (pending.size > 0) lookup.pending = [...pending];
    if (unavailable.size > 0) lookup.unavailable = [...unavailable].map(([artifact, message]) => ({ artifact, message }));
  }
  return lookup;
}

// ---------- 逆引き（住所 → 郵便番号） ----------

/** 出力に使う郵便番号の項目（種別を除く）。 */
export type PostalCodeEntry = Omit<ZipForAddress, 'kind'>;
export const toPostalEntry = ({ zipcode, town, townRaw, exact, fallback }: ZipForAddress): PostalCodeEntry => ({ zipcode, town, townRaw, exact, fallback });

export interface ZipForAddress {
  zipcode: string;
  kind: PostalKind;
  town: string;
  townRaw: string;
  /** 括弧の注記（丁目・番地の範囲、通り名）まで解釈して、この住所に当たること。 */
  exact: boolean;
  /** 町字の専用番号が無く、市区町村の既定番号を返したこと。 */
  fallback: boolean;
}

/**
 * 正規化した住所に当たる郵便番号。町字まで解決していれば町字に結びついた番号（exact を先に）、
 * 市区町村までなら市区町村の既定番号（fallback）を返す。
 */
export async function zipsForAddress(ctx: AddressContext, address: NormalizedAddress, options: { waitMs?: number } = {}): Promise<ZipForAddress[]> {
  const lgCode = address.keys.lgCode;
  if (address.level < 2 || !lgCode) return [];
  const waitMs = options.waitMs ?? ctx.data.config.waitMs;
  let matches: ZipMatch[];
  if (address.level >= 3 && address.keys.machiazaId) {
    const entry = await cityLinks(ctx, lgCode, waitMs);
    matches = refineByStreetNames(zipsForTown(entry.rows, entry.links, address.keys.machiazaId, address.addr ?? address.other), address.input);
  } else {
    const { reader } = await ctx.data.postal(waitMs);
    matches = zipsForTown(reader.byLg5(lgCode.slice(0, 5)), new Map(), '');
  }
  return matches.map(({ row, exact, fallback }) => ({
    zipcode: row.zip, kind: row.kind, town: row.town, townRaw: row.townRaw, exact, fallback,
  }));
}
