import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestAddressData, settleAddressData } from '../test_fixtures/address/builders.js';
import { sampleUpstream } from '../test_fixtures/address/harness.js';
import { createAddressContext } from './address_context.js';
import { checkCoordinates, checkZip, compareAddresses } from './address_checks.js';
import { AddressInputError } from './address_errors.js';
import type { NormalizedAddress } from './address_normalize.js';

const address = (over: Partial<NormalizedAddress>): NormalizedAddress => ({
  input: 'x', other: '', normalized: 'x', level: 3, numberSource: null, keys: {}, ...over,
});
const keysOf = (lgCode: string, machiazaId?: string) => ({ prefCode: lgCode.slice(0, 2), lgCode, ...(machiazaId ? { machiazaId } : {}) });

describe('compareAddresses', () => {
  const nagata = address({ keys: keysOf('131016', '0005001'), other: '7-1' });

  test('解釈できない住所は different', () => {
    expect(compareAddresses(address({ level: 0 }), nagata)).toEqual({ relation: 'different', sameLevel: 0, differences: ['住所を解釈できませんでした'] });
  });

  test('都道府県が違えば different、市区町村が違えば same-prefecture、町字が違えば same-city', () => {
    expect(compareAddresses(nagata, address({ keys: keysOf('011011', '0013001') }))).toEqual({ relation: 'different', sameLevel: 0, differences: ['都道府県'] });
    expect(compareAddresses(nagata, address({ keys: keysOf('131024', '0001001') }))).toEqual({ relation: 'same-prefecture', sameLevel: 1, differences: ['市区町村'] });
    expect(compareAddresses(nagata, address({ keys: keysOf('131016', '0006000') }))).toEqual({ relation: 'same-city', sameLevel: 2, differences: ['町字'] });
    expect(compareAddresses(nagata, address({ level: 2, keys: keysOf('131016') }))).toEqual({ relation: 'same-city', sameLevel: 2, differences: ['町字'] });
  });

  test('同じ町字で番地・号の残りが同じなら identical（番地を照合できていなくても、正規化した文字列で判定する）', () => {
    expect(compareAddresses(nagata, address({ keys: keysOf('131016', '0005001'), other: '7-1' }))).toEqual({ relation: 'identical', sameLevel: 3, differences: [] });
  });

  test('番地が違えば same-town、番地が同じで建物名・部屋番号だけが違えば same-block', () => {
    expect(compareAddresses(nagata, address({ keys: keysOf('131016', '0005001'), other: '7-2' }))).toEqual({ relation: 'same-town', sameLevel: 3, differences: ['番地・号'] });
    expect(compareAddresses(nagata, address({ keys: keysOf('131016', '0005001'), other: '' }))).toEqual({ relation: 'same-town', sameLevel: 3, differences: ['番地・号'] });
    const a = address({ keys: keysOf('131016', '0005001'), other: '7-1 ABCビル 301' });
    const b = address({ keys: keysOf('131016', '0005001'), other: '7-1 ABCビル 302' });
    expect(compareAddresses(a, b)).toEqual({ relation: 'same-block', sameLevel: 3, differences: ['建物名・部屋番号'] });
    expect(compareAddresses(a, address({ keys: keysOf('131016', '0005001'), other: '7-1　ＡＢＣビル　301' })).relation).toBe('identical');
  });

  test('住居表示で照合できていれば、キーで判定する（住居番号だけが違えば same-block）', () => {
    const rsdt = (blk: string, no: string, rsdt2?: string) => address({
      level: 8, numberSource: 'rsdt', addr: `${blk}-${no}`, keys: { ...keysOf('131016', '0005001'), blk, rsdt: no, ...(rsdt2 ? { rsdt2 } : {}) },
    });
    expect(compareAddresses(rsdt('7', '1'), rsdt('7', '1'))).toEqual({ relation: 'identical', sameLevel: 8, differences: [] });
    expect(compareAddresses(rsdt('7', '1'), rsdt('7', '2'))).toEqual({ relation: 'same-block', sameLevel: 3, differences: ['住居番号'] });
    expect(compareAddresses(rsdt('7', '1'), rsdt('8', '1'))).toEqual({ relation: 'same-town', sameLevel: 3, differences: ['番地・号'] });
  });

  test('地番で照合できていれば、本番が同じで枝番が違うものは same-block', () => {
    const chiban = (...prc: string[]) => address({ level: 8, numberSource: 'chiban', addr: prc.join('-'), keys: { ...keysOf('262013', '0012000'), prc } });
    expect(compareAddresses(chiban('12', '3'), chiban('12', '3'))).toEqual({ relation: 'identical', sameLevel: 8, differences: [] });
    expect(compareAddresses(chiban('12', '3'), chiban('12', '4'))).toEqual({ relation: 'same-block', sameLevel: 3, differences: ['枝番'] });
    expect(compareAddresses(chiban('12', '3'), chiban('13', '3'))).toEqual({ relation: 'same-town', sameLevel: 3, differences: ['番地・号'] });
  });
});

describe('checkZip', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'addr-checks-'));
  });
  afterEach(async () => {
    await settleAddressData();
    rmSync(dir, { recursive: true, force: true });
  });

  const setup = () => {
    const ctx = createAddressContext(createTestAddressData(dir).data);
    return { ctx, normalize: (input: string) => ctx.normalizer.normalize(input) };
  };

  test('町域の郵便番号と一致すれば match', async () => {
    const { ctx, normalize } = setup();
    const check = await checkZip(ctx, '〒100-0014', await normalize('東京都千代田区永田町1-7-1'));
    expect(check).toMatchObject({ status: 'match', zipcode: '1000014', reason: expect.stringContaining('一致') });
    expect(check.expected.map((zip) => zip.zipcode)).toEqual(['1000014']);
  });

  test('同じ市区町村の別の町の番号や、市区町村の既定の番号は partial', async () => {
    const { ctx, normalize } = setup();
    const nagata = await normalize('東京都千代田区永田町1-7-1');
    expect(await checkZip(ctx, '100-0001', nagata)).toMatchObject({ status: 'partial', reason: expect.stringContaining('同じ市区町村') });
    expect(await checkZip(ctx, '100-0000', nagata)).toMatchObject({ status: 'partial' });
    const cityOnly = await normalize('東京都千代田区');
    expect(await checkZip(ctx, '100-0000', cityOnly)).toMatchObject({ status: 'partial', reason: expect.stringContaining('既定') });
  });

  test('別の市区町村の番号と、存在しない番号は mismatch', async () => {
    const { ctx, normalize } = setup();
    const nagata = await normalize('東京都千代田区永田町1-7-1');
    expect(await checkZip(ctx, '060-0042', nagata)).toMatchObject({ status: 'mismatch', reason: expect.stringContaining('札幌市中央区') });
    expect(await checkZip(ctx, '999-9999', nagata)).toMatchObject({ status: 'mismatch', reason: expect.stringContaining('存在しません') });
  });

  test('住所を市区町村まで解釈できなければ unknown', async () => {
    const { ctx, normalize } = setup();
    expect(await checkZip(ctx, '100-0014', await normalize('こんにちは'))).toMatchObject({ status: 'unknown', expected: [] });
  });

  test('不正な郵便番号は AddressInputError', async () => {
    const { ctx, normalize } = setup();
    await expect(checkZip(ctx, '12', await normalize('東京都千代田区永田町1-7-1'))).rejects.toBeInstanceOf(AddressInputError);
  });
});

describe('checkCoordinates', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'addr-check-coords-'));
  });
  afterEach(async () => {
    await settleAddressData();
    rmSync(dir, { recursive: true, force: true });
  });

  const setup = () => {
    const built = createTestAddressData(dir, { up: sampleUpstream({ numbers: true }) });
    const ctx = createAddressContext(built.data);
    return { ctx, normalize: (input: string, level?: number) => ctx.normalizer.normalize(input, { level }) };
  };

  test('住所の番地・号の点に近ければ match', async () => {
    const { ctx, normalize } = setup();
    const address = await normalize('東京都千代田区永田町1-7-1');
    const check = await checkCoordinates(ctx, 35.675915, 139.745515, address);
    expect(check).toMatchObject({ status: 'match', reason: expect.stringContaining('一致') });
    expect(check.nearest).toMatchObject({ normalized: '東京都千代田区永田町一丁目7-1', level: 8 });
    expect(check.distanceMeters).toBeLessThan(5);
  });

  test('同じ町・同じ街区だが住居番号が違い、住所の点から離れていれば partial', async () => {
    const { ctx, normalize } = setup();
    const address = await normalize('東京都千代田区永田町1-7-1');
    // 永田町一丁目 7-2 の点から北に 250m。同じ町字・同じ街区だが、住所の 7-1 の点から 150m を超える
    const check = await checkCoordinates(ctx, 35.67835, 139.7457, address);
    expect(check).toMatchObject({ status: 'partial', reason: expect.stringContaining('同じ番地・号ですが、点から離れています') });
    expect(check.distanceMeters).toBeGreaterThan(150);
  });

  test('同じ市区町村で町が違えば partial（町違い）', async () => {
    const { ctx, normalize } = setup();
    const address = await normalize('東京都千代田区永田町1-7-1');
    const check = await checkCoordinates(ctx, 35.684052, 139.752145, address);
    expect(check).toMatchObject({ status: 'partial', reason: expect.stringContaining('同じ市区町村ですが、町字が違います') });
  });

  test('別の市区町村の座標なら mismatch', async () => {
    const { ctx, normalize } = setup();
    const address = await normalize('東京都千代田区永田町1-7-1');
    const check = await checkCoordinates(ctx, 43.063, 141.3544, address);
    expect(check).toMatchObject({ status: 'mismatch', reason: expect.stringContaining('札幌市中央区') });
  });

  test('level 3 の住所は、同じ町字の座標なら match（住所が主張する階層まで一致）', async () => {
    const { ctx, normalize } = setup();
    const address = await normalize('東京都千代田区');
    const town = await normalize('東京都千代田区永田町1-7-1', 3);
    const check = await checkCoordinates(ctx, 35.6759, 139.7463, town);
    expect(check).toMatchObject({ status: 'match' });
    expect(check.nearest).toMatchObject({ normalized: expect.stringContaining('永田町一丁目') });
    expect(address.level).toBe(2);
  });

  test('市区町村までの住所は、その市区町村内なら match', async () => {
    const { ctx, normalize } = setup();
    const address = await normalize('東京都千代田区');
    const check = await checkCoordinates(ctx, 35.6759, 139.7463, address);
    expect(check).toMatchObject({ status: 'match', reason: expect.stringContaining('範囲内') });
  });

  test('住所を解釈できなければ unknown、座標が不正なら AddressInputError', async () => {
    const { ctx, normalize } = setup();
    const address = await normalize('こんにちは');
    expect(await checkCoordinates(ctx, 35.6759, 139.7463, address)).toMatchObject({ status: 'unknown', nearest: null });
    await expect(checkCoordinates(ctx, 91, 139, address)).rejects.toBeInstanceOf(AddressInputError);
  });
});
