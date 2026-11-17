import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentCaller, runAsCaller } from '../security/caller.js';
import { TenantBudget } from '../security/tenant_budget.js';
import type { QueuePolicy } from '../security/fair_queue.js';
import { createTestAddressData, prebuild, settleAddressData } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, sampleUpstream } from '../test_fixtures/address/harness.js';
import { createAddressContext } from './address_context.js';
import { ADDRESS_SYSTEM_TENANT } from './address_data.js';
import { AddressBusyError } from './address_errors.js';
import { Gaps } from './address_gaps.js';
import { AddressNormalizer } from './address_normalize.js';
import { runPreload } from './address_preload.js';
import { annotatePoiAddresses } from './address_poi.js';
import { lookupZip } from './address_postal.js';
import type { BuildJob } from './address_store.js';

/**
 * 構築の順番・予算で断られたとき（AddressBusyError。設計 6。穴 25）の、住所機能の中の扱い。
 * 取れている範囲で答える呼び出し（市区町村までの答え・郵便番号の候補・施設の住所）は、取得に失敗したデータ（AddressUnavailableError）と同じに、
 * 断られたデータの ID と文を記録して続ける。答えようがない呼び出し（全国マスター・郵便番号が無い）は、そのまま失敗する（REST では 429）。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-busy-'));
});
afterEach(async () => {
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
});

/** 利用者の新しい構築を全部断る（待てる数 0）。システムの事前取得は断らない */
const noRoom = (): QueuePolicy => ({ perTenant: 0, total: 1000, waitMs: Number.POSITIVE_INFINITY, sharePercent: 100 });
const system = <T>(fn: () => Promise<T>): Promise<T> => runAsCaller(ADDRESS_SYSTEM_TENANT, fn);
const asUser = <T>(fn: () => Promise<T>): Promise<T> => runAsCaller('name:A', fn);
const prebuildAsSystem = (data: Parameters<typeof prebuild>[0], ...jobs: BuildJob[]) => system(() => prebuild(data, ...jobs));
const busy = () => new AddressBusyError('住所データの構築の順番を待つ要求が、この利用者の上限（0 件）に達しています', 'tenant_queue_full', 5, `city:${CHIYODA_LG}`);

describe('Gaps', () => {
  test('構築を断られたデータは、取得に失敗したデータと同じに、ID と文を記録して続ける', () => {
    const gaps = new Gaps();
    gaps.absorb(busy());
    expect(gaps.result()).toEqual({ incomplete: true, unavailable: [{ artifact: `city:${CHIYODA_LG}`, message: busy().message }] });
  });

  test('データに絡まない例外は、これまでどおり投げ直す', () => {
    expect(() => new Gaps().absorb(new Error('boom'))).toThrow('boom');
  });
});

describe('取れている範囲で答える呼び出し', () => {
  test('正規化: 市区町村の構築を断られたら、市区町村までの答えに unavailable（断られた ID と文）を付ける', async () => {
    const { data } = createTestAddressData(dir, { queuePolicy: noRoom });
    await prebuildAsSystem(data, { kind: 'master' });
    const result = await asUser(() => new AddressNormalizer(data).normalize('東京都千代田区永田町1-7-1'));
    expect(result).toMatchObject({ level: 2, incomplete: true });
    expect(result.unavailable).toEqual([{ artifact: `city:${CHIYODA_LG}`, message: expect.stringContaining('住所データの構築の順番') }]);
  });

  test('郵便番号: 市区町村の構築を断られたら、市区町村の代表点で答えて unavailable を付ける', async () => {
    const built = createTestAddressData(dir, { queuePolicy: noRoom });
    const ctx = createAddressContext(built.data);
    await prebuildAsSystem(built.data, { kind: 'postal' }, { kind: 'master' });
    const lookup = await asUser(() => lookupZip(ctx, '1000014', { waitMs: 300 }));
    expect(lookup).toMatchObject({ incomplete: true, unavailable: [{ artifact: `city:${CHIYODA_LG}`, message: expect.stringContaining('住所データの構築の順番') }] });
    expect(lookup.candidates[0]).toMatchObject({ town: '永田町', locationLevel: 2 });
  });
});

describe('取れている範囲で答える呼び出し（続き）', () => {
  test('正規化: 番地・号（段B）の構築を断られたら、市区町村までの答えに unavailable を付ける', async () => {
    const { data } = createTestAddressData(dir, { queuePolicy: noRoom, up: sampleUpstream({ numbers: true }) });
    await prebuildAsSystem(data, { kind: 'master' }, { kind: 'city', lgCode: CHIYODA_LG });
    const result = await asUser(() => new AddressNormalizer(data).normalize('東京都千代田区永田町1-7-1'));
    expect(result).toMatchObject({ level: 2, incomplete: true });
    expect(result.unavailable).toEqual([{ artifact: `num:${CHIYODA_LG}`, message: expect.stringContaining('住所データの構築の順番') }]);
  });

  test('正規化: 街区レベル位置参照（国土交通省）の構築を断られたら、ABR だけの答えに unavailable（断られた ID）を付ける', async () => {
    const { data } = createTestAddressData(dir, { queuePolicy: noRoom, up: sampleUpstream({ numbers: true, mlit: true }) });
    await prebuildAsSystem(data, { kind: 'master' }, { kind: 'city', lgCode: CHIYODA_LG }, { kind: 'num', lgCode: CHIYODA_LG });
    const result = await asUser(() => new AddressNormalizer(data).normalize('東京都千代田区永田町1-9-5'));
    expect(result).toMatchObject({ level: 3, numberSource: null, other: '9-5', incomplete: true });
    expect(result.unavailable).toEqual([{ artifact: `mlit:${CHIYODA_LG}`, message: expect.stringContaining('住所データの構築の順番') }]);
  });

  test('正規化: 番地・号（段B）を断られたら、街区（国土交通省）は頼まない（unavailable は番地・号だけ）', async () => {
    const { data } = createTestAddressData(dir, { queuePolicy: noRoom, up: sampleUpstream({ numbers: true, mlit: true }) });
    await prebuildAsSystem(data, { kind: 'master' }, { kind: 'city', lgCode: CHIYODA_LG });
    const result = await asUser(() => new AddressNormalizer(data).normalize('東京都千代田区永田町1-9-5'));
    expect((result.unavailable ?? []).map((item) => item.artifact)).toEqual([`num:${CHIYODA_LG}`]);
  });

  test('正規化: 郵便番号から市区町村を決めるための郵便番号データの構築を断られたら、「解釈できない」と黙らず、unavailable（postal）を付ける', async () => {
    const { data } = createTestAddressData(dir, { queuePolicy: noRoom });
    await prebuildAsSystem(data, { kind: 'master' });
    const result = await asUser(() => new AddressNormalizer(data).normalize('永田町1-7-1', { zipcode: '100-0014' }));
    expect(result).toMatchObject({ level: 0, incomplete: true });
    expect(result.unavailable).toEqual([{ artifact: 'postal', message: expect.stringContaining('住所データの構築の順番') }]);
  });

  test('施設の住所: 市区町村の構築を断られた施設は、incomplete にして、足りないデータを gaps に集める（その施設の住所を「解釈できない」と黙って扱わない）', async () => {
    const built = createTestAddressData(dir, { queuePolicy: noRoom });
    const ctx = createAddressContext(built.data);
    await prebuildAsSystem(built.data, { kind: 'master' }, { kind: 'postal' }, { kind: 'index' });
    const pois = [{ address: '東京都千代田区永田町1-7-1', lat: 35.6759, lng: 139.7455 }];
    const annotation = await asUser(() => annotatePoiAddresses(ctx, pois as never));
    expect(annotation.results[0]).toMatchObject({ incomplete: true });
    expect(annotation.gaps).toMatchObject({ incomplete: true, unavailable: [{ artifact: `city:${CHIYODA_LG}`, message: expect.stringContaining('住所データの構築の順番') }] });
  });
});

describe('正規化の世代は全員で共有する: 断られた利用者の欠けた答えを、別の利用者に残さない', () => {
  /** A だけ、新しい構築を全部断る。B は余裕がある */
  const onlyAIsRefused = (): QueuePolicy => ({ perTenant: currentCaller() === 'name:A' ? 0 : 100, total: 1000, waitMs: Number.POSITIVE_INFINITY, sharePercent: 100 });
  const QUERY = '東京都千代田区永田町1-7-1';

  test('A が番地・号（段B）の構築を断られたあとでも、余裕のある B は、同じ正規化器で、番地・号まで答えられる（段B が構築される）', async () => {
    const { data } = createTestAddressData(dir, { queuePolicy: onlyAIsRefused, up: sampleUpstream({ numbers: true }) });
    await prebuildAsSystem(data, { kind: 'master' }, { kind: 'city', lgCode: CHIYODA_LG });
    const normalizer = new AddressNormalizer(data); // 本番と同じく、全員で 1 つ
    const a = await runAsCaller('name:A', () => normalizer.normalize(QUERY));
    expect(a.unavailable).toEqual([{ artifact: `num:${CHIYODA_LG}`, message: expect.any(String) }]);
    const b = await runAsCaller('name:B', () => normalizer.normalize(QUERY));
    expect(b).toMatchObject({ level: 8, numberSource: 'rsdt' });
    expect(b.incomplete).toBeUndefined();
    expect(data.peek(`num:${CHIYODA_LG}`)).not.toBeNull();
  });

  test('A の待たない取得（background）が断られたあとでも、B は、番地・号まで答えられる（A の断りを「取得中」として覚えない）', async () => {
    const { data } = createTestAddressData(dir, { queuePolicy: onlyAIsRefused, up: sampleUpstream({ numbers: true }) });
    await prebuildAsSystem(data, { kind: 'master' }, { kind: 'city', lgCode: CHIYODA_LG });
    const normalizer = new AddressNormalizer(data);
    const a = await runAsCaller('name:A', () => data.withoutWaiting('background', () => normalizer.normalize(QUERY)));
    expect(a.unavailable).toEqual([{ artifact: `num:${CHIYODA_LG}`, message: expect.any(String) }]);
    expect(a.pending).toBeUndefined();
    const b = await runAsCaller('name:B', () => normalizer.normalize(QUERY));
    expect(b).toMatchObject({ level: 8 });
    expect(b.incomplete).toBeUndefined();
  });
});

describe('システムの事前取得（SORA_ADDRESS_PRELOAD）', () => {
  test('利用者の構築を全部断る方針・使い切った予算のもとでも、事前取得は断られず、最後まで進む（上限にも予算にも数えない）', async () => {
    const empty = new TenantBudget({ resource: 'address', policy: () => ({ perWindow: 1, windowMs: 60_000 }) });
    const built = createTestAddressData(dir, { preload: ['13'], queuePolicy: noRoom, budget: empty, up: sampleUpstream({ numbers: true }) });
    const state = await runPreload(built.data, { log: () => undefined, sleep: async () => undefined });
    expect(state).toMatchObject({ state: 'done', total: 1, done: 1, failed: 0 });
    expect(empty.usedBy('legacy')).toBe(0);
    expect(empty.usedBy(ADDRESS_SYSTEM_TENANT)).toBe(0);
  });
});

describe('答えようがない呼び出しは、そのまま失敗する', () => {
  test('全国マスターの構築を断られたら、正規化は AddressBusyError で失敗する', async () => {
    const { data } = createTestAddressData(dir, { queuePolicy: noRoom });
    const error = await asUser(() => new AddressNormalizer(data).normalize('東京都千代田区永田町1-7-1')).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(AddressBusyError);
    expect((error as AddressBusyError).artifact).toBe('master');
  });
});
