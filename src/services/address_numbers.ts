import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSupportedSrid } from './address_abr.js';
import { streamZipCsv } from './address_csv.js';

/** txt の中の 1 つの節の位置（先頭からのバイト数と長さ）。Geolonia のライブラリが `csv_ranges` として読む。 */
export interface NumberRange {
  start: number;
  length: number;
}

/** 町字 ID → 節の範囲。住居表示の町は `住居表示`、それ以外の町は `地番`。 */
export type NumberRanges = Record<string, { 住居表示?: NumberRange; 地番?: NumberRange }>;

export interface NumberFiles {
  rsdt?: string;
  rsdtPos?: string;
  parcel?: string;
  parcelPos?: string;
}

export interface BuildNumbersOptions {
  outDir: string;
  /** 市区町村の町字。`rsdt: true` の町は住居表示、それ以外は地番を出力する（ライブラリがどちらか一方しか引かないため）。 */
  towns: ReadonlyArray<{ machiaza_id: string; rsdt?: boolean }>;
  files: NumberFiles;
}

export interface BuildNumbersResult {
  ranges: NumberRanges;
  rsdtRows: number;
  chibanRows: number;
  /** 値にカンマ・引用符・改行を含む、または番号の無い行の数。 */
  skipped: number;
}

interface KindSpec {
  /** 節の見出しと ranges のキー。 */
  kind: '住居表示' | '地番';
  /** 位置参照との結合に使う列（先頭は町字 ID）。 */
  keyColumns: readonly string[];
  /** txt に出す番号の列。 */
  numberColumns: readonly [string, string, string];
  /** 空であってはならない番号の位置。 */
  requiredNumber: number;
  /** 節の 2 行目（ライブラリが読む見出し行）。 */
  header: string;
  file: string;
}

const RSDT_SPEC: KindSpec = {
  kind: '住居表示',
  keyColumns: ['machiaza_id', 'blk_id', 'rsdt_id', 'rsdt2_id'],
  numberColumns: ['blk_num', 'rsdt_num', 'rsdt_num2'],
  requiredNumber: 1,
  header: 'blk_num,rsdt_num,rsdt_num2,lng,lat',
  file: 'rsdt.txt',
};

const CHIBAN_SPEC: KindSpec = {
  kind: '地番',
  keyColumns: ['machiaza_id', 'prc_id'],
  numberColumns: ['prc_num1', 'prc_num2', 'prc_num3'],
  requiredNumber: 0,
  header: 'prc_num1,prc_num2,prc_num3,lng,lat',
  file: 'chiban.txt',
};

/** txt の行を壊す値（カンマ・引用符・改行）。 */
const UNSAFE = /[,"\r\n]/;

/** 見出し行から、必要な列の位置を引く。無い列があれば失敗する。 */
function columnIndexes(header: readonly string[], names: readonly string[], label: string): number[] {
  const missing = names.filter((name) => !header.includes(name));
  if (missing.length > 0) throw new Error(`ABR の${label}に列 ${missing.join(', ')} がありません`);
  return names.map((name) => header.indexOf(name));
}

/** CSV を 1 行ずつ読み、見出し行で決めた列の位置とともに onRow に渡す。 */
async function scan(zipPath: string, label: string, names: readonly string[], onRow: (cols: number[], row: string[]) => void): Promise<void> {
  let cols: number[] | null = null;
  await streamZipCsv(zipPath, (row) => {
    if (cols === null) cols = columnIndexes(row, names, label);
    else onRow(cols, row);
  });
  if (cols === null) throw new Error(`ABR の${label}が空です`);
}

/** 位置参照を、結合キー → "経度,緯度"（小数 6 桁）にする。対応しない座標参照系は使わない。重複するキーは最初の行。 */
async function loadPositions(zipPath: string, spec: KindSpec): Promise<Map<string, string>> {
  const positions = new Map<string, string>();
  const keys = spec.keyColumns.length;
  await scan(zipPath, `${spec.kind}の位置参照`, [...spec.keyColumns, 'rep_lon', 'rep_lat', 'rep_srid'], (cols, row) => {
    if (!isSupportedSrid(row[cols[keys + 2] as number])) return;
    const lon = Number.parseFloat(row[cols[keys] as number] ?? '');
    const lat = Number.parseFloat(row[cols[keys + 1] as number] ?? '');
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const key = cols.slice(0, keys).map((col) => row[col] ?? '').join('|');
    if (!positions.has(key)) positions.set(key, `${lon.toFixed(6)},${lat.toFixed(6)}`);
  });
  return positions;
}

interface Collected {
  sections: Map<string, string[]>;
  rows: number;
  skipped: number;
}

async function collect(spec: KindSpec, towns: ReadonlySet<string>, mainZip: string, posZip: string | undefined): Promise<Collected> {
  const positions = posZip ? await loadPositions(posZip, spec) : new Map<string, string>();
  const sections = new Map<string, string[]>();
  const keys = spec.keyColumns.length;
  let rows = 0;
  let skipped = 0;
  await scan(mainZip, spec.kind, [...spec.keyColumns, ...spec.numberColumns], (cols, row) => {
    const machiaza = row[cols[0] as number] ?? '';
    if (!towns.has(machiaza)) return;
    const numbers = [0, 1, 2].map((index) => row[cols[keys + index] as number] ?? '');
    if (numbers[spec.requiredNumber] === '' || numbers.some((value) => UNSAFE.test(value))) {
      skipped += 1;
      return;
    }
    const key = cols.slice(0, keys).map((col) => row[col] ?? '').join('|');
    const line = `${numbers.join(',')},${positions.get(key) ?? ','}`;
    const lines = sections.get(machiaza);
    if (lines) lines.push(line);
    else sections.set(machiaza, [line]);
    rows += 1;
  });
  return { sections, rows, skipped };
}

/** 節を並べた txt を書き、町字 ID ごとの範囲（バイト単位）を ranges に記録する。 */
function writeSections(outDir: string, spec: KindSpec, sections: ReadonlyMap<string, string[]>, ranges: NumberRanges): void {
  if (sections.size === 0) return;
  const buffers: Buffer[] = [];
  let offset = 0;
  for (const [machiaza, lines] of sections) {
    const buffer = Buffer.from(`${spec.kind},${machiaza}\n${spec.header}\n${lines.join('\n')}\n`, 'utf8');
    buffers.push(buffer);
    const entry = ranges[machiaza] ?? {};
    entry[spec.kind] = { start: offset, length: buffer.length };
    ranges[machiaza] = entry;
    offset += buffer.length;
  }
  writeFileSync(join(outDir, spec.file), Buffer.concat(buffers));
}

/**
 * 住居表示・地番の zip から、町字ごとの節を並べた txt（rsdt.txt / chiban.txt）と範囲表（ranges.json）を作る。
 * CSV はストリームで読み、メモリに持つのは位置参照の表と出力する行だけ。
 */
export async function buildNumbers(options: BuildNumbersOptions): Promise<BuildNumbersResult> {
  const { outDir, towns, files } = options;
  const rsdtTowns = new Set(towns.filter((town) => town.rsdt).map((town) => town.machiaza_id));
  const chibanTowns = new Set(towns.filter((town) => !town.rsdt).map((town) => town.machiaza_id));
  const ranges: NumberRanges = {};
  let rsdtRows = 0;
  let chibanRows = 0;
  let skipped = 0;

  if (files.rsdt && rsdtTowns.size > 0) {
    const rsdt = await collect(RSDT_SPEC, rsdtTowns, files.rsdt, files.rsdtPos);
    writeSections(outDir, RSDT_SPEC, rsdt.sections, ranges);
    rsdtRows = rsdt.rows;
    skipped += rsdt.skipped;
  }
  if (files.parcel && chibanTowns.size > 0) {
    const chiban = await collect(CHIBAN_SPEC, chibanTowns, files.parcel, files.parcelPos);
    writeSections(outDir, CHIBAN_SPEC, chiban.sections, ranges);
    chibanRows = chiban.rows;
    skipped += chiban.skipped;
  }
  writeFileSync(join(outDir, 'ranges.json'), JSON.stringify(ranges));
  return { ranges, rsdtRows, chibanRows, skipped };
}
