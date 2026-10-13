import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHIYODA_LG, CHIYODA_RSDT, CHIYODA_RSDT_POS, PARCEL_HEADER, PARCEL_POS_HEADER, RSDT_HEADER, RSDT_POS_HEADER, SAPPORO_LG,
  SAPPORO_PARCELS, SAPPORO_PARCEL_POS, csv, parcelPosRow, parcelRow, rsdtPosRow, rsdtRow,
} from '../test_fixtures/address/harness.js';
import { makeZip } from '../test_fixtures/address/zip.js';
import { buildNumbers, type NumberRanges } from './address_numbers.js';

let dir: string;
let out: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-num-'));
  out = join(dir, 'out');
  mkdirSync(out);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function zipOf(name: string, header: readonly string[], rows: readonly (readonly string[])[]): string {
  const path = join(dir, `${name}.zip`);
  writeFileSync(path, makeZip({ [`${name}.csv`]: csv(header, rows) }));
  return path;
}

/** ranges の開始位置と長さ（バイト）で txt を切り出す。 */
function slice(file: string, range: { start: number; length: number } | undefined): string {
  if (!range) throw new Error('range がありません');
  return readFileSync(join(out, file)).subarray(range.start, range.start + range.length).toString('utf8');
}

const rsdtTowns = [{ machiaza_id: '0005001', rsdt: true }, { machiaza_id: '0005002', rsdt: true }, { machiaza_id: '0006000', rsdt: true }];
const chibanTowns = [{ machiaza_id: '0013001' }, { machiaza_id: '0013002' }];

describe('住居表示', () => {
  const files = () => ({ rsdt: zipOf('rsdt', RSDT_HEADER, CHIYODA_RSDT), rsdtPos: zipOf('rsdtpos', RSDT_POS_HEADER, CHIYODA_RSDT_POS) });

  test('町字ごとの節を rsdt.txt に出力し、範囲をバイト単位で記録する', async () => {
    const result = await buildNumbers({ outDir: out, towns: rsdtTowns, files: files() });
    expect(result.rsdtRows).toBe(5);
    expect(slice('rsdt.txt', result.ranges['0005001']?.住居表示)).toBe(
      '住居表示,0005001\nblk_num,rsdt_num,rsdt_num2,lng,lat\n7,1,,139.745512,35.675912\n7,2,,139.745700,35.676100\n6,5,,,\n',
    );
    expect(slice('rsdt.txt', result.ranges['0005002']?.住居表示)).toBe('住居表示,0005002\nblk_num,rsdt_num,rsdt_num2,lng,lat\n1,1,1,139.743300,35.674100\n');
    expect(slice('rsdt.txt', result.ranges['0006000']?.住居表示)).toContain('1,1,,139.752100,35.684000');
    expect(existsSync(join(out, 'chiban.txt'))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, 'ranges.json'), 'utf8'))).toEqual(result.ranges);
  });

  test('住居表示の町でない町字の行は出力しない', async () => {
    const result = await buildNumbers({ outDir: out, towns: [{ machiaza_id: '0005001', rsdt: true }, { machiaza_id: '0005002' }], files: files() });
    expect(Object.keys(result.ranges)).toEqual(['0005001']);
    expect(result.rsdtRows).toBe(3);
  });

  test('座標参照系が対応外の位置参照は、座標なしで出力する。重複したキーは最初の行を使う', async () => {
    const rsdt = zipOf('rsdt', RSDT_HEADER, [rsdtRow(CHIYODA_LG, '0005001', '007', '001', '', '7', '1', ''), rsdtRow(CHIYODA_LG, '0005001', '007', '002', '', '7', '2', '')]);
    const rsdtPos = zipOf('rsdtpos', RSDT_POS_HEADER, [
      rsdtPosRow(CHIYODA_LG, '0005001', '007', '001', '', '1', '2', 'EPSG:2451'),
      rsdtPosRow(CHIYODA_LG, '0005001', '007', '002', '', '139.5', '35.5'),
      rsdtPosRow(CHIYODA_LG, '0005001', '007', '002', '', '139.9', '35.9'),
    ]);
    const result = await buildNumbers({ outDir: out, towns: rsdtTowns, files: { rsdt, rsdtPos } });
    expect(slice('rsdt.txt', result.ranges['0005001']?.住居表示)).toBe('住居表示,0005001\nblk_num,rsdt_num,rsdt_num2,lng,lat\n7,1,,,\n7,2,,139.500000,35.500000\n');
  });

  test('位置参照のファイルが無くても、座標なしで出力する', async () => {
    const result = await buildNumbers({ outDir: out, towns: rsdtTowns, files: { rsdt: files().rsdt } });
    expect(slice('rsdt.txt', result.ranges['0005002']?.住居表示)).toBe('住居表示,0005002\nblk_num,rsdt_num,rsdt_num2,lng,lat\n1,1,1,,\n');
  });

  test('値にカンマ・引用符・改行を含む行と、番号の無い行は捨てる', async () => {
    const rsdt = zipOf('rsdt', RSDT_HEADER, [
      rsdtRow(CHIYODA_LG, '0005001', '007', '001', '', '7', '1', ''),
      rsdtRow(CHIYODA_LG, '0005001', '007', '002', '', '7,5', '2', ''),
      rsdtRow(CHIYODA_LG, '0005001', '007', '003', '', '7', '"3"', ''),
      rsdtRow(CHIYODA_LG, '0005001', '007', '004', '', '7', '', ''),
      rsdtRow(CHIYODA_LG, '0005001', '007', '005', '', '7', '5\n6', ''),
    ]);
    const result = await buildNumbers({ outDir: out, towns: rsdtTowns, files: { rsdt } });
    expect(result.rsdtRows).toBe(1);
    expect(result.skipped).toBe(4);
    expect(slice('rsdt.txt', result.ranges['0005001']?.住居表示)).toBe('住居表示,0005001\nblk_num,rsdt_num,rsdt_num2,lng,lat\n7,1,,,\n');
  });

  test('必要な列が無ければ、列名を示して失敗する', async () => {
    const rsdt = zipOf('rsdt', RSDT_HEADER.filter((name) => name !== 'rsdt_num'), []);
    await expect(buildNumbers({ outDir: out, towns: rsdtTowns, files: { rsdt } })).rejects.toThrow('rsdt_num');
  });
});

describe('地番', () => {
  const files = () => ({ parcel: zipOf('parcel', PARCEL_HEADER, SAPPORO_PARCELS), parcelPos: zipOf('parcelpos', PARCEL_POS_HEADER, SAPPORO_PARCEL_POS) });

  test('住居表示でない町字ごとの節を chiban.txt に出力する（位置参照の無い地番は座標なし）', async () => {
    const result = await buildNumbers({ outDir: out, towns: chibanTowns, files: files() });
    expect(result.chibanRows).toBe(4);
    expect(slice('chiban.txt', result.ranges['0013002']?.地番)).toBe(
      '地番,0013002\nprc_num1,prc_num2,prc_num3,lng,lat\n12,3,,141.354100,43.064000\n12,4,,,\n13,,,141.354300,43.064200\n',
    );
    expect(slice('chiban.txt', result.ranges['0013001']?.地番)).toBe('地番,0013001\nprc_num1,prc_num2,prc_num3,lng,lat\n1,1,,141.354400,43.063000\n');
    expect(existsSync(join(out, 'rsdt.txt'))).toBe(false);
  });

  test('住居表示の町の地番は出力しない', async () => {
    const result = await buildNumbers({ outDir: out, towns: [{ machiaza_id: '0013001' }, { machiaza_id: '0013002', rsdt: true }], files: files() });
    expect(Object.keys(result.ranges)).toEqual(['0013001']);
  });

  test('全角の番号など、複数バイトの文字を含んでも範囲はバイト単位', async () => {
    const parcel = zipOf('parcel', PARCEL_HEADER, [parcelRow(SAPPORO_LG, '0013002', 'a', '１２', '３', ''), parcelRow(SAPPORO_LG, '0013001', 'b', '5', '', '')]);
    const parcelPos = zipOf('parcelpos', PARCEL_POS_HEADER, [parcelPosRow(SAPPORO_LG, '0013002', 'a', '141.1', '43.1')]);
    const result = await buildNumbers({ outDir: out, towns: chibanTowns, files: { parcel, parcelPos } });
    expect(slice('chiban.txt', result.ranges['0013002']?.地番)).toBe('地番,0013002\nprc_num1,prc_num2,prc_num3,lng,lat\n１２,３,,141.100000,43.100000\n');
    expect(slice('chiban.txt', result.ranges['0013001']?.地番)).toBe('地番,0013001\nprc_num1,prc_num2,prc_num3,lng,lat\n5,,,,\n');
  });

  test('同名の町字が複数あっても、町字 ID ごとに別の節になる', async () => {
    const parcel = zipOf('parcel', PARCEL_HEADER, [parcelRow(SAPPORO_LG, '0009001', 'a', '1', '', ''), parcelRow(SAPPORO_LG, '0009002', 'b', '2', '', ''), parcelRow(SAPPORO_LG, '0009001', 'c', '3', '', '')]);
    const result = await buildNumbers({ outDir: out, towns: [{ machiaza_id: '0009001' }, { machiaza_id: '0009002' }], files: { parcel } });
    expect(slice('chiban.txt', result.ranges['0009001']?.地番)).toBe('地番,0009001\nprc_num1,prc_num2,prc_num3,lng,lat\n1,,,,\n3,,,,\n');
    expect(slice('chiban.txt', result.ranges['0009002']?.地番)).toBe('地番,0009002\nprc_num1,prc_num2,prc_num3,lng,lat\n2,,,,\n');
  });
});

describe('住居表示と地番の両方', () => {
  test('1 つの町字に両方の範囲を持てる（町字ごとにどちらか一方だが、ranges は合わせて返す）', async () => {
    const result = await buildNumbers({
      outDir: out,
      towns: [...rsdtTowns, ...chibanTowns],
      files: {
        rsdt: zipOf('rsdt', RSDT_HEADER, CHIYODA_RSDT), rsdtPos: zipOf('rsdtpos', RSDT_POS_HEADER, CHIYODA_RSDT_POS),
        parcel: zipOf('parcel', PARCEL_HEADER, SAPPORO_PARCELS), parcelPos: zipOf('parcelpos', PARCEL_POS_HEADER, SAPPORO_PARCEL_POS),
      },
    });
    const ranges: NumberRanges = result.ranges;
    expect(Object.keys(ranges).sort()).toEqual(['0005001', '0005002', '0006000', '0013001', '0013002']);
    expect(ranges['0005001']?.住居表示).toBeDefined();
    expect(ranges['0005001']?.地番).toBeUndefined();
    expect(ranges['0013002']?.地番).toBeDefined();
  });

  test('行が 1 つも無ければ、txt は作らず、空の ranges.json だけを出力する', async () => {
    const result = await buildNumbers({ outDir: out, towns: rsdtTowns, files: {} });
    expect(result).toMatchObject({ ranges: {}, rsdtRows: 0, chibanRows: 0 });
    expect(readFileSync(join(out, 'ranges.json'), 'utf8')).toBe('{}');
    expect(existsSync(join(out, 'rsdt.txt'))).toBe(false);
    expect(existsSync(join(out, 'chiban.txt'))).toBe(false);
  });
});
