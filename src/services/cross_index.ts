// CBP の分類判例（CROSS）の手元の索引。CBP の API はボット対策の後ろにあり、プログラムからは引けないため、公開の判例データから作った
// 索引を Sora のリリースから取得し、SQLite の FTS5 にして引く。HTS の全件データと同じく、使われたときだけ取得し、起動時の処理や
// タイマーは持たない。用意ができるまでは呼び出し側が全文検索だけで答える（準備中の間、検索は undefined を返す）。
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { envError, envStr, envUrl } from '../config.js';
import { errorMessage } from '../errors.js';
import type { CrossRuling } from './cbp_cross.js';
import { htsDirectory, queryTerms } from './hts_data.js';

export const CROSS_INDEX_URL = 'https://github.com/ikenokazuki/Sora/releases/download/cross-index-1/cross-rulings-index-1.jsonl.gz';
export const CROSS_INDEX_SHA256 = 'cdb7b121d62a969aa73492b285616b5b661047bf09e82ce522f92fadb029d861';
export const CROSS_RULING_URL = 'https://rulings.cbp.gov/ruling/';
/** 索引に ATLAS の判例が入るときに表示する出典（Apache-2.0 の表示の義務）。 */
export const CROSS_INDEX_ATTRIBUTION =
  'CBP の分類判例（米国政府の著作物）から作った索引。品名・説明は判例の原文を書き直したもの。一部の判例は “CROSS Rulings HTS Dataset for Tariff Classification by Flexify.AI Inc. (https://www.flexify.ai)” （https://huggingface.co/datasets/flexifyai/cross_rulings_hts_dataset_for_tariffs）の問い文を、名前を消して使用。';
const SCHEMA_VERSION = '1';
const FETCH_TIMEOUT_MS = 120_000;
const RETRY_MS = 60 * 60 * 1000;

/** 索引の 1 行（gzip の JSONL。1 行目は見出し {"schema":1,...}）。n が空の行は判例番号の無い判例（票だけに使い、根拠には出さない）。 */
export interface CrossIndexLine {
  n: string;
  d: string;
  t: string;
  x: string;
  c: string[];
}

/** 索引の取り先。運用者の索引（URL と SHA-256 の組）が読めないときは、リリースの索引に黙って戻さず、初回の利用で失敗する。 */
function source(): { url: string; sha256: string } {
  const invalidUrl = envError('SORA_HTS_CROSS_INDEX_URL');
  if (invalidUrl) throw new Error(invalidUrl);
  const url = envUrl('SORA_HTS_CROSS_INDEX_URL');
  if (!url) return { url: CROSS_INDEX_URL, sha256: CROSS_INDEX_SHA256 };
  const sha256 = envStr('SORA_HTS_CROSS_INDEX_SHA256');
  if (!sha256) throw new Error('SORA_HTS_CROSS_INDEX_URL を使うときは SORA_HTS_CROSS_INDEX_SHA256（16 進 64 字の小文字）も指定してください');
  return { url, sha256 };
}

/** 索引のファイル（gzip の JSONL）から SQLite を組み立てる。 */
export function buildCrossDatabase(lines: CrossIndexLine[], db: Database, sha256: string): void {
  db.exec(`
    CREATE TABLE rulings (id INTEGER PRIMARY KEY, number TEXT NOT NULL, date TEXT NOT NULL, subject TEXT NOT NULL, tariffs TEXT NOT NULL);
    CREATE VIRTUAL TABLE rulings_fts USING fts5(title, description, tokenize='porter unicode61');
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insert = db.prepare('INSERT INTO rulings VALUES (?,?,?,?,?)');
  const insertFts = db.prepare('INSERT INTO rulings_fts(rowid, title, description) VALUES (?,?,?)');
  db.transaction(() => {
    for (const [i, l] of lines.entries()) {
      insert.run(i + 1, l.n, l.d, l.t, l.c.join(' '));
      insertFts.run(i + 1, l.t, l.x);
    }
    for (const [k, v] of [['schema_version', SCHEMA_VERSION], ['sha256', sha256], ['rulings', String(lines.length)]]) {
      db.prepare('INSERT INTO meta VALUES (?, ?)').run(k, v);
    }
  })();
}

async function download(): Promise<{ lines: CrossIndexLine[]; sha256: string }> {
  const { url, sha256 } = source();
  const res = await fetch(url, { headers: { 'User-Agent': 'Sora-Trade-Compliance-Fetcher/1.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`判例の索引の取得に失敗しました (HTTP ${res.status}): ${url}`);
  const gz = new Uint8Array(await res.arrayBuffer());
  const got = createHash('sha256').update(gz).digest('hex');
  if (got !== sha256) throw new Error(`判例の索引の SHA-256 が違います（期待 ${sha256.slice(0, 12)}…、実際 ${got.slice(0, 12)}…）`);
  const text = new TextDecoder().decode(Bun.gunzipSync(gz));
  const [head, ...rows] = text.split('\n').filter((l) => l.trim());
  if ((JSON.parse(head) as { schema?: number }).schema !== Number(SCHEMA_VERSION)) throw new Error('判例の索引の形式の版が違います');
  return { lines: rows.map((l) => JSON.parse(l) as CrossIndexLine), sha256 };
}

function openExisting(file: string, sha256: string): Database | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const db = new Database(file, { readonly: true });
    const meta = (k: string) => (db.query('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | null)?.value;
    if (meta('schema_version') === SCHEMA_VERSION && meta('sha256') === sha256) return db;
    db.close();
  } catch {
    // 壊れたファイルは作り直す
  }
  return undefined;
}

async function build(): Promise<Database> {
  const { lines, sha256 } = await download();
  const dir = htsDirectory();
  if (!dir) {
    const mem = new Database(':memory:');
    buildCrossDatabase(lines, mem, sha256);
    return mem;
  }
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, 'cross.sqlite');
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  for (const p of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) rmSync(p, { force: true });
  const tmp = new Database(tmpPath, { create: true });
  try {
    buildCrossDatabase(lines, tmp, sha256);
  } finally {
    tmp.close();
  }
  renameSync(tmpPath, finalPath);
  return new Database(finalPath, { readonly: true });
}

let current: Database | undefined;
let loading: Promise<Database> | undefined;
let lastError: string | undefined;
let retryAt = 0;

/** 索引を用意する（取得・確かめ・組み立て）。同時の要求は 1 回にまとめる。失敗したら 1 時間は取り直さない。 */
export function ensureCrossIndex(): Promise<Database> {
  if (current) return Promise.resolve(current);
  if (!loading) {
    loading = (async () => {
      const dir = htsDirectory();
      const existing = dir ? openExisting(join(dir, 'cross.sqlite'), source().sha256) : undefined;
      current = existing ?? (await build());
      lastError = undefined;
      return current;
    })()
      .catch((err) => {
        lastError = errorMessage(err);
        retryAt = Date.now() + RETRY_MS;
        throw err;
      })
      .finally(() => {
        loading = undefined;
      });
  }
  return loading;
}

/** 索引がまだ無いときの説明（準備中・取得の失敗）。用意ができていれば undefined。 */
export function crossIndexPendingNote(): string {
  return lastError ? `判例の索引を用意できませんでした（${lastError}）` : '判例の索引を準備中です（初めての利用で取得しています）';
}

/**
 * 照会語の全部の語を含む判例を、bm25 の順に limit 件と、該当の件数を返す（CBP の検索と同じく AND）。
 * 索引の用意ができていなければ、裏で用意を始めて undefined を返す。
 */
export function searchCrossIndex(term: string, limit: number): { rulings: CrossRuling[]; totalHits: number } | undefined {
  if (!current) {
    if (!loading && Date.now() >= retryAt) ensureCrossIndex().catch(() => {});
    return undefined;
  }
  const words = queryTerms(term);
  if (words.length === 0) return { rulings: [], totalHits: 0 };
  const match = words.map((w) => `"${w}"`).join(' AND ');
  const totalHits = (current.query('SELECT count(*) AS n FROM rulings_fts WHERE rulings_fts MATCH ?').get(match) as { n: number }).n;
  type Row = { id: number; number: string; date: string; subject: string; tariffs: string };
  const sql = `SELECT r.id, r.number, r.date, r.subject, r.tariffs FROM rulings_fts JOIN rulings r ON r.id = rulings_fts.rowid
       WHERE rulings_fts MATCH ? ORDER BY bm25(rulings_fts, 2.0, 1.0) LIMIT ?`;
  // 品名だけで先に引く形は dev で下がった（品名と説明を合わせて bm25 で並べる）
  const rows = current.query(sql).all(match, limit) as Row[];
  return {
    totalHits,
    rulings: rows.map((r) => ({
      // 判例番号の無い判例は、重複を除く鍵だけ作り、URL は空（根拠には出さない）
      rulingNumber: r.number || `unnumbered:${r.id}`,
      date: r.date,
      subject: r.subject,
      tariffs: r.tariffs.split(' ').filter(Boolean),
      url: r.number ? `${CROSS_RULING_URL}${encodeURIComponent(r.number)}` : '',
    })),
  };
}

/** テスト用: 保持している索引を捨てる。 */
export function resetCrossIndexForTest(): void {
  current?.close();
  current = undefined;
  loading = undefined;
  lastError = undefined;
  retryAt = 0;
}
