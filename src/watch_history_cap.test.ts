import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache } from './cache.js';
import { closeDb, dbInsertWatchHistory, dbListWatchHistory, dbSaveWatchTarget, getDb, WATCH_HISTORY_TRIM_BATCH } from './db.js';
import { STANDARD_LIMITS, STRICT_LIMITS } from './security/limits.js';
import { getSecurityMetrics, resetSecurityMetrics } from './security/metrics.js';
import { withEnv } from './test_fixtures/env.js';

/**
 * ウォッチの履歴（watch_history）の件数の上限（設計 6。穴 24）。内容が変わるたびに 1 行（差分の要約と最大 2000 文字の写し）が増え、
 * 1 つの対象あたりの上限は無かった（古い行の掃除は 180 日だけ。E38: 内容が変わるページを 300 回確認すると 299 行）。
 * 1 つの対象につき、新しい方から watchHistoryPerTarget 件だけ持つ。
 * 共有の in-memory DB を使うほかのテストの行を巻き込まないよう、ここでは、毎回、新しい DB を使う。
 */

let directory: string;
let previousPath: string | undefined;

beforeEach(() => {
  closeDb();
  previousPath = process.env.SORA_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'watch-history-cap-'));
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

const HUGE = Number.MAX_SAFE_INTEGER;
const caps = (watchHistoryPerTarget: number) => ({ ...STANDARD_LIMITS, watchHistoryPerTarget });
const newTarget = (url = 'https://example.com/') => dbSaveWatchTarget({ tenantId: 't', url }).id;

/** 時刻を決めて 1 行足す。足した行の要約（diff_summary）は label */
function add(targetId: string, label: string, at: number, lim = caps(HUGE)) {
  const now = spyOn(Date, 'now').mockReturnValue(at);
  try {
    return dbInsertWatchHistory({ watch_target_id: targetId, diff_summary: label, snapshot: `snap-${label}` }, lim);
  } finally {
    now.mockRestore();
  }
}
/** 残っている行の要約を、書いた時刻の古い順に */
const labels = (targetId: string) =>
  (getDb().query('SELECT diff_summary AS s FROM watch_history WHERE watch_target_id = ? ORDER BY detected_at, rowid').all(targetId) as Array<{ s: string }>).map((r) => r.s);

describe('1 つの対象あたりの履歴の件数', () => {
  test('上限を超えたら、書いた時刻の古い行から消し、新しい上限件数だけ残す', () => {
    const id = newTarget();
    for (let i = 1; i <= 5; i++) add(id, `h${i}`, 1000 + i, caps(3));
    expect(labels(id)).toEqual(['h3', 'h4', 'h5']);
  });

  test('ちょうど上限までは、消さない', () => {
    const id = newTarget();
    for (let i = 1; i <= 3; i++) add(id, `h${i}`, 1000 + i, caps(3));
    expect(labels(id)).toEqual(['h1', 'h2', 'h3']);
  });

  test('上限 1 のとき、いま足した行だけが残る', () => {
    const id = newTarget();
    add(id, 'a', 1001, caps(1));
    add(id, 'b', 1002, caps(1));
    expect(labels(id)).toEqual(['b']);
  });

  test('ほかの対象の履歴は、数えず、消さない', () => {
    const a = newTarget('https://a.example/');
    const b = newTarget('https://b.example/');
    for (let i = 1; i <= 4; i++) add(b, `b${i}`, 500 + i, caps(HUGE));
    for (let i = 1; i <= 4; i++) add(a, `a${i}`, 1000 + i, caps(2));
    expect(labels(a)).toEqual(['a3', 'a4']);
    expect(labels(b)).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  test('時計が戻って、いま足した行の時刻が一番古くなっても、いま足した行は消さない', () => {
    const id = newTarget();
    add(id, 'old1', 5000, caps(2));
    add(id, 'old2', 6000, caps(2));
    add(id, 'now', 100, caps(2)); // 時刻が一番古い
    expect(labels(id)).toContain('now');
    expect(labels(id)).toHaveLength(2);
    expect(labels(id)).toEqual(['now', 'old2']); // 消えたのは、残りのうち古い方（old1）
  });

  test('同じ時刻の行は、足した順に古い方から消す', () => {
    const id = newTarget();
    for (const label of ['s1', 's2', 's3', 's4']) add(id, label, 7000, caps(2));
    expect(labels(id)).toEqual(['s3', 's4']);
  });

  test('すでに上限を超えている対象（上限を入れる前の行）は、次の 1 件で、上限まで一度に減る', () => {
    const id = newTarget();
    for (let i = 1; i <= 20; i++) add(id, `p${i}`, 1000 + i, caps(HUGE));
    expect(labels(id)).toHaveLength(20);
    add(id, 'p21', 2000, caps(5));
    expect(labels(id)).toEqual(['p17', 'p18', 'p19', 'p20', 'p21']);
  });

  test.each([0, -3, 0.5, Number.NaN])('上限が小さすぎる値 %p でも、いま足した行は 1 件残る', (cap) => {
    const id = newTarget();
    add(id, 'a', 1001, caps(HUGE));
    add(id, 'b', 1002, caps(cap));
    expect(labels(id)).toEqual(['b']);
  });

  test('上限が小数のとき、切り捨てた件数を残す', () => {
    const id = newTarget();
    for (let i = 1; i <= 5; i++) add(id, `h${i}`, 1000 + i, caps(2.9));
    expect(labels(id)).toEqual(['h4', 'h5']);
  });

  test('足した行の中身は、これまでと同じ値で返る', () => {
    const id = newTarget();
    const record = add(id, 'x', 4242, caps(1));
    expect(record).toMatchObject({ watch_target_id: id, diff_summary: 'x', snapshot: 'snap-x', detected_at: 4242 });
    expect(record.id).toMatch(/^wh_[0-9a-f]{12}$/);
    expect(dbListWatchHistory(id)).toEqual([record]);
  });
});

describe('すでに大きく超えている対象は、1 回の追加で消す行数を区切る（同期の処理を長く止めない）', () => {
  /** 1 つの対象に、時刻 1000, 1001, … の行を n 行、まとめて足す（上限を入れる前の DB の形） */
  function seed(targetId: string, n: number): void {
    const db = getDb();
    const insert = db.query('INSERT INTO watch_history (id, watch_target_id, diff_summary, snapshot, detected_at) VALUES (?, ?, ?, ?, ?)');
    db.run('BEGIN');
    for (let i = 0; i < n; i++) insert.run(`seed${i}`, targetId, `s${i}`, null, 1000 + i);
    db.run('COMMIT');
  }
  const total = (id: string) => (getDb().query('SELECT COUNT(*) AS n FROM watch_history WHERE watch_target_id = ?').get(id) as { n: number }).n;

  test('1 回に消すのは WATCH_HISTORY_TRIM_BATCH 行まで。足りない分は、次の追加で続きを消し、上限に収まる', () => {
    const id = newTarget();
    const cap = 100;
    seed(id, WATCH_HISTORY_TRIM_BATCH + 500);
    add(id, 'next1', 1_000_000, caps(cap)); // 5,501 行 → 5,000 行消す → 501 行
    expect(total(id)).toBe(WATCH_HISTORY_TRIM_BATCH + 501 - WATCH_HISTORY_TRIM_BATCH);
    add(id, 'next2', 1_000_001, caps(cap)); // 502 行 → 402 行消す → 100 行
    expect(total(id)).toBe(cap);
    expect(labels(id).slice(-2)).toEqual(['next1', 'next2']);
  });

  test('区切りに満たない超過は、1 回で上限まで減る（通常の追加は、1 行ずつ）', () => {
    const id = newTarget();
    seed(id, 50);
    add(id, 'n', 1_000_000, caps(10));
    expect(total(id)).toBe(10);
  });
});

describe('古い行を消すのに失敗したとき', () => {
  test('次の追加で、消す文がまた通れば、まとめて上限まで減る（やり直す）', () => {
    const id = newTarget();
    add(id, 'a', 1001, caps(HUGE));
    add(id, 'b', 1002, caps(HUGE));
    getDb().run(`CREATE TRIGGER block_history_delete BEFORE DELETE ON watch_history BEGIN SELECT RAISE(ABORT, 'delete blocked'); END`);
    add(id, 'c', 1003, caps(1)); // 消せない: 3 行のまま
    expect(labels(id)).toEqual(['a', 'b', 'c']);
    getDb().run('DROP TRIGGER block_history_delete');
    add(id, 'd', 1004, caps(1)); // 次の追加: 消せる
    expect(labels(id)).toEqual(['d']);
  });

  test('足した行は残り、例外は投げず、書き込みの失敗に数える', () => {
    const id = newTarget();
    add(id, 'a', 1001, caps(HUGE));
    add(id, 'b', 1002, caps(HUGE));
    // 履歴の行を消す文だけを失敗させる（足す文は通る）
    getDb().run(`CREATE TRIGGER block_history_delete BEFORE DELETE ON watch_history BEGIN SELECT RAISE(ABORT, 'delete blocked'); END`);
    let record: ReturnType<typeof dbInsertWatchHistory> | undefined;
    expect(() => {
      record = add(id, 'c', 1003, caps(1));
    }).not.toThrow();
    expect(record?.diff_summary).toBe('c');
    expect(labels(id)).toEqual(['a', 'b', 'c']);
    expect(getSecurityMetrics()['sora_db_write_failures_total']).toBe(1);
  });

  test('足す文そのものの失敗は、これまでどおり、投げる（呼ぶ側が扱う）', () => {
    expect(() => add('wt_missing', 'x', 1001)).toThrow(); // 外部キー（対象が無い）
  });
});

describe('水準ごとの既定', () => {
  test('値の表: strict 100・standard 1,000（strict は standard より小さい）', () => {
    expect(STRICT_LIMITS.watchHistoryPerTarget).toBe(100);
    expect(STANDARD_LIMITS.watchHistoryPerTarget).toBe(1000);
    expect(STRICT_LIMITS.watchHistoryPerTarget).toBeLessThan(STANDARD_LIMITS.watchHistoryPerTarget);
  });

  test('上限を渡さないとき、SORA_ISOLATION の水準の値で上限がかかる', async () => {
    const id = newTarget();
    await withEnv({ SORA_ISOLATION: 'strict' }, () => {
      for (let i = 1; i <= STRICT_LIMITS.watchHistoryPerTarget + 5; i++) {
        const now = spyOn(Date, 'now').mockReturnValue(1000 + i);
        try {
          dbInsertWatchHistory({ watch_target_id: id, diff_summary: `h${i}` });
        } finally {
          now.mockRestore();
        }
      }
    });
    const rows = labels(id);
    expect(rows).toHaveLength(STRICT_LIMITS.watchHistoryPerTarget);
    expect(rows.at(-1)).toBe(`h${STRICT_LIMITS.watchHistoryPerTarget + 5}`);
  });

  test('standard は、strict の件数では消さない', async () => {
    const id = newTarget();
    await withEnv({ SORA_ISOLATION: undefined }, () => {
      for (let i = 1; i <= STRICT_LIMITS.watchHistoryPerTarget + 5; i++) {
        const now = spyOn(Date, 'now').mockReturnValue(1000 + i);
        try {
          dbInsertWatchHistory({ watch_target_id: id, diff_summary: `h${i}` });
        } finally {
          now.mockRestore();
        }
      }
    });
    expect(labels(id)).toHaveLength(STRICT_LIMITS.watchHistoryPerTarget + 5);
  });
});

describe('書き込みのたびの数え方', () => {
  test('1 つの対象の件数は、索引（対象, 時刻）だけで数え、古い順の取り出しは、並べ替えない', () => {
    const count = getDb().query('EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM watch_history WHERE watch_target_id = ?').all('x') as Array<{ detail: string }>;
    expect(count.map((p) => p.detail).join(' ')).toContain('COVERING INDEX idx_watch_history_target');
    const order = getDb()
      .query('EXPLAIN QUERY PLAN SELECT rowid FROM watch_history WHERE watch_target_id = ? AND id <> ? ORDER BY detected_at, rowid LIMIT 5')
      .all('x', 'y') as Array<{ detail: string }>;
    expect(order.map((p) => p.detail).join(' ')).toContain('idx_watch_history_target');
    expect(order.map((p) => p.detail).join(' ')).not.toContain('TEMP B-TREE');
  });
});
