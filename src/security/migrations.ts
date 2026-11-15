// Versioned security migrations (RFC DB migration rules).
// Transactional via applyMigrations; legacy tables are never dropped.
import type { DbMigration } from '../db.js';

export const SECURITY_MIGRATIONS: readonly DbMigration[] = [
  {
    version: 100,
    name: 'tenant domain cookies',
    up(database) {
      database.run(`CREATE TABLE IF NOT EXISTS domain_cookies_v2 (
        tenant_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'default',
        cookies_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, domain, scope)
      )`);
      database.run(`INSERT OR IGNORE INTO domain_cookies_v2 (tenant_id, domain, scope, cookies_json, updated_at)
        SELECT 'legacy', domain, 'default', cookies_json, updated_at FROM domain_cookies`);
    },
  },
  {
    version: 101,
    name: 'tenant domain storage',
    up(database) {
      database.run(`CREATE TABLE IF NOT EXISTS domain_storage_v2 (
        tenant_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'default',
        storage_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, domain, scope)
      )`);
      database.run(`INSERT OR IGNORE INTO domain_storage_v2 (tenant_id, domain, scope, storage_json, updated_at)
        SELECT 'legacy', domain, 'default', storage_json, updated_at FROM domain_storage`);
    },
  },
  {
    version: 102,
    name: 'tenant watch targets',
    up(database) {
      // 持ち主（tenant）を記録する。旧い行は legacy（鍵なしの利用者）のものになる（見せ分けの互換の規則は作らない）。
      // watch_history には列を足さない: 履歴は対象の id でだけ引かれ（対象は、持ち主を確かめてから読む）、公開された読み口が無い
      database.run(`ALTER TABLE watch_targets ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'legacy'`);
      database.run('CREATE INDEX IF NOT EXISTS idx_watch_targets_tenant ON watch_targets(tenant_id, created_at)');
    },
  },
  {
    version: 103,
    name: 'cache entry size',
    up(database) {
      // キャッシュの容量の上限（穴 24）のため、行ごとの大きさ（JSON の UTF-8 のバイト数）を持つ。古い行は、いまの中身から埋める。
      // 索引は (expires_at, size): 期限の近い順に消すときの並びと、行数・容量の合計（表の本体を読まない）に使う。古い索引 idx_cache_expires は、これに含まれる
      database.run('ALTER TABLE cache_entries ADD COLUMN size INTEGER NOT NULL DEFAULT 0');
      database.run('UPDATE cache_entries SET size = LENGTH(CAST(value AS BLOB))');
      database.run('CREATE INDEX IF NOT EXISTS idx_cache_expires_size ON cache_entries(expires_at, size)');
      database.run('DROP INDEX IF EXISTS idx_cache_expires');
    },
  },
];
