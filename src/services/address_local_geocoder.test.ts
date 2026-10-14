import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatedBuilder, createTestAddressData, settleAddressData, waitFor } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, SAPPORO_LG, sampleUpstream } from '../test_fixtures/address/harness.js';
import { createAddressContext } from './address_context.js';
import { ADDRESS_ATTRIBUTION, PARCEL_ATTRIBUTION, addressAttribution } from './address_attribution.js';
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

  test('地番で照合した住所には法務省の出典を添え、住居表示や郵便番号の結果には添えない', async () => {
    const built = setup();
    await warm(built);
    await built.data.ensure({ kind: 'city', lgCode: SAPPORO_LG });
    await built.data.ensure({ kind: 'num', lgCode: SAPPORO_LG });
    const parcel = await localGeocode(built.ctx, '札幌市中央区北1条西2丁目12-3');
    expect(parcel).toMatchObject({ source: 'abr', attribution: addressAttribution(true) });
    expect(parcel?.attribution).toContain(PARCEL_ATTRIBUTION);
    const rsdt = await localGeocode(built.ctx, '東京都千代田区永田町1-7-1');
    expect(rsdt).toMatchObject({ source: 'abr' });
    expect(rsdt?.attribution).toBeUndefined();
    expect((await localGeocode(built.ctx, '〒100-0014'))?.attribution).toBeUndefined();
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

describe('annotatePoiAddresses', () => {
  test('施設の住所を正規化し、座標と突き合わせる', async () => {
    const built = setup();
    await warm(built);
    const { results, gaps } = await annotatePoiAddresses(built.ctx, [
      { address: '東京都千代田区永田町1-7-1', lat: 35.675912, lng: 139.745512 },
      { address: '東京都千代田区永田町1-7-1', lat: 35.0, lng: 139.0 },
      { lat: 35.0, lng: 139.0 },
    ]);
    expect(results[0]?.info).toMatchObject({ level: 8, numberSource: 'rsdt', check: { status: 'match' }, postalCodes: [{ zipcode: '1000014' }] });
    expect(results[1]?.info?.check.status).not.toBe('match');
    expect(results[2]).toEqual({ info: null });
    expect(results.some((result) => result.incomplete)).toBe(false);
    expect(gaps).toEqual({});
  });

  test('解釈できない住所は info なしで、データ待ちの印は付けない', async () => {
    const built = setup();
    await warm(built);
    const { results, gaps } = await annotatePoiAddresses(built.ctx, [{ address: 'こんにちは', lat: 35, lng: 139 }]);
    expect(results).toEqual([{ info: null }]);
    expect(gaps).toEqual({});
  });

  test('市区町村のデータが間に合わなかった施設には incomplete を付け、pending を集める。揃えば完全に答える', async () => {
    let gated!: GatedBuilder;
    const built = createTestAddressData(dir, {
      up: sampleUpstream({ numbers: true }),
      wrap: (inner) => (gated = new GatedBuilder(inner, (job) => job.kind === 'city')),
      waitMs: 300, concurrency: 2,
    });
    const ctx = createAddressContext(built.data);
    const pois = [
      { address: '東京都千代田区永田町1-7-1', lat: 35.675912, lng: 139.745512 },
      { address: 'こんにちは', lat: 35, lng: 139 },
      { lat: 35, lng: 139 },
    ];
    const partial = await annotatePoiAddresses(ctx, pois);
    expect(partial.results[0]?.incomplete).toBe(true);
    // 時間切れと、解釈できない・住所が無い施設は区別される
    expect(partial.results[1]).toEqual({ info: null });
    expect(partial.results[2]).toEqual({ info: null });
    expect(partial.gaps).toMatchObject({ incomplete: true, pending: expect.arrayContaining([`city:${CHIYODA_LG}`]) });

    gated.release();
    await built.data.idle();
    const complete = await annotatePoiAddresses(ctx, pois);
    expect(complete.results[0]).toMatchObject({ info: { level: 8, numberSource: 'rsdt' } });
    expect(complete.results[0]?.incomplete).toBeUndefined();
    expect(complete.gaps).toEqual({});
  });

  test('待ち時間は全体で共有する。使い切ったあとの施設も、黙って落とさず incomplete を付ける', async () => {
    const built = createTestAddressData(dir, {
      up: sampleUpstream({ numbers: true }),
      wrap: (inner) => new GatedBuilder(inner, (job) => job.kind === 'master'),
      waitMs: 200,
    });
    const ctx = createAddressContext(built.data);
    const started = Date.now();
    const { results, gaps } = await annotatePoiAddresses(ctx, [
      { address: '東京都千代田区永田町1-7-1', lat: 35.675912, lng: 139.745512 },
      { address: '東京都千代田区永田町1-7-2', lat: 35.675912, lng: 139.745512 },
      { address: '東京都千代田区永田町1-7-3', lat: 35.675912, lng: 139.745512 },
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(results).toEqual([{ info: null, incomplete: true }, { info: null, incomplete: true }, { info: null, incomplete: true }]);
    expect(gaps).toMatchObject({ incomplete: true, pending: ['master'] });
  });

  test('住所機能が無効なら、unavailable に理由を入れる（施設ごとの印は付けない）', async () => {
    const built = createTestAddressData(dir, { mode: 'off' });
    const { results, gaps } = await annotatePoiAddresses(createAddressContext(built.data), [{ address: '東京都千代田区永田町1-7-1', lat: 35.675912, lng: 139.745512 }]);
    expect(results).toEqual([{ info: null }]);
    expect(gaps).toMatchObject({ incomplete: true, unavailable: [{ artifact: 'address', message: expect.stringContaining('SORA_ADDRESS=off') }] });
  });
});

describe('search_poi withAddress', () => {
  const poiFetch = (results: unknown[]) => (async () => new Response(JSON.stringify({ count: results.length, results }), { status: 200 })) as never;
  const two = [{ name: 'A', address: 'a', lat: 1, lng: 2 }, { name: 'B', lat: 1, lng: 2 }];
  const info = { normalized: 'n', level: 8, numberSource: 'rsdt' as const, keys: {}, postalCodes: [], check: { status: 'match' as const } };

  test('withAddress を指定しなければ addressInfo も出典も付けず、住所モジュールを呼ばない', async () => {
    let called = false;
    const annotate = async () => { called = true; return { results: [], gaps: {} }; };
    const result = await searchOpenPoi({ query: 'a', limit: 1 }, poiFetch([{ name: 'A', address: '東京都千代田区永田町1-7-1', lat: 35.675912, lng: 139.745512 }]), 1000, undefined, annotate);
    expect(called).toBe(false);
    expect(result.pois[0]?.addressInfo).toBeUndefined();
    expect(result.addressAttribution).toBeUndefined();
    expect(result.addressIncomplete).toBeUndefined();
  });

  test('withAddress を指定すると addressInfo を付ける', async () => {
    const result = await searchOpenPoi({ query: 'a', limit: 2, withAddress: true }, poiFetch(two), 1000, undefined, async () => ({ results: [{ info }, { info: null }], gaps: {} }));
    expect(result.pois[0]?.addressInfo).toEqual(info);
    expect(result.pois[1]?.addressInfo).toBeUndefined();
    expect(result.pois[1]?.addressIncomplete).toBeUndefined();
    expect(result.addressIncomplete).toBeUndefined();
  });

  test('addressInfo を付けた結果には住所データの出典を addressAttribution として添える（地番を使えば法務省の出典も）', async () => {
    const run = (infos: Array<typeof info | null>) =>
      searchOpenPoi({ query: 'a', limit: 2, withAddress: true }, poiFetch(two), 1000, undefined, async () => ({ results: infos.map((one) => ({ info: one })), gaps: {} }));
    expect((await run([info, null])).addressAttribution).toBe(ADDRESS_ATTRIBUTION);
    const parcel = await run([info, { ...info, numberSource: 'chiban' as never }]);
    expect(parcel.addressAttribution).toBe(addressAttribution(true));
    expect(parcel.addressAttribution).toContain(PARCEL_ATTRIBUTION);
    // 何も付かなければ、出典も付けない
    expect((await run([null, null])).addressAttribution).toBeUndefined();
  });

  test('データが間に合わなかった施設に addressIncomplete を付け、全体の incomplete / pending / unavailable を返す', async () => {
    const gaps = { incomplete: true as const, pending: [`city:${CHIYODA_LG}`], unavailable: [{ artifact: `num:${CHIYODA_LG}`, message: '取得に失敗' }] };
    const result = await searchOpenPoi({ query: 'a', limit: 2, withAddress: true }, poiFetch(two), 1000, undefined, async () => ({
      results: [{ info: null, incomplete: true }, { info: null }], gaps,
    }));
    expect(result.pois[0]?.addressIncomplete).toBe(true);
    expect(result.pois[1]?.addressIncomplete).toBeUndefined();
    expect(result).toMatchObject({ addressIncomplete: true, addressPending: gaps.pending, addressUnavailable: gaps.unavailable });
  });

  test('住所の付与に失敗しても検索結果は返し、unavailable に理由を入れる', async () => {
    const failed = await searchOpenPoi({ query: 'a', limit: 2, withAddress: true }, poiFetch(two), 1000, undefined, async () => { throw new Error('boom'); });
    expect(failed.count).toBe(2);
    expect(failed.pois[0]?.addressInfo).toBeUndefined();
    expect(failed).toMatchObject({ addressIncomplete: true, addressUnavailable: [{ artifact: 'address', message: 'boom' }] });
  });
});
