import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestAddressData, settleAddressData, waitFor } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, sampleUpstream } from '../test_fixtures/address/harness.js';
import { createAddressContext } from './address_context.js';
import { localGeocode } from './address_local_geocoder.js';
import { annotatePoiAddresses } from './address_poi.js';
import { createGeocoder } from './geocoding.js';
import { searchOpenPoi } from './poi.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-local-'));
});
afterEach(async () => {
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
});

const setup = (mode: 'lazy' | 'eager' = 'lazy') => {
  const built = createTestAddressData(dir, { mode, up: sampleUpstream({ numbers: true }) });
  return { ...built, ctx: createAddressContext(built.data) };
};

type Built = ReturnType<typeof setup>;

/** マスター・郵便番号・千代田区の段A・段B を先に取得済みにする。 */
async function warm({ data }: Built): Promise<void> {
  await data.ensure({ kind: 'master' });
  await data.ensure({ kind: 'postal' });
  await data.ensure({ kind: 'city', lgCode: CHIYODA_LG });
  await data.ensure({ kind: 'num', lgCode: CHIYODA_LG });
}

describe('localGeocode', () => {
  test('lazy: データが無ければ何も頼まず null を返す', async () => {
    const built = setup('lazy');
    expect(await localGeocode(built.ctx, '東京都千代田区永田町1-7-1')).toBeNull();
    expect(await localGeocode(built.ctx, '100-0014')).toBeNull();
    await built.data.idle();
    expect(built.up.requests).toEqual([]);
  });

  test('eager: データが無ければ待たずに null を返し、裏で取得を始める（番地・号まで揃ってから解決する）', async () => {
    const built = setup('eager');
    expect(await localGeocode(built.ctx, '東京都千代田区永田町1-7-1')).toBeNull();
    await waitFor(() => built.data.peek('master') !== null);
    // マスターが揃えば、次の呼び出しで市区町村の取得が始まる（その回は市区町村までの答え）。
    expect(await localGeocode(built.ctx, '東京都千代田区永田町1-7-1')).toBeNull();
    await waitFor(() => built.data.peek(`city:${CHIYODA_LG}`) !== null);
    // 町字までは分かるが、番地・号をまだ照合できない（段B が無い）ので、従来の経路に任せる。段B の取得は始める。
    expect(await localGeocode(built.ctx, '東京都千代田区永田町1-7-1')).toBeNull();
    await waitFor(() => built.data.peek(`num:${CHIYODA_LG}`) !== null);
    expect(await localGeocode(built.ctx, '東京都千代田区永田町1-7-1')).toMatchObject({ source: 'abr', needsVerification: false });
  });

  test('番地・号が入力にあるのに照合できない住所は、町字の代表点を返さず null（従来の経路へ）', async () => {
    const built = setup();
    await warm(built);
    // データに無い番地。町字までしか分からない。表記が違っても同じ
    for (const query of ['東京都千代田区永田町1-9-9', '東京都千代田区永田町一丁目９－９', '東京都千代田区永田町一丁目九番九号', '東京都千代田区永田町一丁目7番地']) {
      expect(await localGeocode(built.ctx, query)).toBeNull();
    }
  });

  test('番地・号のデータが無い市区町村でも、番地付きの住所は町字の代表点を返さず null', async () => {
    const built = createTestAddressData(join(dir, 'no-numbers'), { up: sampleUpstream() });
    const ctx = createAddressContext(built.data);
    await built.data.ensure({ kind: 'master' });
    await built.data.ensure({ kind: 'city', lgCode: CHIYODA_LG });
    expect(await localGeocode(ctx, '東京都千代田区永田町1-7-1')).toBeNull();
    // 番地の無い入力なら、同じデータで町字の代表点を返せる
    expect(await localGeocode(ctx, '東京都千代田区永田町一丁目')).toMatchObject({ source: 'abr' });
  });

  test('番地の無い町字までの住所は、町字の代表点で解決する（建物名は番地ではない）', async () => {
    const built = setup();
    await warm(built);
    expect(await localGeocode(built.ctx, '東京都千代田区永田町一丁目')).toMatchObject({ address: '東京都千代田区永田町一丁目', source: 'abr', needsVerification: false });
    expect(await localGeocode(built.ctx, '東京都千代田区永田町一丁目 ABCビル3F')).toMatchObject({ address: '東京都千代田区永田町一丁目', source: 'abr' });
    expect(await localGeocode(built.ctx, '東京都千代田区永田町一丁目 三井ビル')).toMatchObject({ source: 'abr' });
  });

  test('番地・号まで照合できた住所は、建物名が続いても番地の座標で解決する', async () => {
    const built = setup();
    await warm(built);
    expect(await localGeocode(built.ctx, '東京都千代田区永田町1-7-1 ABCビル3F')).toMatchObject({
      address: '東京都千代田区永田町一丁目7-1', lat: 35.675912, lon: 139.745512,
    });
  });

  test('取得済みの住所を、番地の座標で解決する', async () => {
    const built = setup();
    await warm(built);
    expect(await localGeocode(built.ctx, '東京都千代田区永田町1-7-1')).toEqual({
      address: '東京都千代田区永田町一丁目7-1', lat: 35.675912, lon: 139.745512, source: 'abr', needsVerification: false,
    });
  });

  test('取得済みの郵便番号を、町字の代表点で解決する', async () => {
    const built = setup();
    await warm(built);
    expect(await localGeocode(built.ctx, '〒100-0014')).toMatchObject({
      address: '東京都千代田区永田町', lat: 35.675008, lon: 139.744738, source: 'abr', needsVerification: false,
    });
  });

  test('地名・駅名・存在しない郵便番号は null（従来の経路へ）', async () => {
    const built = setup();
    await warm(built);
    for (const query of ['渋谷駅', '東京タワー', '原宿', '999-9999', '東京都千代田区', '']) {
      expect(await localGeocode(built.ctx, query)).toBeNull();
    }
  });

  test('off では null', async () => {
    const built = createTestAddressData(dir, { mode: 'off' });
    expect(await localGeocode(createAddressContext(built.data), '東京都千代田区永田町1-7-1')).toBeNull();
  });
});

describe('createGeocoder（ローカル優先）', () => {
  const failingFetch = async (): Promise<Response> => {
    throw new Error('外部に問い合わせてはいけない');
  };

  test('ローカルで解決できれば外部へ問い合わせず、待ちも入らない', async () => {
    const sleeps: number[] = [];
    const geocode = createGeocoder({
      fetchFn: failingFetch, sleep: async (ms) => { sleeps.push(ms); },
      local: async () => ({ address: 'x', lat: 35, lon: 139, source: 'abr', needsVerification: false }),
    });
    expect(await geocode('東京都千代田区永田町1-7-1')).toMatchObject({ source: 'abr' });
    expect(await geocode('東京都千代田区永田町1-7-2')).toMatchObject({ source: 'abr' });
    expect(sleeps).toEqual([]);
  });

  test('ローカルで解決しなければ従来どおり Nominatim へ進む', async () => {
    const urls: string[] = [];
    const geocode = createGeocoder({
      local: async () => null,
      fetchFn: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify([{ display_name: '渋谷駅', lat: '35.658', lon: '139.7016' }]), { status: 200 });
      },
    });
    expect(await geocode('渋谷駅-local-test', { noCache: true })).toMatchObject({ source: 'nominatim' });
    expect(urls.length).toBe(1);
  });
});

describe('annotatePoiAddresses / search_poi withAddress', () => {
  test('施設の住所を正規化し、座標と突き合わせる', async () => {
    const built = setup();
    await warm(built);
    const [near, far, noAddress] = await annotatePoiAddresses(built.ctx, [
      { address: '東京都千代田区永田町1-7-1', lat: 35.675912, lng: 139.745512 },
      { address: '東京都千代田区永田町1-7-1', lat: 35.0, lng: 139.0 },
      { lat: 35.0, lng: 139.0 },
    ]);
    expect(near).toMatchObject({ level: 8, numberSource: 'rsdt', check: { status: 'match' }, postalCodes: [{ zipcode: '1000014' }] });
    expect(far?.check.status).not.toBe('match');
    expect(noAddress).toBeNull();
  });

  test('withAddress を指定しなければ addressInfo を付けず、住所モジュールを呼ばない', async () => {
    let called = false;
    const fetchFn = async () => new Response(JSON.stringify({ count: 1, results: [{ name: 'A', address: '東京都千代田区永田町1-7-1', lat: 35.675912, lng: 139.745512 }] }), { status: 200 });
    const annotate = async () => { called = true; return []; };
    const result = await searchOpenPoi({ query: 'a', limit: 1 }, fetchFn as never, 1000, undefined, annotate);
    expect(called).toBe(false);
    expect(result.pois[0]?.addressInfo).toBeUndefined();
  });

  test('withAddress を指定すると addressInfo を付け、失敗しても検索結果は返す', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ count: 2, results: [{ name: 'A', address: 'a', lat: 1, lng: 2 }, { name: 'B', lat: 1, lng: 2 }] }), { status: 200 });
    const info = { normalized: 'n', level: 3, numberSource: null, keys: {}, postalCodes: [], check: { status: 'match' as const } };
    const withInfo = await searchOpenPoi({ query: 'a', limit: 2, withAddress: true }, fetchFn as never, 1000, undefined, async () => [info, null]);
    expect(withInfo.pois[0]?.addressInfo).toEqual(info);
    expect(withInfo.pois[1]?.addressInfo).toBeUndefined();
    const failed = await searchOpenPoi({ query: 'a', limit: 2, withAddress: true }, fetchFn as never, 1000, undefined, async () => { throw new Error('boom'); });
    expect(failed.count).toBe(2);
    expect(failed.pois[0]?.addressInfo).toBeUndefined();
  });
});
