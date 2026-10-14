import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatedBuilder, createTestAddressData, settleAddressData, waitFor } from '../test_fixtures/address/builders.js';
import {
  ABR_LAST_MODIFIED, CHIYODA_LG, CHIYODA_TOWNS, RSDT_POS_HEADER, abrUrl, csv, replaceTowns, rsdtPosRow, sampleUpstream, townRow,
} from '../test_fixtures/address/harness.js';
import { AddressInputError, AddressUnavailableError } from './address_errors.js';
import { AddressNormalizer, addressVariants, shapeResult, splitPostalCode } from './address_normalize.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-norm-'));
});
afterEach(async () => {
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
});

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

describe('addressVariants', () => {
  test.each([
    ['都城市姫城町6街区21号', ['都城市姫城町6-21']],
    ['旭川市西神楽一線五号六十七番九十号', ['旭川市西神楽1線5号67番90号']],
    ['熊本県葦北郡葦北町大字葦北2670', ['熊本県葦北郡芦北町大字芦北2670']],
    ['芦北郡芦北町芦北2670', ['葦北郡芦北町芦北2670']],
  ])('言い換えの候補: %s', (input, expected) => {
    expect(addressVariants(input)).toEqual(expected);
  });

  test('言い換えるところが無ければ候補は空。地名の漢数字（一番町、三井）は変えない', () => {
    expect(addressVariants('東京都千代田区永田町1-7-1')).toEqual([]);
    expect(addressVariants('東京都千代田区一番町1-1')).toEqual([]);
    expect(addressVariants('東京都千代田区三井ビル')).toEqual([]);
  });
});

describe('normalize（国土交通省の街区レベル位置参照で補う）', () => {
  const setup = (up = sampleUpstream({ numbers: true, mlit: true })) => {
    const built = createTestAddressData(dir, { up });
    return { ...built, normalizer: new AddressNormalizer(built.data) };
  };

  test('ABR で番地・号に届かず、街区符号が国土交通省のデータにあれば、街区までの点で答える', async () => {
    const { normalizer } = setup();
    const result = await normalizer.normalize('東京都千代田区永田町1-9-5');
    expect(result).toMatchObject({
      level: 8, numberSource: 'mlit', normalized: '東京都千代田区永田町一丁目9', addr: '9', other: '5',
      keys: { lgCode: CHIYODA_LG, prc: ['9'] }, point: { lat: 35.674, lon: 139.7461, level: 7 },
    });
    expect(result.incomplete).toBeUndefined();
  });

  test('ABR で届く住所には使わない。街区符号が無ければ町字止まりのまま', async () => {
    const { normalizer } = setup();
    expect(await normalizer.normalize('東京都千代田区永田町1-7-1')).toMatchObject({ numberSource: 'rsdt', level: 8 });
    expect(await normalizer.normalize('東京都千代田区永田町1-3-1')).toMatchObject({ numberSource: null, level: 3, other: '3-1' });
    expect((await normalizer.normalize('東京都千代田区永田町1-9-5', { level: 3 })).numberSource).toBeNull();
  });

  test('国土交通省のデータを取得できなくても、ABR だけの答えを返す', async () => {
    const { normalizer } = setup(sampleUpstream({ numbers: true }));
    expect(await normalizer.normalize('東京都千代田区永田町1-9-5')).toMatchObject({ level: 3, numberSource: null, other: '9-5' });
  });
});

describe('normalize（郵便番号で市区町村を補う）', () => {
  const setup = () => new AddressNormalizer(createTestAddressData(dir, { up: sampleUpstream({ numbers: true }) }).data);

  test('住所が解釈できず、先頭に郵便番号があるときは、郵便番号の都道府県・市区町村を補って解決し直す', async () => {
    const normalizer = setup();
    expect(await normalizer.normalize('〒100-0014 永田町一丁目7-1')).toMatchObject({
      level: 8, normalized: '東京都千代田区永田町一丁目7-1', postalCode: '1000014', input: '〒100-0014 永田町一丁目7-1',
    });
    expect(await normalizer.normalize('100-0014 大字永田町1丁目7-1')).toMatchObject({ level: 8 });
  });

  test('住所とは別に渡された郵便番号（zipcode）でも、同じように市区町村を補う。先頭の郵便番号が優先', async () => {
    const normalizer = setup();
    const result = await normalizer.normalize('永田町一丁目7-1', { zipcode: '1000014' });
    expect(result).toMatchObject({ level: 8, normalized: '東京都千代田区永田町一丁目7-1', input: '永田町一丁目7-1' });
    expect(result.postalCode).toBeUndefined();
    expect((await normalizer.normalize('永田町一丁目7-1', { zipcode: '9999999' })).level).toBe(0);
    expect((await normalizer.normalize('〒100-0014 永田町一丁目7-1', { zipcode: '0600001' })).level).toBe(8);
  });

  test('郵便番号が無い、見つからない、解釈できる住所には使わない', async () => {
    const normalizer = setup();
    expect((await normalizer.normalize('永田町一丁目7-1')).level).toBe(0);
    expect((await normalizer.normalize('〒999-9999 永田町一丁目7-1')).level).toBe(0);
    expect(await normalizer.normalize('〒060-0001 東京都千代田区永田町一丁目7-1')).toMatchObject({ level: 8 });
  });
});

describe('normalize', () => {
  test('入力のままでは番地・号に届かなければ、言い換えた入力で届いたものを採る（街区表記）', async () => {
    const { data } = createTestAddressData(dir, { up: sampleUpstream({ numbers: true }) });
    const normalizer = new AddressNormalizer(data);
    const result = await normalizer.normalize('東京都千代田区永田町一丁目7街区1号');
    expect(result).toMatchObject({ level: 8, numberSource: 'rsdt', normalized: '東京都千代田区永田町一丁目7-1' });
    // 入力のままで届く住所は、言い換えない
    expect((await normalizer.normalize('東京都千代田区永田町1-7-1')).input).toBe('東京都千代田区永田町1-7-1');
  });

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
      await settleAddressData();
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe('番地・号（段B）', () => {
  const setup = (options: Parameters<typeof createTestAddressData>[1] = {}) => {
    const built = createTestAddressData(dir, { up: sampleUpstream({ numbers: true }), ...options });
    return { ...built, normalizer: new AddressNormalizer(built.data) };
  };

  test('住居表示の番地・号まで照合して、level 8・numberSource: rsdt・番地の座標を返す', async () => {
    const { normalizer } = setup();
    const result = await normalizer.normalize('東京都千代田区永田町1-7-1');
    expect(result).toMatchObject({
      level: 8, addr: '7-1', other: '', numberSource: 'rsdt',
      normalized: '東京都千代田区永田町一丁目7-1',
      keys: { prefCode: '13', lgCode: CHIYODA_LG, machiazaId: '0005001', blk: '7', rsdt: '1' },
      point: { lat: 35.675912, lon: 139.745512, level: 8 },
    });
    expect(result.keys.rsdt2).toBeUndefined();
    expect(result.incomplete).toBeUndefined();
  });

  test('番地の後ろの建物名は other に残る。住居番号2もキーになる', async () => {
    const { normalizer } = setup();
    expect(await normalizer.normalize('東京都千代田区永田町1-7-2 ABCビル3F')).toMatchObject({ level: 8, addr: '7-2', other: 'ABCビル3F' });
    expect(await normalizer.normalize('東京都千代田区永田町2-1-1-1')).toMatchObject({
      level: 8, addr: '1-1-1', numberSource: 'rsdt', keys: { machiazaId: '0005002', blk: '1', rsdt: '1', rsdt2: '1' },
    });
  });

  test('位置参照の無い番地は level 8 のまま、座標は町字の点（level 3）のままにする', async () => {
    const { normalizer } = setup();
    expect(await normalizer.normalize('東京都千代田区永田町1-6-5')).toMatchObject({
      level: 8, addr: '6-5', numberSource: 'rsdt', point: { lat: 35.675895, lon: 139.746306, level: 3 },
    });
  });

  test('データに無い番地は level 3 のまま、番地は other に残る', async () => {
    const { normalizer } = setup();
    expect(await normalizer.normalize('東京都千代田区永田町1-9-9')).toMatchObject({ level: 3, other: '9-9', numberSource: null });
  });

  test('住居表示でない町は地番で照合する（numberSource: chiban）', async () => {
    const { normalizer } = setup();
    expect(await normalizer.normalize('札幌市中央区北1条西2丁目12-3')).toMatchObject({
      level: 8, addr: '12-3', numberSource: 'chiban', keys: { machiazaId: '0013002', prc: ['12', '3'] },
      point: { lat: 43.064, lon: 141.3541, level: 8 },
    });
    expect(await normalizer.normalize('札幌市中央区北1条西2丁目13')).toMatchObject({ level: 8, addr: '13', keys: { prc: ['13'] } });
    expect(await normalizer.normalize('札幌市中央区北1条西2丁目12-4')).toMatchObject({ level: 8, addr: '12-4', point: { level: 3 } });
    expect(await normalizer.normalize('札幌市中央区北1条西2丁目99')).toMatchObject({ level: 3, other: '99', numberSource: null });
  });

  test('番地・号のデータが無い市区町村は、段B が空でも level 3 で答え、incomplete にしない', async () => {
    const { normalizer, up } = setup();
    up.routes.delete(abrUrl(`mt_rsdtdsp_rsdt/city/mt_rsdtdsp_rsdt_city${CHIYODA_LG}`));
    up.routes.delete(abrUrl(`mt_rsdtdsp_rsdt_pos/city/mt_rsdtdsp_rsdt_pos_city${CHIYODA_LG}`));
    const result = await normalizer.normalize('東京都千代田区永田町1-7-1');
    expect(result).toMatchObject({ level: 3, other: '7-1', numberSource: null });
    expect(result.incomplete).toBeUndefined();
  });

  test('市区町村までの入力は、段B を取りに行かない', async () => {
    const { normalizer, inner } = setup();
    await normalizer.normalize('東京都千代田区');
    expect(inner.runs.filter((job) => job.kind === 'num')).toHaveLength(0);
  });

  test('段B の構築が間に合わなければ level 3 で incomplete と pending。構築が終わると次の呼び出しで読み直して level 8 になる', async () => {
    let gated!: GatedBuilder;
    const { normalizer, data } = setup({ wrap: (inner) => (gated = new GatedBuilder(inner, (job) => job.kind === 'num')) });
    const partial = await normalizer.normalize('東京都千代田区永田町1-7-1', { waitMs: 400 });
    expect(partial).toMatchObject({ level: 3, other: '7-1', incomplete: true, pending: [`num:${CHIYODA_LG}`] });
    expect(normalizer.generation).toBe(1);
    // 同じ世代では、段B が無いまま配った市区町村の答えに印を付け続ける
    expect(await normalizer.normalize('東京都千代田区永田町1-7-2')).toMatchObject({ level: 3, incomplete: true, pending: [`num:${CHIYODA_LG}`] });

    gated.release();
    await waitFor(() => data.peek(`num:${CHIYODA_LG}`) !== null);
    const full = await normalizer.normalize('東京都千代田区永田町1-7-1');
    expect(full).toMatchObject({ level: 8, addr: '7-1', numberSource: 'rsdt' });
    expect(full.incomplete).toBeUndefined();
    expect(normalizer.generation).toBe(2);
  });

  test('段B を取得できなければ level 3 で unavailable', async () => {
    const { normalizer, up } = setup();
    up.set(abrUrl(`mt_rsdtdsp_rsdt/city/mt_rsdtdsp_rsdt_city${CHIYODA_LG}`), { body: '', status: 403 });
    const result = await normalizer.normalize('東京都千代田区永田町1-7-1');
    expect(result).toMatchObject({ level: 3, incomplete: true });
    expect(result.unavailable).toEqual([{ artifact: `num:${CHIYODA_LG}`, message: expect.stringContaining('HTTP 403') }]);
  });

  test('段B が更新されたら、次の呼び出しで読み直して新しい座標を使う', async () => {
    const { normalizer, up, data } = setup();
    expect(await normalizer.normalize('東京都千代田区永田町1-7-1')).toMatchObject({ point: { lon: 139.745512 } });
    const url = abrUrl(`mt_rsdtdsp_rsdt_pos/city/mt_rsdtdsp_rsdt_pos_city${CHIYODA_LG}`);
    up.setZip(url, {
      'pos.csv': csv(RSDT_POS_HEADER, [rsdtPosRow(CHIYODA_LG, '0005001', '007', '001', '', '139.9', '35.9')]),
    }, { etag: '"moved"', lastModified: ABR_LAST_MODIFIED });
    await data.request({ kind: 'num', lgCode: CHIYODA_LG });
    expect(await normalizer.normalize('東京都千代田区永田町1-7-1')).toMatchObject({ level: 8, point: { lat: 35.9, lon: 139.9, level: 8 } });
    expect(normalizer.generation).toBe(2);
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
