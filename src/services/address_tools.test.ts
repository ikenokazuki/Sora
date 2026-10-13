import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatedBuilder, createTestAddressData, settleAddressData } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, SAPPORO_LG, abrUrl, sampleUpstream } from '../test_fixtures/address/harness.js';
import { createAddressContext } from './address_context.js';
import { AddressInputError } from './address_errors.js';
import { JAPANPOST_FALLBACK } from './address_http.js';
import { ADDRESS_ATTRIBUTION, normalizeAddressTool, reverseGeocodeTool, searchPostalCode, type SearchPostalCodeByAddress, type SearchPostalCodeByZip } from './address_tools.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-tools-'));
});
afterEach(async () => {
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
});

const setup = (options: Parameters<typeof createTestAddressData>[1] = {}) => {
  const built = createTestAddressData(dir, options);
  return { ...built, ctx: createAddressContext(built.data) };
};

describe('searchPostalCode', () => {
  test('郵便番号から住所の候補を引く', async () => {
    const { ctx } = setup();
    const result = (await searchPostalCode({ zipcode: '〒100-0014' }, ctx)) as SearchPostalCodeByZip;
    expect(result).toMatchObject({ zipcode: '1000014', count: 1 });
    expect(result.candidates[0]).toMatchObject({ kind: 'general', prefecture: '東京都', city: '千代田区', town: '永田町', lgCode: CHIYODA_LG, locationLevel: 3 });
    expect(result.dataset).toEqual({ source: expect.stringContaining('アドレス・ベース・レジストリ'), updatedAt: '2026-09-30', stale: false });
    expect(result.attribution).toBe(ADDRESS_ATTRIBUTION);
    expect(result.incomplete).toBeUndefined();
  });

  test('存在しない郵便番号は count: 0（エラーにしない）', async () => {
    const { ctx } = setup();
    expect(await searchPostalCode({ zipcode: '999-9999' }, ctx)).toMatchObject({ zipcode: '9999999', count: 0, candidates: [] });
  });

  test('住所から郵便番号を逆引きする', async () => {
    const { ctx } = setup();
    const result = (await searchPostalCode({ address: '東京都千代田区永田町1-7-1' }, ctx)) as SearchPostalCodeByAddress;
    expect(result).toMatchObject({
      address: '東京都千代田区永田町1-7-1', normalized: '東京都千代田区永田町一丁目', level: 3,
      postalCodes: [{ zipcode: '1000014', town: '永田町', townRaw: '永田町', exact: true, fallback: false }],
    });
    expect(result.attribution).toBe(ADDRESS_ATTRIBUTION);
  });

  test('市区町村までの住所は、既定の番号を fallback で返す', async () => {
    const { ctx } = setup();
    const result = (await searchPostalCode({ address: '東京都千代田区' }, ctx)) as SearchPostalCodeByAddress;
    expect(result).toMatchObject({ level: 2, postalCodes: [{ zipcode: '1000000', fallback: true, exact: false }] });
  });

  test('zipcode と address は、どちらか一方だけを受ける', async () => {
    const { ctx } = setup();
    await expect(searchPostalCode({}, ctx)).rejects.toBeInstanceOf(AddressInputError);
    await expect(searchPostalCode({ zipcode: '1000014', address: '東京都千代田区' }, ctx)).rejects.toBeInstanceOf(AddressInputError);
    await expect(searchPostalCode({ zipcode: '  ' }, ctx)).rejects.toBeInstanceOf(AddressInputError);
    await expect(searchPostalCode({ zipcode: '12' }, ctx)).rejects.toBeInstanceOf(AddressInputError);
  });

  test('市区町村のデータが間に合わなければ incomplete と pending を付ける', async () => {
    const { ctx } = setup({ wrap: (inner) => new GatedBuilder(inner, (job) => job.kind === 'city'), waitMs: 300 });
    const result = (await searchPostalCode({ zipcode: '1000014' }, ctx)) as SearchPostalCodeByZip;
    expect(result).toMatchObject({ incomplete: true, pending: [`city:${CHIYODA_LG}`] });
    expect(result.candidates[0]?.locationLevel).toBe(2);
  });
});

describe('番地・号まで照合した住所', () => {
  const setup8 = () => {
    const built = createTestAddressData(dir, { up: sampleUpstream({ numbers: true }) });
    return createAddressContext(built.data);
  };

  test('normalize_address は level 8・numberSource・番地の座標・郵便番号を返す', async () => {
    const result = await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1', zipcode: '100-0014' }, setup8());
    expect(result).toMatchObject({
      level: 8, normalized: '東京都千代田区永田町一丁目7-1', numberSource: 'rsdt', keys: { blk: '7', rsdt: '1' },
      point: { lat: 35.675912, lon: 139.745512, level: 8 },
      postalCodes: [{ zipcode: '1000014', exact: true }], checks: { zipcode: { status: 'match' } },
    });
  });

  test('search_postal_code の逆引きも、番地まで照合した住所で働く', async () => {
    const result = (await searchPostalCode({ address: '札幌市中央区北1条西2丁目12-3' }, setup8())) as SearchPostalCodeByAddress;
    expect(result).toMatchObject({ level: 8, normalized: '北海道札幌市中央区北１条西二丁目12-3', postalCodes: [{ zipcode: '0600001', exact: true }] });
  });

  test('名寄せ: 住居番号だけが違えば same-block、同じ番地は identical、建物名だけが違えば same-block', async () => {
    const ctx = setup8();
    const compare = async (compareAddress: string) =>
      (await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1', compareAddress }, ctx)).checks?.compare;
    expect(await compare('東京都千代田区永田町1-7-2')).toMatchObject({ relation: 'same-block', sameLevel: 3, differences: ['住居番号'] });
    expect(await compare('千代田区永田町一丁目7番1号')).toMatchObject({ relation: 'identical', sameLevel: 8, differences: [] });
    expect(await compare('東京都千代田区永田町1-7-1 ABCビル')).toMatchObject({ relation: 'same-block', sameLevel: 8, differences: ['建物名・部屋番号'] });
    expect(await compare('東京都千代田区永田町1-6-5')).toMatchObject({ relation: 'same-town', differences: ['番地・号'] });
  });
});

describe('normalizeAddressTool', () => {
  test('正規化した住所と、キー・代表点・郵便番号を返す', async () => {
    const { ctx } = setup();
    const result = await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1' }, ctx);
    expect(result).toMatchObject({
      normalized: '東京都千代田区永田町一丁目', level: 3, numberSource: null, other: '7-1',
      keys: { prefCode: '13', lgCode: CHIYODA_LG, machiazaId: '0005001' },
      point: { lat: 35.675895, lon: 139.746306, level: 3 },
      postalCodes: [{ zipcode: '1000014', exact: true, fallback: false }],
      dataset: { updatedAt: '2026-09-30', stale: false },
      attribution: ADDRESS_ATTRIBUTION,
    });
    expect(result.checks).toBeUndefined();
    expect(result.incomplete).toBeUndefined();
  });

  test('zipcode を渡すと、住所との突き合わせ（checks.zipcode）を返す', async () => {
    const { ctx } = setup();
    expect((await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1', zipcode: '100-0014' }, ctx)).checks?.zipcode).toMatchObject({ status: 'match' });
    expect((await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1', zipcode: '060-0042' }, ctx)).checks?.zipcode).toMatchObject({ status: 'mismatch' });
  });

  test('住所の先頭の郵便番号は postalCode に分け、zipcode が無ければ突き合わせに使う', async () => {
    const { ctx } = setup();
    const result = await normalizeAddressTool({ address: '〒100-0001 東京都千代田区永田町1-7-1' }, ctx);
    expect(result.postalCode).toBe('1000001');
    expect(result.normalized).toBe('東京都千代田区永田町一丁目');
    expect(result.checks?.zipcode).toMatchObject({ status: 'partial', zipcode: '1000001' });
  });

  test('compareAddress を渡すと、2 つの住所の名寄せ（checks.compare）を返す', async () => {
    const { ctx } = setup();
    const same = await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1', compareAddress: '千代田区永田町一丁目7番1号' }, ctx);
    expect(same.checks?.compare).toMatchObject({
      relation: 'identical', sameLevel: 3, differences: [], other: { normalized: '東京都千代田区永田町一丁目', level: 3 },
    });
    const other = await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1', compareAddress: '東京都千代田区千代田1-1' }, ctx);
    expect(other.checks?.compare).toMatchObject({ relation: 'same-city', differences: ['町字'] });
  });

  test('level を渡すと、その階層までで止める', async () => {
    const { ctx } = setup();
    const result = await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1', level: 2 }, ctx);
    expect(result).toMatchObject({ level: 2, normalized: '東京都千代田区', postalCodes: [{ zipcode: '1000000', fallback: true }] });
  });

  test.each([[0], [9], [1.5]])('level が 1〜8 の整数でなければ AddressInputError: %p', async (level) => {
    const { ctx } = setup();
    await expect(normalizeAddressTool({ address: '東京都千代田区', level }, ctx)).rejects.toBeInstanceOf(AddressInputError);
  });

  test('郵便番号データを取得できなくても、正規化の結果は返し、unavailable を付ける', async () => {
    const { ctx, up } = setup();
    up.set(JAPANPOST_FALLBACK.kenAll, { body: '', status: 403 });
    const result = await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1' }, ctx);
    expect(result).toMatchObject({ level: 3, postalCodes: [], incomplete: true });
    expect(result.unavailable).toEqual([{ artifact: 'postal', message: expect.stringContaining('HTTP 403') }]);
  });

  test('市区町村のデータが間に合わなければ incomplete と pending を付ける', async () => {
    const { ctx } = setup({ wrap: (inner) => new GatedBuilder(inner, (job) => job.kind === 'city'), waitMs: 300, concurrency: 2 });
    const result = await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1' }, ctx);
    expect(result).toMatchObject({ level: 2, incomplete: true, pending: [`city:${CHIYODA_LG}`], postalCodes: [{ zipcode: '1000000', fallback: true }] });
  });

  test('市区町村のデータも郵便番号も使わなかった答えは、全国マスターの更新日を示す', async () => {
    const { ctx, up } = setup();
    up.set(JAPANPOST_FALLBACK.kenAll, { body: '', status: 403 });
    const result = await normalizeAddressTool({ address: '東京都千代田区' }, ctx);
    expect(result).toMatchObject({ level: 2, dataset: { updatedAt: '2026-10-02' } });
  });

  test('全国マスターを取得できなければ AddressUnavailableError', async () => {
    const { ctx, up } = setup();
    up.set(abrUrl('mt_city/mt_city_all'), { body: '', status: 403 });
    await expect(normalizeAddressTool({ address: '東京都千代田区永田町1-7-1' }, ctx)).rejects.toMatchObject({ name: 'AddressUnavailableError', blocked: true });
  });

  test('lat / lon を渡すと、座標との突き合わせ（checks.coordinates）を返す', async () => {
    const built8 = createTestAddressData(dir, { up: sampleUpstream({ numbers: true }) });
    const ctx8 = createAddressContext(built8.data);
    const near = await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1', lat: 35.675915, lon: 139.745515 }, ctx8);
    expect(near.checks?.coordinates).toMatchObject({ status: 'match', distanceMeters: expect.any(Number) });
    const far = await normalizeAddressTool({ address: '東京都千代田区永田町1-7-1', lat: 43.063, lon: 141.3544 }, ctx8);
    expect(far.checks?.coordinates).toMatchObject({ status: 'mismatch' });
  });

  test('lat だけ・lon だけ・不正な座標は AddressInputError', async () => {
    const { ctx } = setup();
    await expect(normalizeAddressTool({ address: '東京都千代田区', lat: 35.6 }, ctx)).rejects.toBeInstanceOf(AddressInputError);
    await expect(normalizeAddressTool({ address: '東京都千代田区', lon: 139.7 }, ctx)).rejects.toBeInstanceOf(AddressInputError);
    await expect(normalizeAddressTool({ address: '東京都千代田区', lat: 91, lon: 139.7 }, ctx)).rejects.toBeInstanceOf(AddressInputError);
  });
});

describe('reverseGeocodeTool', () => {
  const setup8 = () => {
    const built = createTestAddressData(dir, { up: sampleUpstream({ numbers: true }) });
    return { ...built, ctx: createAddressContext(built.data) };
  };

  test('座標から番地・号の住所を引く（dataset と attribution つき）', async () => {
    const { ctx } = setup8();
    const result = await reverseGeocodeTool({ lat: 35.675915, lon: 139.745515 }, ctx);
    expect(result).toMatchObject({
      found: true, level: 8, numberSource: 'rsdt', normalized: '東京都千代田区永田町一丁目7-1',
      keys: { prefCode: '13', lgCode: CHIYODA_LG, machiazaId: '0005001', blk: '7', rsdt: '1' },
      postalCodes: [{ zipcode: '1000014', exact: true }], attribution: ADDRESS_ATTRIBUTION,
    });
    expect(result.dataset).toEqual({ source: expect.stringContaining('アドレス・ベース・レジストリ'), updatedAt: expect.any(String), stale: false });
    expect(result.incomplete).toBeUndefined();
  });

  test('範囲外の座標は found: false（dataset つき）', async () => {
    const { ctx } = setup8();
    const result = await reverseGeocodeTool({ lat: 40, lon: 135 }, ctx);
    expect(result).toMatchObject({ found: false, level: 0, postalCodes: [] });
    expect(result.dataset.source).toContain('アドレス・ベース・レジストリ');
  });

  test('見つからない座標でも、使った索引の新しさを示す', async () => {
    const { ctx } = setup8();
    const result = await reverseGeocodeTool({ lat: 51.5, lon: -0.12 }, ctx);
    expect(result).toMatchObject({ found: false, dataset: { updatedAt: null } });
  });

  test('座標が不正なら AddressInputError、maxDistanceMeters が範囲外なら AddressInputError', async () => {
    const { ctx } = setup8();
    await expect(reverseGeocodeTool({ lat: Number.NaN, lon: 139.7 }, ctx)).rejects.toBeInstanceOf(AddressInputError);
    await expect(reverseGeocodeTool({ lat: 35.6, lon: 139.7, maxDistanceMeters: 5000 }, ctx)).rejects.toBeInstanceOf(AddressInputError);
  });

  test('番地・号のデータが間に合わなければ incomplete と pending を付ける', async () => {
    const built = createTestAddressData(dir, {
      up: sampleUpstream({ numbers: true }),
      wrap: (inner) => new GatedBuilder(inner, (job) => job.kind === 'num'),
      waitMs: 400, concurrency: 2,
    });
    const ctxGated = createAddressContext(built.data);
    const partial = await reverseGeocodeTool({ lat: 35.675915, lon: 139.745515 }, ctxGated);
    expect(partial).toMatchObject({ found: true, level: 3, incomplete: true, pending: [`num:${CHIYODA_LG}`] });
  });

  test('札幌の座標は地番の住所になる', async () => {
    const { ctx } = setup8();
    const result = await reverseGeocodeTool({ lat: 43.0640, lon: 141.3541 }, ctx);
    expect(result).toMatchObject({
      found: true, level: 8, numberSource: 'chiban', normalized: '北海道札幌市中央区北１条西二丁目12-3',
      keys: { lgCode: SAPPORO_LG, machiazaId: '0013002', prc: ['12', '3'] },
    });
  });
});
