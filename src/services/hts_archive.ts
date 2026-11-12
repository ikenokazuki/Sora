// USITC の HTS の版の保存（モジュール 'hts-archive'。SORA_MODULES に名前を挙げたときだけ）。
// 全件の JSON（exportList）を 1 日 1 回取り、中身が最後に保存した版と違うときだけ、版の一覧（releaseList）の現行版の名前を付けて保存する。
// 一覧はデータの更新と同時に書き換わるとは限らないので、変わったかどうかは中身だけで決める。保存した版は消さない。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../errors.js';
import { isModuleActive } from '../mcp/registry.js';
import { HTS_EXPORT_URL, htsDirectory } from './hts_data.js';

export const HTS_RELEASE_LIST_URL = 'https://hts.usitc.gov/reststop/releaseList';
export const ARCHIVE_ID_PATTERN = /^[0-9A-Za-z_-]{1,80}$/;
const USER_AGENT = 'Sora-Trade-Compliance-Fetcher/1.0';
const EXPORT_TIMEOUT_MS = 90_000;
const LIST_TIMEOUT_MS = 30_000;
const START_DELAY_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArchivedRelease {
  /** 保存した版の名前。ふつうは版の名前。同じ名前で中身が違えば取得の時刻（UTC、分まで）を付ける。 */
  id: string;
  /** 取得したときに版の一覧で current だった版の名前。 */
  release: string;
  title: string;
  description: string;
  /** 版の一覧の date（MM/DD/YYYY）のまま。 */
  date: string;
  fetchedAt: string;
  /** records を決まった形（キーを並べ替え、空白なし）の JSON にした SHA-256。 */
  sha256: string;
  rowCount: number;
  /** 保存した gzip の大きさ。 */
  bytes: number;
}

export interface ArchiveIndex {
  checkedAt: string | null;
  lastError: string | null;
  /** 新しく保存したものが先頭。 */
  releases: ArchivedRelease[];
}

interface ReleaseListRow {
  name?: string;
  title?: string;
  description?: string;
  date?: string;
  status?: string;
}

function archiveDir(): string | undefined {
  const dir = htsDirectory();
  return dir ? join(dir, 'releases') : undefined;
}

/** records を、どの深さでもキーを並べ替え、空白を入れない JSON にしてから SHA-256 を取る。キーの順や空白だけの違いは同じ中身とみなす。 */
export function canonicalSha256(records: unknown): string {
  const json = JSON.stringify(records, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, (value as Record<string, unknown>)[k]]))
      : value,
  );
  return createHash('sha256').update(json).digest('hex');
}

export function readArchiveIndex(): ArchiveIndex {
  const dir = archiveDir();
  const file = dir ? join(dir, 'index.json') : undefined;
  if (!file || !existsSync(file)) return { checkedAt: null, lastError: null, releases: [] };
  return JSON.parse(readFileSync(file, 'utf8')) as ArchiveIndex;
}

/** 保存した版の gzip のバイト列。一覧に無い id や形の違う id は undefined。 */
export function readArchivedRelease(id: string): Uint8Array<ArrayBuffer> | undefined {
  const dir = archiveDir();
  if (!dir || !ARCHIVE_ID_PATTERN.test(id) || !readArchiveIndex().releases.some((r) => r.id === id)) return undefined;
  return new Uint8Array(readFileSync(join(dir, `${id}.json.gz`)));
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

async function get(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`USITC の取得に失敗しました (HTTP ${res.status}): ${url}`);
  return res.text();
}

async function runCheck(now: () => Date): Promise<ArchiveIndex> {
  const dir = archiveDir();
  if (!dir) throw new Error('HTS の版の保存先がありません（SORA_HTS_DIR を指定してください）');
  mkdirSync(dir, { recursive: true });
  const index = readArchiveIndex();
  const checkedAt = now().toISOString();
  index.checkedAt = checkedAt;
  try {
    const body = await get(HTS_EXPORT_URL, EXPORT_TIMEOUT_MS);
    const records = JSON.parse(body) as unknown;
    if (!Array.isArray(records) || records.length < 100) throw new Error('USITC の全件データの形が想定と違います（行が少なすぎます）');
    const sha256 = canonicalSha256(records);
    if (index.releases[0]?.sha256 !== sha256) {
      const list = JSON.parse(await get(HTS_RELEASE_LIST_URL, LIST_TIMEOUT_MS)) as ReleaseListRow[];
      const current = Array.isArray(list) ? list.find((r) => r.status === 'current') : undefined;
      if (!current?.name || !ARCHIVE_ID_PATTERN.test(current.name)) throw new Error('版の一覧に現行版（status: current）が見つかりません');
      const taken = new Set(index.releases.map((r) => r.id));
      // 一覧が遅れて、同じ版の名前のまま中身が変わったときは、取得の時刻（UTC、分まで）を付けて別に残す
      const id = taken.has(current.name) ? `${current.name}-${checkedAt.replace(/[-:]/g, '').slice(0, 13)}Z` : current.name;
      if (taken.has(id)) throw new Error(`同じ id の版がもう保存されています: ${id}`);
      const head = { id, release: current.name, title: current.title ?? '', description: current.description ?? '', date: current.date ?? '', fetchedAt: checkedAt };
      // records は応答の本文を文字列のまま差し込む（USITC が返したバイト列のまま残す）
      const gz = Bun.gzipSync(new TextEncoder().encode(`${JSON.stringify(head).slice(0, -1)},"records":${body}}`));
      writeAtomic(join(dir, `${id}.json.gz`), gz);
      index.releases.unshift({ ...head, sha256, rowCount: records.length, bytes: gz.byteLength });
    }
    index.lastError = null;
  } catch (err) {
    index.lastError = errorMessage(err) ?? String(err);
    console.warn(`[Sora/HtsArchive] check failed: ${index.lastError}`);
  }
  writeAtomic(join(dir, 'index.json'), JSON.stringify(index, null, 2));
  return index;
}

let running: Promise<ArchiveIndex> | undefined;

/** 1 回確かめる。同時の呼び出しは 1 回にまとめる。取得の失敗は index の lastError に残す（保存先が無いときだけ失敗で返す）。 */
export function checkHtsRelease(now: () => Date = () => new Date()): Promise<ArchiveIndex> {
  running ??= runCheck(now).finally(() => {
    running = undefined;
  });
  return running;
}

/**
 * サーバの起動時に呼ぶ。モジュール 'hts-archive' が有効で保存先があれば、少し待ってから 1 回、そのあと 24 時間ごとに確かめる。
 * 無効なら何もしない（null）。
 */
export function startHtsArchive(options: { delayMs?: number; intervalMs?: number } = {}): { stop(): void } | null {
  if (!isModuleActive('hts-archive')) return null;
  if (!archiveDir()) {
    console.warn('[Sora/HtsArchive] no storage directory (set SORA_HTS_DIR); not starting');
    return null;
  }
  const run = () => {
    checkHtsRelease().catch((err) => console.warn(`[Sora/HtsArchive] check failed: ${errorMessage(err)}`));
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    run();
    interval = setInterval(run, options.intervalMs ?? DAY_MS);
    interval.unref();
  }, options.delayMs ?? START_DELAY_MS);
  first.unref();
  return {
    stop: () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}

/** テスト用: 走っている確認を忘れる。 */
export function resetHtsArchiveForTest(): void {
  running = undefined;
}
