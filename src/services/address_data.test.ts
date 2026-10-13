import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatedBuilder, createTestAddressData, settleAddressData, tick, waitFor } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, SAPPORO_LG, abrUrl, sampleUpstream } from '../test_fixtures/address/harness.js';
import { AddressDisabledError, AddressPendingError, AddressUnavailableError } from './address_errors.js';
import { JAPANPOST_FALLBACK } from './address_http.js';
import { runBuildJob } from './address_jobs.js';
import { AddressStore, type BuildJob } from './address_store.js';
import { SMALL_MINIMUM } from '../test_fixtures/address/harness.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-data-'));
});
afterEach(async () => {
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
});

const chiyoda: BuildJob = { kind: 'city', lgCode: CHIYODA_LG };
const sapporo: BuildJob = { kind: 'city', lgCode: SAPPORO_LG };
const DAY = 86_400_000;

describe('ensure', () => {
  test('同じ市区町村への同時の ensure は構築 1 回にまとまる', async () => {
    const { data, up, inner } = createTestAddressData(dir);
    const results = await Promise.all([data.ensure(chiyoda), data.ensure(chiyoda), data.ensure(chiyoda)]);
    expect(results.every((ready) => ready.id === `city:${CHIYODA_LG}`)).toBe(true);
    expect(inner.runs).toHaveLength(1);
    expect(up.count('GET', 'mt_town/city')).toBe(1);
  });

  test('成果物がすでにあれば構築役を呼ばない', async () => {
    const { data, inner } = createTestAddressData(dir);
    await data.ensure(chiyoda);
    const ready = await data.ensure(chiyoda);
    expect(ready.meta.bytes).toBeGreaterThan(0);
    expect(inner.runs).toHaveLength(1);
  });

  test('待ち時間までに終わらなければ AddressPendingError を投げ、構築は続く', async () => {
    let gated!: GatedBuilder;
    const { data } = createTestAddressData(dir, { wrap: (inner) => (gated = new GatedBuilder(inner)) });
    const error = await data.ensure(chiyoda, 20).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressPendingError);
    expect((error as AddressPendingError).pending).toBe(`city:${CHIYODA_LG}`);
    expect(data.peek(`city:${CHIYODA_LG}`)).toBeNull();
    gated.release();
    await waitFor(() => data.peek(`city:${CHIYODA_LG}`) !== null);
    expect(data.peek(`city:${CHIYODA_LG}`)?.meta.bytes).toBeGreaterThan(0);
  });

  test('構築の失敗は AddressUnavailableError。冷却中は構築役を呼ばず、冷却が明けたらやり直す', async () => {
    let t = Date.parse('2026-10-13T00:00:00Z');
    const { data, up, inner } = createTestAddressData(dir, { now: () => t });
    const url = abrUrl(`mt_town/city/mt_town_city${CHIYODA_LG}`);
    const original = up.routes.get(url)!;
    up.set(url, { body: '', status: 403 });

    const error = await data.ensure(chiyoda).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressUnavailableError);
    expect(error).toMatchObject({ blocked: true, artifact: `city:${CHIYODA_LG}` });
    expect(inner.runs).toHaveLength(1);

    t += 30_000;
    await expect(data.ensure(chiyoda)).rejects.toMatchObject({ name: 'AddressUnavailableError', blocked: true });
    expect(inner.runs).toHaveLength(1);

    t += 11 * 60_000;
    up.set(url, original);
    const ready = await data.ensure(chiyoda);
    expect(ready.meta.bytes).toBeGreaterThan(0);
    expect(inner.runs).toHaveLength(2);
  });

  test('SORA_ADDRESS=off では AddressDisabledError で、何も構築しない', async () => {
    const { data, inner } = createTestAddressData(dir, { mode: 'off' });
    expect(data.enabled).toBe(false);
    await expect(data.ensure(chiyoda)).rejects.toBeInstanceOf(AddressDisabledError);
    await data.request(chiyoda);
    expect(inner.runs).toHaveLength(0);
  });
});

describe('queue', () => {
  test.each([[1, 1], [2, 2]])('同時実行数 %i なら、同時に走るのは最大 %i 件', async (concurrency, expected) => {
    let gated!: GatedBuilder;
    const { data } = createTestAddressData(dir, { concurrency, wrap: (inner) => (gated = new GatedBuilder(inner)) });
    void data.request(chiyoda).catch(() => undefined);
    void data.request(sapporo).catch(() => undefined);
    await tick();
    expect(gated.started).toHaveLength(expected);
    gated.release();
    await waitFor(() => data.peek(`city:${CHIYODA_LG}`) !== null && data.peek(`city:${SAPPORO_LG}`) !== null);
    expect(gated.maxActive).toBe(expected);
  });
});

describe('idle', () => {
  test('待機中・実行中のジョブがすべて終わるまで待つ', async () => {
    let gated!: GatedBuilder;
    const { data } = createTestAddressData(dir, { wrap: (inner) => (gated = new GatedBuilder(inner)) });
    void data.request(chiyoda).catch(() => undefined);
    let done = false;
    const idle = data.idle().then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    gated.release();
    await idle;
    expect(data.peek(`city:${CHIYODA_LG}`)).not.toBeNull();
  });
});

describe('priority', () => {
  test('待機中のジョブは、全国マスター → 郵便番号 → 索引 → 市区町村（段A）→ 番地・号（段B）の順で始める（同じ種類は頼んだ順）', async () => {
    let gated!: GatedBuilder;
    const { data } = createTestAddressData(dir, { wrap: (inner) => (gated = new GatedBuilder(inner, (job) => job.kind === 'city' && job.lgCode === CHIYODA_LG)) });
    void data.request(chiyoda).catch(() => undefined);
    await tick();
    void data.request({ kind: 'num', lgCode: SAPPORO_LG }).catch(() => undefined);
    void data.request({ kind: 'city', lgCode: '011002' }).catch(() => undefined);
    void data.request(sapporo).catch(() => undefined);
    void data.request({ kind: 'index' }).catch(() => undefined);
    void data.request({ kind: 'postal' }).catch(() => undefined);
    void data.request({ kind: 'master' }).catch(() => undefined);
    gated.release();
    await data.idle();
    expect(gated.started.map((job) => (job.kind === 'city' || job.kind === 'num' ? `${job.kind}:${job.lgCode}` : job.kind))).toEqual([
      `city:${CHIYODA_LG}`, 'master', 'postal', 'index', 'city:011002', `city:${SAPPORO_LG}`, `num:${SAPPORO_LG}`,
    ]);
  });
});

describe('revalidate', () => {
  test('期限を過ぎた成果物は即座に返し、裏で再確認して確認日時だけを進める', async () => {
    let t = Date.parse('2026-10-13T00:00:00Z');
    const { data, up, inner } = createTestAddressData(dir, { now: () => t });
    await data.ensure(chiyoda);
    const downloads = up.count('GET');
    const heads = up.count('HEAD');
    const builtAt = t;

    t += 8 * DAY;
    const ready = await data.ensure(chiyoda);
    expect(ready.meta.checkedAt).toBe(builtAt);
    await data.idle();
    expect(data.peek(`city:${CHIYODA_LG}`)?.meta.checkedAt ?? 0).toBeGreaterThanOrEqual(t);
    expect(up.count('GET')).toBe(downloads);
    expect(up.count('HEAD')).toBeGreaterThan(heads);
    expect(inner.runs).toHaveLength(2);
  });

  test('期限内なら再確認しない', async () => {
    let t = Date.parse('2026-10-13T00:00:00Z');
    const { data, inner } = createTestAddressData(dir, { now: () => t });
    await data.ensure(chiyoda);
    t += 6 * DAY;
    await data.ensure(chiyoda);
    await tick();
    expect(inner.runs).toHaveLength(1);
  });
});

describe('evict', () => {
  test('予算を超えたら、最近使われていない市区町村を破棄し、直前に作ったものは残す', async () => {
    let t = Date.parse('2026-10-13T00:00:00Z');
    const { data } = createTestAddressData(dir, { maxBytes: 1, now: () => t });
    await data.ensure(sapporo);
    expect(data.peek(`city:${SAPPORO_LG}`)).not.toBeNull();
    t += 1000;
    await data.ensure(chiyoda);
    expect(data.peek(`city:${SAPPORO_LG}`)).toBeNull();
    expect(data.peek(`city:${CHIYODA_LG}`)).not.toBeNull();
  });
});

describe('datasetInfo', () => {
  test('使ったデータのうち最も古い更新日と、期限の 2 倍を超えたかを返す', async () => {
    let t = Date.parse('2026-10-13T00:00:00Z');
    const { data } = createTestAddressData(dir, { now: () => t });
    expect(data.datasetInfo(['master', 'postal'])).toEqual({ updatedAt: null, stale: false });
    await data.ensure({ kind: 'master' });
    expect(data.datasetInfo(['master', 'postal'])).toEqual({ updatedAt: '2026-10-02', stale: false });
    await data.ensure({ kind: 'postal' });
    expect(data.datasetInfo(['master', 'postal'])).toEqual({ updatedAt: '2026-09-30', stale: false });
    t += 100 * DAY;
    expect(data.datasetInfo(['master', 'postal'])).toEqual({ updatedAt: '2026-09-30', stale: true });
  });
});

describe('status', () => {
  test('別のストアが公開した成果物を、再読み込みなしで見つける', async () => {
    const { data } = createTestAddressData(dir);
    expect(data.peek('master')).toBeNull();
    const other = new AddressStore(dir);
    await runBuildJob({ kind: 'master' }, {
      store: other, http: { fetchFn: sampleUpstream().fetchFn, sleep: async () => undefined }, minimum: SMALL_MINIMUM,
    });
    expect(data.peek('master')?.meta.bytes).toBeGreaterThan(0);
  });
});

describe('loaders', () => {
  test('master() が市区町村名から 6 桁のコードを引ける。同じ版ならキャッシュを返す', async () => {
    const { data } = createTestAddressData(dir);
    const index = await data.master();
    expect(index.byName.get('東京都/千代田区')).toMatchObject({ lgCode: CHIYODA_LG, lg5: '13101', prefCode: '13', pref: '東京都', name: '千代田区' });
    expect(index.byName.get('北海道/札幌市中央区')).toMatchObject({ lgCode: SAPPORO_LG, lg5: '01101', prefCode: '01' });
    expect(index.byLgCode.get(CHIYODA_LG)?.name).toBe('千代田区');
    expect(index.byLg5.get('13101')?.lgCode).toBe(CHIYODA_LG);
    expect(await data.master()).toBe(index);
  });

  test('取得元が変わって作り直されたら、master() は新しい索引を返す', async () => {
    const { data, up } = createTestAddressData(dir);
    const first = await data.master();
    const url = abrUrl('mt_pref/mt_pref_all');
    up.set(url, { ...up.routes.get(url)!, etag: '"changed"' });
    await data.request({ kind: 'master' });
    const second = await data.master();
    expect(second.ver).not.toBe(first.ver);
    expect(second).not.toBe(first);
  });

  test('towns() が町字を返し、同じ版ではキャッシュする', async () => {
    const { data } = createTestAddressData(dir);
    const first = await data.towns(CHIYODA_LG);
    expect(first.json.data.find((town) => town.machiaza_id === '0005001')).toMatchObject({
      oaza_cho: '永田町', chome: '一丁目', chome_n: 1, point: [139.746306, 35.675895],
    });
    expect(await data.towns(CHIYODA_LG)).toBe(first);
  });

  test('towns() は 6 桁でないコードを拒否する', async () => {
    const { data } = createTestAddressData(dir);
    await expect(data.towns('13101')).rejects.toThrow('6 桁');
  });

  test('numbers() が段B の範囲表とファイルの場所を返す。同じ版ではキャッシュする', async () => {
    const { data } = createTestAddressData(dir, { up: sampleUpstream({ numbers: true }) });
    const first = await data.numbers(CHIYODA_LG);
    expect(Object.keys(first.ranges).sort()).toEqual(['0005001', '0005002', '0006000']);
    expect(first.ranges['0005001']?.住居表示?.length).toBeGreaterThan(0);
    expect(first.path).toContain(`num/${CHIYODA_LG}`);
    expect(await data.numbers(CHIYODA_LG)).toBe(first);
    await expect(data.numbers('13101')).rejects.toThrow('6 桁');
  });

  test('geoIndex() の読み取り役が近傍の町字を引ける。同じ版では使い回す', async () => {
    const { data } = createTestAddressData(dir);
    const first = await data.geoIndex();
    expect(first.reader.nearest(35.6759, 139.7463, 1, 1000)[0]).toMatchObject({ lgCode: CHIYODA_LG, machiazaId: '0005001' });
    expect(await data.geoIndex()).toBe(first);
  });

  test('postal() の読み取り役が郵便番号を引ける。作り直されると新しい版になり、古い読み取り役もすぐには壊れない', async () => {
    const { data, up } = createTestAddressData(dir);
    const first = await data.postal();
    expect(first.reader.byZip('1000014')[0]).toMatchObject({ kind: 'general', town: '永田町' });
    up.set(JAPANPOST_FALLBACK.kenAll, { ...up.routes.get(JAPANPOST_FALLBACK.kenAll)!, etag: '"changed"' });
    await data.request({ kind: 'postal' });
    const second = await data.postal();
    expect(second.ver).not.toBe(first.ver);
    expect(second.reader).not.toBe(first.reader);
    expect(first.reader.byZip('1000014')).toHaveLength(1);
  });
});
