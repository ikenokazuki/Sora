import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, dbGetWatchTarget, dbListWatchTargets, getDb } from '../db.js';

/** tenant の列ができる前の watch_targets（v4 までの形） */
const OLD_WATCH_SCHEMA = `CREATE TABLE watch_targets (
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
)`;

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'watch-migration-'));
});
afterEach(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SORA_DB_PATH;
  else process.env.SORA_DB_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
});

describe('watch_targets の tenant の列（移行 102）', () => {
  test('tenant の列が無い旧い DB を開くと、既存の行は legacy の tenant になり、別の tenant には見えない', () => {
    const path = join(directory, 'old.db');
    const old = new Database(path);
    old.run(OLD_WATCH_SCHEMA);
    old.run(`INSERT INTO watch_targets (id, url, title, webhook_url, created_at) VALUES ('wt_old', 'https://example.com/old', '旧', 'https://hooks.example.com/old', 1)`);
    old.close();

    process.env.SORA_DB_PATH = path;
    expect(dbListWatchTargets('legacy').map((t) => t.id)).toEqual(['wt_old']);
    expect(dbGetWatchTarget('wt_old', 'legacy')?.title).toBe('旧');
    expect(dbListWatchTargets('name:alice')).toEqual([]);
    expect(dbGetWatchTarget('wt_old', 'name:alice')).toBeUndefined();
    expect(dbGetWatchTarget('wt_old', 'key:0123456789abcdef')).toBeUndefined();
  });

  test('移行は 1 回だけ。2 回目に開いても、行は変わらず、失敗しない', () => {
    const path = join(directory, 'twice.db');
    const old = new Database(path);
    old.run(OLD_WATCH_SCHEMA);
    old.run(`INSERT INTO watch_targets (id, url, created_at) VALUES ('wt_old', 'https://example.com/old', 1)`);
    old.close();

    process.env.SORA_DB_PATH = path;
    expect(dbListWatchTargets('legacy')).toHaveLength(1);
    closeDb();
    expect(dbListWatchTargets('legacy')).toHaveLength(1);
    const versions = getDb().query<{ version: number }, []>('SELECT version FROM schema_migrations WHERE version = 102').all();
    expect(versions).toHaveLength(1);
  });

  test('新しい DB でも、tenant の列と、tenant で絞る索引がある。列の既定は legacy', () => {
    process.env.SORA_DB_PATH = join(directory, 'fresh.db');
    const db = getDb();
    const columns = db.query<{ name: string; notnull: number; dflt_value: string | null }, []>('PRAGMA table_info(watch_targets)').all();
    const tenant = columns.find((c) => c.name === 'tenant_id');
    expect(tenant).toBeDefined();
    expect(tenant?.notnull).toBe(1);
    expect(tenant?.dflt_value).toBe("'legacy'");
    const indexes = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'watch_targets'").all();
    expect(indexes.map((i) => i.name)).toContain('idx_watch_targets_tenant');
  });
});
