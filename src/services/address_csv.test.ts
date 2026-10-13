import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip } from '../test_fixtures/address/zip.js';
import { CsvByteStream, CsvRowParser, parseCsvMatrix, parseCsvRows, readZipEntry, readZipText, streamZipCsv } from './address_csv.js';

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

function collect(chunks: string[]): string[][] {
  const rows: string[][] = [];
  const parser = new CsvRowParser((row) => {
    rows.push(row);
  });
  for (const chunk of chunks) if (!parser.push(chunk)) break;
  parser.end();
  return rows;
}

describe('CsvRowParser', () => {
  const sample = 'a,"b,c","d\ne",f\r\n1,,3\n\n"he said ""hi""",x';
  const expected = [['a', 'b,c', 'd\ne', 'f'], ['1', '', '3'], ['he said "hi"', 'x']];

  test('引用符・カンマ・改行・"" のエスケープ・空の列・空行・末尾の改行なしを扱う', () => {
    expect(collect([sample])).toEqual(expected);
  });

  test('どこでチャンクを切っても同じ行になる（1 文字ずつ、引用符の途中を含む）', () => {
    expect(collect([...sample])).toEqual(expected);
    expect(collect(['"a"', '"b",c\n'])).toEqual([['a"b', 'c']]);
    expect(collect(['x\r', '\ny,"z"', '\r\n'])).toEqual([['x'], ['y', 'z']]);
  });

  test('引用符で終わらない行は、そこまでの内容を最後の行にする', () => {
    expect(collect(['a,"b,c'])).toEqual([['a', 'b,c']]);
  });

  test('行の途中の引用符は文字として扱う', () => {
    expect(collect(['5" nail,x\n'])).toEqual([['5" nail', 'x']]);
  });

  test('onRow が false を返したら、それ以降は渡さない', () => {
    const rows: string[][] = [];
    const parser = new CsvRowParser((row) => {
      rows.push(row);
      return rows.length < 2;
    });
    expect(parser.push('a\nb\nc\nd\n')).toBe(false);
    parser.end();
    expect(rows).toEqual([['a'], ['b']]);
  });

  describe('keepColumns', () => {
    const input = 'h0,h1,h2,h3\n"a,x",b,"c\n""d",e\n1,2,3,4\n5,6,7';
    const expected = [['h0', 'h1', 'h2', 'h3'], ['', 'b', '', 'e'], ['', '2', '', '4'], ['', '6', '']];

    const run = (chunks: string[]): string[][] => {
      const rows: string[][] = [];
      const parser = new CsvRowParser((row, control) => {
        rows.push(row);
        if (rows.length === 1) control.keepColumns([1, 3]);
      });
      for (const chunk of chunks) parser.push(chunk);
      parser.end();
      return rows;
    };

    test('見出し行のあと、指定した列だけを文字列にして、他の列は空文字にする（位置は変わらない）', () => {
      expect(run([input])).toEqual(expected);
    });

    test('捨てる列に引用符・カンマ・改行があっても、1 文字ずつ流しても同じ', () => {
      expect(run([...input])).toEqual(expected);
    });

    test('列数が足りない行は、足りない分を含めず、指定した列の位置はそのまま', () => {
      expect(run(['h0,h1,h2,h3\nx,y\n'])).toEqual([['h0', 'h1', 'h2', 'h3'], ['', 'y']]);
    });
  });
});

describe('streamZipCsv', () => {
  const text = '﻿lg_code,name,note\r\n131016,"千代田区",""\r\n131024,"港区, 東京","a\r\nb"\r\n';

  test('zip の最初のファイルを 1 行ずつ渡す（BOM を除く。parseCsvMatrix と同じ結果）', async () => {
    const path = zipFile('s.zip', { 'a.csv': text });
    const rows: string[][] = [];
    await streamZipCsv(path, (row) => {
      rows.push(row);
    });
    expect(rows).toEqual(parseCsvMatrix(text.replace(/^﻿/, '')));
    expect(rows[0]).toEqual(['lg_code', 'name', 'note']);
    expect(rows[2]).toEqual(['131024', '港区, 東京', 'a\r\nb']);
  });

  test('keepColumns を zip の読み込みでも使える', async () => {
    const path = zipFile('k.zip', { 'k.csv': 'id,name,note\n1,"千代田区","a,b"\n2,港区,c\n' });
    const rows: string[][] = [];
    await streamZipCsv(path, (row, control) => {
      rows.push(row);
      if (rows.length === 1) control.keepColumns([1]);
    });
    expect(rows).toEqual([['id', 'name', 'note'], ['', '千代田区', ''], ['', '港区', '']]);
  });

  test('バイト列を 1 バイトずつ流しても、3 バイトの日本語の途中で切れても壊れない', () => {
    const rows: string[][] = [];
    const stream = new CsvByteStream((row) => {
      rows.push(row);
    });
    for (const byte of Buffer.from(text, 'utf8')) stream.write(Buffer.from([byte]));
    stream.end();
    expect(rows.map((row) => row[1])).toEqual(['name', '千代田区', '港区, 東京']);
  });

  test('onRow が false を返したら、そこで読み終える', async () => {
    const path = zipFile('s.zip', { 'a.csv': 'a\nb\nc\n' });
    const rows: string[][] = [];
    await streamZipCsv(path, (row) => {
      rows.push(row);
      return row[0] !== 'b';
    });
    expect(rows).toEqual([['a'], ['b']]);
  });

  test('数十万行の zip を、行を保持せずに読める', async () => {
    const lines = ['id,name,value'];
    for (let i = 0; i < 300_000; i++) lines.push(`${i},"町${i % 997}",${i * 3}`);
    const path = zipFile('big.zip', { 'big.csv': `${lines.join('\n')}\n` });
    let count = 0;
    let last: string[] = [];
    const started = performance.now();
    await streamZipCsv(path, (row) => {
      count += 1;
      last = row;
    });
    expect(count).toBe(300_001);
    expect(last).toEqual(['299999', `町${299_999 % 997}`, String(299_999 * 3)]);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test('エントリの無い zip と zip でないファイルは失敗する', async () => {
    await expect(streamZipCsv(zipFile('empty.zip', {}), () => undefined)).rejects.toThrow();
    const path = join(dir, 'bad.zip');
    writeFileSync(path, 'not a zip');
    await expect(streamZipCsv(path, () => undefined)).rejects.toThrow();
  });
});
