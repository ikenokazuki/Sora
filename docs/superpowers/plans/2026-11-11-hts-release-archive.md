# HTS の版の保存（hts-archive）の実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ENABLED_MODULES` に `hts-archive` を挙げたときだけ、USITC の HTS 全件の JSON を 1 日 1 回取り、中身が変わったら版ごとに保存し、REST で取り出せるようにする。

**Architecture:** `src/services/hts_archive.ts` が確認（取得・比較・保存）とタイマーを持ち、`src/routes/hts_archive.ts` が 2 つの GET を返す。保存先は HTS の全件データと同じ `htsDirectory()` の下の `releases/`。設計は `docs/superpowers/specs/2026-11-11-hts-release-archive-design.md`。

**Tech Stack:** Bun（`Bun.gzipSync`・`Bun.gunzipSync`・`bun:test`）、Hono、TypeScript。

## Global Constraints

- `hts-archive` は `all` では有効にならない（`EXPLICIT_ONLY_MODULES`）。無効なら、起動時の処理・タイマー・取得は無く、REST は 404 `MODULE_DISABLED`、OpenAPI と `GET /` の一覧にも出ない。
- 変化の判定は `exportList` の中身だけで行う。`releaseList` は名前を付けるのにだけ使い、中身が変わった日にだけ取る。
- `sha256` は `records` を、どの深さでもキーを並べ替え、空白を入れない JSON に直してから取る。保存する本文は応答のまま。
- 保存した版は消さない（同じ `id` は上書きしない）。
- 取得の時間切れは `releaseList` 30 秒、`exportList` 90 秒。User-Agent は `Sora-Trade-Compliance-Fetcher/1.0`。
- 起動から 1 分後に 1 回、そのあと 24 時間ごと。タイマーは `unref`。
- `id` の形は `^[0-9A-Za-z_-]{1,80}$`。同じ名前で中身が違うときは `<版の名前>-<YYYYMMDDTHHMM>Z`（UTC、例 `2026HTSRev22-20261112T0412Z`）。
- 文書・コミットに、Sora の外の個人のサービスの名前を書かない。

---

### Task 1: モジュールの名前を足す

**Files:**
- Modify: `src/mcp/registry.ts:5`（`SoraModule`）、`src/mcp/registry.ts:167`（`EXPLICIT_ONLY_MODULES`）
- Test: `src/hts_archive_module.test.ts`（新規。Task 3 でも使う）

**Interfaces:**
- Produces: `isModuleActive('hts-archive')`

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { isModuleActive } from './mcp/registry.js';

const savedModules = process.env.ENABLED_MODULES;
afterEach(() => {
  if (savedModules === undefined) delete process.env.ENABLED_MODULES;
  else process.env.ENABLED_MODULES = savedModules;
});

describe('hts-archive module is explicit opt-in', () => {
  test('all, wildcard and unset do not enable it; naming it does', () => {
    delete process.env.ENABLED_MODULES;
    expect(isModuleActive('hts-archive')).toBe(false);
    process.env.ENABLED_MODULES = 'all';
    expect(isModuleActive('hts-archive')).toBe(false);
    process.env.ENABLED_MODULES = '*';
    expect(isModuleActive('hts-archive')).toBe(false);
    expect(isModuleActive('hts-archive', ['all'])).toBe(false);
    process.env.ENABLED_MODULES = 'all,hts-archive';
    expect(isModuleActive('hts-archive')).toBe(true);
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — `bun test src/hts_archive_module.test.ts`（型の誤りか、`all` で true になって落ちる）
- [ ] **Step 3: 実装** — `SoraModule` の末尾に `| 'hts-archive'`、`EXPLICIT_ONLY_MODULES` を `['lyrics', 'shazam', 'hts-archive']` にする。
- [ ] **Step 4: 通るのを確かめる** — 同じコマンドで PASS、`bun run typecheck` も通る。
- [ ] **Step 5: コミット** — `feat(trade): HTS の版の保存のモジュール名 hts-archive を足す（名前を挙げたときだけ有効）`

### Task 2: 確認と保存のサービス

**Files:**
- Create: `src/services/hts_archive.ts`
- Test: `src/services/hts_archive.test.ts`

**Interfaces:**
- Consumes: `HTS_EXPORT_URL`・`htsDirectory()`（`src/services/hts_data.ts`）、`errorMessage`（`src/errors.ts`）、`isModuleActive`（Task 1）
- Produces:
  - `HTS_RELEASE_LIST_URL: string`
  - `ARCHIVE_ID_PATTERN: RegExp`
  - `interface ArchivedRelease { id: string; release: string; title: string; description: string; date: string; fetchedAt: string; sha256: string; rowCount: number; bytes: number }`
  - `interface ArchiveIndex { checkedAt: string | null; lastError: string | null; releases: ArchivedRelease[] }`
  - `canonicalSha256(records: unknown): string`
  - `readArchiveIndex(): ArchiveIndex`
  - `readArchivedRelease(id: string): Uint8Array | undefined`（保存した gzip のバイト列）
  - `checkHtsRelease(now?: () => Date): Promise<ArchiveIndex>`
  - `startHtsArchive(options?: { delayMs?: number; intervalMs?: number }): { stop(): void } | null`
  - `resetHtsArchiveForTest(): void`

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256, checkHtsRelease, readArchivedRelease, readArchiveIndex, resetHtsArchiveForTest, startHtsArchive } from './hts_archive.js';

// USITC の応答は作り物。exportList は 100 行以上の配列でないと受け付けない
const rows = (tag: string) => Array.from({ length: 120 }, (_, i) => ({ htsno: `0101.${String(i).padStart(2, '0')}`, indent: '0', description: `${tag} ${i}`, footnotes: [{ value: 'x', type: 'endnote' }] }));
const release = (name: string, status = 'current') => ({ name, title: `title ${name}`, description: `desc ${name}`, date: '10/26/2026', status });

let dir: string;
let exportBody = '';
let list: unknown[] = [];
let calls: string[] = [];
let listFails = false;
const realFetch = globalThis.fetch;
const savedDir = process.env.SORA_HTS_DIR;
const savedModules = process.env.ENABLED_MODULES;

beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url.includes('releaseList') ? 'releaseList' : 'exportList');
    if (url.includes('releaseList')) return listFails ? new Response('down', { status: 503 }) : Response.json(list);
    return new Response(exportBody, { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (savedDir === undefined) delete process.env.SORA_HTS_DIR;
  else process.env.SORA_HTS_DIR = savedDir;
  if (savedModules === undefined) delete process.env.ENABLED_MODULES;
  else process.env.ENABLED_MODULES = savedModules;
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sora-hts-archive-'));
  process.env.SORA_HTS_DIR = dir;
  resetHtsArchiveForTest();
  exportBody = JSON.stringify(rows('a'));
  list = [release('2026HTSRev22'), release('2026HTSRev21', 'archive')];
  calls = [];
  listFails = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (iso: string) => () => new Date(iso);

describe('HTS release archive', () => {
  it('saves the current release on the first check, keeping the export body as-is', async () => {
    exportBody = `  ${JSON.stringify(rows('a'), null, 1)}\n`; // 空白も含めて、そのまま残す
    const index = await checkHtsRelease(at('2026-11-12T04:12:34.567Z'));
    expect(index.lastError).toBeNull();
    expect(index.checkedAt).toBe('2026-11-12T04:12:34.567Z');
    expect(index.releases).toHaveLength(1);
    const r = index.releases[0];
    expect(r).toMatchObject({ id: '2026HTSRev22', release: '2026HTSRev22', title: 'title 2026HTSRev22', description: 'desc 2026HTSRev22', date: '10/26/2026', fetchedAt: '2026-11-12T04:12:34.567Z', rowCount: 120 });
    expect(r.sha256).toBe(canonicalSha256(rows('a')));
    const gz = readArchivedRelease('2026HTSRev22');
    expect(gz?.byteLength).toBe(r.bytes);
    const text = new TextDecoder().decode(Bun.gunzipSync(gz!));
    expect(text.endsWith(`"records":${exportBody}}`)).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ id: '2026HTSRev22', release: '2026HTSRev22', fetchedAt: '2026-11-12T04:12:34.567Z' });
    expect(JSON.parse(readFileSync(join(dir, 'releases', 'index.json'), 'utf8'))).toEqual(index);
  });

  it('treats key order and whitespace as the same content', () => {
    expect(canonicalSha256([{ b: 1, a: { d: [1, { f: 2, e: 3 }], c: 'x' } }])).toBe(canonicalSha256([{ a: { c: 'x', d: [1, { e: 3, f: 2 }] }, b: 1 }]));
    expect(canonicalSha256([{ a: 1 }])).not.toBe(canonicalSha256([{ a: 2 }]));
  });

  it('does not save or read the release list while the content is unchanged, even if the list moved on', async () => {
    await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    calls = [];
    list = [release('2026HTSRev23'), release('2026HTSRev22', 'archive')];
    exportBody = JSON.stringify(rows('a').map((r) => ({ footnotes: r.footnotes, description: r.description, indent: r.indent, htsno: r.htsno })));
    const index = await checkHtsRelease(at('2026-11-13T04:00:00Z'));
    expect(calls).toEqual(['exportList']);
    expect(index.releases.map((r) => r.id)).toEqual(['2026HTSRev22']);
    expect(index.checkedAt).toBe('2026-11-13T04:00:00.000Z');
  });

  it('saves changed content under the new release name, newest first', async () => {
    await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    list = [release('2026HTSRev23'), release('2026HTSRev22', 'archive')];
    exportBody = JSON.stringify(rows('b'));
    const index = await checkHtsRelease(at('2026-11-20T04:00:00Z'));
    expect(index.releases.map((r) => r.id)).toEqual(['2026HTSRev23', '2026HTSRev22']);
    expect(readArchivedRelease('2026HTSRev22')).toBeDefined();
  });

  it('saves changed content under the same release name with the fetch time when the list lags behind', async () => {
    await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    exportBody = JSON.stringify(rows('b'));
    const index = await checkHtsRelease(at('2026-11-14T05:06:07Z'));
    expect(index.releases.map((r) => r.id)).toEqual(['2026HTSRev22-20261114T0506Z', '2026HTSRev22']);
    expect(index.releases[0].release).toBe('2026HTSRev22');
  });

  it('does not save when the release list cannot be read, and records why', async () => {
    listFails = true;
    const index = await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    expect(index.releases).toEqual([]);
    expect(index.lastError).toContain('503');
    expect(readArchiveIndex().lastError).toContain('503');
  });

  it('rejects an export that is not a list of rows', async () => {
    exportBody = '[]';
    const index = await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    expect(index.releases).toEqual([]);
    expect(index.lastError).toContain('行');
  });

  it('reads only saved ids with the allowed shape', async () => {
    await checkHtsRelease(at('2026-11-12T04:00:00Z'));
    expect(readArchivedRelease('../index')).toBeUndefined();
    expect(readArchivedRelease('index')).toBeUndefined();
    expect(readArchivedRelease('2026HTSRev21')).toBeUndefined();
  });

  it('starts no timer unless the module is named, and checks after the delay when it is', async () => {
    process.env.ENABLED_MODULES = 'all';
    expect(startHtsArchive({ delayMs: 1 })).toBeNull();
    process.env.ENABLED_MODULES = 'all,hts-archive';
    const handle = startHtsArchive({ delayMs: 1, intervalMs: 60_000 });
    expect(handle).not.toBeNull();
    await Bun.sleep(50);
    handle?.stop();
    await checkHtsRelease(); // 走っている確認を待つ（同時の呼び出しは 1 回にまとまる）
    expect(readArchiveIndex().releases.map((r) => r.id)).toEqual(['2026HTSRev22']);
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — `bun test src/services/hts_archive.test.ts`（モジュールが無い）
- [ ] **Step 3: 実装**

```ts
// USITC の HTS の版の保存（モジュール 'hts-archive'。ENABLED_MODULES に名前を挙げたときだけ）。
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
export function readArchivedRelease(id: string): Uint8Array | undefined {
  const dir = archiveDir();
  if (!dir || !ARCHIVE_ID_PATTERN.test(id) || !readArchiveIndex().releases.some((r) => r.id === id)) return undefined;
  return readFileSync(join(dir, `${id}.json.gz`));
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
  const at = now();
  index.checkedAt = at.toISOString();
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
      const id = taken.has(current.name) ? `${current.name}-${index.checkedAt.replace(/[-:]/g, '').slice(0, 13)}Z` : current.name;
      if (taken.has(id)) throw new Error(`同じ id の版がもう保存されています: ${id}`);
      const head = { id, release: current.name, title: current.title ?? '', description: current.description ?? '', date: current.date ?? '', fetchedAt: index.checkedAt };
      // records は応答の本文を文字列のまま差し込む（USITC が返したバイト列のまま残す）
      const gz = Bun.gzipSync(new TextEncoder().encode(`${JSON.stringify(head).slice(0, -1)},"records":${body}}`));
      writeAtomic(join(dir, `${id}.json.gz`), gz);
      index.releases.unshift({ ...head, sha256, rowCount: records.length, bytes: gz.byteLength });
    }
    index.lastError = null;
  } catch (err) {
    index.lastError = errorMessage(err);
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
```

- [ ] **Step 4: 通るのを確かめる** — `bun test src/services/hts_archive.test.ts` が PASS、`bun run typecheck`・`bun run lint` が通る。
- [ ] **Step 5: コミット** — `feat(trade): HTS の全件の JSON を中身で比べ、変わったら版ごとに保存する`

### Task 3: REST・起動・一覧・OpenAPI

**Files:**
- Create: `src/routes/hts_archive.ts`
- Modify: `src/index.ts`（ルートの登録、起動時の `startHtsArchive`）、`src/routes/system.ts:86-87`（`GET /` の一覧）、`src/types.ts`（OpenAPI、shazam の節の後）
- Test: `src/hts_archive_module.test.ts`（Task 1 のファイルに足す）

**Interfaces:**
- Consumes: Task 2 の `readArchiveIndex`・`readArchivedRelease`・`ARCHIVE_ID_PATTERN`・`startHtsArchive`
- Produces: `GET /trade/hts/releases`、`GET /trade/hts/releases/:id`、`htsArchiveRoutes`

- [ ] **Step 1: 失敗するテストを足す**（`src/hts_archive_module.test.ts`）

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from './index.js';
import { generateOpenApiDocument } from './types.js';

describe('hts-archive REST', () => {
  const savedDir = process.env.SORA_HTS_DIR;
  let dir: string;
  const body = '{"id":"2026HTSRev22","release":"2026HTSRev22","records":[]}';
  const entry = { id: '2026HTSRev22', release: '2026HTSRev22', title: 't', description: 'd', date: '10/26/2026', fetchedAt: '2026-11-12T04:00:00.000Z', sha256: 'x', rowCount: 0, bytes: 0 };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sora-hts-archive-rest-'));
    process.env.SORA_HTS_DIR = dir;
    mkdirSync(join(dir, 'releases'));
    writeFileSync(join(dir, 'releases', '2026HTSRev22.json.gz'), Bun.gzipSync(new TextEncoder().encode(body)));
    writeFileSync(join(dir, 'releases', 'index.json'), JSON.stringify({ checkedAt: '2026-11-12T04:00:00.000Z', lastError: null, releases: [entry] }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.SORA_HTS_DIR;
    else process.env.SORA_HTS_DIR = savedDir;
  });

  test('answers 404 MODULE_DISABLED and stays out of the docs unless named', async () => {
    process.env.ENABLED_MODULES = 'all';
    for (const path of ['/trade/hts/releases', '/trade/hts/releases/2026HTSRev22']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('MODULE_DISABLED');
    }
    expect((generateOpenApiDocument() as any).paths['/trade/hts/releases']).toBeUndefined();
    expect(JSON.stringify(await (await app.request('/')).json())).not.toContain('/trade/hts/releases');
  });

  test('lists saved releases and returns one release, gzip or plain', async () => {
    process.env.ENABLED_MODULES = 'all,hts-archive';
    const list = await app.request('/trade/hts/releases');
    expect(await list.json()).toEqual({ checkedAt: '2026-11-12T04:00:00.000Z', lastError: null, releases: [entry] });
    const plain = await app.request('/trade/hts/releases/2026HTSRev22');
    expect(plain.headers.get('content-type')).toContain('application/json');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(body);
    const gz = await app.request('/trade/hts/releases/2026HTSRev22', { headers: { 'accept-encoding': 'gzip, br' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(body);
    expect((generateOpenApiDocument() as any).paths['/trade/hts/releases/{id}'].get).toBeDefined();
    expect(JSON.stringify(await (await app.request('/')).json())).toContain('GET /trade/hts/releases');
  });

  test('rejects a malformed id with 400 and an unknown one with 404', async () => {
    process.env.ENABLED_MODULES = 'all,hts-archive';
    expect((await app.request('/trade/hts/releases/bad.name')).status).toBe(400);
    const missing = await app.request('/trade/hts/releases/2026HTSRev21');
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('NOT_FOUND');
  });
});
```

（ファイルの先頭の import に `beforeEach` を足す。`app.request` はブラウザの Origin を付けないので、REST の Origin の検査を通る。）

- [ ] **Step 2: 失敗を確かめる** — `bun test src/hts_archive_module.test.ts`（ルートが無く 404 の code が違う、など）
- [ ] **Step 3: 実装**

`src/routes/hts_archive.ts`:

```ts
import { Hono, type Context } from 'hono';
import { isModuleActive } from '../mcp/registry.js';
import { ARCHIVE_ID_PATTERN, readArchivedRelease, readArchiveIndex } from '../services/hts_archive.js';
import { formatError } from './utils.js';

const moduleDisabled = (c: Context) =>
  formatError(c, 'hts-archive module is not enabled. Add it to ENABLED_MODULES by name (e.g. ENABLED_MODULES=all,hts-archive); "all" alone does not include it.', 'MODULE_DISABLED', 404, false);

/** HTS の版の保存（GET /trade/hts/releases, GET /trade/hts/releases/:id）。モジュール 'hts-archive' を ENABLED_MODULES に名前で挙げたときだけ応答する。 */
export const htsArchiveRoutes = new Hono();

htsArchiveRoutes.get('/trade/hts/releases', (c) => (isModuleActive('hts-archive') ? c.json(readArchiveIndex()) : moduleDisabled(c)));

htsArchiveRoutes.get('/trade/hts/releases/:id', (c) => {
  if (!isModuleActive('hts-archive')) return moduleDisabled(c);
  const id = c.req.param('id');
  if (!ARCHIVE_ID_PATTERN.test(id)) return formatError(c, 'id must match ^[0-9A-Za-z_-]{1,80}$', 'INVALID_INPUT', 400, false);
  const gz = readArchivedRelease(id);
  if (!gz) return formatError(c, `HTS release not archived: ${id}`, 'NOT_FOUND', 404, false);
  if (/\bgzip\b/.test(c.req.header('accept-encoding') ?? '')) {
    return c.body(gz, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' });
  }
  return c.body(Bun.gunzipSync(gz), 200, { 'Content-Type': 'application/json; charset=utf-8' });
});
```

`src/index.ts`:
- import に `import { htsArchiveRoutes } from './routes/hts_archive.js';`、`app.route('/', songRecognitionRoutes);` の次に `app.route('/', htsArchiveRoutes);`
- `import.meta.main` の中、住所の事前取得の次に:

```ts
  // HTS の版の保存は、ENABLED_MODULES に hts-archive を挙げた運用者だけ。挙げなければ何も読み込まず、何も始めない。
  if (isModuleActive('hts-archive')) {
    void import('./services/hts_archive.js')
      .then(({ startHtsArchive }) => startHtsArchive())
      .catch((error) => console.warn(`[Sora/HtsArchive] failed to start: ${error instanceof Error ? error.message : String(error)}`));
  }
```
（`isModuleActive` を `./mcp/registry.js` から import する。）

`src/routes/system.ts` の一覧（shazam の行の次）:

```ts
      ...(isModuleActive('hts-archive') ? { tradeHtsReleases: 'GET /trade/hts/releases, GET /trade/hts/releases/:id' } : {}),
```

`src/types.ts`（shazam の節の次、`return doc;` の前）:

```ts
  // HTS の版の保存は ENABLED_MODULES に名前を挙げたときだけ公開する（1 日 1 回 USITC から全件を取る常駐の処理を伴うため）
  if (isModuleActive('hts-archive')) {
    const release = {
      type: 'object',
      properties: {
        id: { type: 'string', description: '保存した版の名前。ふつうは版の名前、同じ名前で中身が違えば取得の時刻（UTC）付き（例 2026HTSRev22-20261112T0412Z）' },
        release: { type: 'string', description: '取得したときに USITC の版の一覧で current だった版の名前' },
        title: { type: 'string' },
        description: { type: 'string' },
        date: { type: 'string', description: '版の一覧の date（MM/DD/YYYY）' },
        fetchedAt: { type: 'string', format: 'date-time' },
        sha256: { type: 'string', description: 'records をキーを並べ替え空白を入れない JSON にした SHA-256。同じなら中身が同じ' },
        rowCount: { type: 'integer' },
        bytes: { type: 'integer', description: '保存した gzip の大きさ' },
      },
    };
    paths['/trade/hts/releases'] = {
      get: {
        summary: '保存した HTS の版の一覧 (新しい順。ENABLED_MODULES に hts-archive を挙げたときだけ)',
        responses: {
          '200': {
            description: '保存した版と、最後に確かめた時刻・最後の失敗',
            content: { 'application/json': { schema: { type: 'object', properties: { checkedAt: { type: 'string', nullable: true }, lastError: { type: 'string', nullable: true }, releases: { type: 'array', items: release } } } } },
          },
        },
      },
    };
    paths['/trade/hts/releases/{id}'] = {
      get: {
        summary: '保存した HTS の版の全件 ({id, release, title, description, date, fetchedAt, records}。records は USITC の exportList の応答のまま。Accept-Encoding に gzip があれば gzip のまま返す)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9A-Za-z_-]{1,80}$' }, description: '一覧の id' }],
        responses: { '200': { description: '版の全件の JSON' }, '400': { description: 'id の形が違う' }, '404': { description: '保存されていない版、またはモジュールが無効' } },
      },
    };
  }
```

- [ ] **Step 4: 通るのを確かめる** — `bun test src/hts_archive_module.test.ts src/services/hts_archive.test.ts src/docs_contract.test.ts src/index.test.ts`、`bun run typecheck`・`bun run lint`・`bun run schema:notation`
- [ ] **Step 5: コミット** — `feat(trade): 保存した HTS の版を REST で返す（GET /trade/hts/releases）`

### Task 4: 文書

**Files:**
- Modify: `README.md`（§2 の冒頭の段落 304 行、Module 14 の後に Module 15、§3.34 の後に §3.35、環境変数の表の `SORA_HTS_DIR` の行）、`docs/engines/hts-prediction.md`（「HTS の全件データ」の節の後）

- [ ] **Step 1: README**
  - 304 行の段落の末尾に「同じく **`hts-archive` モジュール（HTS の版の保存、REST だけ）** も `all` には含まれず、`ENABLED_MODULES=all,hts-archive` のように名前を挙げたときだけ有効になります（[Module 15](#-module-15-hts-release-archive-enabled_modulesallhts-archive)）。」を足す。
  - Module 15 の節: 目的（改訂の前後を比べるための版ごとの全件）、有効にしたときの動き（起動から 1 分後と 24 時間ごと、中身の SHA-256 で判定、一覧は名前だけ、id の付け方）、通信量（1 日 gzip で約 640KB）、保存の量（1 版約 640KB、消さない）、無効なら何も起きないこと、`docker run -e ENABLED_MODULES="all,hts-archive"` と `curl --compressed http://localhost:3016/trade/hts/releases/2026HTSRev22 -o 2026HTSRev22.json` の例。
  - §3.35 `HTS の版の保存 (GET /trade/hts/releases, GET /trade/hts/releases/:id, v4.3.0, 明示オプトイン)`: 応答の項目（設計の「保存の形」と同じ）、400・404、gzip の扱い。
  - 環境変数の表の `SORA_HTS_DIR` の行に「`hts-archive` を有効にすると、保存した版も `releases/` に置きます」を足す。
- [ ] **Step 2: docs/engines/hts-prediction.md** — 「HTS の版の保存（任意）」の小節: 推測そのものは版を保存しないこと、`hts-archive` を有効にすると版ごとの全件が残ること、README の Module 15 へのリンク。
- [ ] **Step 3: 確かめる** — `bun test src/docs_contract.test.ts`、README のアンカーが見出しと合うか目で見る。
- [ ] **Step 4: コミット** — `docs(trade): HTS の版の保存（hts-archive）の使い方`

---

## 最後の確かめ

- `bun run typecheck`・`bun run lint`・`bun run schema:notation`
- `bun test src/services src/routes src/mcp` と、契約のテスト（`src/docs_contract.test.ts`・`src/index.test.ts`・`src/hts_archive_module.test.ts`）
- 実の USITC で 1 回: 使い捨ての `SORA_HTS_DIR` で `checkHtsRelease()` を呼び、`2026HTSRev22` が保存され、もう 1 回呼ぶと `exportList` だけで終わることを見る。
