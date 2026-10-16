// 米国 USITC の HTS（関税率表）全件のローカルコピー。使われたときだけ取得し、SQLite に保存する。
// export は中間行（"Other:" など説明だけの行）と率を含む完全な木で、各行に祖先の説明（path）と継承した率を持たせる。
// 検索は FTS5（porter）で、説明と path を引く。起動時の処理・タイマー・事前取得は持たない。
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDatabasePath } from '../db.js';
import { errorMessage } from '../errors.js';

export const HTS_EXPORT_URL = 'https://hts.usitc.gov/reststop/exportList?from=0101&to=9999&format=JSON&styles=false';
const SCHEMA_VERSION = '1';
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 古いデータで答えつつ、次の利用時に裏で更新する
const REFRESH_RETRY_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 90_000;

export interface HtsExportRow {
  htsno?: string | null;
  indent?: string | null;
  description?: string | null;
  general?: string | null;
  special?: string | null;
  other?: string | null;
}

export interface HtsLine {
  /** USITC 表記のコード。中間行（説明だけの行）は空文字。 */
  code: string;
  digits: string;
  indent: number;
  description: string;
  /** 祖先の説明（最上位から親まで）。 */
  path: string[];
  /** 継承後の率。どの祖先にも無ければ空文字。 */
  general: string;
  special: string;
  other: string;
  /** 率を継承した祖先のコード。自分の行の率なら undefined。 */
  rateFrom?: string;
  /** これより細かい行を持たない（申告に使う）行か。 */
  leaf: boolean;
}

export interface HtsSearchHit extends HtsLine {
  score: number;
}

interface LineRecord {
  id: number;
  code: string;
  digits: string;
  indent: number;
  description: string;
  path: string;
  general: string;
  special: string;
  other: string;
  rate_from: string;
  leaf: number;
}

const PATH_SEP = '\u001f';

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function toLine(r: LineRecord): HtsLine {
  return {
    code: r.code,
    digits: r.digits,
    indent: r.indent,
    description: r.description,
    path: r.path ? r.path.split(PATH_SEP) : [],
    general: r.general,
    special: r.special,
    other: r.other,
    rateFrom: r.rate_from || undefined,
    leaf: r.leaf === 1,
  };
}

/** export の行から、検索用の SQLite を組み立てる。 */
export function buildHtsDatabase(rows: HtsExportRow[], db: Database, fetchedAt: Date = new Date()): void {
  db.exec(`
    CREATE TABLE lines (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL, digits TEXT NOT NULL, indent INTEGER NOT NULL,
      description TEXT NOT NULL, path TEXT NOT NULL,
      general TEXT NOT NULL, special TEXT NOT NULL, other TEXT NOT NULL, rate_from TEXT NOT NULL,
      leaf INTEGER NOT NULL
    );
    CREATE INDEX lines_digits ON lines(digits);
    CREATE VIRTUAL TABLE lines_fts USING fts5(description, path, tokenize='porter unicode61');
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  interface Frame {
    description: string;
    code: string;
    general: string;
    special: string;
    other: string;
    /** 率の持ち主（自分の行の率ならその行、継承なら祖先）のコード。コードの無い行は説明。 */
    rateOwner: string;
  }
  const stack: Frame[] = [];
  const records: Omit<LineRecord, 'leaf'>[] = [];
  const indents: number[] = [];

  for (const [i, r] of rows.entries()) {
    // USITC の indent は、同じ見出しの配下の小見出しの番号だけが変わった行（例: 6109.10 の "Underwear (352)" の下の
    // "Women's (339)"、indent 3→5）で、中間の字下げを飛ばすことがある。深さは「直前の行より1つ深い」と読み替える
    const rawIndent = Math.max(0, Number.parseInt(r.indent ?? '0', 10) || 0);
    const prevIndent = indents.length > 0 ? indents[indents.length - 1] : -1;
    const indent = rawIndent > prevIndent ? prevIndent + 1 : rawIndent;
    stack.length = Math.min(stack.length, indent);
    const parent = stack[stack.length - 1];
    const code = clean(r.htsno);
    const own = { general: clean(r.general), special: clean(r.special), other: clean(r.other) };
    const description = clean(r.description);
    const frame: Frame = {
      description,
      code,
      general: own.general || parent?.general || '',
      special: own.special || parent?.special || '',
      other: own.other || parent?.other || '',
      rateOwner: own.general ? code || description : (parent?.rateOwner ?? ''),
    };
    records.push({
      id: i + 1,
      code,
      digits: code.replace(/\D/g, ''),
      indent,
      description,
      path: stack.map((f) => f.description).join(PATH_SEP),
      general: frame.general,
      special: frame.special,
      other: frame.other,
      rate_from: own.general ? '' : frame.rateOwner,
    });
    indents.push(indent);
    stack[indent] = frame;
  }

  const insertLine = db.prepare('INSERT INTO lines VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insertFts = db.prepare('INSERT INTO lines_fts(rowid, description, path) VALUES (?,?,?)');
  db.transaction(() => {
    for (const [i, r] of records.entries()) {
      // 葉: 次の行が自分と同じかそれより浅い（これより細かい行を持たない）
      const leaf = i === records.length - 1 || indents[i + 1] <= indents[i] ? 1 : 0;
      insertLine.run(r.id, r.code, r.digits, r.indent, r.description, r.path, r.general, r.special, r.other, r.rate_from, leaf);
      // 検索の対象は、申告に使う行（葉で、コードがあり、98・99 章を除く）
      if (leaf === 1 && r.digits.length >= 8 && !/^9[89]/.test(r.digits)) {
        insertFts.run(r.id, r.description, r.path.split(PATH_SEP).join(' '));
      }
    }
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('fetched_at', fetchedAt.toISOString());
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('lines', String(records.length));
  })();
}

async function fetchExport(): Promise<HtsExportRow[]> {
  const res = await fetch(HTS_EXPORT_URL, {
    headers: { 'User-Agent': 'Sora-Trade-Compliance-Fetcher/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`USITC HTS全件データの取得に失敗しました (HTTP ${res.status}): ${HTS_EXPORT_URL}`);
  const rows = (await res.json()) as HtsExportRow[];
  if (!Array.isArray(rows) || rows.length < 100) throw new Error('USITC HTS全件データの形式が想定と違います（行数が少なすぎます）');
  return rows;
}

/** 保存先のディレクトリ。テスト（DB が :memory:）で SORA_HTS_DIR が無いときは undefined（メモリ上に置く）。 */
function htsDirectory(): string | undefined {
  if (process.env.SORA_HTS_DIR) return process.env.SORA_HTS_DIR;
  const dbPath = getDatabasePath();
  return dbPath === ':memory:' ? undefined : join(dirname(dbPath), 'hts');
}

function readMeta(db: Database, key: string): string | undefined {
  try {
    return (db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null)?.value;
  } catch {
    return undefined;
  }
}

async function buildNew(dir: string | undefined): Promise<Database> {
  const rows = await fetchExport();
  if (!dir) {
    const mem = new Database(':memory:');
    buildHtsDatabase(rows, mem);
    return mem;
  }
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, 'hts.sqlite');
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  for (const p of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) rmSync(p, { force: true });
  const tmp = new Database(tmpPath, { create: true });
  try {
    buildHtsDatabase(rows, tmp);
  } catch (err) {
    tmp.close();
    rmSync(tmpPath, { force: true });
    throw err;
  }
  tmp.close();
  renameSync(tmpPath, finalPath);
  return new Database(finalPath, { readonly: true });
}

let current: Database | undefined;
let loading: Promise<Database> | undefined;
let refreshing = false;
let nextRefreshAllowedAt = 0;

function openExisting(dir: string | undefined): Database | undefined {
  if (!dir) return undefined;
  const file = join(dir, 'hts.sqlite');
  if (!existsSync(file)) return undefined;
  try {
    const db = new Database(file, { readonly: true });
    if (readMeta(db, 'schema_version') !== SCHEMA_VERSION) {
      db.close();
      return undefined;
    }
    return db;
  } catch {
    return undefined;
  }
}

function isStale(db: Database): boolean {
  const fetchedAt = Date.parse(readMeta(db, 'fetched_at') ?? '');
  return !Number.isFinite(fetchedAt) || Date.now() - fetchedAt > REFRESH_AFTER_MS;
}

function refreshInBackground(dir: string | undefined): void {
  if (refreshing || Date.now() < nextRefreshAllowedAt) return;
  refreshing = true;
  buildNew(dir)
    .then((fresh) => {
      const old = current;
      current = fresh;
      // 進行中の検索が古い接続を使い終えるのを待ってから閉じる
      if (old) setTimeout(() => old.close(), 30_000).unref?.();
    })
    .catch((err) => {
      nextRefreshAllowedAt = Date.now() + REFRESH_RETRY_MS;
      console.warn('[HtsData] refresh failed, keep serving the existing copy:', errorMessage(err));
    })
    .finally(() => {
      refreshing = false;
    });
}

/** HTS のデータベースを返す。無ければ初回だけ取得して作る（約 12 秒）。同時の要求は 1 回の取得にまとめる。 */
async function getDb(): Promise<Database> {
  if (current) {
    if (isStale(current)) refreshInBackground(htsDirectory());
    return current;
  }
  if (!loading) {
    const dir = htsDirectory();
    loading = (async () => {
      const existing = openExisting(dir);
      if (existing) {
        current = existing;
        if (isStale(existing)) refreshInBackground(dir);
        return existing;
      }
      const built = await buildNew(dir);
      current = built;
      return built;
    })().finally(() => {
      loading = undefined;
    });
  }
  return loading;
}

/** テスト用: 保持しているデータベースを捨てる。 */
export function resetHtsDataForTest(): void {
  current?.close();
  current = undefined;
  loading = undefined;
  refreshing = false;
  nextRefreshAllowedAt = 0;
}

const STOPWORDS = new Set(
  'a an and or of the for with without in on to by from at as is are be it its this that these those your our new set pack pcs piece pieces one two three other not than such'.split(' '),
);

/** 商品の文章から検索語を取り出す。数量の単位（500ml など）と英字の無い語は捨てる。 */
export function queryTerms(text: string, maxTerms = 40): string[] {
  const normalized = text.toLowerCase().replace(/\d+(?:\.\d+)?\s*[a-z]{1,3}\b/g, ' ');
  const terms = new Set<string>();
  for (const m of normalized.matchAll(/[a-z][a-z0-9]*/g)) {
    const w = m[0];
    if (w.length >= 2 && !STOPWORDS.has(w)) terms.add(w);
    if (terms.size >= maxTerms) break;
  }
  return [...terms];
}

/** 検索語を FTS5 の OR クエリにする。 */
export function toFtsQuery(text: string, maxTerms = 40): string {
  return queryTerms(text, maxTerms).map((w) => `"${w}"`).join(' OR ');
}

/** 英字の語（数量の単位を除く）を含むか。 */
export function hasEnglishWords(text: string): boolean {
  return queryTerms(text, 1).length > 0;
}

/** 申告に使う行を、説明と祖先の説明の全文検索で引く（bm25。説明を祖先より重く見る）。 */
export async function searchHtsLines(text: string, opts: { prefix?: string; limit?: number } = {}): Promise<HtsSearchHit[]> {
  const query = toFtsQuery(text);
  if (!query) return [];
  const db = await getDb();
  const prefix = opts.prefix?.replace(/\D/g, '');
  const sql = `
    SELECT l.*, -bm25(lines_fts, 3.0, 1.0) AS score
    FROM lines_fts JOIN lines l ON l.id = lines_fts.rowid
    WHERE lines_fts MATCH ?${prefix ? ' AND l.digits LIKE ?' : ''}
    ORDER BY score DESC LIMIT ?`;
  const params: (string | number)[] = prefix ? [query, `${prefix}%`, opts.limit ?? 50] : [query, opts.limit ?? 50];
  const rows = db.query(sql).all(...params) as (LineRecord & { score: number })[];
  return rows.map((r) => ({ ...toLine(r), score: r.score }));
}

/** コード（4〜10 桁、区切りは自由）の行を 1 つ返す。 */
export async function getHtsLine(code: string): Promise<HtsLine | undefined> {
  const digits = code.replace(/\D/g, '');
  if (digits.length < 4) return undefined;
  const db = await getDb();
  const r = db.query('SELECT * FROM lines WHERE digits = ? ORDER BY id LIMIT 1').get(digits) as LineRecord | null;
  return r ? toLine(r) : undefined;
}

/** 指定コードで始まる行（コードのある行だけ）。leafOnly で申告に使う行に絞る。 */
export async function htsLinesUnder(prefix: string, opts: { leafOnly?: boolean; limit?: number } = {}): Promise<HtsLine[]> {
  const digits = prefix.replace(/\D/g, '');
  if (digits.length < 4) return [];
  const db = await getDb();
  const rows = db
    .query(`SELECT * FROM lines WHERE digits LIKE ?${opts.leafOnly ? ' AND leaf = 1' : ''} ORDER BY id LIMIT ?`)
    .all(`${digits}%`, opts.limit ?? 200) as LineRecord[];
  return rows.map(toLine);
}

export async function htsDataInfo(): Promise<{ fetchedAt: string; lines: number }> {
  const db = await getDb();
  return { fetchedAt: readMeta(db, 'fetched_at') ?? '', lines: Number(readMeta(db, 'lines') ?? 0) };
}
