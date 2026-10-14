import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ABR_LAST_MODIFIED, CHIYODA_LG, SAPPORO_LG, SMALL_MINIMUM, abrUrl, sampleUpstream, type FakeUpstream,
} from '../test_fixtures/address/harness.js';
import { GeoIndexReader } from './address_geo_index.js';
import { JAPANPOST_FALLBACK } from './address_http.js';
import { mlitCityUrl } from './address_mlit.js';
import { runBuildJob, type JobDeps } from './address_jobs.js';
import { AddressStore } from './address_store.js';
import { PostalReader } from './postal_code.js';

let dir: string;
let store: AddressStore;
let up: FakeUpstream;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-jobs-'));
  store = new AddressStore(dir);
  up = sampleUpstream({ numbers: true, mlit: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = (): JobDeps => ({ store, http: { fetchFn: up.fetchFn, sleep: async () => undefined }, minimum: SMALL_MINIMUM, nowSeconds: () => 1_700_000_000 });
const readJson = (id: string, file: string): any => JSON.parse(readFileSync(join(store.current(id)!.path, file), 'utf8'));

describe('master', () => {
  test('全国マスターから ja.json を作って公開する', async () => {
    await runBuildJob({ kind: 'master' }, deps());
    const ja = readJson('master', 'ja.json');
    expect(ja.meta.updated).toBe(1_700_000_000);
    expect(ja.data.map((p: any) => p.pref)).toEqual(['北海道', '東京都']);
    expect(ja.data[0].cities.map((c: any) => `${c.city}${c.ward ?? ''}`)).toEqual(['札幌市中央区']);
    expect(store.current('master')?.meta.sourceDate).toBe('2026-10-02');
  });

  test('取得元が変わっていなければダウンロードせず、確認日時だけ進める', async () => {
    await runBuildJob({ kind: 'master' }, deps());
    const seq = store.read().seq;
    await runBuildJob({ kind: 'master' }, deps());
    expect(up.count('GET', 'mt_pref/mt_pref_all')).toBe(1);
    expect(up.count('HEAD', 'mt_pref/mt_pref_all')).toBe(2);
    expect(store.read().seq).toBe(seq);
  });

  test('想定より小さい結果は公開せず、旧版を維持して失敗を記録する', async () => {
    await runBuildJob({ kind: 'master' }, deps());
    const before = store.current('master')!.meta;
    up.setZip(abrUrl('mt_pref/mt_pref_all'), { 'mt_pref_all.csv': 'lg_code,pref,pref_kana,pref_roma\r\n130001,東京都,トウキョウト,Tokyo\r\n' }, { etag: '"changed"', lastModified: ABR_LAST_MODIFIED });
    await expect(runBuildJob({ kind: 'master' }, deps())).rejects.toThrow('想定より小さい');
    expect(store.current('master')?.meta.ver).toBe(before.ver);
    expect(store.read().artifacts.master?.error).toContain('想定より小さい');
  });

  test('国外からの接続拒否（403）は失敗として記録する', async () => {
    up.set(abrUrl('mt_city/mt_city_all'), { body: '', status: 403 });
    await expect(runBuildJob({ kind: 'master' }, deps())).rejects.toThrow('HTTP 403');
    expect(store.read().failures.master?.message).toContain('HTTP 403');
    expect(store.current('master')).toBeNull();
  });
});

describe('city', () => {
  test('町字と位置参照から town.json を作る', async () => {
    await runBuildJob({ kind: 'city', lgCode: CHIYODA_LG }, deps());
    const town = readJson(`city:${CHIYODA_LG}`, 'town.json');
    expect(town.data.map((t: any) => [t.machiaza_id, t.oaza_cho, t.chome ?? null])).toEqual([
      ['0006000', '千代田', null], ['0005001', '永田町', '一丁目'], ['0005002', '永田町', '二丁目'],
    ]);
    expect(town.data[1]).toMatchObject({ chome_n: 1, rsdt: true, point: [139.746306, 35.675895] });
  });

  test('位置参照が無い市区町村でも、座標なしで作る', async () => {
    up.routes.delete(abrUrl(`mt_town_pos/city/mt_town_pos_city${SAPPORO_LG}`));
    await runBuildJob({ kind: 'city', lgCode: SAPPORO_LG }, deps());
    const town = readJson(`city:${SAPPORO_LG}`, 'town.json');
    expect(town.data).toHaveLength(5);
    expect(town.data.every((t: any) => t.point === undefined)).toBe(true);
  });

  test('ABR に無い市区町村と不正なコードは失敗として記録する', async () => {
    await expect(runBuildJob({ kind: 'city', lgCode: '999999' }, deps())).rejects.toThrow('999999');
    expect(store.read().failures['city:999999']?.message).toContain('999999');
    await expect(runBuildJob({ kind: 'city', lgCode: 'abc' }, deps())).rejects.toThrow('不正');
  });

  test('取得元が変わっていなければ再構築しない', async () => {
    await runBuildJob({ kind: 'city', lgCode: CHIYODA_LG }, deps());
    const seq = store.read().seq;
    await runBuildJob({ kind: 'city', lgCode: CHIYODA_LG }, deps());
    expect(store.read().seq).toBe(seq);
    expect(up.count('GET', `mt_town_city${CHIYODA_LG}`)).toBe(1);
  });
});

describe('postal', () => {
  test('一般と事業所の郵便番号を postal.sqlite にまとめる', async () => {
    await runBuildJob({ kind: 'postal' }, deps());
    const reader = new PostalReader(join(store.current('postal')!.path, 'postal.sqlite'));
    try {
      expect(reader.byZip('1000001')).toHaveLength(1);
      expect(reader.byZip('0608621')[0]).toMatchObject({ kind: 'office', city: '札幌市中央区' });
      expect(reader.byZip('1008799')[0]).toMatchObject({ kind: 'po_box' });
      expect(reader.byLg5('01101')).toHaveLength(5);
    } finally {
      reader.close();
    }
    expect(store.current('postal')?.meta.sourceDate).toBe('2026-09-30');
  });

  test('サンプルの郵便番号 1000001 が無いデータは公開しない', async () => {
    const line = (zip: string, town: string) => `13101,"100  ","${zip}","カナ","カナ","カナ","東京都","千代田区","${town}",0,0,0,0,0,0\r\n`;
    up.setZip(
      JAPANPOST_FALLBACK.kenAll,
      { 'utf_ken_all.csv': line('1000014', '永田町') + line('1000000', '以下に掲載がない場合') + line('1000002', '皇居外苑') },
      { lastModified: 'Wed, 30 Sep 2026 07:46:52 GMT', etag: '"x"' },
    );
    await expect(runBuildJob({ kind: 'postal' }, deps())).rejects.toThrow('1000001');
    expect(store.current('postal')).toBeNull();
  });
});

describe('index', () => {
  const readerOf = () => new GeoIndexReader(join(store.current('index')!.path, 'geo.sqlite'));

  test('全国マスターの都道府県ごとに町字の位置参照を取得して、近傍検索の索引を公開する', async () => {
    await runBuildJob({ kind: 'index' }, deps());
    expect(store.current('master')).not.toBeNull();
    expect(up.count('GET', 'mt_town_pos/pref')).toBe(2);
    const reader = readerOf();
    try {
      const near = reader.nearest(35.6759, 139.7463, 5, 1000);
      expect(near.map((town) => [town.lgCode, town.machiazaId, town.rsdt])).toEqual([[CHIYODA_LG, '0005001', true], [CHIYODA_LG, '0005002', true]]);
      expect(reader.nearest(43.063, 141.3544, 1, 500)[0]).toMatchObject({ lgCode: SAPPORO_LG, machiazaId: '0013001', rsdt: false });
    } finally {
      reader.close();
    }
    expect(store.current('index')?.meta.sourceDate).toBe('2026-10-02');
  });

  test('取得元が変わっていなければダウンロードせず、確認日時だけ進める', async () => {
    await runBuildJob({ kind: 'index' }, deps());
    const seq = store.read().seq;
    await runBuildJob({ kind: 'index' }, deps());
    expect(store.read().seq).toBe(seq);
    expect(up.count('GET', 'mt_town_pos/pref')).toBe(2);
  });

  test('想定より少ない点しか無ければ公開しない', async () => {
    await expect(runBuildJob({ kind: 'index' }, { ...deps(), minimum: { ...SMALL_MINIMUM, points: 1000 } })).rejects.toThrow('想定より小さい');
    expect(store.current('index')).toBeNull();
    expect(store.read().failures.index?.message).toContain('想定より小さい');
  });

  test('都道府県の位置参照が見つからない・国外 IP の拒否（403）は失敗として記録する', async () => {
    up.routes.delete(abrUrl('mt_town_pos/pref/mt_town_pos_pref01'));
    await expect(runBuildJob({ kind: 'index' }, deps())).rejects.toThrow('01');
    up.set(abrUrl('mt_town_pos/pref/mt_town_pos_pref13'), { body: '', status: 403 });
    await expect(runBuildJob({ kind: 'index' }, deps())).rejects.toThrow('HTTP 403');
  });
});

describe('mlit', () => {
  test('街区レベル位置参照から、町ごとの街区符号の点の索引を公開する（更新前の履歴の行と代表でない行は使わない）', async () => {
    await runBuildJob({ kind: 'mlit', lgCode: CHIYODA_LG }, deps());
    const index = readJson(`mlit:${CHIYODA_LG}`, 'index.json');
    expect(index.towns['永田町1']).toEqual({ '7': [139.745512, 35.675912], '9': [139.7461, 35.674] });
    expect(index.towns['永田町2']).toEqual({ '5': [139.742, 35.6735] });
    expect(store.current(`mlit:${CHIYODA_LG}`)?.meta.sourceDate).toBe('2026-07-07');
    // 新しい版（25.0a）がまだ無いので、24.0a を使う
    expect(up.requests.some((r) => r.url.includes('/25.0a/'))).toBe(true);
  });

  test('取得元が変わっていなければダウンロードせず、確認日時だけ進める', async () => {
    await runBuildJob({ kind: 'mlit', lgCode: CHIYODA_LG }, deps());
    const seq = store.read().seq;
    const downloads = up.count('GET');
    await runBuildJob({ kind: 'mlit', lgCode: CHIYODA_LG }, deps());
    expect(store.read().seq).toBe(seq);
    expect(up.count('GET')).toBe(downloads);
  });

  test('街区レベルのデータが無い市区町村は、空の索引だけを公開する（毎回調べ直さない）', async () => {
    await runBuildJob({ kind: 'mlit', lgCode: '011002' }, deps());
    expect(readJson('mlit:011002', 'index.json')).toEqual({ towns: {} });
    expect(store.current('mlit:011002')?.meta.sig).toBe('none');
    const seq = store.read().seq;
    await runBuildJob({ kind: 'mlit', lgCode: '011002' }, deps());
    expect(store.read().seq).toBe(seq);
  });

  test('国外 IP の拒否（403）と不正なコードは失敗として記録する', async () => {
    up.set(mlitCityUrl(CHIYODA_LG, '25.0a'), { status: 403, body: '' });
    await expect(runBuildJob({ kind: 'mlit', lgCode: CHIYODA_LG }, deps())).rejects.toThrow();
    expect(store.read().failures[`mlit:${CHIYODA_LG}`]).toBeDefined();
    await expect(runBuildJob({ kind: 'mlit', lgCode: '13' }, deps())).rejects.toThrow();
  });
});

describe('num', () => {
  const rangesOf = (id: string): Record<string, { 住居表示?: { start: number; length: number }; 地番?: { start: number; length: number } }> =>
    JSON.parse(readFileSync(join(store.current(id)!.path, 'ranges.json'), 'utf8'));
  const sectionOf = (id: string, file: string, range: { start: number; length: number }): string =>
    readFileSync(join(store.current(id)!.path, file)).subarray(range.start, range.start + range.length).toString('utf8');

  test('住居表示の市区町村: 段A を先に作り、rsdt.txt と ranges.json を公開する。地番は取得しない', async () => {
    await runBuildJob({ kind: 'num', lgCode: CHIYODA_LG }, deps());
    const id = `num:${CHIYODA_LG}`;
    const ranges = rangesOf(id);
    expect(Object.keys(ranges).sort()).toEqual(['0005001', '0005002', '0006000']);
    expect(sectionOf(id, 'rsdt.txt', ranges['0005001']!.住居表示!)).toContain('7,1,,139.745512,35.675912\n');
    expect(existsSync(join(store.current(id)!.path, 'chiban.txt'))).toBe(false);
    expect(store.current(`city:${CHIYODA_LG}`)).not.toBeNull();
    expect(up.count('GET', 'mt_rsdtdsp_rsdt/city')).toBe(1);
    expect(up.count('GET', 'mt_rsdtdsp_rsdt_pos/city')).toBe(1);
    expect(up.count('GET', 'mt_parcel')).toBe(0);
    expect(store.current(id)?.meta.sourceDate).toBe('2026-10-02');
  });

  test('地番の市区町村: chiban.txt を公開する。住居表示は取得しない', async () => {
    await runBuildJob({ kind: 'num', lgCode: SAPPORO_LG }, deps());
    const id = `num:${SAPPORO_LG}`;
    const ranges = rangesOf(id);
    expect(sectionOf(id, 'chiban.txt', ranges['0013002']!.地番!)).toContain('12,3,,141.354100,43.064000\n12,4,,,\n');
    expect(existsSync(join(store.current(id)!.path, 'rsdt.txt'))).toBe(false);
    expect(up.count('GET', 'mt_rsdtdsp')).toBe(0);
    expect(up.count('GET', 'mt_parcel/city')).toBe(1);
  });

  test('取得元が変わっていなければダウンロードせず、確認日時だけ進める', async () => {
    await runBuildJob({ kind: 'num', lgCode: SAPPORO_LG }, deps());
    const seq = store.read().seq;
    await runBuildJob({ kind: 'num', lgCode: SAPPORO_LG }, deps());
    expect(store.read().seq).toBe(seq);
    expect(up.count('GET', 'mt_parcel/city')).toBe(1);
    expect(up.count('HEAD', 'mt_parcel/city')).toBe(2);
  });

  test('取得元が変わったら作り直し、旧版を維持して失敗を記録する経路も働く', async () => {
    await runBuildJob({ kind: 'num', lgCode: SAPPORO_LG }, deps());
    const before = store.current(`num:${SAPPORO_LG}`)!.meta.ver;
    const url = abrUrl(`mt_parcel/city/mt_parcel_city${SAPPORO_LG}`);
    up.set(url, { ...up.routes.get(url)!, etag: '"changed"' });
    await runBuildJob({ kind: 'num', lgCode: SAPPORO_LG }, deps());
    expect(store.current(`num:${SAPPORO_LG}`)!.meta.ver).not.toBe(before);

    up.setZip(url, { 'broken.csv': 'lg_code,machiaza_id\r\n1,2\r\n' }, { etag: '"broken"', lastModified: ABR_LAST_MODIFIED });
    const good = store.current(`num:${SAPPORO_LG}`)!.meta.ver;
    await expect(runBuildJob({ kind: 'num', lgCode: SAPPORO_LG }, deps())).rejects.toThrow('prc_id');
    expect(store.current(`num:${SAPPORO_LG}`)!.meta.ver).toBe(good);
    expect(store.read().artifacts[`num:${SAPPORO_LG}`]?.error).toContain('prc_id');
  });

  test('住居表示も地番も無い市区町村は、空の ranges.json だけを公開し、2 回目は確認だけ', async () => {
    for (const path of ['mt_parcel/city/mt_parcel_city', 'mt_parcel_pos/city/mt_parcel_pos_city']) up.routes.delete(abrUrl(`${path}${SAPPORO_LG}`));
    await runBuildJob({ kind: 'num', lgCode: SAPPORO_LG }, deps());
    const id = `num:${SAPPORO_LG}`;
    expect(rangesOf(id)).toEqual({});
    expect(readdirSync(store.current(id)!.path).sort()).toEqual(['ranges.json']);
    const seq = store.read().seq;
    await runBuildJob({ kind: 'num', lgCode: SAPPORO_LG }, deps());
    expect(store.read().seq).toBe(seq);
  });

  test('国外 IP の拒否（403）と不正なコードは失敗として記録する', async () => {
    up.set(abrUrl(`mt_parcel/city/mt_parcel_city${SAPPORO_LG}`), { body: '', status: 403 });
    await expect(runBuildJob({ kind: 'num', lgCode: SAPPORO_LG }, deps())).rejects.toThrow('HTTP 403');
    expect(store.read().failures[`num:${SAPPORO_LG}`]?.message).toContain('HTTP 403');
    await expect(runBuildJob({ kind: 'num', lgCode: 'abc' }, deps())).rejects.toThrow('不正');
  });
});
