import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatedBuilder, createTestAddressData, settleAddressData } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, KEN_ALL_FIXTURE, POSTAL_LAST_MODIFIED, SAPPORO_LG, addTown } from '../test_fixtures/address/harness.js';
import { createAddressContext, type AddressContext } from './address_context.js';
import { AddressInputError } from './address_errors.js';
import { JAPANPOST_FALLBACK } from './address_http.js';
import { lookupZip, normalizeZip, zipsForAddress } from './address_postal.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-postal-'));
});
afterEach(async () => {
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
});

const newContext = (options: Parameters<typeof createTestAddressData>[1] = {}) => {
  const built = createTestAddressData(dir, options);
  return { ...built, ctx: createAddressContext(built.data) };
};

describe('normalizeZip', () => {
  test.each([
    ['1000014', '1000014'],
    ['100-0014', '1000014'],
    ['〒100-0014', '1000014'],
    ['１００－００１４', '1000014'],
    [' 100 0014 ', '1000014'],
    ['100−0014', '1000014'],
  ])('7 桁にそろえる: %s', (input, expected) => {
    expect(normalizeZip(input)).toBe(expected);
  });

  test.each([[''], ['12-34'], ['10000141'], ['abc-defg'], ['100-001']])('7 桁でなければ AddressInputError: %s', (input) => {
    expect(() => normalizeZip(input)).toThrow(AddressInputError);
  });
});

describe('lookupZip', () => {
  test('町域の郵便番号は、結びついた町字の代表点の平均を座標にする', async () => {
    const { ctx } = newContext();
    const lookup = await lookupZip(ctx, '〒100-0014');
    expect(lookup.zipcode).toBe('1000014');
    expect(lookup.candidates).toHaveLength(1);
    const [candidate] = lookup.candidates;
    expect(candidate).toMatchObject({
      kind: 'general', prefecture: '東京都', city: '千代田区', town: '永田町', townRaw: '永田町',
      lgCode: CHIYODA_LG, machiazaIds: ['0005001', '0005002'], locationLevel: 3,
    });
    expect(candidate?.lat).toBeCloseTo(35.6750075, 5);
    expect(candidate?.lon).toBeCloseTo(139.744738, 5);
    expect(lookup.incomplete).toBeUndefined();
  });

  test('1 つの町字に結びつく番号は、その町字の点をそのまま使う', async () => {
    const { ctx } = newContext();
    const [candidate] = (await lookupZip(ctx, '1000001')).candidates;
    expect(candidate).toMatchObject({ town: '千代田', machiazaIds: ['0006000'], lat: 35.684052, lon: 139.752145, locationLevel: 3 });
  });

  test('市区町村の既定の番号は、市区町村の代表点を使う', async () => {
    const { ctx } = newContext();
    const [candidate] = (await lookupZip(ctx, '1000000')).candidates;
    expect(candidate).toMatchObject({ town: '', lgCode: CHIYODA_LG, lat: 35.694003, lon: 139.753634, locationLevel: 2 });
    expect(candidate?.machiazaIds).toBeUndefined();
  });

  test('事業所の番号は事業所名を持ち、住所を正規化して座標を付ける', async () => {
    const { ctx, up } = newContext();
    addTown(up, CHIYODA_LG, { id: '0002002', oaza: '丸の内', chome: '二丁目', n: '2', rsdt: '1', lon: 139.7633, lat: 35.6811 }, '"marunouchi"');
    const [box] = (await lookupZip(ctx, '1008799')).candidates;
    expect(box).toMatchObject({
      kind: 'po_box', office: '私書箱テスト', town: '丸の内', detail: '２丁目７－２', lgCode: CHIYODA_LG,
      machiazaIds: ['0002002'], lat: 35.6811, lon: 139.7633, locationLevel: 3,
    });
    const [office] = (await lookupZip(ctx, '060-8621')).candidates;
    expect(office).toMatchObject({ kind: 'office', office: '株式会社　日本経済新聞社　札幌支社', city: '札幌市中央区', lgCode: SAPPORO_LG });
    expect(office?.locationLevel).toBeGreaterThanOrEqual(2);
    expect(typeof office?.lat).toBe('number');
  });

  test('存在しない番号は候補なし', async () => {
    const { ctx } = newContext();
    expect(await lookupZip(ctx, '9999999')).toEqual({ zipcode: '9999999', candidates: [] });
  });

  test('不正な番号は AddressInputError', async () => {
    const { ctx } = newContext();
    await expect(lookupZip(ctx, '12-34')).rejects.toBeInstanceOf(AddressInputError);
  });

  test('市区町村の町字が間に合わなければ、市区町村の代表点で答えて incomplete と pending を付ける', async () => {
    const { ctx } = newContext({ wrap: (inner) => new GatedBuilder(inner, (job) => job.kind === 'city') });
    const lookup = await lookupZip(ctx, '1000014', { waitMs: 300 });
    expect(lookup).toMatchObject({ incomplete: true, pending: [`city:${CHIYODA_LG}`] });
    expect(lookup.candidates[0]).toMatchObject({ town: '永田町', lgCode: CHIYODA_LG, lat: 35.694003, lon: 139.753634, locationLevel: 2 });
  });
});

describe('zipsForAddress', () => {
  const zipsOf = async (ctx: AddressContext, input: string) => {
    const address = await ctx.normalizer.normalize(input);
    return zipsForAddress(ctx, address);
  };

  test('町字に結びついた郵便番号を、exact として返す', async () => {
    const { ctx } = newContext();
    expect(await zipsOf(ctx, '東京都千代田区永田町1-7-1')).toEqual([
      { zipcode: '1000014', kind: 'general', town: '永田町', townRaw: '永田町', exact: true, fallback: false },
    ]);
    expect((await zipsOf(ctx, '東京都千代田区千代田1-1')).map((zip) => zip.zipcode)).toEqual(['1000001']);
  });

  test('丁目の範囲で郵便番号が分かれる町は、丁目で選ぶ', async () => {
    const { ctx } = newContext();
    expect((await zipsOf(ctx, '札幌市中央区北1条西2丁目')).map((zip) => [zip.zipcode, zip.exact])).toEqual([['0600001', true]]);
    expect((await zipsOf(ctx, '札幌市中央区北1条西20丁目')).map((zip) => [zip.zipcode, zip.exact])).toEqual([['0640821', true]]);
    expect((await zipsOf(ctx, '札幌市中央区大通西1丁目')).map((zip) => zip.zipcode)).toEqual(['0600042']);
  });

  test('市区町村までしか分からない住所は、市区町村の既定の番号を fallback で返す', async () => {
    const { ctx } = newContext();
    expect(await zipsOf(ctx, '東京都千代田区')).toEqual([
      { zipcode: '1000000', kind: 'general', town: '', townRaw: '以下に掲載がない場合', exact: false, fallback: true },
    ]);
    expect((await zipsOf(ctx, '東京都千代田区霞が関1-1-1')).map((zip) => [zip.zipcode, zip.fallback])).toEqual([['1000000', true]]);
  });

  test('住所でなければ空', async () => {
    const { ctx } = newContext();
    expect(await zipsOf(ctx, 'こんにちは')).toEqual([]);
  });

  test('通り名の列が注記の郵便番号は、入力に含まれる通り名で選ぶ', async () => {
    const { ctx, up } = newContext();
    const line = (zip: string, town: string) => `13101,"100  ","${zip}","カナ","カナ","カナ","東京都","千代田区","${town}",0,0,0,0,0,0`;
    up.setZip(
      JAPANPOST_FALLBACK.kenAll,
      { 'utf_ken_all.csv': `${KEN_ALL_FIXTURE}${line('1000051', '大黒町（釜座通夷川下る、釜座通二条上る）')}\r\n${line('1000052', '大黒町（河原町通三条下る、三条通河原町東入）')}\r\n` },
      { lastModified: POSTAL_LAST_MODIFIED },
    );
    addTown(up, CHIYODA_LG, { id: '0009001', oaza: '大黒町', chome: '', n: '', rsdt: '0', lon: 139.75, lat: 35.69 }, '"daikoku"');
    expect((await zipsOf(ctx, '東京都千代田区大黒町123 釜座通夷川下る')).map((zip) => [zip.zipcode, zip.exact])).toEqual([['1000051', true]]);
    expect((await zipsOf(ctx, '東京都千代田区大黒町123 三条通河原町東入')).map((zip) => [zip.zipcode, zip.exact])).toEqual([['1000052', true]]);
    expect((await zipsOf(ctx, '東京都千代田区大黒町123')).map((zip) => [zip.zipcode, zip.exact])).toEqual([['1000051', false], ['1000052', false]]);
  });
});
