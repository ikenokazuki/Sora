import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestAddressData, settleAddressData } from '../test_fixtures/address/builders.js';
import { CHIYODA_LG, SAPPORO_LG, abrUrl, sampleUpstream } from '../test_fixtures/address/harness.js';
import { AddressUnavailableError } from './address_errors.js';
import { runPreload, startAddressPreload } from './address_preload.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-preload-'));
});
afterEach(async () => {
  await settleAddressData();
  rmSync(dir, { recursive: true, force: true });
});

const quiet = { log: () => undefined, sleep: async () => undefined };
const setup = (options: Parameters<typeof createTestAddressData>[1] = {}, where: string = dir) =>
  createTestAddressData(where, { up: sampleUpstream({ numbers: true }), ...options });
const stateOf = (where: string = dir) => JSON.parse(readFileSync(join(where, 'preload.json'), 'utf8')) as Record<string, unknown>;
const sumBytes = (built: ReturnType<typeof setup>): number => Object.values(built.data.status().artifacts).reduce((sum, meta) => sum + meta.bytes, 0);

describe('runPreload', () => {
  test('指定が無ければ何もしない（ファイルも通信も作らない）', async () => {
    const built = setup({ preload: null });
    expect(await runPreload(built.data, quiet)).toBeNull();
    expect(built.up.requests).toEqual([]);
    await built.data.idle();
    expect(() => readFileSync(join(dir, 'preload.json'))).toThrow();
  });

  test('住所機能が off なら何もしない', async () => {
    const built = setup({ mode: 'off', preload: ['13'] });
    expect(await runPreload(built.data, quiet)).toBeNull();
    expect(built.up.requests).toEqual([]);
  });

  test('指定した都道府県の市区町村だけを取得して印を付け、全国の小さい成果物も揃える', async () => {
    const built = setup({ preload: ['13'] });
    const state = await runPreload(built.data, quiet);
    expect(state).toMatchObject({ state: 'done', total: 1, done: 1, failed: 0, target: ['13'] });
    for (const id of ['master', 'postal', 'index', `city:${CHIYODA_LG}`, `num:${CHIYODA_LG}`]) expect(built.data.peek(id)).not.toBeNull();
    expect(built.data.peek(`city:${CHIYODA_LG}`)?.meta.pinned).toBe(true);
    expect(built.data.peek(`num:${CHIYODA_LG}`)?.meta.pinned).toBe(true);
    // 範囲外（北海道）は取得しない
    expect(built.data.peek(`city:${SAPPORO_LG}`)).toBeNull();
    expect(built.up.requests.some((request) => request.url.includes(`city${SAPPORO_LG}`))).toBe(false);
    expect(stateOf()).toMatchObject({ state: 'done', total: 1, done: 1, failed: 0, target: ['13'] });
  });

  test("'all' は全国マスターにあるすべての市区町村を取得する（政令市の親の行は含まない）", async () => {
    const built = setup({ preload: 'all' });
    expect(await runPreload(built.data, quiet)).toMatchObject({ state: 'done', total: 2, done: 2, target: 'all' });
    for (const lg of [SAPPORO_LG, CHIYODA_LG]) {
      expect(built.data.peek(`city:${lg}`)?.meta.pinned).toBe(true);
      expect(built.data.peek(`num:${lg}`)?.meta.pinned).toBe(true);
    }
  });

  test('再実行では、確認が新しい成果物を取り直さない（再開できる）', async () => {
    const first = setup({ preload: 'all' });
    await runPreload(first.data, quiet);
    await first.data.idle();
    const second = setup({ preload: 'all' });
    expect(await runPreload(second.data, quiet)).toMatchObject({ state: 'done', total: 2, done: 2 });
    expect(second.up.requests).toEqual([]);
  });

  test('確認が古い成果物は、署名だけ確かめる。変わっていなければ作り直さない', async () => {
    let clock = 1_700_000_000_000;
    const first = setup({ preload: ['13'], now: () => clock });
    await runPreload(first.data, { ...quiet, now: () => clock });
    await first.data.idle();
    clock += 2 * 86_400_000;
    const second = setup({ preload: ['13'], now: () => clock });
    expect(await runPreload(second.data, { ...quiet, now: () => clock })).toMatchObject({ state: 'done', done: 1 });
    await second.data.idle();
    // 取得元へは署名の確認（HEAD）だけ。zip の本体は取り直さない
    expect(second.up.count('HEAD')).toBeGreaterThan(0);
    expect(second.up.requests.filter((request) => request.method === 'GET' && request.url.endsWith('.zip'))).toEqual([]);
    expect(second.data.peek(`num:${CHIYODA_LG}`)?.meta.checkedAt).toBe(clock);
  });

  test('予算に空きが無ければ止めて理由を残す。取得済みの成果物は残り、予算を増やして再実行すると続きから進む', async () => {
    // 先に札幌だけを取得したときの使用量を測り、それを 1 バイト下回る予算にする（2 件目の前で止まる）
    const measured = setup({ preload: ['01'] }, join(dir, 'measure'));
    await runPreload(measured.data, quiet);
    await measured.data.idle();
    const budget = sumBytes(measured) - 1;

    const tight = setup({ preload: 'all', maxBytes: budget }, join(dir, 'real'));
    const stopped = await runPreload(tight.data, { ...quiet, headroomBytes: 0 });
    expect(stopped).toMatchObject({ state: 'stopped', reason: 'budget', total: 2, done: 1 });
    expect(stopped?.message).toContain('SORA_ADDRESS_MAX_MB');
    expect(stateOf(join(dir, 'real'))).toMatchObject({ state: 'stopped', reason: 'budget', done: 1 });
    await tight.data.idle();
    // 取得済みの札幌は、予算を超えていても破棄されない
    expect(tight.data.peek(`num:${SAPPORO_LG}`)?.meta.pinned).toBe(true);
    expect(tight.data.peek(`city:${CHIYODA_LG}`)).toBeNull();

    const roomy = setup({ preload: 'all' }, join(dir, 'real'));
    expect(await runPreload(roomy.data, quiet)).toMatchObject({ state: 'done', total: 2, done: 2 });
    await roomy.data.idle();
    expect(roomy.up.requests.some((request) => request.url.includes(`city${SAPPORO_LG}`))).toBe(false);
    expect(roomy.data.peek(`num:${CHIYODA_LG}`)?.meta.pinned).toBe(true);
  });

  test('1 つの市区町村が取れなくても次へ進み、失敗を数える。間隔は失敗が続くほど延びて、成功で戻る', async () => {
    const up = sampleUpstream({ numbers: true });
    up.routes.delete(abrUrl(`mt_town/city/mt_town_city${SAPPORO_LG}`));
    const sleeps: number[] = [];
    const built = setup({ preload: 'all', up });
    const state = await runPreload(built.data, { log: () => undefined, sleep: async (ms) => { sleeps.push(ms); } });
    expect(state).toMatchObject({ state: 'done', total: 2, done: 1, failed: 1 });
    expect(built.data.peek(`num:${CHIYODA_LG}`)?.meta.pinned).toBe(true);
    expect(built.data.peek(`city:${SAPPORO_LG}`)).toBeNull();
    expect(sleeps).toEqual([30_000]);
  });

  test('失敗が続けば止める', async () => {
    const built = setup({ preload: 'all', wrap: (inner) => ({
      run: async (job) => {
        if (job.kind === 'city' || job.kind === 'num') throw new AddressUnavailableError('取得元が応答しません', false, `${job.kind}:${job.lgCode}`);
        await inner.run(job);
      },
    }) });
    const sleeps: number[] = [];
    const state = await runPreload(built.data, { log: () => undefined, sleep: async (ms) => { sleeps.push(ms); }, maxFailures: 2 });
    expect(state).toMatchObject({ state: 'stopped', reason: 'errors', failed: 2, done: 0 });
    expect(state?.message).toContain('取得元が応答しません');
    expect(sleeps).toEqual([30_000]);
  });

  test('国外 IP の拒否（403）は、再試行しても変わらないのでその場で止める', async () => {
    const up = sampleUpstream({ numbers: true });
    up.set(abrUrl(`mt_town/city/mt_town_city${SAPPORO_LG}`), { status: 403, body: '' });
    const built = setup({ preload: 'all', up });
    const state = await runPreload(built.data, quiet);
    expect(state).toMatchObject({ state: 'stopped', reason: 'blocked', done: 0 });
    expect(state?.message).toContain('国外 IP');
  });

  test('全国マスターが取れなければ、市区町村の一覧が無いので止める', async () => {
    const up = sampleUpstream({ numbers: true });
    up.set(abrUrl('mt_pref/mt_pref_all'), { status: 403, body: '' });
    const built = setup({ preload: 'all', up });
    expect(await runPreload(built.data, quiet)).toMatchObject({ state: 'stopped', reason: 'blocked', total: 0 });
  });
});

describe('事前取得と破棄', () => {
  test('事前取得の範囲にある印つきの成果物は予算を超えても破棄されず、範囲外の印や、指定を外した後の印は効かない', async () => {
    const ids = [`city:${CHIYODA_LG}`, `num:${CHIYODA_LG}`, `city:${SAPPORO_LG}`, `num:${SAPPORO_LG}`];
    const scoped = setup({ preload: ['13'] });
    for (const id of ids) {
      const [kind, lgCode] = id.split(':') as ['city' | 'num', string];
      await scoped.data.ensure({ kind, lgCode });
    }
    await scoped.store.pin(ids);
    // 範囲外（北海道）の印は無視されて破棄され、範囲内（東京都）は残る
    expect((await scoped.data.evictTo(1)).sort()).toEqual([`city:${SAPPORO_LG}`, `num:${SAPPORO_LG}`]);
    expect(scoped.data.peek(`city:${CHIYODA_LG}`)).not.toBeNull();
    // 指定を外した運用（同じ保存先）では、印があっても破棄できる
    const unset = setup({ preload: null });
    expect((await unset.data.evictTo(1)).sort()).toEqual([`city:${CHIYODA_LG}`, `num:${CHIYODA_LG}`]);
  });
});

describe('startAddressPreload', () => {
  test('指定が無い、または off なら何も予約しない', () => {
    expect(startAddressPreload({})).toBeNull();
    expect(startAddressPreload({ SORA_ADDRESS_PRELOAD: '  ' })).toBeNull();
    expect(startAddressPreload({ SORA_ADDRESS: 'off', SORA_ADDRESS_PRELOAD: '13' })).toBeNull();
  });

  test('指定があれば、少し待ってから裏で始める予約をする', () => {
    const timer = startAddressPreload({ SORA_ADDRESS_PRELOAD: '13' }, { delayMs: 3_600_000 });
    expect(timer).not.toBeNull();
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  });
});
