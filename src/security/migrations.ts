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
];
