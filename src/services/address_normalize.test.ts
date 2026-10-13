import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatedBuilder, createTestAddressData, waitFor } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, CHIYODA_TOWNS, abrUrl, replaceTowns, townRow } from '../test_fixtures/address/harness.js';
import { AddressInputError, AddressUnavailableError } from './address_errors.js';
import { AddressNormalizer, shapeResult, splitPostalCode } from './address_normalize.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-norm-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cityJobs = (runs: ReadonlyArray<{ kind: string }>) => runs.filter((job) => job.kind === 'city');

describe('splitPostalCode', () => {
  test.each([
    ['〒100-0014 東京都千代田区永田町1-7-1', '1000014', '東京都千代田区永田町1-7-1'],
    ['〒１００−００１４　東京都千代田区', '1000014', '東京都千代田区'],
    ['100-0014 東京都千代田区', '1000014', '東京都千代田区'],
    ['1000014 東京都千代田区', '1000014', '東京都千代田区'],
    ['〒1000014東京都千代田区', '1000014', '東京都千代田区'],
    ['  〒100ー0014,東京都千代田区', '1000014', '東京都千代田区'],
    ['100-0014', '1000014', ''],
  ])('先頭の郵便番号を外す: %s', (input, postalCode, address) => {
    expect(splitPostalCode(input)).toEqual({ postalCode, address });
  });

  test.each([
    ['東京都千代田区永田町1-7-1'],
    ['1-7-1 永田町'],
    ['東京都千代田区1000014'],
    ['123-4567890 東京都'],
    ['12345678 東京都'],
  ])('郵便番号でないものは外さない: %s', (input) => {
    expect(splitPostalCode(input)).toEqual({ address: input.trim() });
  });
});

describe('normalize', () => {
  test('町字まで解決し、キーと代表点を返す', async () => {
    const { data } = createTestAddressData(dir);
    const normalizer = new AddressNormalizer(data);
    const result = await normalizer.normalize('東京都千代田区永田町1-7-1');
    expect(result).toMatchObject({
      input: '東京都千代田区永田町1-7-1',
      pref: '東京都',
      city: '千代田区',
      town: '永田町一丁目',
      other: '7-1',
      normalized: '東京都千代田区永田町一丁目',
      level: 3,
      numberSource: null,
      keys: { prefCode: '13', lgCode: CHIYODA_LG, machiazaId: '0005001' },
      point: { lat: 35.675895, lon: 139.746306, level: 3 },
    });
    expect(result.incomplete).toBeUndefined();
    expect(result.postalCode).toBeUndefined();
  });

  test('市区町村までの住所は、市区町村のデータを取りに行かない', async () => {
    const { data, inner } = createTestAddressData(dir);
    const result = await new AddressNormalizer(data).normalize('東京都千代田区');
    expect(result).toMatchObject({ level: 2, normalized: '東京都千代田区', keys: { prefCode: '13', lgCode: CHIYODA_LG } });
    expect(result.keys.machiazaId).toBeUndefined();
    expect(cityJobs(inner.runs)).toHaveLength(0);
  });

  test('先頭の郵便番号は postalCode に分けて、同じ町字を解決する', async () => {
    const { data } = createTestAddressData(dir);
    const normalizer = new AddressNormalizer(data);
    for (const input of ['〒100-0014 東京都千代田区永田町1-7-1', '１００−００１４ 東京都千代田区永田町１－７－１']) {
      const result = await normalizer.normalize(input);
      expect(result).toMatchObject({ postalCode: '1000014', level: 3, keys: { machiazaId: '0005001' }, input });
    }
  });

  test('都道府県を省略した住所と、全角数字の大字名を解決する', async () => {
    const { data } = createTestAddressData(dir);
    const result = await new AddressNormalizer(data).normalize('札幌市中央区北1条西2丁目');
    expect(result).toMatchObject({ pref: '北海道', city: '札幌市中央区', level: 3, keys: { prefCode: '01', lgCode: '011011', machiazaId: '0013002' } });
  });

  test('住所でない文字列は level 0 で、何も構築しない', async () => {
    const { data, inner } = createTestAddressData(dir);
    const result = await new AddressNormalizer(data).normalize('こんにちは');
    expect(result).toMatchObject({ level: 0, normalized: '', other: 'こんにちは', keys: {} });
    expect(cityJobs(inner.runs)).toHaveLength(0);
  });

  test('郵便番号だけの入力は level 0 で、データも取りに行かない', async () => {
    const { data, inner } = createTestAddressData(dir);
    const result = await new AddressNormalizer(data).normalize('〒100-0014');
    expect(result).toMatchObject({ postalCode: '1000014', level: 0, normalized: '', other: '' });
    expect(inner.runs).toHaveLength(0);
  });

  test('空の入力と長すぎる入力は AddressInputError', async () => {
    const { data } = createTestAddressData(dir);
    const normalizer = new AddressNormalizer(data);
    await expect(normalizer.normalize('   ')).rejects.toBeInstanceOf(AddressInputError);
    await expect(normalizer.normalize('あ'.repeat(301))).rejects.toBeInstanceOf(AddressInputError);
  });

  test('同じ住所の同時の 20 呼び出しで、市区町村の構築は 1 回', async () => {
    const { data, inner } = createTestAddressData(dir);
    const normalizer = new AddressNormalizer(data);
    const results = await Promise.all(Array.from({ length: 20 }, () => normalizer.normalize('東京都千代田区永田町1-7-1')));
    expect(results.every((result) => result.level === 3)).toBe(true);
    expect(cityJobs(inner.runs)).toHaveLength(1);
    expect(inner.runs.filter((job) => job.kind === 'master')).toHaveLength(1);
    expect(normalizer.generation).toBe(1);
  });
});

describe('待ち時間と失敗', () => {
  test('市区町村の構築が間に合わなければ、市区町村までの答えに incomplete と pending を付ける', async () => {
    let gated!: GatedBuilder;
    const { data } = createTestAddressData(dir, { wrap: (inner) => (gated = new GatedBuilder(inner, (job) => job.kind === 'city')) });
    const normalizer = new AddressNormalizer(data);
    const partial = await normalizer.normalize('東京都千代田区永田町1-7-1', { waitMs: 300 });
    expect(partial).toMatchObject({ level: 2, incomplete: true, pending: [`city:${CHIYODA_LG}`], normalized: '東京都千代田区' });
    expect(partial.keys.machiazaId).toBeUndefined();

    gated.release();
    await waitFor(() => data.peek(`city:${CHIYODA_LG}`) !== null);
    const full = await normalizer.normalize('東京都千代田区永田町1-7-1');
    expect(full).toMatchObject({ level: 3, keys: { machiazaId: '0005001' } });
    expect(full.incomplete).toBeUndefined();
  });

  test('市区町村の取得に失敗したら、市区町村までの答えに unavailable を付ける', async () => {
    const { data, up } = createTestAddressData(dir);
    up.set(abrUrl(`mt_town/city/mt_town_city${CHIYODA_LG}`), { body: '', status: 403 });
    const result = await new AddressNormalizer(data).normalize('東京都千代田区永田町1-7-1');
    expect(result).toMatchObject({ level: 2, incomplete: true });
    expect(result.unavailable).toEqual([{ artifact: `city:${CHIYODA_LG}`, message: expect.stringContaining('HTTP 403') }]);
  });

  test('全国マスターを取得できなければ AddressUnavailableError', async () => {
    const { data, up } = createTestAddressData(dir);
    up.set(abrUrl('mt_city/mt_city_all'), { body: '', status: 403 });
    const error = await new AddressNormalizer(data).normalize('東京都千代田区永田町1-7-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressUnavailableError);
    expect(error).toMatchObject({ blocked: true, artifact: 'master' });
  });
});

describe('世代の作り直し', () => {
  test('配ったデータの版が変わったら、次の呼び出しでライブラリを読み直して新しい町字を解決する', async () => {
    const { data, up } = createTestAddressData(dir);
    const normalizer = new AddressNormalizer(data);
    expect((await normalizer.normalize('東京都千代田区霞が関1-1-1')).level).toBe(2);
    expect(normalizer.generation).toBe(1);

    replaceTowns(up, CHIYODA_LG, [...CHIYODA_TOWNS, townRow(CHIYODA_LG, '0003001', '霞が関', '一丁目', '1', '1')], '"v2"');
    await data.request({ kind: 'city', lgCode: CHIYODA_LG });
    const result = await normalizer.normalize('東京都千代田区霞が関1-1-1');
    expect(result).toMatchObject({ level: 3, town: '霞が関一丁目', keys: { machiazaId: '0003001' } });
    expect(normalizer.generation).toBe(2);
  });

  test('版が変わらなければ読み直さない', async () => {
    const { data } = createTestAddressData(dir);
    const normalizer = new AddressNormalizer(data);
    await normalizer.normalize('東京都千代田区永田町1-7-1');
    await normalizer.normalize('東京都千代田区永田町2-1-1');
    expect(normalizer.generation).toBe(1);
  });

  test('時間が経ったら読み直す', async () => {
    let t = Date.parse('2026-10-13T00:00:00Z');
    const { data } = createTestAddressData(dir, { now: () => t });
    const normalizer = new AddressNormalizer(data, { maxAgeMs: 60_000, now: () => t });
    await normalizer.normalize('東京都千代田区永田町1-7-1');
    t += 30_000;
    await normalizer.normalize('東京都千代田区永田町1-7-1');
    expect(normalizer.generation).toBe(1);
    t += 31_000;
    await normalizer.normalize('東京都千代田区永田町1-7-1');
    expect(normalizer.generation).toBe(2);
  });

  test('別のインスタンスは、互いのデータ（ライブラリ内のキャッシュ）を共有しない', async () => {
    const dirB = mkdtempSync(join(tmpdir(), 'addr-norm-b-'));
    try {
      const a = createTestAddressData(dir);
      replaceTowns(a.up, CHIYODA_LG, [...CHIYODA_TOWNS, townRow(CHIYODA_LG, '0003001', '霞が関', '一丁目', '1', '1')], '"a"');
      const b = createTestAddressData(dirB);
      const [first, second] = await Promise.all([
        new AddressNormalizer(a.data).normalize('東京都千代田区霞が関1-1-1'),
        new AddressNormalizer(b.data).normalize('東京都千代田区霞が関1-1-1'),
      ]);
      expect(first.level).toBe(3);
      expect(second.level).toBe(2);
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe('shapeResult', () => {
  const base = { pref: '東京都', city: '千代田区', town: '永田町一丁目', other: '', level: 8 };

  test('住居表示の一致は numberSource: rsdt と街区・住居番号のキーにする', () => {
    const shaped = shapeResult('東京都千代田区永田町1-7-1', undefined, {
      ...base,
      addr: '7-1',
      point: { lat: 35.1, lng: 139.2, level: 8 },
      metadata: { city: { code: 131016 }, machiAza: { machiaza_id: '0005001' }, rsdt: { blk_num: '7', rsdt_num: '1', rsdt_num2: '' } },
    }, {});
    expect(shaped).toMatchObject({
      normalized: '東京都千代田区永田町一丁目7-1', numberSource: 'rsdt', level: 8,
      keys: { prefCode: '13', lgCode: CHIYODA_LG, machiazaId: '0005001', blk: '7', rsdt: '1' },
      point: { lat: 35.1, lon: 139.2, level: 8 },
    });
    expect(shaped.keys.rsdt2).toBeUndefined();
  });

  test('地番の一致は numberSource: chiban と地番のキーにする', () => {
    const shaped = shapeResult('x', undefined, {
      ...base,
      addr: '12-3',
      metadata: { city: { code: 131016 }, machiAza: { machiaza_id: '0005001' }, chiban: { prc_num1: '12', prc_num2: '3', prc_num3: '' } },
    }, {});
    expect(shaped).toMatchObject({ numberSource: 'chiban', keys: { prc: ['12', '3'] } });
  });

  test('先頭 0 の 6 桁コードに戻す（北海道）', () => {
    const shaped = shapeResult('x', undefined, {
      pref: '北海道', city: '札幌市中央区', other: '', level: 2, metadata: { city: { code: 11011 } },
    }, {});
    expect(shaped.keys).toEqual({ prefCode: '01', lgCode: '011011' });
  });

  test('都道府県だけの答えは、都道府県コードを metadata.prefecture から取る', () => {
    const shaped = shapeResult('東京都', undefined, { pref: '東京都', other: '', level: 1, metadata: { prefecture: { code: 130001 } } }, {});
    expect(shaped.keys).toEqual({ prefCode: '13' });
    expect(shaped.normalized).toBe('東京都');
  });
});
