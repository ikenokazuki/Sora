import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatedBuilder, createTestAddressData, tick, waitFor } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, SAPPORO_LG, abrUrl, sampleUpstream } from '../test_fixtures/address/harness.js';
import { AddressDisabledError, AddressPendingError, AddressUnavailableError } from './address_errors.js';
import { runBuildJob } from './address_jobs.js';
import { AddressStore, type BuildJob } from './address_store.js';
import { SMALL_MINIMUM } from '../test_fixtures/address/harness.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-data-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    await waitFor(() => (data.peek(`city:${CHIYODA_LG}`)?.meta.checkedAt ?? 0) >= t);
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
  test('取得元の最終更新日の最大と、期限の 2 倍を超えたかを返す', async () => {
    let t = Date.parse('2026-10-13T00:00:00Z');
    const { data } = createTestAddressData(dir, { now: () => t });
    expect(data.datasetInfo(['master', 'postal'])).toEqual({ updatedAt: null, stale: false });
    await data.ensure({ kind: 'master' });
    await data.ensure({ kind: 'postal' });
    expect(data.datasetInfo(['master', 'postal'])).toEqual({ updatedAt: '2026-10-02', stale: false });
    t += 100 * DAY;
    expect(data.datasetInfo(['master', 'postal'])).toEqual({ updatedAt: '2026-10-02', stale: true });
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
