import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';

let dbInstance: Database | null = null;

export function getDatabasePath(): string {
  if (process.env.NODE_ENV === 'test' && !process.env.SORA_DB_PATH) {
    return ':memory:';
  }
  return process.env.SORA_DB_PATH || './data/sora.db';
}

export function initDatabase(dbPath?: string): Database {
  if (dbInstance) return dbInstance;

  const targetPath = dbPath || getDatabasePath();
  if (targetPath !== ':memory:') {
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(targetPath, { create: true });

  // WAL モード & パフォーマンス設定
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA synchronous = NORMAL;');
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA temp_store = MEMORY;');

  // 1. 永続キャッシュテーブル
  db.run(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);`);

  // 2. API キー使用量 & レート制限テーブル
  db.run(`
    CREATE TABLE IF NOT EXISTS api_usage (
      api_key_hash TEXT NOT NULL,
      date TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (api_key_hash, date)
    );
  `);

  // 3. 汎用 URL 監視ターゲットテーブル
  db.run(`
    CREATE TABLE IF NOT EXISTS watch_targets (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      selector TEXT,
      last_hash TEXT,
      last_content TEXT,
      webhook_url TEXT,
      interval_seconds INTEGER DEFAULT 3600,
      last_checked_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);

  // 4. 差分検知履歴テーブル
  db.run(`
    CREATE TABLE IF NOT EXISTS watch_history (
      id TEXT PRIMARY KEY,
      watch_target_id TEXT NOT NULL,
      diff_summary TEXT,
      snapshot TEXT,
      detected_at INTEGER NOT NULL,
      FOREIGN KEY(watch_target_id) REFERENCES watch_targets(id) ON DELETE CASCADE
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_watch_history_target ON watch_history(watch_target_id, detected_at);`);

  // 5. ドメイン単位の Cookie 永続化テーブル（bot対策突破後のセッション再利用用）
  db.run(`
    CREATE TABLE IF NOT EXISTS domain_cookies (
      domain TEXT PRIMARY KEY,
      cookies_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // 6. ドメイン単位の localStorage 永続化テーブル（Cookieだけでは引き継がれないトークン等の再利用用）
  db.run(`
    CREATE TABLE IF NOT EXISTS domain_storage (
      domain TEXT PRIMARY KEY,
      storage_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  dbInstance = db;

  // Cookie/APIキー使用量等の機微データを含むため、同一マシンの他ユーザーから
  // 読めないようオーナーのみ読み書き可能に制限する（デフォルトumaskだと644になりうる）。
  if (targetPath !== ':memory:') {
    try {
      chmodSync(targetPath, 0o600);
      if (existsSync(`${targetPath}-wal`)) chmodSync(`${targetPath}-wal`, 0o600);
      if (existsSync(`${targetPath}-shm`)) chmodSync(`${targetPath}-shm`, 0o600);
    } catch {}
  }

  return db;
}

export function getDb(): Database {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {}
    dbInstance = null;
  }
}

// ==========================================
// 永続キャッシュ DAO
// ==========================================

export function dbGetCache<T = any>(key: string): { value: T; expiresAt: number } | undefined {
  try {
    const db = getDb();
    const row = db.query<{ value: string; expires_at: number }, [string, number]>(
      'SELECT value, expires_at FROM cache_entries WHERE key = ? AND expires_at > ? LIMIT 1',
    ).get(key, Date.now());

    if (!row) return undefined;
    return {
      value: JSON.parse(row.value) as T,
      expiresAt: row.expires_at,
    };
  } catch {
    return undefined;
  }
}

export function dbSetCache<T = any>(key: string, value: T, ttlSeconds: number): void {
  try {
    const db = getDb();
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const jsonStr = JSON.stringify(value);

    db.query(`
      INSERT INTO cache_entries (key, value, expires_at, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `).run(key, jsonStr, expiresAt, now);
  } catch (err) {
    console.warn('[Sora/DB] Failed to set cache entry:', err);
  }
}

export function dbDeleteCache(key: string): boolean {
  try {
    const db = getDb();
    const res = db.query('DELETE FROM cache_entries WHERE key = ?').run(key);
    return res.changes > 0;
  } catch {
    return false;
  }
}

export function dbClearExpiredCache(): number {
  try {
    const db = getDb();
    const res = db.query('DELETE FROM cache_entries WHERE expires_at <= ?').run(Date.now());
    return res.changes;
  } catch {
    return 0;
  }
}

export function dbClearAllCache(): number {
  try {
    const db = getDb();
    const res = db.query('DELETE FROM cache_entries').run();
    return res.changes;
  } catch {
    return 0;
  }
}

// ==========================================
// 汎用 watch/diff DAO
// ==========================================

export interface WatchTargetRecord {
  id: string;
  url: string;
  title?: string;
  selector?: string;
  last_hash?: string;
  last_content?: string;
  webhook_url?: string;
  interval_seconds: number;
  last_checked_at?: number;
  created_at: number;
}

export interface WatchHistoryRecord {
  id: string;
  watch_target_id: string;
  diff_summary?: string;
  snapshot?: string;
  detected_at: number;
}

export function dbSaveWatchTarget(target: {
  id?: string;
  url: string;
  title?: string;
  selector?: string;
  last_hash?: string;
  last_content?: string;
  webhook_url?: string;
  interval_seconds?: number;
}): WatchTargetRecord {
  const db = getDb();
  const id = target.id || `wt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = Date.now();
  const interval = target.interval_seconds || 3600;

  db.query(`
    INSERT INTO watch_targets (id, url, title, selector, last_hash, last_content, webhook_url, interval_seconds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      title = excluded.title,
      selector = excluded.selector,
      last_hash = excluded.last_hash,
      last_content = excluded.last_content,
      webhook_url = excluded.webhook_url,
      interval_seconds = excluded.interval_seconds
  `).run(
    id,
    target.url,
    target.title || null,
    target.selector || null,
    target.last_hash || null,
    target.last_content || null,
    target.webhook_url || null,
    interval,
    now,
  );

  return dbGetWatchTarget(id)!;
}

export function dbGetWatchTarget(id: string): WatchTargetRecord | undefined {
  try {
    const db = getDb();
    const row = db.query<WatchTargetRecord, [string]>('SELECT * FROM watch_targets WHERE id = ?').get(id);
    return row || undefined;
  } catch {
    return undefined;
  }
}

export function dbListWatchTargets(): WatchTargetRecord[] {
  try {
    const db = getDb();
    return db.query<WatchTargetRecord, []>('SELECT * FROM watch_targets ORDER BY created_at DESC').all();
  } catch {
    return [];
  }
}

export function dbUpdateWatchTargetCheck(id: string, hash: string, content?: string): void {
  try {
    const db = getDb();
    db.query(`
      UPDATE watch_targets
      SET last_hash = ?, last_content = ?, last_checked_at = ?
      WHERE id = ?
    `).run(hash, content || null, Date.now(), id);
  } catch (err) {
    console.warn('[Sora/DB] Failed to update watch target check:', err);
  }
}

export function dbDeleteWatchTarget(id: string): boolean {
  try {
    const db = getDb();
    const res = db.query('DELETE FROM watch_targets WHERE id = ?').run(id);
    return res.changes > 0;
  } catch {
    return false;
  }
}

export function dbInsertWatchHistory(history: {
  watch_target_id: string;
  diff_summary?: string;
  snapshot?: string;
}): WatchHistoryRecord {
  const db = getDb();
  const id = `wh_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = Date.now();

  db.query(`
    INSERT INTO watch_history (id, watch_target_id, diff_summary, snapshot, detected_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, history.watch_target_id, history.diff_summary || null, history.snapshot || null, now);

  return {
    id,
    watch_target_id: history.watch_target_id,
    diff_summary: history.diff_summary,
    snapshot: history.snapshot,
    detected_at: now,
  };
}

export function dbListWatchHistory(targetId: string, limit = 20): WatchHistoryRecord[] {
  try {
    const db = getDb();
    return db.query<WatchHistoryRecord, [string, number]>(
      'SELECT * FROM watch_history WHERE watch_target_id = ? ORDER BY detected_at DESC LIMIT ?',
    ).all(targetId, limit);
  } catch {
    return [];
  }
}

// ==========================================
// API 使用量 & レート制限 DAO
// ==========================================

export function dbIncrementApiUsage(apiKeyHash: string, dateStr: string): number {
  try {
    const db = getDb();
    db.query(`
      INSERT INTO api_usage (api_key_hash, date, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(api_key_hash, date) DO UPDATE SET
        request_count = request_count + 1
    `).run(apiKeyHash, dateStr);

    const row = db.query<{ request_count: number }, [string, string]>(
      'SELECT request_count FROM api_usage WHERE api_key_hash = ? AND date = ?',
    ).get(apiKeyHash, dateStr);

    return row ? row.request_count : 1;
  } catch {
    return 1;
  }
}

// ==========================================
// ドメイン単位 Cookie 永続化 DAO
// ==========================================

export interface PersistedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  expiresAtMs?: number;
}

export function dbSaveDomainCookies(domain: string, cookies: PersistedCookie[]): void {
  try {
    const db = getDb();
    db.query(`
      INSERT INTO domain_cookies (domain, cookies_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        cookies_json = excluded.cookies_json,
        updated_at = excluded.updated_at
    `).run(domain, JSON.stringify(cookies), Date.now());
  } catch {}
}

export function dbGetDomainCookies(domain: string): PersistedCookie[] | undefined {
  try {
    const db = getDb();
    const row = db.query<{ cookies_json: string }, [string]>(
      'SELECT cookies_json FROM domain_cookies WHERE domain = ?',
    ).get(domain);
    if (!row) return undefined;
    const cookies: PersistedCookie[] = JSON.parse(row.cookies_json);
    const now = Date.now();
    return cookies.filter((c) => c.expiresAtMs === undefined || c.expiresAtMs > now);
  } catch {
    return undefined;
  }
}

export function dbSaveDomainStorage(domain: string, storage: Record<string, string>): void {
  try {
    const db = getDb();
    db.query(`
      INSERT INTO domain_storage (domain, storage_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        storage_json = excluded.storage_json,
        updated_at = excluded.updated_at
    `).run(domain, JSON.stringify(storage), Date.now());
  } catch {}
}

export function dbGetDomainStorage(domain: string): Record<string, string> | undefined {
  try {
    const db = getDb();
    const row = db.query<{ storage_json: string }, [string]>(
      'SELECT storage_json FROM domain_storage WHERE domain = ?',
    ).get(domain);
    if (!row) return undefined;
    return JSON.parse(row.storage_json);
  } catch {
    return undefined;
  }
}
