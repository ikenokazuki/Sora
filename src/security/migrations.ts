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
];
