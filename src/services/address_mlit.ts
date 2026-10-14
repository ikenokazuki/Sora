import { foldName } from './postal_code.js';

/**
 * 国土交通省「街区レベル位置参照情報」。町（大字・丁目）ごとの街区符号（住居表示でない町は地番の本番）と代表点。
 * 住居番号（号）は持たない。ABR で番地・号に届かなかった住所の補完にだけ使う。
 */
export const MLIT_BASE = 'https://nlftp.mlit.go.jp/isj/dls/data';
/** 新しい版から順に試す（毎年 1 回、版が上がる）。 */
export const MLIT_VERSIONS: readonly string[] = ['25.0a', '24.0a', '23.0a', '22.0a'];

/** 市区町村単位の zip。5 桁の市区町村コードで引く。 */
export const mlitCityUrl = (lgCode: string, version: string): string => `${MLIT_BASE}/${version}/${lgCode.slice(0, 5)}-${version}.zip`;

export type MlitRow = Record<string, string>;

/** 折りたたんだ町名 → 折りたたんだ街区符号 → [経度, 緯度]。 */
export interface MlitIndex {
  towns: Record<string, Record<string, [number, number]>>;
}

export interface MlitHit {
  /** 照合した街区符号（折りたたみ後）。 */
  block: string;
  /** 街区符号のあとに残った入力（号や建物名）。 */
  rest: string;
  lat: number;
  lon: number;
}

const foldBlock = (block: string): string => block.normalize('NFKC').replace(/\s/g, '');
const SYMBOL_BLOCK = /^([^\d-]+)(\d.*)$/;

function townKey(town: string, sub: string): string {
  const joined = `${town}${sub}`;
  return foldName(joined === '（大字なし）' ? '' : joined);
}

/**
 * CSV の行から索引を作る。代表の点だけを使い（代表フラグ 1）、更新前の履歴の行は捨てる。
 * 街区符号が「マ17」のように仮名・英字で始まる行は、町名に仮名を足した別名（高浜町マ → 17）でも引けるようにする
 * （ABR の町字が仮名を含む形で区切られているため）。
 */
export function buildMlitIndex(rows: readonly MlitRow[]): MlitIndex {
  const towns: MlitIndex['towns'] = {};
  const put = (town: string, block: string, point: [number, number]): void => {
    const blocks = (towns[town] ??= {});
    blocks[block] ??= point;
  };
  for (const row of rows) {
    if (row['代表フラグ'] !== '1' || row['更新前履歴フラグ'] === '1') continue;
    const lat = Number.parseFloat(row['緯度'] ?? '');
    const lon = Number.parseFloat(row['経度'] ?? '');
    const block = foldBlock(row['街区符号・地番'] ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || block === '') continue;
    const name = townKey(row['大字・丁目名'] ?? '', row['小字・通称名'] ?? '');
    put(name, block, [lon, lat]);
    const symbol = SYMBOL_BLOCK.exec(block);
    if (symbol) put(foldName(`${name}${symbol[1]}`), symbol[2] as string, [lon, lat]);
  }
  return { towns };
}

/**
 * 町名と、その町の続きの入力（番地以降）から、街区符号の点を引く。ハイフンで区切った先頭から長い順に試し、
 * 「渡辺3」のような名前＋数字は名前だけでも試す。見つからなければ null。
 */
export function lookupMlit(index: MlitIndex, townName: string, other: string): MlitHit | null {
  const blocks = index.towns[foldName(townName)];
  const input = other.normalize('NFKC').trim();
  if (!blocks || input === '') return null;
  const parts = input.split('-');
  for (let count = parts.length; count >= 1; count--) {
    const prefix = parts.slice(0, count).join('-');
    const candidates = [prefix, ...(/^\D/.test(prefix) ? [prefix.replace(/\d+$/, '')] : [])];
    for (const candidate of candidates) {
      const point = candidate === '' ? undefined : blocks[candidate];
      if (point) return { block: candidate, rest: input.slice(candidate.length).replace(/^-/, ''), lon: point[0], lat: point[1] };
    }
  }
  return null;
}
