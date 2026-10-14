import { join } from 'node:path';
import type { AddressContext } from './address_context.js';
import type { MasterCity } from './address_data.js';
import { AddressInputError } from './address_errors.js';
import { Gaps, type Incomplete } from './address_gaps.js';
import { distanceMeters, type NearTown } from './address_geo_index.js';
import { townNameOf, type TownEntry } from './address_names.js';
import type { AddressKeys, NormalizedAddress } from './address_normalize.js';
import { toPostalEntry, zipsForAddress, type PostalCodeEntry } from './address_postal.js';
import { foldName } from './postal_code.js';

/** txt の節の 1 行。座標が無い番号は lon / lat が undefined。 */
export interface SectionRow {
  numbers: [string, string, string];
  lon: number | undefined;
  lat: number | undefined;
}

/** 節（`住居表示,<町字ID>` と見出しの 2 行のあとに、`番号 1,番号 2,番号 3,経度,緯度` の行が並ぶ）を読む。 */
export function parseSection(text: string): SectionRow[] {
  const rows: SectionRow[] = [];
  const lines = text.split('\n');
  for (let index = 2; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    const [a = '', b = '', c = '', lng = '', lat = ''] = line.split(',');
    rows.push({ numbers: [a, b, c], lon: lng === '' ? undefined : Number(lng), lat: lat === '' ? undefined : Number(lat) });
  }
  return rows;
}

export interface ReverseAlternative {
  normalized: string;
  level: number;
  distanceMeters: number;
  /** 番地・号を何の点から得たか（町字の候補は null）。mlit は国土交通省の街区の点。 */
  numberSource: 'rsdt' | 'chiban' | 'mlit' | null;
}

export interface ReverseResult extends Incomplete {
  lat: number;
  lon: number;
  found: boolean;
  /** found: false の理由。 */
  reason?: string;
  address?: { pref: string; city: string; town?: string; addr?: string };
  normalized?: string;
  /** 8 番地・号 / 3 町字 / 2 市区町村 / 0 見つからない。 */
  level: number;
  /** mlit は国土交通省の街区の点（ABR の点が範囲内に無いときだけ。point.level は 7、号は無い）。 */
  numberSource: 'rsdt' | 'chiban' | 'mlit' | null;
  /** 入力の座標から、見つけた点までの距離。 */
  distanceMeters?: number;
  /** 見つけた点（番地・号、町字、市区町村の代表点）。 */
  point?: { lat: number; lon: number; level: number };
  /** 代表点による最寄り判定で、ポリゴンの包含判定ではない。 */
  approximate: true;
  keys: AddressKeys;
  postalCodes: PostalCodeEntry[];
  /** 次に近い住所（最大 3 件、重複なし）。 */
  alternatives: ReverseAlternative[];
}

export interface ReverseInput {
  lat: number;
  lon: number;
  /** 番地・号の点を探す範囲（既定 300、最大 2000）。 */
  maxDistanceMeters?: number;
  /** データの取得を待つ上限。省略時は設定の waitMs。 */
  waitMs?: number;
}

const DEFAULT_MAX_DISTANCE = 300;
const MAX_DISTANCE_LIMIT = 2000;
/** 近い町字を何件まで候補にするか。 */
const CANDIDATE_TOWNS = 10;
/** 町字の代表点は大きい町では遠いので、探す範囲に余裕を持たせる。 */
const CANDIDATE_MARGIN_METERS = 1500;
const MAX_CITIES = 4;
const MAX_ALTERNATIVES = 3;

interface Candidate {
  near: NearTown;
  city: MasterCity;
  entry: TownEntry;
  townName: string;
}

interface FoundPoint {
  candidate: Candidate;
  kind: '住居表示' | '地番';
  numbers: [string, string, string];
  lon: number;
  lat: number;
  distance: number;
}

/** 国土交通省の街区の点。ABR の町に対応する町だけを使う。 */
interface MlitFound {
  city: MasterCity;
  entry: TownEntry;
  townName: string;
  block: string;
  lon: number;
  lat: number;
  distance: number;
}

/** 読み込んだ市区町村の街区の点のうち、範囲内のものを近い順に返す。取得中・失敗は gaps に記録して飛ばす。 */
async function mlitPointsNear(
  ctx: AddressContext,
  loaded: ReadonlyMap<string, { city: MasterCity; entries: readonly TownEntry[] }>,
  origin: { lat: number; lon: number },
  maxDistance: number,
  remaining: () => number,
  gaps: Gaps,
): Promise<MlitFound[]> {
  const found: MlitFound[] = [];
  // 度で粗く絞ってから距離を測る（市区町村の街区は数万件ありうる）。
  const latSpan = (maxDistance / 111_000) * 1.2;
  const lonSpan = latSpan / Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180));
  for (const [lgCode, { city, entries }] of loaded) {
    let index: Awaited<ReturnType<typeof ctx.data.mlit>>['index'];
    try {
      index = (await ctx.data.mlit(lgCode, remaining())).index;
    } catch (error) {
      gaps.absorb(error);
      continue;
    }
    const byName = new Map(entries.map((entry) => [foldName(townNameOf(entry)), entry] as const));
    for (const [key, blocks] of Object.entries(index.towns)) {
      const entry = byName.get(key);
      if (!entry) continue;
      for (const [block, [lon, lat]] of Object.entries(blocks)) {
        if (Math.abs(lat - origin.lat) > latSpan || Math.abs(lon - origin.lon) > lonSpan) continue;
        const distance = distanceMeters(origin, { lat, lon });
        if (distance <= maxDistance) found.push({ city, entry, townName: townNameOf(entry), block, lon, lat, distance });
      }
    }
  }
  // 地番の街区は、近くの複数の番地が 1 つの代表点を共有する。どの番地か決められないので、共有された点は使わない。
  const sharing = new Map<string, number>();
  for (const one of found) sharing.set(`${one.lat},${one.lon}`, (sharing.get(`${one.lat},${one.lon}`) ?? 0) + 1);
  return found.filter((one) => sharing.get(`${one.lat},${one.lon}`) === 1).sort((a, b) => a.distance - b.distance);
}

const numberText = (numbers: readonly string[]): string => numbers.filter(Boolean).join('-');
const nameOf = (candidate: Candidate): string => `${candidate.city.pref}${candidate.city.name}${candidate.townName}`;

function keysOfPoint(found: FoundPoint): AddressKeys {
  const { candidate, kind, numbers } = found;
  const keys: AddressKeys = { prefCode: candidate.city.prefCode, lgCode: candidate.city.lgCode, machiazaId: candidate.entry.machiaza_id };
  if (kind === '住居表示') {
    if (numbers[0]) keys.blk = numbers[0];
    keys.rsdt = numbers[1];
    if (numbers[2]) keys.rsdt2 = numbers[2];
  } else {
    keys.prc = numbers.filter(Boolean);
  }
  return keys;
}

/**
 * 緯度経度から住所を探す。町字の点の全国索引から近い町字を取り、その市区町村の番地・号（住居表示は住居表示、
 * それ以外は地番）の点から最寄りを探す。範囲内に見つかれば level 8、無ければ最寄りの町字（level 3）。
 * 代表点による最寄り判定で、ポリゴンの包含判定ではない（approximate）。
 */
export async function reverseGeocode(ctx: AddressContext, input: ReverseInput): Promise<ReverseResult> {
  const { lat, lon } = input;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new AddressInputError('lat は -90〜90 の数値で指定してください');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new AddressInputError('lon は -180〜180 の数値で指定してください');
  const maxDistance = input.maxDistanceMeters ?? DEFAULT_MAX_DISTANCE;
  if (!Number.isFinite(maxDistance) || maxDistance < 1 || maxDistance > MAX_DISTANCE_LIMIT) {
    throw new AddressInputError(`maxDistanceMeters は 1〜${MAX_DISTANCE_LIMIT} の数値で指定してください`);
  }
  const notFound = (reason: string): ReverseResult => ({
    lat, lon, found: false, reason, level: 0, numberSource: null, approximate: true, keys: {}, postalCodes: [], alternatives: [],
  });
  if (lat < 20 || lat > 46 || lon < 122 || lon > 154) return notFound('日本国内の座標ではありません');

  const deadline = Date.now() + (input.waitMs ?? ctx.data.config.waitMs);
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const gaps = new Gaps();

  const geo = await ctx.data.geoIndex(remaining());
  const near = geo.reader.nearest(lat, lon, CANDIDATE_TOWNS, maxDistance + CANDIDATE_MARGIN_METERS);
  const first = near[0];
  if (!first) return notFound('付近に町字がありません');
  // 郵便番号は最後に使う。市区町村のデータを待つ間に作っておき、待ち時間を使い切らないようにする。
  void ctx.data.request({ kind: 'postal' }).catch(() => undefined);
  const master = await ctx.data.master(remaining());

  const cities = new Map<string, NearTown[]>();
  for (const town of near) {
    const list = cities.get(town.lgCode);
    if (list) list.push(town);
    else if (cities.size < MAX_CITIES) cities.set(town.lgCode, [town]);
  }

  const candidates: Candidate[] = [];
  const points: FoundPoint[] = [];
  const loaded = new Map<string, { city: MasterCity; entries: readonly TownEntry[] }>();
  for (const [lgCode, group] of cities) {
    const city = master.byLgCode.get(lgCode);
    if (!city) continue;
    let towns: Awaited<ReturnType<typeof ctx.data.towns>>;
    try {
      towns = await ctx.data.towns(lgCode, remaining());
    } catch (error) {
      gaps.absorb(error);
      continue;
    }
    let numbers: Awaited<ReturnType<typeof ctx.data.numbers>> | undefined;
    try {
      numbers = await ctx.data.numbers(lgCode, remaining());
    } catch (error) {
      gaps.absorb(error);
    }
    loaded.set(lgCode, { city, entries: towns.json.data });
    const byId = new Map(towns.json.data.map((entry) => [entry.machiaza_id, entry] as const));
    for (const town of group) {
      const entry = byId.get(town.machiazaId);
      if (!entry) continue;
      const candidate: Candidate = { near: town, city, entry, townName: townNameOf(entry) };
      candidates.push(candidate);
      const kind = entry.rsdt ? '住居表示' : '地番';
      const range = numbers?.ranges[town.machiazaId]?.[kind];
      if (!numbers || !range) continue;
      const file = join(numbers.path, kind === '住居表示' ? 'rsdt.txt' : 'chiban.txt');
      const section = await Bun.file(file).slice(range.start, range.start + range.length).text();
      for (const row of parseSection(section)) {
        if (row.lat === undefined || row.lon === undefined) continue;
        const distance = distanceMeters({ lat, lon }, { lat: row.lat, lon: row.lon });
        if (distance <= maxDistance) points.push({ candidate, kind, numbers: row.numbers, lon: row.lon, lat: row.lat, distance });
      }
    }
  }
  points.sort((a, b) => a.distance - b.distance);
  candidates.sort((a, b) => a.near.distanceMeters - b.near.distanceMeters);

  const best = points[0];
  // ABR の番地・号の点が範囲内に無いときだけ、国土交通省の街区の点を候補にする。
  const blocks = best ? [] : await mlitPointsNear(ctx, loaded, { lat, lon }, maxDistance, remaining, gaps);
  const block = blocks[0];
  const nearestTown = candidates[0];
  let result: ReverseResult;
  let address: NormalizedAddress | undefined;
  if (best) {
    const { candidate } = best;
    const number = numberText(best.numbers);
    const normalized = `${nameOf(candidate)}${number}`;
    const keys = keysOfPoint(best);
    const numberSource = best.kind === '住居表示' ? 'rsdt' : 'chiban';
    const seen = new Set([normalized]);
    const alternatives: ReverseAlternative[] = [];
    for (const point of points.slice(1)) {
      const text = `${nameOf(point.candidate)}${numberText(point.numbers)}`;
      if (seen.has(text)) continue;
      seen.add(text);
      alternatives.push({
        normalized: text, level: 8, distanceMeters: Math.round(point.distance), numberSource: point.kind === '住居表示' ? 'rsdt' : 'chiban',
      });
      if (alternatives.length >= MAX_ALTERNATIVES) break;
    }
    result = {
      lat, lon, found: true, level: 8, numberSource, approximate: true, normalized,
      address: { pref: candidate.city.pref, city: candidate.city.name, town: candidate.townName, addr: number },
      distanceMeters: Math.round(best.distance * 10) / 10, point: { lat: best.lat, lon: best.lon, level: 8 }, keys, postalCodes: [], alternatives,
    };
    address = {
      input: normalized, pref: candidate.city.pref, city: candidate.city.name, town: candidate.townName, addr: number, other: '', normalized,
      level: 8, numberSource, keys,
    };
  } else if (block) {
    const textOf = (found: MlitFound): string => `${found.city.pref}${found.city.name}${found.townName}${found.block}`;
    const normalized = textOf(block);
    const keys: AddressKeys = { prefCode: block.city.prefCode, lgCode: block.city.lgCode, machiazaId: block.entry.machiaza_id, prc: [block.block] };
    const seen = new Set([normalized]);
    const alternatives: ReverseAlternative[] = [];
    for (const other of blocks.slice(1)) {
      const text = textOf(other);
      if (seen.has(text)) continue;
      seen.add(text);
      alternatives.push({ normalized: text, level: 8, distanceMeters: Math.round(other.distance), numberSource: 'mlit' });
      if (alternatives.length >= MAX_ALTERNATIVES) break;
    }
    result = {
      lat, lon, found: true, level: 8, numberSource: 'mlit', approximate: true, normalized,
      address: { pref: block.city.pref, city: block.city.name, town: block.townName, addr: block.block },
      distanceMeters: Math.round(block.distance * 10) / 10, point: { lat: block.lat, lon: block.lon, level: 7 }, keys, postalCodes: [], alternatives,
    };
    address = {
      input: normalized, pref: block.city.pref, city: block.city.name, town: block.townName, addr: block.block, other: '', normalized,
      level: 8, numberSource: 'mlit', keys,
    };
  } else if (nearestTown) {
    const normalized = nameOf(nearestTown);
    const keys: AddressKeys = { prefCode: nearestTown.city.prefCode, lgCode: nearestTown.city.lgCode, machiazaId: nearestTown.entry.machiaza_id };
    const seen = new Set([normalized]);
    const alternatives: ReverseAlternative[] = [];
    for (const other of candidates.slice(1)) {
      const text = nameOf(other);
      if (seen.has(text)) continue;
      seen.add(text);
      alternatives.push({ normalized: text, level: 3, distanceMeters: Math.round(other.near.distanceMeters), numberSource: null });
      if (alternatives.length >= MAX_ALTERNATIVES) break;
    }
    result = {
      lat, lon, found: true, level: 3, numberSource: null, approximate: true, normalized,
      address: { pref: nearestTown.city.pref, city: nearestTown.city.name, town: nearestTown.townName },
      distanceMeters: Math.round(nearestTown.near.distanceMeters * 10) / 10, point: { lat: nearestTown.near.lat, lon: nearestTown.near.lon, level: 3 },
      keys, postalCodes: [], alternatives,
    };
    address = {
      input: normalized, pref: nearestTown.city.pref, city: nearestTown.city.name, town: nearestTown.townName, other: '', normalized,
      level: 3, numberSource: null, keys,
    };
  } else {
    // 町字の一覧を使えなかった（取得中・失敗）。市区町村の代表点で答える。
    const city = master.byLgCode.get(first.lgCode);
    if (!city) return { ...notFound('付近の市区町村を特定できません'), ...gaps.result() };
    const normalized = `${city.pref}${city.name}`;
    result = {
      lat, lon, found: true, level: 2, numberSource: null, approximate: true, normalized,
      address: { pref: city.pref, city: city.name },
      distanceMeters: Math.round(distanceMeters({ lat, lon }, { lat: city.city.point[1], lon: city.city.point[0] })),
      point: { lat: city.city.point[1], lon: city.city.point[0], level: 2 },
      keys: { prefCode: city.prefCode, lgCode: city.lgCode }, postalCodes: [], alternatives: [],
    };
    address = { input: normalized, pref: city.pref, city: city.name, other: '', normalized, level: 2, numberSource: null, keys: result.keys };
  }

  try {
    result.postalCodes = (await zipsForAddress(ctx, address, { waitMs: remaining() })).map(toPostalEntry);
  } catch (error) {
    gaps.absorb(error);
  }
  return { ...result, ...gaps.result() };
}
