import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setToCache } from './cache.js';
import {
  closeDb,
  dbAddApiUsage,
  dbClearAllCache,
  dbClearCacheByPrefix,
  dbClearExpiredCache,
  dbDeleteCache,
  dbDeleteTenantSession,
  dbDeleteWatchTarget,
  dbGetApiUsage,
  dbGetCache,
  dbGetTenantCookies,
  dbIncrementApiUsage,
  dbPurgeOldApiUsage,
  dbPurgeOldWatchHistory,
  dbPurgeStaleSavedState,
  dbReleaseWatchCheck,
  dbSaveTenantCookies,
  dbSaveTenantStorage,
  dbSetCache,
  dbUpdateWatchTargetCheck,
  getDb,
} from './db.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { STANDARD_LIMITS } from './security/limits.js';

/**
 * DB の書き込みの失敗と、上限で入れなかった書き込みの計数（設計 6。穴 24）。
 * 書き込みの失敗は、握りつぶして続ける作りで（取得そのものを、保存の失敗で止めない）、これまで、数えるものが無かった。
 * DB が読み取り専用・満杯・壊れていても、静かに保存されないだけで、運用者が気づけなかった。
 * 失敗は sora_db_write_failures_total、上限（大きさ）を超えて入れなかった書き込みは sora_db_write_dropped_total に数える。
 * 共有の in-memory DB を使うほかのテストの行を巻き込まないよう、ここでは、毎回、新しい DB を使う。
 */

const FAILURES = 'sora_db_write_failures_total';
const DROPPED = 'sora_db_write_dropped_total';

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'db-write-failures-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
  clearCache();
  resetSecurityMetrics();
});
afterEach(() => {
  clearCache();
  closeDb();
  resetSecurityMetrics();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

const count = (name: string) => getSecurityMetrics()[name] ?? 0;
/**
 * DB を開けない状態にする。DB のファイルの置き場所の親が、ディレクトリではなくファイルのとき、getDb() は投げる
 * （存在しないディレクトリは、initDatabase が作るので、開けてしまう）
 */
function breakDb(): void {
  getDb();
  closeDb();
  const blocker = join(directory, 'blocker');
  writeFileSync(blocker, '');
  process.env.SORA_DB_PATH = join(blocker, 'x.db');
}

/** 握りつぶして続ける書き込みの、全部（読み出しは含まない） */
const WRITES: Array<[string, () => unknown]> = [
  ['dbSetCache', () => dbSetCache('k', { a: 1 }, 60)],
  ['dbDeleteCache', () => dbDeleteCache('k')],
  ['dbClearExpiredCache', () => dbClearExpiredCache()],
  ['dbClearAllCache', () => dbClearAllCache()],
  ['dbClearCacheByPrefix', () => dbClearCacheByPrefix('tenant:t:')],
  ['dbPurgeOldApiUsage', () => dbPurgeOldApiUsage()],
  ['dbPurgeOldWatchHistory', () => dbPurgeOldWatchHistory()],
  ['dbPurgeStaleSavedState', () => dbPurgeStaleSavedState()],
  ['dbSaveTenantCookies', () => dbSaveTenantCookies('t', 'a.example', [{ name: 'n', value: 'v' }])],
  ['dbSaveTenantStorage', () => dbSaveTenantStorage('t', 'a.example', { n: 'v' })],
  ['dbDeleteTenantSession', () => dbDeleteTenantSession('t', 'a.example')],
  ['dbIncrementApiUsage', () => dbIncrementApiUsage('h', '2026-01-01')],
  ['dbAddApiUsage', () => dbAddApiUsage('h', '2026-01-01', 2)],
  ['dbUpdateWatchTargetCheck', () => dbUpdateWatchTargetCheck('w_1', 'hash')],
  ['dbReleaseWatchCheck', () => dbReleaseWatchCheck('w_1', 't', 1, null)],
  ['dbDeleteWatchTarget', () => dbDeleteWatchTarget('w_1', 't')],
];

describe('書き込みが失敗したとき、数える（投げない作りは、そのまま）', () => {
  test.each(WRITES)('%s: 1 回の失敗を 1 と数え、投げない', (_name, write) => {
    breakDb();
    expect(() => write()).not.toThrow();
    expect(count(FAILURES)).toBe(1);
    expect(count(DROPPED)).toBe(0);
  });

  test('失敗した回数だけ増える', () => {
    breakDb();
    for (let i = 0; i < 3; i++) dbSetCache(`k${i}`, i, 60);
    dbSaveTenantCookies('t', 'a.example', []);
    expect(count(FAILURES)).toBe(4);
  });

  test('読み出しの失敗は、数えない（書き込みだけ）', () => {
    breakDb();
    expect(dbGetCache('k')).toBeUndefined();
    expect(dbGetApiUsage('h', '2026-01-01')).toBe(0);
    expect(dbGetTenantCookies('t', 'a.example')).toBeUndefined();
    expect(count(FAILURES)).toBe(0);
  });

  test('保存した状態で、古い行を消すのに失敗しても、いまの保存は残り、失敗として数える', () => {
    const lim = { ...STANDARD_LIMITS, savedStateRowsPerTenant: 2.5 }; // 消す件数が整数にならず、削除の文が失敗する
    dbSaveTenantCookies('t', 'a.example', [{ name: 'n', value: '1' }], 'default', lim);
    dbSaveTenantCookies('t', 'b.example', [{ name: 'n', value: '2' }], 'default', lim);
    dbSaveTenantCookies('t', 'c.example', [{ name: 'n', value: '3' }], 'default', lim);
    expect(count(FAILURES)).toBe(1);
    expect(dbGetTenantCookies('t', 'c.example', 'default', lim)).toEqual([{ name: 'n', value: '3' }]);
  });
});

describe('成功した書き込みは、数えない', () => {
  test('ふつうの保存・消去・掃除は、失敗にも上限超えにも数えない', () => {
    dbSetCache('k', { a: 1 }, 60);
    dbDeleteCache('k');
    dbClearExpiredCache();
    dbClearAllCache();
    dbClearCacheByPrefix('tenant:t:');
    dbPurgeOldApiUsage();
    dbPurgeOldWatchHistory();
    dbPurgeStaleSavedState();
    dbSaveTenantCookies('t', 'a.example', [{ name: 'n', value: 'v' }]);
    dbSaveTenantStorage('t', 'a.example', { n: 'v' });
    dbDeleteTenantSession('t', 'a.example');
    dbIncrementApiUsage('h', '2026-01-01');
    dbAddApiUsage('h', '2026-01-01', 2);
    dbUpdateWatchTargetCheck('w_1', 'hash');
    dbReleaseWatchCheck('w_1', 't', 1, null);
    dbDeleteWatchTarget('w_1', 't');
    expect(getSecurityMetrics()).toEqual({});
  });

  test('public の tenant の保存（もともと何もしない）は、失敗に数えない', () => {
    breakDb();
    dbSaveTenantCookies('public', 'a.example', [{ name: 'n', value: 'v' }]);
    dbSaveTenantStorage('public', 'a.example', { n: 'v' });
    expect(count(FAILURES)).toBe(0);
  });
});

describe('大きさの上限を超えて入れなかった書き込みを、数える', () => {
  const big = (bytes: number) => 'x'.repeat(bytes);

  test('保存した Cookie: 1 行の上限を超えると、1 と数える（失敗には数えない）', () => {
    const lim = { ...STANDARD_LIMITS, savedStateMaxBytes: 200 };
    dbSaveTenantCookies('t', 'a.example', [{ name: 'n', value: big(500) }], 'default', lim);
    expect(count(DROPPED)).toBe(1);
    expect(count(FAILURES)).toBe(0);
  });

  test('保存した localStorage: 同じ', () => {
    const lim = { ...STANDARD_LIMITS, savedStateMaxBytes: 200 };
    dbSaveTenantStorage('t', 'a.example', { n: big(500) }, 'default', lim);
    expect(count(DROPPED)).toBe(1);
    expect(count(FAILURES)).toBe(0);
  });

  test('保存した状態: 上限ちょうどは、入れる。数えない', () => {
    const value = 'x';
    const exact = Buffer.byteLength(JSON.stringify({ n: value }));
    dbSaveTenantStorage('t', 'a.example', { n: value }, 'default', { ...STANDARD_LIMITS, savedStateMaxBytes: exact });
    expect(count(DROPPED)).toBe(0);
  });

  test('DB のキャッシュ: 1 件が容量の上限を超えると、1 と数える', () => {
    dbSetCache('big', big(500), 60, { ...STANDARD_LIMITS, cacheDbMaxBytes: 100 });
    expect(count(DROPPED)).toBe(1);
    expect(count(FAILURES)).toBe(0);
  });

  test('DB のキャッシュ: 上限ちょうどは、入れる。数えない', () => {
    const exact = Buffer.byteLength(JSON.stringify('y'));
    dbSetCache('fit', 'y', 60, { ...STANDARD_LIMITS, cacheDbMaxBytes: exact });
    expect(count(DROPPED)).toBe(0);
  });

  test('上限を超えた回数だけ増える', () => {
    const lim = { ...STANDARD_LIMITS, savedStateMaxBytes: 50, cacheDbMaxBytes: 50 };
    for (let i = 0; i < 2; i++) dbSaveTenantCookies('t', `a${i}.example`, [{ name: 'n', value: big(200) }], 'default', lim);
    dbSetCache('k', big(200), 60, lim);
    expect(count(DROPPED)).toBe(3);
  });
});

describe('db.ts の外の握りつぶし・DAO を通らない捨て方', () => {
  test('メモリ・DB のキャッシュに入れない 1 件 2MB 超の応答は、入れなかった書き込みに数える（失敗には数えない）', () => {
    expect(setToCache('too-big', { s: 'x'.repeat(3 * 1024 * 1024) }, 60_000)).toBe(false);
    expect(count(DROPPED)).toBe(1);
    expect(count(FAILURES)).toBe(0);
    expect(setToCache('small', { s: 'x' }, 60_000)).toBe(true);
    expect(count(DROPPED)).toBe(1);
  });

  test('JSON にできない値（循環）を入れられないのは、大きさの上限ではないので、数えない', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(setToCache('circular', circular, 60_000)).toBe(false);
    expect(count(DROPPED)).toBe(0);
  });

  test('国の情報の問い合わせ時スナップショットの保存が失敗しても、応答は返り、書き込みの失敗に数える', async () => {
    const countryDb = await import('./services/country_intel/db.js');
    const { researchCountryContext } = await import('./services/country_intel/report.js');
    const { createWeiboHotProvider } = await import('./services/country_intel/providers/weibo_hot.js');
    const body = JSON.stringify({ ok: 1, data: { hotgovs: [], realtime: [{ word: 'topic-a', num: 100, realpos: 1 }] } });
    const fetchFn = (async () => new Response(body, { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const spy = spyOn(countryDb, 'saveHotObservations').mockImplementation(() => {
      throw new Error('database is locked');
    });
    try {
      const report = await researchCountryContext({ region: 'China', noCache: true }, { providers: [createWeiboHotProvider(fetchFn)], cache: null, now: () => new Date('2026-09-23T12:00:00Z'), scrapeArticle: undefined });
      expect(report.recentContext?.topics.length).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalled();
      expect(count(FAILURES)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('/metrics に出る', () => {
  test('Prometheus と JSON の counters に、失敗と、入れなかった書き込みの数が出る', async () => {
    const { app } = await import('./index.js');
    dbSetCache('big', 'x'.repeat(500), 60, { ...STANDARD_LIMITS, cacheDbMaxBytes: 100 });
    breakDb();
    dbSetCache('k', 1, 60);
    dbSetCache('k', 2, 60);
    const text = await (await app.request('/metrics?format=prometheus')).text();
    expect(text).toContain(`# TYPE ${FAILURES} counter\n${FAILURES} 2\n`);
    expect(text).toContain(`# TYPE ${DROPPED} counter\n${DROPPED} 1\n`);
    const data = (await (await app.request('/metrics')).json()) as { counters: Record<string, number> };
    expect(data.counters[FAILURES]).toBe(2);
    expect(data.counters[DROPPED]).toBe(1);
  });
});
