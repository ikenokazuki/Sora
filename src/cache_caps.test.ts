import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, clearTenantCache, getCacheMetrics, getFromCache, setToCache, sweepExpiredEntries } from './cache.js';
import { closeDb, dbCacheStats, dbGetCache, dbSetCache, getDb } from './db.js';
import * as limitsModule from './security/limits.js';
import { STANDARD_LIMITS, STRICT_LIMITS } from './security/limits.js';
import { tenantCacheKey } from './security/tenant_state.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * キャッシュの上限（設計 6。穴 24）。DB（L2）は行数と容量、メモリ（L1）は容量に上限を置く。超えたら、期限の近い順に消す（期限切れが先）。
 * これまで、L2 は上限が無く、L1 は件数（3000）だけだった（1 件が最大 2MB なので、容量には上限が無かった）。
 * 共有の in-memory DB を使うほかのテストの行を巻き込まないよう、ここでは、毎回、新しい DB を使う。
 */

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'cache-caps-'));
  process.env.SORA_DB_PATH = join(directory, 'test.db');
  clearCache();
});
afterEach(() => {
  clearCache();
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

const HUGE = Number.MAX_SAFE_INTEGER;
/** 上限だけ差し替えた値の組（ここでは、キャッシュの 3 つだけを見る） */
const caps = (extra: Partial<typeof STANDARD_LIMITS> = {}) => ({ ...STANDARD_LIMITS, cacheDbMaxRows: HUGE, cacheDbMaxBytes: HUGE, cacheMemoryMaxBytes: HUGE, ...extra });
const rowKeys = () => (getDb().query('SELECT key FROM cache_entries ORDER BY expires_at, key').all() as Array<{ key: string }>).map((r) => r.key);
/** JSON にしたときの大きさが、およそ n バイトの値 */
const payload = (n: number, tag = '') => ({ body: `${tag}`.padEnd(n - 11, 'x') }); // {"body":"…"} は、本文以外で 11 バイト

describe('DB（L2）の行数の上限', () => {
  test('上限を超える書き込みでは、期限の近い（古い）行から消し、行数は上限のまま。新しい行は残る', () => {
    const lim = caps({ cacheDbMaxRows: 10 });
    for (let i = 0; i < 25; i++) dbSetCache(`rows:${String(i).padStart(2, '0')}`, { n: i }, 600 + i, lim);
    expect(dbCacheStats().rows).toBe(10);
    expect(rowKeys()).toEqual(Array.from({ length: 10 }, (_, i) => `rows:${15 + i}`)); // 後から書いた 10 件（期限が遠い）
    expect(dbGetCache('rows:00')).toBeUndefined();
    expect(dbGetCache('rows:24')).toBeDefined();
  });

  test('期限切れの行が先に消える（まだ有効な行を、期限切れより先に消さない）', () => {
    const lim = caps({ cacheDbMaxRows: 3 });
    dbSetCache('live-a', { v: 1 }, 600, lim);
    dbSetCache('expired', { v: 2 }, 0, lim); // 書いた時点で期限
    dbSetCache('live-b', { v: 3 }, 700, lim);
    expect(dbCacheStats().rows).toBe(3);
    dbSetCache('live-c', { v: 4 }, 800, lim); // 4 件目 → 1 件消える
    expect(rowKeys().sort()).toEqual(['live-a', 'live-b', 'live-c']);
  });

  test('同じキーの書き直しは、行を増やさず、ほかの行を消さない', () => {
    const lim = caps({ cacheDbMaxRows: 3 });
    dbSetCache('other-1', { v: 1 }, 600, lim);
    dbSetCache('other-2', { v: 2 }, 700, lim);
    for (let i = 0; i < 50; i++) dbSetCache('same', { v: i }, 800, lim);
    expect(dbCacheStats().rows).toBe(3);
    expect(rowKeys().sort()).toEqual(['other-1', 'other-2', 'same']);
    expect(dbGetCache<{ v: number }>('same')?.value.v).toBe(49);
  });
});

describe('DB（L2）の容量の上限', () => {
  test('容量（JSON の UTF-8 のバイト数の合計）が上限を超えたら、期限の近い行から消す', () => {
    const lim = caps({ cacheDbMaxBytes: 100_000 });
    for (let i = 0; i < 8; i++) dbSetCache(`bytes:${i}`, payload(30_000, `${i}`), 600 + i, lim); // 1 件およそ 30,000 バイト
    const stats = dbCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(100_000);
    expect(stats.bytes).toBeGreaterThan(60_000); // 消しすぎない（3 件は残る）
    expect(rowKeys()).toEqual(['bytes:5', 'bytes:6', 'bytes:7']);
  });

  test('大きさは UTF-8 のバイト数（日本語は 1 文字 3 バイト）で数える。保存した行から、同じ大きさで読める', () => {
    dbSetCache('size:ja', { t: 'あいう' }, 600, caps());
    dbSetCache('size:en', { t: 'abc' }, 600, caps());
    expect(dbGetCache('size:ja')?.size).toBe(Buffer.byteLength('{"t":"あいう"}'));
    expect(dbGetCache('size:en')?.size).toBe(Buffer.byteLength('{"t":"abc"}'));
    expect(dbCacheStats().bytes).toBe(Buffer.byteLength('{"t":"あいう"}') + Buffer.byteLength('{"t":"abc"}'));
  });

  test('同じキーを大きさの違う値で書き直すと、行の大きさも書き直す（合計が古い大きさのままにならない）', () => {
    dbSetCache('resize', payload(100), 600, caps());
    dbSetCache('resize', payload(3_000), 600, caps());
    expect(dbGetCache('resize')?.size).toBe(3_000);
    expect(dbCacheStats()).toEqual({ rows: 1, bytes: 3_000 });
    dbSetCache('resize', payload(50), 600, caps());
    expect(dbCacheStats()).toEqual({ rows: 1, bytes: 50 });
  });

  test('上限が行数より小さくても（誤った値でも）、消せる行を消し終えたら止まる（終わらずに回り続けない）', () => {
    dbSetCache('a', { v: 1 }, 600, caps());
    dbSetCache('b', { v: 2 }, 700, caps());
    dbSetCache('c', { v: 3 }, 800, caps({ cacheDbMaxRows: -5 }));
    expect(dbCacheStats().rows).toBe(0);
  });

  test('1 件がちょうど上限の大きさなら入る（超えたときだけ入れない）', () => {
    dbSetCache('exact', payload(50_000), 600, caps({ cacheDbMaxBytes: 50_000 }));
    expect(rowKeys()).toEqual(['exact']);
    expect(dbCacheStats().bytes).toBe(50_000);
  });

  test('1 件が上限より大きいときは、その 1 件を入れず（ほかの行を巻き込んで全部消さない）、行は残らない', () => {
    const lim = caps({ cacheDbMaxBytes: 50_000 });
    dbSetCache('small', payload(1_000), 600, lim);
    dbSetCache('huge', payload(60_000), 700, lim);
    expect(rowKeys()).toEqual(['small']);
  });
});

describe('書き込みのたびの数え方', () => {
  test('行数と容量の合計は、索引だけで数える（大きな中身を読まない。索引を外す変更に気づく）', () => {
    const plan = getDb().query('EXPLAIN QUERY PLAN SELECT COUNT(*) AS rows, COALESCE(SUM(size), 0) AS bytes FROM cache_entries').all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toContain('COVERING INDEX idx_cache_expires_size');
    const order = getDb().query('EXPLAIN QUERY PLAN SELECT key, size FROM cache_entries ORDER BY expires_at LIMIT 200').all() as Array<{ detail: string }>;
    expect(order.map((p) => p.detail).join(' ')).not.toContain('TEMP B-TREE'); // 期限順に引くとき、並べ替えをしない
  });
});

describe('水準ごとの既定', () => {
  test('値の表: strict は standard より小さい（行数・容量・メモリのすべて）', () => {
    expect(STRICT_LIMITS.cacheDbMaxRows).toBeLessThan(STANDARD_LIMITS.cacheDbMaxRows);
    expect(STRICT_LIMITS.cacheDbMaxBytes).toBeLessThan(STANDARD_LIMITS.cacheDbMaxBytes);
    expect(STRICT_LIMITS.cacheMemoryMaxBytes).toBeLessThan(STANDARD_LIMITS.cacheMemoryMaxBytes);
  });

  test('limits を渡さないとき、SORA_ISOLATION の水準の値で上限がかかる（standard は strict の行数では消さない）', async () => {
    const rows = STRICT_LIMITS.cacheDbMaxRows;
    await withEnv({ SORA_ISOLATION: undefined }, () => {
      getDb().transaction(() => {
        const insert = getDb().query('INSERT INTO cache_entries (key, value, expires_at, created_at, size) VALUES (?, ?, ?, ?, ?)');
        for (let i = 0; i < rows; i++) insert.run(`fill:${i}`, '{}', Date.now() + 600_000 + i, Date.now(), 2);
      })();
      dbSetCache('fill:next', { v: 1 }, 600);
      expect(dbCacheStats().rows).toBe(rows + 1); // standard: strict の上限を超えても消さない
    });
    await withEnv({ SORA_ISOLATION: 'strict' }, () => {
      dbSetCache('fill:next2', { v: 1 }, 600);
      expect(dbCacheStats().rows).toBe(rows); // strict: 上限まで消す
    });
  });
});

describe('マイグレーション（既存の DB に size の列を足し、古い行の大きさを埋める）', () => {
  test('size の列が無い古い DB を開くと、列が足され、既存の行の大きさが埋まり、上限の数え方に使われる', () => {
    getDb(); // 新しい DB（size の列あり）
    getDb().run('DROP INDEX IF EXISTS idx_cache_expires_size');
    getDb().run('ALTER TABLE cache_entries DROP COLUMN size');
    getDb().run("DELETE FROM schema_migrations WHERE name = 'cache entry size'");
    getDb().query('INSERT INTO cache_entries (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)').run('old:1', '{"t":"あいう"}', Date.now() + 600_000, Date.now());
    getDb().query('INSERT INTO cache_entries (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)').run('old:2', '{"t":"abc"}', Date.now() + 700_000, Date.now());
    closeDb();
    getDb(); // 開き直す → マイグレーション
    expect(dbGetCache('old:1')?.size).toBe(Buffer.byteLength('{"t":"あいう"}'));
    expect(dbGetCache('old:2')?.size).toBe(Buffer.byteLength('{"t":"abc"}'));
    expect(dbCacheStats()).toEqual({ rows: 2, bytes: Buffer.byteLength('{"t":"あいう"}') + Buffer.byteLength('{"t":"abc"}') });
    // 大きさが数えられているので、容量の上限が効く
    dbSetCache('new:1', payload(5_000), 800, caps({ cacheDbMaxBytes: 5_010 }));
    expect(rowKeys()).toEqual(['new:1']);
  });
});

describe('メモリ（L1）の容量の上限', () => {
  const mem = (cacheMemoryMaxBytes: number) => caps({ cacheMemoryMaxBytes });

  test('容量が上限を超えたら、古い（先頭の）エントリから外す。DB（L2）の行は消さない', () => {
    const lim = mem(99_000);
    for (let i = 0; i < 10; i++) setToCache(`mem:${i}`, payload(20_000, `${i}`), 600_000, lim);
    const metrics = getCacheMetrics();
    expect(metrics.bytes).toBeLessThanOrEqual(99_000);
    expect(metrics.size).toBe(4); // 1 件 20,000 バイトを 4 件まで（5 件で 100,000）
    expect(dbCacheStats().rows).toBe(10); // L2 は別の上限（ここでは無制限）
    getDb().run('DELETE FROM cache_entries'); // L2 を空にして、L1 に残っているものだけを見る
    expect(getFromCache('mem:0')).toBeNull();
    expect(getFromCache('mem:5')).toBeNull();
    expect(getFromCache('mem:6')).toMatchObject({ body: expect.stringMatching(/^6x/) });
    expect(getFromCache('mem:9')).toMatchObject({ body: expect.stringMatching(/^9x/) });
  });

  test('1 件がちょうど上限の大きさなら、メモリに入る', () => {
    setToCache('exact:mem', payload(50_000), 600_000, mem(50_000));
    expect(getCacheMetrics()).toMatchObject({ size: 1, bytes: 50_000 });
  });

  test('日本語（1 文字 3 バイト）は、バイト数で数える（文字数ではない）', () => {
    const value = { body: 'あ'.repeat(100) };
    setToCache('ja:mem', value, 600_000, mem(HUGE));
    expect(getCacheMetrics().bytes).toBe(Buffer.byteLength(JSON.stringify(value)));
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(300);
  });

  test('合計がちょうど上限になるまでは入る（5 件 × 20,000 = 100,000 が上限 100,000 に収まる）', () => {
    const lim = mem(100_000);
    for (let i = 0; i < 5; i++) setToCache(`fit:${i}`, payload(20_000, `${i}`), 600_000, lim);
    expect(getCacheMetrics()).toMatchObject({ size: 5, bytes: 100_000 });
    setToCache('fit:5', payload(20_000, '5'), 600_000, lim);
    expect(getCacheMetrics()).toMatchObject({ size: 5, bytes: 100_000 }); // 1 つ増えたら、1 つ外れる
  });

  test('setToCache に渡した上限は、DB（L2）にも使われる', () => {
    const lim = { ...mem(HUGE), cacheDbMaxRows: 3 };
    for (let i = 0; i < 8; i++) setToCache(`pass:${i}`, { n: i }, 600_000 + i, lim);
    expect(dbCacheStats().rows).toBe(3);
  });

  test('DB（L2）から読んで昇格するときも、メモリの容量の上限がかかる（水準の値）', () => {
    const spy = spyOn(limitsModule, 'limits').mockReturnValue(mem(50_000));
    try {
      for (let i = 0; i < 4; i++) dbSetCache(`promo:${i}`, payload(20_000, `${i}`), 600, mem(HUGE));
      for (let i = 0; i < 4; i++) expect(getFromCache(`promo:${i}`)).not.toBeNull(); // 4 件とも読める（L2 にある）
      expect(getCacheMetrics()).toMatchObject({ size: 2, bytes: 40_000 }); // メモリには 50,000 に収まる 2 件だけ
    } finally {
      spy.mockRestore();
    }
  });

  test('件数の上限（3000）で外すときも、容量の数え方がずれない', () => {
    const lim = mem(HUGE);
    const one = Buffer.byteLength(JSON.stringify({ n: 1000 }));
    for (let i = 0; i < 3001; i++) setToCache(`count:${i}`, { n: 1000 + (i % 9000) }, 600_000, lim);
    const metrics = getCacheMetrics();
    expect(metrics.size).toBeLessThan(3001); // 古い 15% が外れた
    expect(metrics.bytes).toBe(metrics.size * one);
  }, 60_000);

  test('参照したエントリは新しい側になり、先に外されない（LRU）', () => {
    const lim = mem(99_000);
    for (let i = 0; i < 4; i++) setToCache(`lru:${i}`, payload(20_000, `${i}`), 600_000, lim);
    expect(getFromCache('lru:0')).not.toBeNull(); // lru:0 を最近使ったことにする
    setToCache('lru:4', payload(20_000, '4'), 600_000, lim); // 5 件目 → 一番古い lru:1 が外れる
    getDb().run('DELETE FROM cache_entries');
    expect(getFromCache('lru:1')).toBeNull();
    expect(getFromCache('lru:0')).not.toBeNull();
  });

  test('容量の数え方がずれない: 書き直し・期限切れ・掃除・全消去・tenant の消去・L2 からの昇格のあと、合計はエントリの大きさの和に一致する', () => {
    const lim = mem(HUGE);
    const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const a = payload(1_000, 'a');
    const b = payload(2_000, 'b');
    setToCache('acc:a', a, 600_000, lim);
    setToCache('acc:b', b, 600_000, lim);
    expect(getCacheMetrics().bytes).toBe(sizeOf(a) + sizeOf(b));
    setToCache('acc:a', payload(500, 'a2'), 600_000, lim); // 書き直し: 古い大きさを引く
    expect(getCacheMetrics().bytes).toBe(sizeOf(payload(500, 'a2')) + sizeOf(b));
    const ta = tenantCacheKey('name:acc', 'acc:t');
    setToCache(ta, payload(700, 't'), 600_000, lim);
    clearTenantCache('name:acc'); // tenant の分を消す
    expect(getCacheMetrics().bytes).toBe(sizeOf(payload(500, 'a2')) + sizeOf(b));
    setToCache('acc:exp', payload(300, 'e'), 1, lim); // 1 ms で期限
    Bun.sleepSync(5);
    sweepExpiredEntries();
    expect(getCacheMetrics().bytes).toBe(sizeOf(payload(500, 'a2')) + sizeOf(b));
    expect(getCacheMetrics().size).toBe(2);
    // L2 からの昇格: L1 を空にしてから、L2 の行を読む
    clearCache();
    dbSetCache('acc:l2', payload(900, 'l'), 600, lim);
    expect(getCacheMetrics().bytes).toBe(0);
    expect(getFromCache('acc:l2')).not.toBeNull();
    expect(getCacheMetrics().bytes).toBe(sizeOf(payload(900, 'l')));
    clearCache();
    expect(getCacheMetrics().bytes).toBe(0);
  });

  test('期限切れのエントリを読んで消したときも、容量を引く', () => {
    const lim = mem(HUGE);
    setToCache('exp:read', payload(1_000), 1, lim); // 1 ms で期限
    const before = getCacheMetrics().bytes;
    expect(before).toBeGreaterThan(0);
    Bun.sleepSync(5);
    expect(getFromCache('exp:read')).toBeNull();
    expect(getCacheMetrics().bytes).toBe(0);
  });

  test('1 件が上限より大きいときも、ほかのエントリを全部外さない（その 1 件を、メモリに入れない）。DB には入る', () => {
    const lim = mem(50_000);
    setToCache('big:small', payload(1_000), 600_000, lim);
    expect(setToCache('big:huge', payload(60_000), 600_000, lim)).toBe(true);
    expect(getCacheMetrics()).toMatchObject({ size: 1, bytes: 1_000 }); // 小さいほうが残り、大きいほうはメモリに入らない
    expect(dbGetCache('big:huge')).toBeDefined();
    getDb().run('DELETE FROM cache_entries');
    expect(getFromCache('big:small')).not.toBeNull();
    expect(getFromCache('big:huge')).toBeNull();
  });

  test('limits を渡さないとき、水準の値が上限になる（getCacheMetrics の maxBytes）', async () => {
    await withEnv({ SORA_ISOLATION: 'strict' }, () => {
      expect(getCacheMetrics().maxBytes).toBe(STRICT_LIMITS.cacheMemoryMaxBytes);
    });
    await withEnv({ SORA_ISOLATION: undefined }, () => {
      expect(getCacheMetrics().maxBytes).toBe(STANDARD_LIMITS.cacheMemoryMaxBytes);
    });
  });
});

describe('/metrics に、上限の近さが出る', () => {
  test('JSON: cache にメモリの容量・上限と、DB の行数・容量。Prometheus: 同じ値の 3 つの gauge', async () => {
    const { app } = await import('./index.js');
    setToCache('metrics:a', payload(1_000, 'a'), 600_000);
    setToCache('metrics:b', payload(2_000, 'b'), 600_000);
    const data = (await (await app.request('/metrics')).json()) as { cache: Record<string, number> };
    expect(data.cache).toMatchObject({ size: 2, bytes: 3_000, maxBytes: STANDARD_LIMITS.cacheMemoryMaxBytes, dbEntries: 2, dbBytes: 3_000 });
    const text = await (await app.request('/metrics?format=prometheus')).text();
    expect(text).toContain('\nsora_cache_memory_bytes 3000\n');
    expect(text).toContain('\nsora_cache_db_entries 2\n');
    expect(text).toContain('\nsora_cache_db_bytes 3000\n');
  });
});
