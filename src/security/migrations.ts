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
      // キャッシュの容量の上限（穴 24）のため、行ごとの大きさ（JSON の UTF-8 のバイト数）を持つ。既存の行は消さない（移行は既存のデータを消さない規則）。
      // 古い行の大きさは埋めない（既定の 0 のまま）: 全行を書き直すと、起動が DB の大きさに比例して遅くなり（540MB で 4 秒、2.7GB で 80 秒）、
      // その間、同じ DB を開く別のプロセスの起動が衝突するため。大きさ 0 の行は、容量の合計に数えられず、期限が来るか、行数の上限で
      // 書いた時刻の古い順に外れるまで残る（キャッシュには、期限がある）。
      // 列の有無を先に見る（ALTER は冪等でない。並行する起動が、同じ移行を 2 回流しても失敗しない）
      const columns = database.query<{ name: string }, []>('PRAGMA table_info(cache_entries)').all();
      if (!columns.some((c) => c.name === 'size')) {
        database.run('ALTER TABLE cache_entries ADD COLUMN size INTEGER NOT NULL DEFAULT 0');
      }
      // 索引: (expires_at, size) は、行数・容量の合計と、期限切れの削除（表の本体を読まない）。created_at は、満杯のときに、書いた時刻の古い順に消すため。
      // 古い索引 idx_cache_expires は、(expires_at, size) に含まれる
      database.run('CREATE INDEX IF NOT EXISTS idx_cache_expires_size ON cache_entries(expires_at, size)');
      database.run('CREATE INDEX IF NOT EXISTS idx_cache_created ON cache_entries(created_at)');
      database.run('DROP INDEX IF EXISTS idx_cache_expires');
    },
  },
  {
    version: 104,
    name: 'saved state indexes',
    up(database) {
      // 保存した Cookie・localStorage の上限（穴 24）のための索引だけを足す。既存の行は消さない（移行は既存のデータを消さない規則）。
      // (tenant_id, updated_at): 1 人あたりの行数を数え、保存した時刻の古い行から消す。updated_at の列は、大きな JSON の列より後ろにあるので、
      //   索引が無いと、時刻を読むために JSON の続きのページまで読む。
      // (updated_at): 期限を過ぎた行の掃除（全員ぶん）。無いと、表の全行を読む
      for (const [table, name] of [['domain_cookies_v2', 'domain_cookies'], ['domain_storage_v2', 'domain_storage']]) {
        database.run(`CREATE INDEX IF NOT EXISTS idx_${name}_tenant_updated ON ${table}(tenant_id, updated_at)`);
        database.run(`CREATE INDEX IF NOT EXISTS idx_${name}_updated ON ${table}(updated_at)`);
      }
    },
  },
];
