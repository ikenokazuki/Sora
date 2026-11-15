import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, sweepExpiredEntries } from './cache.js';
import {
  closeDb,
  dbGetTenantCookies,
  dbGetTenantStorage,
  dbPurgeStaleSavedState,
  dbSaveTenantCookies,
  dbSaveTenantStorage,
  getDb,
  type PersistedCookie,
} from './db.js';
import { STANDARD_LIMITS, STRICT_LIMITS } from './security/limits.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * 保存した Cookie・localStorage の上限（設計 6。穴 24）。domain_cookies_v2・domain_storage_v2 は、これまで、1 行の大きさも、1 人あたりの行数も、
 * 期限も無かった（updated_at は読まれず、掃除もしなかった）。1 行の大きさ・1 人あたりの行数に上限を置き、古い状態は読まず、消す。
 * 共有の in-memory DB を使うほかのテストの行を巻き込まないよう、ここでは、毎回、新しい DB を使う。
 */

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'saved-state-caps-'));
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
const DAY = 24 * 60 * 60 * 1000;
/** 上限だけ差し替えた値の組（ここでは、保存した状態の 3 つだけを見る） */
const caps = (extra: Partial<typeof STANDARD_LIMITS> = {}) => ({ ...STANDARD_LIMITS, savedStateMaxBytes: HUGE, savedStateRowsPerTenant: HUGE, savedStateMaxAgeMs: HUGE, ...extra });

/** 2 つの表を同じ形で試すための表（Cookie と localStorage） */
interface Kind {
  name: string;
  table: 'domain_cookies_v2' | 'domain_storage_v2';
  save: (tenant: string, domain: string, data: unknown, scope?: string, lim?: ReturnType<typeof caps>) => void;
  get: (tenant: string, domain: string, scope?: string, lim?: ReturnType<typeof caps>) => unknown;
  /** JSON にしたときの大きさが、文字数 n ぶんの本文を持つ値 */
  make: (text: string) => unknown;
  /** 値から取り出す本文 */
  text: (data: unknown) => string | undefined;
}
const KINDS: Kind[] = [
  {
    name: 'Cookie',
    table: 'domain_cookies_v2',
    save: (t, d, data, s, l) => dbSaveTenantCookies(t, d, data as PersistedCookie[], s, l),
    get: (t, d, s, l) => dbGetTenantCookies(t, d, s, l),
    make: (text) => [{ name: 's', value: text }],
    text: (data) => (data as PersistedCookie[] | undefined)?.[0]?.value,
  },
  {
    name: 'localStorage',
    table: 'domain_storage_v2',
    save: (t, d, data, s, l) => dbSaveTenantStorage(t, d, data as Record<string, string>, s, l),
    get: (t, d, s, l) => dbGetTenantStorage(t, d, s, l),
    make: (text) => ({ k: text }),
    text: (data) => (data as Record<string, string> | undefined)?.k,
  },
];
const jsonBytes = (data: unknown) => Buffer.byteLength(JSON.stringify(data));
const domains = (k: Kind, tenant: string) => (getDb().query(`SELECT domain FROM ${k.table} WHERE tenant_id = ? ORDER BY domain`).all(tenant) as Array<{ domain: string }>).map((r) => r.domain);
const setUpdatedAt = (k: Kind, tenant: string, domain: string, at: number) => getDb().query(`UPDATE ${k.table} SET updated_at = ? WHERE tenant_id = ? AND domain = ?`).run(at, tenant, domain);

describe.each(KINDS)('$name: 1 行の大きさの上限', (k) => {
  test('JSON の大きさが上限ちょうどなら保存し、1 バイト超えたら保存しない', () => {
    const data = k.make('x'.repeat(100));
    const size = jsonBytes(data);
    k.save('name:t', 'exact.example', data, 'default', caps({ savedStateMaxBytes: size }));
    expect(k.text(k.get('name:t', 'exact.example'))).toBe('x'.repeat(100));
    k.save('name:t', 'over.example', data, 'default', caps({ savedStateMaxBytes: size - 1 }));
    expect(k.get('name:t', 'over.example')).toBeUndefined();
    expect(domains(k, 'name:t')).toEqual(['exact.example']);
  });

  test('大きさは UTF-8 のバイト数で数える（日本語は 1 文字 3 バイト。文字数では数えない）', () => {
    const data = k.make('あ'.repeat(100)); // 文字数なら小さく、バイト数なら大きい
    const chars = JSON.stringify(data).length;
    const bytes = jsonBytes(data);
    expect(bytes).toBeGreaterThan(chars + 150);
    k.save('name:t', 'ja.example', data, 'default', caps({ savedStateMaxBytes: bytes - 1 }));
    expect(k.get('name:t', 'ja.example')).toBeUndefined();
    k.save('name:t', 'ja.example', data, 'default', caps({ savedStateMaxBytes: bytes }));
    expect(k.text(k.get('name:t', 'ja.example'))).toBe('あ'.repeat(100));
  });

  test('超えた書き込みは、同じ場所の前の保存を消す（古い状態を、新しい状態の代わりに戻さない）。ほかの場所は消さない', () => {
    k.save('name:t', 'a.example', k.make('first'), 'default', caps());
    k.save('name:t', 'b.example', k.make('other'), 'default', caps());
    k.save('name:t', 'a.example', k.make('y'.repeat(500)), 'default', caps({ savedStateMaxBytes: 100 }));
    expect(domains(k, 'name:t')).toEqual(['b.example']);
    expect(k.text(k.get('name:t', 'b.example'))).toBe('other');
  });

  test('JSON にできない値（循環）でも、投げない。何も保存しない', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => k.save('name:t', 'loop.example', circular, 'default', caps())).not.toThrow();
    expect(domains(k, 'name:t')).toEqual([]);
  });

  test('場所（scope）が違えば、前の保存は消さない', () => {
    k.save('name:t', 'a.example', k.make('first'), 'default', caps());
    k.save('name:t', 'a.example', k.make('y'.repeat(500)), 'other', caps({ savedStateMaxBytes: 100 }));
    expect(k.text(k.get('name:t', 'a.example'))).toBe('first');
  });

  test('ほかの人（tenant）の同じ場所の保存は、消さない', () => {
    k.save('name:alice', 'a.example', k.make('alice'), 'default', caps());
    k.save('name:bob', 'a.example', k.make('y'.repeat(500)), 'default', caps({ savedStateMaxBytes: 100 }));
    expect(k.text(k.get('name:alice', 'a.example'))).toBe('alice');
  });
});

describe.each(KINDS)('$name: 1 人あたりの行数の上限', (k) => {
  /** 古い順に d00, d01, … を保存し、保存した時刻をそれぞれ過去の別々の時刻にする（時計の同じミリ秒の同点に左右されない） */
  function fill(tenant: string, count: number, lim: ReturnType<typeof caps>) {
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < count; i++) {
      const domain = `d${String(i).padStart(2, '0')}.example`;
      k.save(tenant, domain, k.make(`v${i}`), 'default', lim);
      setUpdatedAt(k, tenant, domain, base + i * 1000);
    }
  }

  test('上限を超える書き込みでは、保存した時刻の古い行から消し、行数は上限のまま。新しい行は残る', () => {
    const lim = caps({ savedStateRowsPerTenant: 4 });
    fill('name:t', 10, lim);
    expect(domains(k, 'name:t')).toEqual(['d06.example', 'd07.example', 'd08.example', 'd09.example']);
    expect(k.get('name:t', 'd00.example')).toBeUndefined();
    expect(k.text(k.get('name:t', 'd09.example'))).toBe('v9');
  });

  test('上限ちょうどまでは、何も消さない', () => {
    fill('name:t', 4, caps({ savedStateRowsPerTenant: 4 }));
    expect(domains(k, 'name:t')).toHaveLength(4);
  });

  test('すでにある場所への上書きは、新しい行ではない（上限にいても、ほかの行を消さない）', () => {
    const lim = caps({ savedStateRowsPerTenant: 3 });
    fill('name:t', 3, lim);
    k.save('name:t', 'd00.example', k.make('again'), 'default', lim);
    expect(domains(k, 'name:t')).toHaveLength(3);
    expect(k.text(k.get('name:t', 'd00.example'))).toBe('again');
    expect(k.text(k.get('name:t', 'd02.example'))).toBe('v2');
  });

  test('上書きした行は新しくなり、次に消えるのは別の行（保存した時刻で並べる）', () => {
    const lim = caps({ savedStateRowsPerTenant: 3 });
    fill('name:t', 3, lim);
    k.save('name:t', 'd00.example', k.make('again'), 'default', lim); // 一番古かった d00 が新しくなる
    k.save('name:t', 'new.example', k.make('new'), 'default', lim); // 4 行目 → いま一番古い d01 が外れる
    expect(domains(k, 'name:t')).toEqual(['d00.example', 'd02.example', 'new.example']);
  });

  test('場所（scope）が違う保存は、別の行として数える', () => {
    const lim = caps({ savedStateRowsPerTenant: 2 });
    k.save('name:t', 'a.example', k.make('1'), 'default', lim);
    setUpdatedAt(k, 'name:t', 'a.example', Date.now() - 5000);
    k.save('name:t', 'a.example', k.make('2'), 'scope-b', lim);
    k.save('name:t', 'a.example', k.make('3'), 'scope-c', lim); // 3 行目 → 最も古い default が外れる
    expect(k.get('name:t', 'a.example', 'default')).toBeUndefined();
    expect(k.text(k.get('name:t', 'a.example', 'scope-b'))).toBe('2');
    expect(k.text(k.get('name:t', 'a.example', 'scope-c'))).toBe('3');
  });

  test('ほかの人（tenant）の行は数えず、消さない', () => {
    const lim = caps({ savedStateRowsPerTenant: 2 });
    fill('name:alice', 2, lim);
    fill('name:bob', 6, lim);
    expect(domains(k, 'name:alice')).toEqual(['d00.example', 'd01.example']);
    expect(domains(k, 'name:bob')).toHaveLength(2);
  });

  test('もう一方の表の行は数えない（Cookie と localStorage は、別々に数える）', () => {
    const other = KINDS.find((x) => x !== k)!;
    const lim = caps({ savedStateRowsPerTenant: 2 });
    fill('name:t', 2, lim);
    for (let i = 0; i < 5; i++) other.save('name:t', `o${i}.example`, other.make('o'), 'default', lim);
    expect(domains(k, 'name:t')).toEqual(['d00.example', 'd01.example']);
    expect(domains(other, 'name:t')).toHaveLength(2);
  });

  test('時計が戻って、新しい書き込みの時刻が一番古くても、いま書いた行は消さない（代わりに、ほかの一番古い行が外れる）', () => {
    const lim = caps({ savedStateRowsPerTenant: 2 });
    const T = Date.now();
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(T);
      k.save('name:t', 'a.example', k.make('a'), 'default', lim);
      k.save('name:t', 'b.example', k.make('b'), 'default', lim);
      now.mockReturnValue(T - 60_000); // 時計が 1 分戻った
      k.save('name:t', 'c.example', k.make('c'), 'default', lim);
    } finally {
      now.mockRestore();
    }
    expect(domains(k, 'name:t')).toEqual(['b.example', 'c.example']);
  });

  test.each([0, -5])('上限が %i でも、いま書いた行は残す（最低 1 行。ほかの行は消える）', (cap) => {
    const lim = caps({ savedStateRowsPerTenant: cap });
    fill('name:t', 3, caps());
    k.save('name:t', 'now.example', k.make('now'), 'default', lim);
    expect(domains(k, 'name:t')).toEqual(['now.example']);
  });

  test('古い行を消すのに失敗しても、いまの保存は残る（保存は、掃除の失敗に巻き込まれない）', () => {
    const lim = caps({ savedStateRowsPerTenant: 2.5 }); // 消す件数が整数にならず、削除の文が失敗する
    fill('name:t', 4, caps());
    k.save('name:t', 'now.example', k.make('now'), 'default', lim);
    expect(k.text(k.get('name:t', 'now.example'))).toBe('now');
    expect(domains(k, 'name:t')).toContain('now.example');
  });

  test('公開の tenant の保存は、これまでどおり何もしない（行数の上限の前の規則は変わらない）', () => {
    k.save('public', 'a.example', k.make('p'), 'default', caps({ savedStateRowsPerTenant: 5 }));
    expect(domains(k, 'public')).toEqual([]);
  });
});

describe.each(KINDS)('$name: 保存した状態の期限', (k) => {
  const MAX_AGE = 10 * DAY;
  const lim = () => caps({ savedStateMaxAgeMs: MAX_AGE });

  test('期限より古い行は読まない（期限ちょうどの行も読まない）。期限の内なら読む', () => {
    const T = Date.now();
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(T);
      for (const [domain, age] of [['fresh.example', MAX_AGE - 1], ['edge.example', MAX_AGE], ['old.example', MAX_AGE + 1]] as const) {
        k.save('name:t', domain, k.make(domain), 'default', lim());
        setUpdatedAt(k, 'name:t', domain, T - age);
      }
      expect(k.text(k.get('name:t', 'fresh.example', 'default', lim()))).toBe('fresh.example');
      expect(k.get('name:t', 'edge.example', 'default', lim())).toBeUndefined();
      expect(k.get('name:t', 'old.example', 'default', lim())).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  test('期限を過ぎた行を読めないだけで、行は消えない（消すのは、掃除）', () => {
    k.save('name:t', 'old.example', k.make('o'), 'default', lim());
    setUpdatedAt(k, 'name:t', 'old.example', Date.now() - 11 * DAY);
    expect(k.get('name:t', 'old.example', 'default', lim())).toBeUndefined();
    expect(domains(k, 'name:t')).toEqual(['old.example']);
  });

  test('保存し直した行は新しくなり、読める', () => {
    k.save('name:t', 'a.example', k.make('first'), 'default', lim());
    setUpdatedAt(k, 'name:t', 'a.example', Date.now() - 11 * DAY);
    k.save('name:t', 'a.example', k.make('second'), 'default', lim());
    expect(k.text(k.get('name:t', 'a.example', 'default', lim()))).toBe('second');
  });
});

describe('期限を過ぎた行の掃除', () => {
  const MAX_AGE = 10 * DAY;
  const lim = () => caps({ savedStateMaxAgeMs: MAX_AGE });
  function seed() {
    for (const k of KINDS) {
      for (const tenant of ['name:alice', 'name:bob']) {
        k.save(tenant, 'fresh.example', k.make('f'), 'default', lim());
        k.save(tenant, 'old.example', k.make('o'), 'default', lim());
        setUpdatedAt(k, tenant, 'old.example', Date.now() - 11 * DAY);
      }
    }
  }

  test('期限を過ぎた行を、全員ぶん、両方の表から消し、消した行数を返す。新しい行は残す', () => {
    seed();
    expect(dbPurgeStaleSavedState(lim())).toBe(4);
    for (const k of KINDS) {
      expect(domains(k, 'name:alice')).toEqual(['fresh.example']);
      expect(domains(k, 'name:bob')).toEqual(['fresh.example']);
    }
    expect(dbPurgeStaleSavedState(lim())).toBe(0);
  });

  test('期限ちょうどの行は消す。1 ミリ秒でも新しければ残す', () => {
    const k = KINDS[0];
    const T = Date.now();
    k.save('name:t', 'edge.example', k.make('e'), 'default', lim());
    k.save('name:t', 'near.example', k.make('n'), 'default', lim());
    setUpdatedAt(k, 'name:t', 'edge.example', T - MAX_AGE);
    setUpdatedAt(k, 'name:t', 'near.example', T - MAX_AGE + 1);
    expect(dbPurgeStaleSavedState(lim(), T)).toBe(1);
    expect(domains(k, 'name:t')).toEqual(['near.example']);
  });

  test('定期の掃除（sweepExpiredEntries）が、これを呼ぶ。水準の既定の期限で消す', async () => {
    const k = KINDS[1];
    k.save('name:t', 'old.example', k.make('o'), 'default', caps());
    k.save('name:t', 'fresh.example', k.make('f'), 'default', caps());
    setUpdatedAt(k, 'name:t', 'old.example', Date.now() - STANDARD_LIMITS.savedStateMaxAgeMs - DAY);
    await withEnv({ SORA_ISOLATION: undefined }, () => sweepExpiredEntries());
    expect(domains(k, 'name:t')).toEqual(['fresh.example']);
  });

  test('DB が読めなくても投げない（0 を返す）', () => {
    getDb();
    closeDb();
    // DB のファイルの置き場所の親が、ディレクトリではなくファイルなら、getDb() は投げる（存在しないディレクトリは、initDatabase が作る）
    const blocker = join(directory, 'blocker');
    writeFileSync(blocker, '');
    process.env.SORA_DB_PATH = join(blocker, 'x.db');
    expect(() => getDb()).toThrow();
    expect(dbPurgeStaleSavedState(lim())).toBe(0);
  });
});

describe('水準ごとの既定（呼び出し側は、値を渡さずに、水準の値で動く）', () => {
  test('strict は standard より小さい（行の大きさ・1 人あたりの行数・期限）', () => {
    expect(STRICT_LIMITS.savedStateMaxBytes).toBeLessThan(STANDARD_LIMITS.savedStateMaxBytes);
    expect(STRICT_LIMITS.savedStateRowsPerTenant).toBeLessThan(STANDARD_LIMITS.savedStateRowsPerTenant);
    expect(STRICT_LIMITS.savedStateMaxAgeMs).toBeLessThan(STANDARD_LIMITS.savedStateMaxAgeMs);
  });

  test.each(KINDS)('$name: 大きさ — strict で保存されず、standard で保存される値', async (k) => {
    const size = Math.floor((STRICT_LIMITS.savedStateMaxBytes + STANDARD_LIMITS.savedStateMaxBytes) / 2); // 2 つの水準の間
    const data = k.make('x'.repeat(size));
    await withEnv({ SORA_ISOLATION: 'strict' }, () => k.save('name:t', 'strict.example', data));
    expect(domains(k, 'name:t')).toEqual([]);
    await withEnv({ SORA_ISOLATION: undefined }, () => k.save('name:t', 'standard.example', data));
    expect(domains(k, 'name:t')).toEqual(['standard.example']);
  });

  test.each(KINDS)('$name: 期限 — strict で読めず、standard で読める古さ', async (k) => {
    const age = Math.floor((STRICT_LIMITS.savedStateMaxAgeMs + STANDARD_LIMITS.savedStateMaxAgeMs) / 2);
    k.save('name:t', 'a.example', k.make('a'), 'default', caps());
    setUpdatedAt(k, 'name:t', 'a.example', Date.now() - age);
    expect(await withEnv({ SORA_ISOLATION: 'strict' }, () => k.get('name:t', 'a.example'))).toBeUndefined();
    expect(k.text(await withEnv({ SORA_ISOLATION: undefined }, () => k.get('name:t', 'a.example')))).toBe('a');
  });

  test.each(KINDS)('$name: 行数 — strict の上限（既定）で外れる', async (k) => {
    const rows = STRICT_LIMITS.savedStateRowsPerTenant;
    await withEnv({ SORA_ISOLATION: 'strict' }, () => {
      const base = Date.now() - 1_000_000;
      for (let i = 0; i < rows + 1; i++) {
        k.save('name:t', `d${String(i).padStart(4, '0')}.example`, k.make('v'));
        setUpdatedAt(k, 'name:t', `d${String(i).padStart(4, '0')}.example`, base + i * 1000);
      }
    });
    expect(domains(k, 'name:t')).toHaveLength(rows);
    expect(k.get('name:t', 'd0000.example', 'default', caps())).toBeUndefined();
  });
});

describe('マイグレーション 104（索引だけを足す。既存の行は消さない）', () => {
  const INDEXES = ['idx_domain_cookies_tenant_updated', 'idx_domain_cookies_updated', 'idx_domain_storage_tenant_updated', 'idx_domain_storage_updated'];
  const indexNames = () => (getDb().query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_domain_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  /** 104 より前の形の DB にする: 索引を外し、行を入れ、移行の記録を消す */
  function makeOldDb() {
    getDb();
    for (const name of INDEXES) getDb().run(`DROP INDEX IF EXISTS ${name}`);
    getDb().run("DELETE FROM schema_migrations WHERE name = 'saved state indexes'");
    getDb().query("INSERT INTO domain_cookies_v2 (tenant_id, domain, scope, cookies_json, updated_at) VALUES ('name:t', 'old.example', 'default', '[]', ?)").run(Date.now() - 400 * DAY);
    getDb().query("INSERT INTO domain_storage_v2 (tenant_id, domain, scope, storage_json, updated_at) VALUES ('name:t', 'old.example', 'default', '{}', ?)").run(Date.now() - 400 * DAY);
  }

  test('新しい DB には、4 つの索引がある', () => {
    getDb();
    expect(indexNames()).toEqual([...INDEXES].sort());
  });

  test('索引の列: 1 人あたりの行数と古い順は (tenant_id, updated_at)、期限の掃除は (updated_at)', () => {
    getDb();
    const columns = (index: string) => (getDb().query(`PRAGMA index_info(${index})`).all() as Array<{ seqno: number; name: string }>).sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
    for (const name of ['domain_cookies', 'domain_storage']) {
      expect(columns(`idx_${name}_tenant_updated`)).toEqual(['tenant_id', 'updated_at']);
      expect(columns(`idx_${name}_updated`)).toEqual(['updated_at']);
    }
  });

  test('古い DB を開くと、索引が足される。とても古い行も、消えない（掃除が消すまで）', () => {
    makeOldDb();
    expect(indexNames()).toEqual([]);
    closeDb();
    getDb();
    expect(indexNames()).toEqual([...INDEXES].sort());
    expect(domains(KINDS[0], 'name:t')).toEqual(['old.example']);
    expect(domains(KINDS[1], 'name:t')).toEqual(['old.example']);
  });

  test('索引がすでにあるときに、もう一度流しても失敗しない', () => {
    getDb();
    getDb().run("DELETE FROM schema_migrations WHERE name = 'saved state indexes'");
    closeDb();
    expect(() => getDb()).not.toThrow();
    expect(indexNames()).toEqual([...INDEXES].sort());
  });

  test('古い行（期限を過ぎている）は、読まれず、掃除で消える。新しい行の保存は、これまでどおり', () => {
    makeOldDb();
    closeDb();
    getDb();
    expect(dbGetTenantCookies('name:t', 'old.example')).toBeUndefined();
    expect(dbPurgeStaleSavedState()).toBe(2);
    expect(domains(KINDS[0], 'name:t')).toEqual([]);
  });
});
