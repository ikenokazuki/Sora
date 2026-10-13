import type { AddressContext } from './address_context.js';
import type { NormalizedAddress } from './address_normalize.js';
import { normalizeZip, zipsForAddress, type ZipForAddress } from './address_postal.js';

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
