import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatedBuilder, createTestAddressData, settleAddressData, waitFor } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, SAPPORO_LG, abrUrl, sampleUpstream } from '../test_fixtures/address/harness.js';
import { createAddressContext } from './address_context.js';
import { AddressInputError, AddressUnavailableError } from './address_errors.js';
import { parseSection, reverseGeocode } from './address_reverse.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-rev-'));
});
afterEach(async () => {
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
});

const setup = (options: Parameters<typeof createTestAddressData>[1] = {}) => {
  const built = createTestAddressData(dir, { up: sampleUpstream({ numbers: true }), ...options });
  return { ...built, ctx: createAddressContext(built.data) };
};

describe('parseSection', () => {
  test('節の見出し 2 行を除き、番号と座標（無ければ undefined）を読む', () => {
    const text = '住居表示,0005001\nblk_num,rsdt_num,rsdt_num2,lng,lat\n7,1,,139.745512,35.675912\n6,5,,,\n1,1,1,139.7433,35.6741\n';
    expect(parseSection(text)).toEqual([
      { numbers: ['7', '1', ''], lon: 139.745512, lat: 35.675912 },
      { numbers: ['6', '5', ''], lon: undefined, lat: undefined },
      { numbers: ['1', '1', '1'], lon: 139.7433, lat: 35.6741 },
    ]);
    expect(parseSection('')).toEqual([]);
  });
});

describe('reverseGeocode', () => {
  test('番地・号の点の近くは level 8 の住所になる（住居表示）', async () => {
    const { ctx } = setup();
    const result = await reverseGeocode(ctx, { lat: 35.675915, lon: 139.745515 });
    expect(result).toMatchObject({
      found: true, level: 8, numberSource: 'rsdt', approximate: true,
      address: { pref: '東京都', city: '千代田区', town: '永田町一丁目', addr: '7-1' },
      normalized: '東京都千代田区永田町一丁目7-1',
      keys: { prefCode: '13', lgCode: CHIYODA_LG, machiazaId: '0005001', blk: '7', rsdt: '1' },
      point: { lat: 35.675912, lon: 139.745512, level: 8 },
      postalCodes: [{ zipcode: '1000014', exact: true, fallback: false }],
    });
    expect(result.distanceMeters).toBeLessThan(5);
    expect(result.incomplete).toBeUndefined();
  });

  test('ABR の番地・号の点が範囲内に無ければ、国土交通省の街区の点を候補にする（ABR の町に対応する町だけ）', async () => {
    const { ctx } = setup({ up: sampleUpstream({ numbers: true, mlit: true }) });
    const result = await reverseGeocode(ctx, { lat: 43.0652, lon: 141.3541, maxDistanceMeters: 100 });
    expect(result).toMatchObject({
      found: true, level: 8, numberSource: 'mlit', normalized: '北海道札幌市中央区北１条西二丁目40',
      address: { pref: '北海道', city: '札幌市中央区', town: '北１条西二丁目', addr: '40' },
      keys: { prefCode: '01', lgCode: SAPPORO_LG, machiazaId: '0013002', prc: ['40'] },
      point: { lat: 43.0648, lon: 141.3541, level: 7 },
    });
    expect(result.distanceMeters).toBeLessThan(60);
    expect(result.incomplete).toBeUndefined();
  });

  test('同じ点を複数の街区が共有しているとき（地番の街区は代表点を共有する）は、どの番地か決められないので使わない', async () => {
    const { ctx } = setup({ up: sampleUpstream({ numbers: true, mlit: true }) });
    const result = await reverseGeocode(ctx, { lat: 43.0661, lon: 141.355, maxDistanceMeters: 100 });
    expect(result).toMatchObject({ found: true, level: 3, numberSource: null, normalized: '北海道札幌市中央区北１条西二丁目' });
  });

  test('ABR の点が範囲内にあれば、街区の点が近くても ABR を優先する。街区データが無ければ町字の答え', async () => {
    const { ctx } = setup({ up: sampleUpstream({ numbers: true, mlit: true }) });
    expect(await reverseGeocode(ctx, { lat: 43.0652, lon: 141.3541 })).toMatchObject({ level: 8, numberSource: 'chiban', normalized: '北海道札幌市中央区北１条西二丁目13' });
    const { ctx: plain } = setup({ up: sampleUpstream({ numbers: true }) });
    expect(await reverseGeocode(plain, { lat: 43.0652, lon: 141.3541, maxDistanceMeters: 100 })).toMatchObject({ level: 3, numberSource: null });
  });

  test('alternatives は次に近い住所を近い順に最大 3 件、重複なしで返す', async () => {
    const { ctx } = setup();
    const result = await reverseGeocode(ctx, { lat: 35.6759, lon: 139.7455, maxDistanceMeters: 1000 });
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives.length).toBeLessThanOrEqual(3);
    expect(result.alternatives[0]).toMatchObject({ normalized: '東京都千代田区永田町一丁目7-2', level: 8 });
    const distances = result.alternatives.map((alt) => alt.distanceMeters);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(new Set(result.alternatives.map((alt) => alt.normalized)).size).toBe(result.alternatives.length);
    expect(result.alternatives.every((alt) => alt.normalized !== result.normalized)).toBe(true);
  });

  test('住居表示でない町は地番の点を使う（numberSource: chiban）', async () => {
    const { ctx } = setup();
    const result = await reverseGeocode(ctx, { lat: 43.0640, lon: 141.3541 });
    expect(result).toMatchObject({
      found: true, level: 8, numberSource: 'chiban', normalized: '北海道札幌市中央区北１条西二丁目12-3',
      keys: { lgCode: SAPPORO_LG, machiazaId: '0013002', prc: ['12', '3'] },
    });
  });

  test('範囲内に番地・号の点が無ければ、最寄りの町字（level 3）を返す', async () => {
    const { ctx } = setup();
    const result = await reverseGeocode(ctx, { lat: 35.675895, lon: 139.746306, maxDistanceMeters: 50 });
    expect(result).toMatchObject({
      found: true, level: 3, numberSource: null, normalized: '東京都千代田区永田町一丁目', approximate: true,
      keys: { machiazaId: '0005001' }, postalCodes: [{ zipcode: '1000014' }],
    });
    expect(result.address?.addr).toBeUndefined();
    expect(result.distanceMeters).toBeLessThan(5);
  });

  test('日本国内でない座標と、近くに町字が無い座標は found: false（データには触れない／索引だけ使う）', async () => {
    const { ctx, inner } = setup();
    expect(await reverseGeocode(ctx, { lat: 51.5, lon: -0.12 })).toMatchObject({ found: false, level: 0, reason: expect.stringContaining('日本国内') });
    expect(inner.runs).toHaveLength(0);
    expect(await reverseGeocode(ctx, { lat: 40, lon: 135 })).toMatchObject({ found: false, level: 0, reason: expect.stringContaining('付近') });
  });

  test('座標と距離の検証', async () => {
    const { ctx } = setup();
    await expect(reverseGeocode(ctx, { lat: 91, lon: 139 })).rejects.toBeInstanceOf(AddressInputError);
    await expect(reverseGeocode(ctx, { lat: Number.NaN, lon: 139 })).rejects.toBeInstanceOf(AddressInputError);
    await expect(reverseGeocode(ctx, { lat: 35, lon: 181 })).rejects.toBeInstanceOf(AddressInputError);
    await expect(reverseGeocode(ctx, { lat: 35.6, lon: 139.7, maxDistanceMeters: 0 })).rejects.toBeInstanceOf(AddressInputError);
    await expect(reverseGeocode(ctx, { lat: 35.6, lon: 139.7, maxDistanceMeters: 2001 })).rejects.toBeInstanceOf(AddressInputError);
  });

  test('番地・号のデータが間に合わなければ、町字の答えに incomplete と pending を付ける。揃ったあとは level 8 になる', async () => {
    let gated!: GatedBuilder;
    const { ctx, data } = setup({ wrap: (inner) => (gated = new GatedBuilder(inner, (job) => job.kind === 'num')), waitMs: 400, concurrency: 2 });
    const partial = await reverseGeocode(ctx, { lat: 35.675915, lon: 139.745515 });
    expect(partial).toMatchObject({ found: true, level: 3, incomplete: true, pending: [`num:${CHIYODA_LG}`], normalized: '東京都千代田区永田町一丁目' });
    gated.release();
    await waitFor(() => data.peek(`num:${CHIYODA_LG}`) !== null);
    expect(await reverseGeocode(ctx, { lat: 35.675915, lon: 139.745515 })).toMatchObject({ level: 8, normalized: '東京都千代田区永田町一丁目7-1' });
  });

  test('番地・号のデータを取得できなければ、町字の答えに unavailable を付ける', async () => {
    const { ctx, up } = setup();
    up.set(abrUrl(`mt_rsdtdsp_rsdt/city/mt_rsdtdsp_rsdt_city${CHIYODA_LG}`), { body: '', status: 403 });
    const result = await reverseGeocode(ctx, { lat: 35.675915, lon: 139.745515 });
    expect(result).toMatchObject({ found: true, level: 3, incomplete: true });
    expect(result.unavailable).toEqual([{ artifact: `num:${CHIYODA_LG}`, message: expect.stringContaining('HTTP 403') }]);
  });

  test('町字の点の索引を取得できなければ AddressUnavailableError', async () => {
    const { ctx, up } = setup();
    up.set(abrUrl('mt_town_pos/pref/mt_town_pos_pref13'), { body: '', status: 403 });
    await expect(reverseGeocode(ctx, { lat: 35.6759, lon: 139.7455 })).rejects.toBeInstanceOf(AddressUnavailableError);
  });
});
