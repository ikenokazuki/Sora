import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ABR_LAST_MODIFIED, CHIYODA_LG, SAPPORO_LG, SMALL_MINIMUM, abrUrl, sampleUpstream, type FakeUpstream,
} from '../test_fixtures/address/harness.js';
import { JAPANPOST_FALLBACK } from './address_http.js';
import { runBuildJob, type JobDeps } from './address_jobs.js';
import { AddressStore } from './address_store.js';
import { PostalReader } from './postal_code.js';

let dir: string;
let store: AddressStore;
let up: FakeUpstream;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-jobs-'));
  store = new AddressStore(dir);
  up = sampleUpstream();
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
