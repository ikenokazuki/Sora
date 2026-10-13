import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip } from '../test_fixtures/address/zip.js';
import { parseCsvMatrix, parseCsvRows, readZipEntry, readZipText } from './address_csv.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'addr-csv-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function zipFile(name: string, entries: Record<string, string | Uint8Array>): string {
  const path = join(dir, name);
  writeFileSync(path, makeZip(entries));
  return path;
}

describe('readZipText', () => {
  test('最初のファイルを UTF-8 で読み、BOM を除く', async () => {
    const path = zipFile('a.zip', { 'sample.csv': '﻿name,value\r\n"a,b",1\r\n' });
    expect(await readZipText(path)).toBe('name,value\r\n"a,b",1\r\n');
  });

  test('Shift_JIS を指定して読める', async () => {
    // 「札幌」を Shift_JIS（cp932）にした 4 バイト
    const path = zipFile('sjis.zip', { 'j.csv': new Uint8Array([0x8e, 0x44, 0x96, 0x79]) });
    expect(await readZipText(path, 'shift_jis')).toBe('札幌');
  });

  test('エントリの無い zip は失敗する', async () => {
    await expect(readZipEntry(zipFile('empty.zip', {}))).rejects.toThrow();
  });

  test('zip ではないファイルは失敗する', async () => {
    const path = join(dir, 'bad.zip');
    writeFileSync(path, 'not a zip');
    await expect(readZipEntry(path)).rejects.toThrow();
  });
});

describe('CSV 解析', () => {
  test('ヘッダーつきで行を連想配列にする（引用符・空行）', () => {
    expect(parseCsvRows('name,value\r\n"a,b",1\r\n\r\nc,\r\n')).toEqual([{ name: 'a,b', value: '1' }, { name: 'c', value: '' }]);
  });

  test('ヘッダー無しで行列にする', () => {
    expect(parseCsvMatrix('13101,"100  ","1000001"\r\n')).toEqual([['13101', '100  ', '1000001']]);
  });
});
