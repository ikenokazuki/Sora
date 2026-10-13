# 住所データ基盤（構築層） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ABR と日本郵便の一次データを、市区町村単位の成果物として構築し、版つきで保存・公開・破棄・再確認できる土台（構築層）を作る。

**Architecture:** 構築ジョブ（`master` / `postal` / `city`）が、取得元の署名を確かめ、変わっていれば作業ディレクトリで構築・検証してから `address/` 配下へ版つきで公開する。状態は `status.json` に持ち、ロックで排他する。この計画はプロセスの外に出ない純粋な処理だけを扱う。待ち行列、子プロセス、ライブラリ連携、ツール登録は、続く計画「住所ツール（取得・正規化・登録）」で行う（段B・`reverse_geocode`・`checks`・既存ツールとの統合はさらに後続）。

**Tech Stack:** Bun、TypeScript、`bun:sqlite`、`yauzl`、`papaparse`、`@geolonia/japanese-numeral`。`@geolonia/normalize-japanese-addresses` はこの計画で依存に加え、次の計画から使う。

**Spec:** [住所データ基盤と住所ツールの設計](../specs/2026-10-13-address-data-design.md)

作成日: 2026-10-13。対象: v2.38.0、`feat/geo-address-data`（worktree `/home/ikeno/.worktrees/Sora/geo-address-data`）。

## Global Constraints

仕様書の制約を、各タスクが暗黙に満たす。

- 使わないユーザーに何も起こらない: 起動時の処理、常駐タイマー、ダウンロード、子プロセス、ディスク書き込みを持たない。住所モジュールは最初に使われるまで読み込まない。この計画のモジュールは、どれも読み込んだだけでは副作用を起こさない。
- 設定の環境変数と既定値: `SORA_ADDRESS`=`lazy`、`SORA_ADDRESS_DIR`=`dirname(getDatabasePath())/address`、`SORA_ADDRESS_MAX_MB`=2048、`SORA_ADDRESS_WAIT_MS`=20000、`SORA_ADDRESS_BUILD_CONCURRENCY`=1。
- 構築は別プロセス（`os.setPriority(0, 10)`）で行い、同時実行は既定で 1 件。
- 差し替えは作業ディレクトリで作って検証してから、版つきのディレクトリへ rename し、`status.json` を一時ファイルから rename する。旧版は直近 1 つを残す。
- ABR の URL は `https://data.address-br.digital.go.jp/` 配下の固定の規則。日本郵便はページから zip のリンクを解決し、失敗したら既知の直 URL を使う。
- 出典の文言: ABR は「『アドレス・ベース・レジストリ』（デジタル庁）（https://dataset.address-br.digital.go.jp/）を加工して作成（加工: Sora）」。
- ツールの説明文は `【` で始まり、`直結`・`必須`・`公式`・`速報` のいずれかを含み、`返却:` を含める（既存の契約テストの規則）。
- 座標は `lat` / `lon` で表す。`level` は 0（解析できず）、1（都道府県）、2（市区町村）、3（町丁目）、8（番地・号）。
- エラーコード: 入力の誤りは `INVALID_INPUT`（400）、データを取得できないときは `ADDRESS_DATA_UNAVAILABLE`（502、`retryable: true`、メッセージに HTTP ステータスを含める）、無効化は `ADDRESS_DISABLED`（404）。仕様書の 503 は `formatError` が扱えないため 502 にする（続く計画で仕様書を直す）。
- テストは通信なしで固定データだけを使う。`NODE_ENV=test SORA_DB_PATH=:memory:`。実行は `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy` のうえ、nix の Chromium を `CHROME_PATH` に指定する。手元の bun は 1.3.3（CI は 1.4.2）。
- コミットは英語の Conventional Commits。attribution 行（Co-Authored-By など）を付けない。push・リリースはしない。
- ユーザーが編集中の `docs/operations/fetcher.md` に触れない。

## File Structure

新規（`src/services/`、テストは隣の `*.test.ts`）:

| ファイル | 責務 |
|---|---|
| `address_errors.ts` | 住所機能の例外クラス（入力・無効化・取得不能・待ち時間切れ） |
| `address_config.ts` | 環境変数の読み取りと既定値、`addressEnabled()` |
| `address_names.ts` | 市区町村名・コードの共通関数と、`ja.json` / `town.json` の型 |
| `address_store.ts` | `status.json`、ロック、版つきディレクトリ、破棄、`BuildJob` 型と TTL |
| `address_http.ts` | HEAD 署名、ダウンロード、リトライ、日本郵便のリンク解決 |
| `address_csv.ts` | zip の最初のエントリの読み取りと CSV の解析 |
| `address_abr.ts` | ABR から `ja.json` と市区町村の `town.json` を作る（段A） |
| `postal_code.ts` | KEN_ALL / JIGYOSYO の解析、SQLite の構築と読み取り、町字への結びつけ、逆引き |
| `address_jobs.ts` | 構築ジョブ（master / postal / city）の実行 |

続く計画「住所ツール（取得・正規化・登録）」で追加するもの: `address_build_main.ts`（子プロセスの入口）、`address_data.ts`（待ち行列・single flight・待ち時間の打ち切り・子プロセス起動）、`address_normalize.ts`（仮想ファイルとライブラリ連携）、`address_tools.ts`（ツールの入口）、`types.ts` / `mcp.ts` / `routes/public_data.ts` / `routes/system.ts` / `scripts/tool-health/catalog.ts` / `Containerfile` / `README.md` への登録。

テスト用の補助（`src/test_fixtures/address/`）: `zip.ts`（保存のみの zip 書き出し）、`jigyosyo.ts`（事業所番号の Shift_JIS 固定データ）、`harness.ts`（偽の取得元）。

変更: `package.json` / `bun.lock` のみ。

## Task 1: 依存・設定・例外・名前

**Files:**
- Modify: `package.json`、`bun.lock`
- Create: `src/services/address_errors.ts`、`src/services/address_config.ts`、`src/services/address_names.ts`
- Test: `src/services/address_config.test.ts`、`src/services/address_names.test.ts`

**Interfaces:**
- Produces（`address_errors.ts`）: `class AddressInputError extends Error`、`class AddressDisabledError extends Error`、`class AddressUnavailableError extends Error { blocked: boolean }`、`class AddressPendingError extends Error { pending: string }`。
- Produces（`address_config.ts`）: `type AddressMode = 'off' | 'lazy' | 'eager'`、`interface AddressConfig { mode; dir; maxBytes; waitMs; concurrency; preload: string[] | 'all' | null }`、`loadAddressConfig(env?, dbPath?): AddressConfig`、`addressEnabled(env?): boolean`。
- Produces（`address_names.ts`）: `lgCode6(code: number | string): string`、`cityNameOf(c: { county?: string; city: string; ward?: string }): string`、型 `JaCity` `JaPref` `JaJson` `TownEntry` `TownJson`。

- [ ] **Step 1: 依存を追加する**

```bash
bun add --exact @geolonia/normalize-japanese-addresses@3.1.3
bun add @geolonia/japanese-numeral@^1.0.2 papaparse@^5.4.1
bun add -d @types/papaparse
```

Expected: `package.json` の `dependencies` に 3 つ、`devDependencies` に `@types/papaparse` が入り、`bun.lock` が更新される。

- [ ] **Step 2: 失敗するテストを書く（設定）**

`src/services/address_config.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { addressEnabled, loadAddressConfig } from './address_config.js';

const MB = 1024 * 1024;

describe('loadAddressConfig', () => {
  test('既定は lazy で、保存先はデータベースの隣', () => {
    expect(loadAddressConfig({}, '/data/sora.db')).toEqual({
      mode: 'lazy', dir: '/data/address', maxBytes: 2048 * MB, waitMs: 20000, concurrency: 1, preload: null,
    });
  });

  test('インメモリのデータベースでは一時ディレクトリを使う', () => {
    expect(loadAddressConfig({}, ':memory:').dir).toContain('sora-address-');
  });

  test('すべての設定を環境変数から読む', () => {
    const config = loadAddressConfig({
      SORA_ADDRESS: 'EAGER', SORA_ADDRESS_DIR: '/tmp/x/../addr', SORA_ADDRESS_MAX_MB: '512',
      SORA_ADDRESS_WAIT_MS: '5000', SORA_ADDRESS_BUILD_CONCURRENCY: '2', SORA_ADDRESS_PRELOAD: '13, 27,1',
    }, '/data/sora.db');
    expect(config).toEqual({
      mode: 'eager', dir: '/tmp/addr', maxBytes: 512 * MB, waitMs: 5000, concurrency: 2, preload: ['13', '27', '01'],
    });
  });

  test('不正な値は既定値に戻す', () => {
    const config = loadAddressConfig({
      SORA_ADDRESS: 'maybe', SORA_ADDRESS_MAX_MB: '-1', SORA_ADDRESS_WAIT_MS: 'abc',
      SORA_ADDRESS_BUILD_CONCURRENCY: '99', SORA_ADDRESS_PRELOAD: 'tokyo',
    }, '/data/sora.db');
    expect(config).toMatchObject({ mode: 'lazy', maxBytes: 2048 * MB, waitMs: 20000, concurrency: 1, preload: null });
  });

  test('PRELOAD は all を受け付ける', () => {
    expect(loadAddressConfig({ SORA_ADDRESS_PRELOAD: 'ALL' }, '/data/sora.db').preload).toBe('all');
  });

  test('addressEnabled は off のときだけ false', () => {
    expect(addressEnabled({})).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS: 'lazy' })).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS: 'eager' })).toBe(true);
    expect(addressEnabled({ SORA_ADDRESS: 'off' })).toBe(false);
    expect(addressEnabled({ SORA_ADDRESS: ' OFF ' })).toBe(false);
  });
});
```

`src/services/address_names.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { cityNameOf, lgCode6 } from './address_names.js';

describe('address names', () => {
  test('lgCode6 は 6 桁に 0 埋めする', () => {
    expect(lgCode6(11011)).toBe('011011');
    expect(lgCode6('131016')).toBe('131016');
    expect(lgCode6(130001)).toBe('130001');
  });

  test('cityNameOf は郡・市・区を連結する', () => {
    expect(cityNameOf({ city: '千代田区' })).toBe('千代田区');
    expect(cityNameOf({ city: '札幌市', ward: '中央区' })).toBe('札幌市中央区');
    expect(cityNameOf({ county: '足柄上郡', city: '中井町' })).toBe('足柄上郡中井町');
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `bun test src/services/address_config.test.ts src/services/address_names.test.ts`
Expected: FAIL（`Cannot find module './address_config.js'` など）。

- [ ] **Step 4: 実装する**

`src/services/address_errors.ts`:

```ts
/** 住所機能の例外。REST と MCP でのエラーの種類をここで決める。 */

/** 入力の誤り（REST では INVALID_INPUT / 400）。 */
export class AddressInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressInputError';
  }
}

/** SORA_ADDRESS=off で無効化されている（REST では ADDRESS_DISABLED / 404）。 */
export class AddressDisabledError extends Error {
  constructor() {
    super('住所機能は SORA_ADDRESS=off で無効化されています');
    this.name = 'AddressDisabledError';
  }
}

/** 必要なデータを取得できない（国外からの接続拒否、通信失敗、取得元の形式変更）。REST では ADDRESS_DATA_UNAVAILABLE / 502。 */
export class AddressUnavailableError extends Error {
  constructor(message: string, readonly blocked = false) {
    super(message);
    this.name = 'AddressUnavailableError';
  }
}

/** 待ち時間の上限までにデータが揃わなかった。呼び出し側は取れている範囲で答える。 */
export class AddressPendingError extends Error {
  constructor(readonly pending: string) {
    super(`address data pending: ${pending}`);
    this.name = 'AddressPendingError';
  }
}
```

`src/services/address_config.ts`:

```ts
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getDatabasePath } from '../db.js';

export type AddressMode = 'off' | 'lazy' | 'eager';

export interface AddressConfig {
  mode: AddressMode;
  /** 保存先（絶対パス）。 */
  dir: string;
  /** ディスク予算（バイト）。 */
  maxBytes: number;
  /** 住所ツールがデータの取得を待つ上限（ミリ秒）。 */
  waitMs: number;
  /** 構築の同時実行数。 */
  concurrency: number;
  /** 事前取得する都道府県コード（2 桁）。'all' は全国。 */
  preload: string[] | 'all' | null;
}

const MB = 1024 * 1024;

function intInRange(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function parsePreload(raw: string | undefined): AddressConfig['preload'] {
  const text = raw?.trim().toLowerCase();
  if (!text) return null;
  if (text === 'all') return 'all';
  const codes = [...new Set(text.split(',').map((part) => part.trim()).filter((part) => /^\d{1,2}$/.test(part)).map((part) => part.padStart(2, '0')))];
  return codes.length > 0 ? codes : null;
}

export function loadAddressConfig(
  env: Record<string, string | undefined> = process.env,
  dbPath: string = getDatabasePath(),
): AddressConfig {
  const rawMode = env.SORA_ADDRESS?.trim().toLowerCase();
  const mode: AddressMode = rawMode === 'off' || rawMode === 'eager' ? rawMode : 'lazy';
  const explicitDir = env.SORA_ADDRESS_DIR?.trim();
  const dir = explicitDir
    ? resolve(explicitDir)
    : dbPath === ':memory:'
      ? join(tmpdir(), `sora-address-${process.pid}`)
      : resolve(dirname(dbPath), 'address');
  return {
    mode,
    dir,
    maxBytes: intInRange(env.SORA_ADDRESS_MAX_MB, 64, 1_048_576, 2048) * MB,
    waitMs: intInRange(env.SORA_ADDRESS_WAIT_MS, 1000, 120_000, 20_000),
    concurrency: intInRange(env.SORA_ADDRESS_BUILD_CONCURRENCY, 1, 4, 1),
    preload: parsePreload(env.SORA_ADDRESS_PRELOAD),
  };
}

/** MCP のツール登録など、設定ファイルを読まずに有効かどうかだけ知りたいとき。 */
export function addressEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SORA_ADDRESS?.trim().toLowerCase() !== 'off';
}
```

`src/services/address_names.ts`:

```ts
/** 市区町村・町字の名前とコードの共通関数、および Geolonia 形式のデータの型。 */

export type LngLat = [number, number];

export interface JaCity {
  code: number;
  county?: string;
  county_k?: string;
  county_r?: string;
  city: string;
  city_k: string;
  city_r: string;
  ward?: string;
  ward_k?: string;
  ward_r?: string;
  point: LngLat;
}

export interface JaPref {
  code: number;
  pref: string;
  pref_k: string;
  pref_r: string;
  point: LngLat;
  cities: JaCity[];
}

export interface JaJson {
  meta: { updated: number };
  data: JaPref[];
}

export interface TownEntry {
  machiaza_id: string;
  oaza_cho?: string;
  oaza_cho_k?: string;
  oaza_cho_r?: string;
  chome?: string;
  chome_n?: number;
  koaza?: string;
  koaza_k?: string;
  koaza_r?: string;
  rsdt?: true;
  point?: LngLat;
  csv_ranges?: Partial<Record<'住居表示' | '地番', { start: number; length: number }>>;
}

export interface TownJson {
  meta: { updated: number };
  data: TownEntry[];
}

/** Geolonia 形式の code（数値）を、ABR の 6 桁の全国地方公共団体コードに戻す。 */
export function lgCode6(code: number | string): string {
  return String(code).padStart(6, '0');
}

/** ライブラリが `ja/<都道府県>/<市区町村>.json` の名前に使う市区町村名（郡 + 市 + 区）。 */
export function cityNameOf(city: { county?: string; city: string; ward?: string }): string {
  return `${city.county ?? ''}${city.city}${city.ward ?? ''}`;
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `bun test src/services/address_config.test.ts src/services/address_names.test.ts`
Expected: PASS（全件）。

- [ ] **Step 6: 型検査と lint**

Run: `bun run typecheck && bun run lint`
Expected: エラーなし。

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/services/address_errors.ts src/services/address_config.ts src/services/address_names.ts src/services/address_config.test.ts src/services/address_names.test.ts
git commit -m "feat(address): add address config, errors and name helpers"
```

## Task 2: 状態ファイルと版つきの保存先

**Files:**
- Create: `src/services/address_store.ts`
- Test: `src/services/address_store.test.ts`

**Interfaces:**
- Consumes: なし。
- Produces:
  - `type BuildJob = { kind: 'master' } | { kind: 'postal' } | { kind: 'city'; lgCode: string }`
  - `jobArtifactId(job: BuildJob): string`（`'master'` / `'postal'` / `` `city:${lgCode}` ``）
  - `ttlFor(id: string): number`（ミリ秒）
  - `interface ArtifactMeta { ver; sig; builtAt; checkedAt; usedAt; bytes; sourceDate?; pinned?; error?; errorAt? }`
  - `interface AddressStatus { version: 1; seq: number; artifacts: Record<string, ArtifactMeta>; failures: Record<string, { message: string; at: number }> }`
  - `artifactRelDir(id: string): string`
  - `class AddressStore { constructor(dir: string, now?: () => number); read(): AddressStatus; update<T>(fn: (s: AddressStatus) => T): Promise<T>; current(id): { meta: ArtifactMeta; path: string } | null; makeWorkDir(): string; publish(id, builtDir, meta: { sig: string; sourceDate?: string; pinned?: boolean }): Promise<ArtifactMeta>; markChecked(id, sourceDate?): Promise<void>; markError(id, message): Promise<void>; touch(id): void; flushUse(): Promise<void>; evict(maxBytes, protect?): Promise<string[]> }`

- [ ] **Step 1: 失敗するテストを書く**

`src/services/address_store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressStore, artifactRelDir, jobArtifactId, ttlFor } from './address_store.js';

let dir: string;
let clock: number;
let store: AddressStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-store-'));
  clock = 1_000_000;
  store = new AddressStore(dir, () => clock);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build(files: Record<string, string>): string {
  const work = store.makeWorkDir();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
  return work;
}

describe('ids and ttl', () => {
  test('ジョブから成果物のIDを決める', () => {
    expect(jobArtifactId({ kind: 'master' })).toBe('master');
    expect(jobArtifactId({ kind: 'postal' })).toBe('postal');
    expect(jobArtifactId({ kind: 'city', lgCode: '131016' })).toBe('city:131016');
  });

  test('成果物のディレクトリ名', () => {
    expect(artifactRelDir('master')).toBe('master');
    expect(artifactRelDir('city:131016')).toBe(join('city', '131016'));
    expect(() => artifactRelDir('bogus')).toThrow();
  });

  test('TTL は種類ごと', () => {
    expect(ttlFor('postal')).toBe(7 * 86_400_000);
    expect(ttlFor('master')).toBe(30 * 86_400_000);
    expect(ttlFor('city:131016')).toBe(7 * 86_400_000);
  });
});

describe('status file', () => {
  test('無い・壊れているときは空の状態を返す', () => {
    expect(store.read()).toEqual({ version: 1, seq: 0, artifacts: {}, failures: {} });
    writeFileSync(join(dir, 'status.json'), '{not json');
    expect(store.read().seq).toBe(0);
  });

  test('update は永続化し、並行しても直列に実行される', async () => {
    await Promise.all(Array.from({ length: 20 }, () => store.update((s) => { s.seq += 1; })));
    expect(store.read().seq).toBe(20);
  });

  test('別のインスタンス（別プロセス相当）とも排他される', async () => {
    const other = new AddressStore(dir, () => clock);
    await Promise.all([
      ...Array.from({ length: 10 }, () => store.update((s) => { s.seq += 1; })),
      ...Array.from({ length: 10 }, () => other.update((s) => { s.seq += 1; })),
    ]);
    expect(store.read().seq).toBe(20);
  });

  test('古いロックは取り除かれる', async () => {
    const lock = join(dir, 'lock');
    writeFileSync(lock, '999999');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await store.update((s) => { s.seq += 1; });
    expect(store.read().seq).toBe(1);
  });
});

describe('publish and current', () => {
  test('作業ディレクトリを版つきの場所へ移し、サイズと更新番号を記録する', async () => {
    const meta = await store.publish('city:131016', build({ 'town.json': '{"a":1}' }), { sig: 's1', sourceDate: '2026-10-02' });
    const current = store.current('city:131016');
    expect(current?.meta).toEqual(meta);
    expect(current?.path).toBe(join(dir, 'city', '131016', meta.ver));
    expect(existsSync(join(current!.path, 'town.json'))).toBe(true);
    expect(meta).toMatchObject({ sig: 's1', sourceDate: '2026-10-02', bytes: 7, builtAt: clock, checkedAt: clock, usedAt: clock });
    expect(store.read().seq).toBe(1);
  });

  test('旧版は直近 1 つだけ残す', async () => {
    const versions: string[] = [];
    for (const sig of ['a', 'b', 'c']) {
      clock += 1000;
      versions.push((await store.publish('master', build({ 'ja.json': sig }), { sig })).ver);
    }
    expect(readdirSync(join(dir, 'master')).sort()).toEqual([versions[1]!, versions[2]!].sort());
    expect(store.read().seq).toBe(3);
  });

  test('ディレクトリが消えていれば current は null', async () => {
    const meta = await store.publish('postal', build({ 'postal.sqlite': 'x' }), { sig: 's' });
    rmSync(join(dir, 'postal', meta.ver), { recursive: true, force: true });
    expect(store.current('postal')).toBeNull();
  });

  test('公開すると記録済みの失敗が消え、最終利用日時は引き継ぐ', async () => {
    await store.markError('postal', '通信失敗');
    expect(store.read().failures.postal?.message).toBe('通信失敗');
    clock = 2_000_000;
    await store.publish('postal', build({ 'postal.sqlite': 'x' }), { sig: 's1' });
    clock = 3_000_000;
    await store.publish('postal', build({ 'postal.sqlite': 'y' }), { sig: 's2' });
    const status = store.read();
    expect(status.failures.postal).toBeUndefined();
    expect(status.artifacts.postal).toMatchObject({ sig: 's2', usedAt: 2_000_000, builtAt: 3_000_000 });
  });
});

describe('checks and errors', () => {
  test('markChecked は確認日時を進め、エラーを消す', async () => {
    await store.publish('master', build({ 'ja.json': '{}' }), { sig: 's' });
    await store.markError('master', '一時的な失敗');
    expect(store.read().artifacts.master?.error).toBe('一時的な失敗');
    clock = 9_000_000;
    await store.markChecked('master', '2026-10-05');
    expect(store.read().artifacts.master).toMatchObject({ checkedAt: 9_000_000, sourceDate: '2026-10-05' });
    expect(store.read().artifacts.master?.error).toBeUndefined();
  });

  test('成果物が無い ID の失敗は failures に残す', async () => {
    await store.markError('city:131016', 'HTTP 403');
    expect(store.read().failures['city:131016']).toEqual({ message: 'HTTP 403', at: clock });
  });
});

describe('use tracking and eviction', () => {
  test('touch と flushUse で最終利用日時を保存する', async () => {
    await store.publish('city:131016', build({ 'town.json': '{}' }), { sig: 's' });
    await store.flushUse(); // 最初の自動書き込みを済ませる
    clock += 10_000;
    store.touch('city:131016'); // 前回の書き込みから 60 秒以内なので、ファイルには書かない
    expect(store.read().artifacts['city:131016']?.usedAt).toBe(1_000_000);
    await store.flushUse();
    expect(store.read().artifacts['city:131016']?.usedAt).toBe(1_010_000);
  });

  test('予算を超えたら、最近使われていない市区町村から破棄する', async () => {
    const ids = ['city:011011', 'city:131016', 'city:131121'];
    for (const [index, id] of ids.entries()) {
      clock = 1_000_000 + index * 1000;
      await store.publish(id, build({ 'town.json': 'x'.repeat(100) }), { sig: id });
    }
    await store.update((s) => { s.artifacts['city:131016']!.usedAt = 9_999_999; });
    const removed = await store.evict(250, new Set());
    expect(removed).toEqual(['city:011011']);
    expect(existsSync(join(dir, 'city', '011011'))).toBe(false);
    expect(Object.keys(store.read().artifacts).sort()).toEqual(['city:131016', 'city:131121']);
  });

  test('pinned と protect の市区町村、および市区町村以外は破棄しない', async () => {
    await store.publish('master', build({ 'ja.json': 'x'.repeat(100) }), { sig: 'm' });
    await store.publish('city:011011', build({ 'town.json': 'x'.repeat(100) }), { sig: 'a', pinned: true });
    await store.publish('city:131016', build({ 'town.json': 'x'.repeat(100) }), { sig: 'b' });
    const removed = await store.evict(1, new Set(['city:131016']));
    expect(removed).toEqual([]);
    expect(Object.keys(store.read().artifacts).sort()).toEqual(['city:011011', 'city:131016', 'master']);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bun test src/services/address_store.test.ts`
Expected: FAIL（`Cannot find module './address_store.js'`）。

- [ ] **Step 3: 実装する**

`src/services/address_store.ts`:

```ts
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** 構築ジョブ。親プロセスと子プロセスで共有する。 */
export type BuildJob = { kind: 'master' } | { kind: 'postal' } | { kind: 'city'; lgCode: string };

export function jobArtifactId(job: BuildJob): string {
  return job.kind === 'city' ? `city:${job.lgCode}` : job.kind;
}

const DAY = 86_400_000;

/** 確認日時がこれを過ぎたら、使われたときに裏で再確認する。 */
export function ttlFor(id: string): number {
  if (id.startsWith('city:')) return 7 * DAY;
  if (id === 'postal') return 7 * DAY;
  return 30 * DAY;
}

export interface ArtifactMeta {
  /** `address/<種類>/<ver>/` のディレクトリ名。 */
  ver: string;
  /** 入力の署名（取得元の ETag / Last-Modified / サイズのハッシュ）。 */
  sig: string;
  builtAt: number;
  checkedAt: number;
  usedAt: number;
  bytes: number;
  /** 取得元の最終更新日（YYYY-MM-DD）。 */
  sourceDate?: string;
  pinned?: boolean;
  error?: string;
  errorAt?: number;
}

export interface AddressStatus {
  version: 1;
  /** 公開・破棄のたびに増える。ライブラリのモジュールを作り直す目印。 */
  seq: number;
  artifacts: Record<string, ArtifactMeta>;
  /** 成果物がまだ無い ID の直近の失敗。 */
  failures: Record<string, { message: string; at: number }>;
}

const emptyStatus = (): AddressStatus => ({ version: 1, seq: 0, artifacts: {}, failures: {} });

export function artifactRelDir(id: string): string {
  if (id === 'master' || id === 'postal' || id === 'index') return id;
  if (id.startsWith('city:') && /^\d{6}$/.test(id.slice(5))) return join('city', id.slice(5));
  throw new Error(`unknown address artifact id: ${id}`);
}

function dirSize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const USE_FLUSH_MS = 60_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AddressStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly used = new Map<string, number>();
  private lastFlush = 0;

  constructor(readonly dir: string, private readonly now: () => number = Date.now) {}

  private get statusPath(): string {
    return join(this.dir, 'status.json');
  }

  private get lockPath(): string {
    return join(this.dir, 'lock');
  }

  read(): AddressStatus {
    try {
      const parsed = JSON.parse(readFileSync(this.statusPath, 'utf8')) as Partial<AddressStatus>;
      if (parsed.version !== 1 || typeof parsed.artifacts !== 'object' || parsed.artifacts === null) return emptyStatus();
      return { version: 1, seq: parsed.seq ?? 0, artifacts: parsed.artifacts, failures: parsed.failures ?? {} };
    } catch {
      return emptyStatus();
    }
  }

  /** ロックを取り、最新の状態に変更を加えて、一時ファイル経由で原子的に書く。 */
  async update<T>(fn: (status: AddressStatus) => T): Promise<T> {
    const run = this.chain.then(() => this.locked(() => {
      const status = this.read();
      const result = fn(status);
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.statusPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(status));
      renameSync(tmp, this.statusPath);
      return result;
    }));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async locked<T>(fn: () => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(this.lockPath);
        } catch { /* 他のプロセスが先に解放した */ }
        if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('address store lock timeout');
        await sleep(15 + Math.random() * 25);
      }
    }
    try {
      return fn();
    } finally {
      try { unlinkSync(this.lockPath); } catch { /* すでに無い */ }
    }
  }

  artifactPath(id: string, ver: string): string {
    return join(this.dir, artifactRelDir(id), ver);
  }

  /** 公開済みの現行版。ディレクトリが消えていれば null。 */
  current(id: string): { meta: ArtifactMeta; path: string } | null {
    const meta = this.read().artifacts[id];
    if (!meta) return null;
    const path = this.artifactPath(id, meta.ver);
    return existsSync(path) ? { meta, path } : null;
  }

  /** 構築用の作業ディレクトリ。公開先と同じボリュームに作り、rename で原子的に移す。 */
  makeWorkDir(): string {
    const path = join(this.dir, 'tmp', `${process.pid}-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(path, { recursive: true });
    return path;
  }

  /** 作業ディレクトリを版つきの場所へ移し、状態を更新して、旧版を直近 1 つだけ残して消す。 */
  async publish(id: string, builtDir: string, meta: { sig: string; sourceDate?: string; pinned?: boolean }): Promise<ArtifactMeta> {
    const ver = `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const target = this.artifactPath(id, ver);
    const previousVer = this.read().artifacts[id]?.ver;
    mkdirSync(join(target, '..'), { recursive: true });
    renameSync(builtDir, target);
    const bytes = dirSize(target);
    const at = this.now();
    const published = await this.update((status) => {
      const previous = status.artifacts[id];
      const next: ArtifactMeta = { ...meta, ver, bytes, builtAt: at, checkedAt: at, usedAt: previous?.usedAt ?? at };
      if (next.pinned === undefined && previous?.pinned) next.pinned = true;
      status.artifacts[id] = next;
      delete status.failures[id];
      status.seq += 1;
      return next;
    });
    const parent = join(this.dir, artifactRelDir(id));
    for (const entry of readdirSync(parent)) {
      if (entry !== ver && entry !== previousVer) rmSync(join(parent, entry), { recursive: true, force: true });
    }
    return published;
  }

  async markChecked(id: string, sourceDate?: string): Promise<void> {
    await this.update((status) => {
      const meta = status.artifacts[id];
      if (meta) {
        meta.checkedAt = this.now();
        delete meta.error;
        delete meta.errorAt;
        if (sourceDate) meta.sourceDate = sourceDate;
      }
      delete status.failures[id];
    });
  }

  async markError(id: string, message: string): Promise<void> {
    await this.update((status) => {
      const at = this.now();
      const meta = status.artifacts[id];
      if (meta) {
        meta.error = message;
        meta.errorAt = at;
      } else {
        status.failures[id] = { message, at };
      }
    });
  }

  /** 最終利用日時をメモリに記録する。ファイルへの書き込みは 60 秒に 1 回まで。 */
  touch(id: string): void {
    this.used.set(id, this.now());
    if (this.now() - this.lastFlush > USE_FLUSH_MS) void this.flushUse().catch(() => undefined);
  }

  async flushUse(): Promise<void> {
    this.lastFlush = this.now();
    if (this.used.size === 0) return;
    const entries = [...this.used];
    this.used.clear();
    await this.update((status) => {
      for (const [id, at] of entries) {
        const meta = status.artifacts[id];
        if (meta && at > meta.usedAt) meta.usedAt = at;
      }
    });
  }

  /** 予算を超えていれば、最近使われていない市区町村から破棄する。破棄した ID を返す。 */
  async evict(maxBytes: number, protect: ReadonlySet<string> = new Set()): Promise<string[]> {
    const removed: string[] = [];
    await this.update((status) => {
      let total = Object.values(status.artifacts).reduce((sum, meta) => sum + meta.bytes, 0);
      const candidates = Object.entries(status.artifacts)
        .filter(([id, meta]) => id.startsWith('city:') && !meta.pinned && !protect.has(id))
        .sort((a, b) => a[1].usedAt - b[1].usedAt);
      for (const [id, meta] of candidates) {
        if (total <= maxBytes) break;
        rmSync(join(this.dir, artifactRelDir(id)), { recursive: true, force: true });
        total -= meta.bytes;
        delete status.artifacts[id];
        removed.push(id);
      }
      if (removed.length > 0) status.seq += 1;
    });
    return removed;
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/services/address_store.test.ts`
Expected: PASS（全件）。

- [ ] **Step 5: 型検査と lint**

Run: `bun run typecheck && bun run lint`
Expected: エラーなし。

- [ ] **Step 6: Commit**

```bash
git add src/services/address_store.ts src/services/address_store.test.ts
git commit -m "feat(address): add versioned address store with locking and eviction"
```

## Task 3: 取得元との通信

**Files:**
- Create: `src/services/address_http.ts`
- Test: `src/services/address_http.test.ts`

**Interfaces:**
- Consumes: なし。
- Produces:
  - 定数 `ABR_BASE`、`JAPANPOST_KEN_ALL_PAGE`、`JAPANPOST_JIGYOSYO_PAGE`、`JAPANPOST_FALLBACK`、`ADDRESS_USER_AGENT`
  - `type FetchFn = (url: string, init?: RequestInit) => Promise<Response>`
  - `interface HttpDeps { fetchFn?: FetchFn; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; retries?: number }`
  - `class AddressHttpError extends Error { status: number | null; blocked: boolean; retryable: boolean }`
  - `interface Signature { url: string; etag: string | null; lastModified: string | null; size: number | null }`
  - `headSignature(url, deps?): Promise<Signature | null>`（404 は null）
  - `combineSignatures(signatures: ReadonlyArray<Signature | null>): string`
  - `latestSourceDate(signatures): string | undefined`（`YYYY-MM-DD`）
  - `downloadToFile(url, destPath, deps?): Promise<{ signature: Signature; bytes: number } | null>`（404 は null）
  - `fetchText(url, deps?): Promise<{ text: string; finalUrl: string }>`
  - `resolveJapanPostLinks(deps?): Promise<{ kenAll: string; jigyosyo: string }>`

- [ ] **Step 1: 失敗するテストを書く**

`src/services/address_http.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADDRESS_USER_AGENT, AddressHttpError, JAPANPOST_FALLBACK, combineSignatures, downloadToFile, headSignature,
  latestSourceDate, resolveJapanPostLinks, type FetchFn, type Signature,
} from './address_http.js';

function respond(status: number, body: string | Uint8Array | null, headers: Record<string, string> = {}, url?: string): Response {
  const response = new Response(body, { status, headers });
  if (url) Object.defineProperty(response, 'url', { value: url });
  return response;
}

function script(...steps: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const queue = [...steps];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    const step = queue.shift();
    if (!step) throw new Error(`unexpected request: ${url}`);
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchFn, calls };
}
const noSleep = { sleep: async () => undefined };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'addr-http-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('headSignature', () => {
  test('ETag・Last-Modified・サイズを読み、取得元と分かる User-Agent を付ける', async () => {
    const { fetchFn, calls } = script(respond(200, null, { etag: '"abc"', 'last-modified': 'Fri, 02 Oct 2026 15:40:53 GMT', 'content-length': '83827' }));
    expect(await headSignature('https://example.test/a.zip', { fetchFn })).toEqual({
      url: 'https://example.test/a.zip', etag: '"abc"', lastModified: 'Fri, 02 Oct 2026 15:40:53 GMT', size: 83827,
    });
    expect(calls[0]?.method).toBe('HEAD');
    expect(calls[0]?.headers.get('user-agent')).toBe(ADDRESS_USER_AGENT);
  });

  test('404 は null', async () => {
    expect(await headSignature('https://example.test/none.zip', { fetchFn: script(respond(404, null)).fetchFn })).toBeNull();
  });

  test('403 は再試行せず、blocked として投げる', async () => {
    const { fetchFn, calls } = script(respond(403, null));
    const error = await headSignature('https://example.test/a.zip', { fetchFn, ...noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddressHttpError);
    expect(error).toMatchObject({ status: 403, blocked: true, retryable: false });
    expect((error as Error).message).toContain('HTTP 403');
    expect(calls).toHaveLength(1);
  });

  test('5xx と通信エラーは待って再試行し、尽きたら retryable で投げる', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); };
    const recovered = script(respond(503, null), new Error('socket closed'), respond(200, null, { etag: '"x"' }));
    expect((await headSignature('https://example.test/a.zip', { fetchFn: recovered.fetchFn, sleep }))?.etag).toBe('"x"');
    expect(waits).toEqual([1000, 2000]);

    const failing = script(respond(500, null), respond(502, null), respond(503, null));
    const error = await headSignature('https://example.test/a.zip', { fetchFn: failing.fetchFn, ...noSleep }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, retryable: true, blocked: false });
  });

  test('404 以外の 4xx は再試行しない', async () => {
    const { fetchFn, calls } = script(respond(400, null));
    await expect(headSignature('https://example.test/a.zip', { fetchFn, ...noSleep })).rejects.toMatchObject({ status: 400, retryable: false });
    expect(calls).toHaveLength(1);
  });
});

describe('signatures', () => {
  const a: Signature = { url: 'https://example.test/a', etag: '"1"', lastModified: 'Fri, 02 Oct 2026 15:40:53 GMT', size: 10 };
  const b: Signature = { url: 'https://example.test/b', etag: null, lastModified: 'Mon, 27 Oct 2025 09:30:04 GMT', size: 20 };

  test('combineSignatures は同じ入力で同じ値、変化があれば別の値', () => {
    expect(combineSignatures([a, b])).toBe(combineSignatures([a, b]));
    expect(combineSignatures([a, b])).not.toBe(combineSignatures([a, { ...b, size: 21 }]));
    expect(combineSignatures([a, null])).not.toBe(combineSignatures([a, b]));
    expect(combineSignatures([a, b])).toMatch(/^[0-9a-f]{16}$/);
  });

  test('latestSourceDate は最も新しい Last-Modified を YYYY-MM-DD で返す', () => {
    expect(latestSourceDate([a, b, null])).toBe('2026-10-02');
    expect(latestSourceDate([null, { ...a, lastModified: null }])).toBeUndefined();
  });
});

describe('downloadToFile', () => {
  test('一時ファイル経由で保存し、署名とバイト数を返す', async () => {
    const dest = join(dir, 'sub', 'a.zip');
    const { fetchFn } = script(respond(200, new Uint8Array([1, 2, 3, 4]), { etag: '"e"', 'last-modified': 'Fri, 02 Oct 2026 15:40:53 GMT', 'content-length': '4' }));
    const result = await downloadToFile('https://example.test/a.zip', dest, { fetchFn });
    expect(result?.bytes).toBe(4);
    expect(result?.signature).toMatchObject({ url: 'https://example.test/a.zip', etag: '"e"', size: 4 });
    expect([...readFileSync(dest)]).toEqual([1, 2, 3, 4]);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  test('404 は null で、ファイルを作らない', async () => {
    const dest = join(dir, 'none.zip');
    expect(await downloadToFile('https://example.test/none.zip', dest, { fetchFn: script(respond(404, null)).fetchFn })).toBeNull();
    expect(existsSync(dest)).toBe(false);
  });
});

describe('resolveJapanPostLinks', () => {
  const page = 'https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html';
  const office = 'https://www.post.japanpost.jp/service/search/zipcode/download/office/index-zip.html';

  test('転送後のページを基準に、相対リンクを解決する', async () => {
    const { fetchFn, calls } = script(
      respond(200, '<a href="utf/zip/utf_add_2609.zip">x</a><a href="utf/zip/utf_ken_all.zip">全国</a>', {}, page),
      respond(200, '<a href="/zipcode/dl/jigyosyo/readme.html">readme</a><a href="zip/jigyosyo.zip">全国</a>', {}, office),
    );
    expect(await resolveJapanPostLinks({ fetchFn })).toEqual({
      kenAll: 'https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/utf_ken_all.zip',
      jigyosyo: 'https://www.post.japanpost.jp/service/search/zipcode/download/office/zip/jigyosyo.zip',
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://www.post.japanpost.jp/zipcode/dl/utf-zip.html',
      'https://www.post.japanpost.jp/zipcode/dl/jigyosyo/index-zip.html',
    ]);
  });

  test('リンクが見つからない・取得できないときは既知の直 URL にする', async () => {
    const { fetchFn } = script(respond(200, '<p>ページの構成が変わった</p>', {}, page), new Error('offline'));
    expect(await resolveJapanPostLinks({ fetchFn, ...noSleep, retries: 1 })).toEqual(JAPANPOST_FALLBACK);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `bun test src/services/address_http.test.ts`
Expected: FAIL（`Cannot find module './address_http.js'`）。

- [ ] **Step 3: 実装する**

`src/services/address_http.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export const ABR_BASE = 'https://data.address-br.digital.go.jp';
/** 旧ページの URL。新しいページへ 301 で転送される。zip のリンクはここから解決する。 */
export const JAPANPOST_KEN_ALL_PAGE = 'https://www.post.japanpost.jp/zipcode/dl/utf-zip.html';
export const JAPANPOST_JIGYOSYO_PAGE = 'https://www.post.japanpost.jp/zipcode/dl/jigyosyo/index-zip.html';
/** ページからリンクを解決できないときに使う、確認済みの直 URL。 */
export const JAPANPOST_FALLBACK = {
  kenAll: 'https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/utf_ken_all.zip',
  jigyosyo: 'https://www.post.japanpost.jp/service/search/zipcode/download/office/zip/jigyosyo.zip',
} as const;
export const ADDRESS_USER_AGENT = 'Sora-Address-Data/1.0 (+https://github.com/ikenokazuki/Sora)';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpDeps {
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retries?: number;
}

export class AddressHttpError extends Error {
  constructor(message: string, readonly status: number | null, readonly blocked: boolean, readonly retryable: boolean) {
    super(message);
    this.name = 'AddressHttpError';
  }
}

export interface Signature {
  url: string;
  etag: string | null;
  lastModified: string | null;
  size: number | null;
}

/** 403 は国外 IP の拒否として再試行せず、429 / 5xx / 通信エラーは待って再試行する。404 はそのまま返す。 */
async function request(url: string, method: 'GET' | 'HEAD', deps: HttpDeps): Promise<Response> {
  const fetchFn: FetchFn = deps.fetchFn ?? ((target, init) => fetch(target, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = deps.retries ?? 3;
  let lastError: AddressHttpError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        redirect: 'follow',
        headers: { 'User-Agent': ADDRESS_USER_AGENT, Accept: '*/*' },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000),
      });
    } catch (error) {
      lastError = new AddressHttpError(`${url}: ${error instanceof Error ? error.message : String(error)}`, null, false, true);
      continue;
    }
    if (response.status === 403) {
      throw new AddressHttpError(`${url}: HTTP 403（国外 IP からの接続は拒否されます）`, 403, true, false);
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = new AddressHttpError(`${url}: HTTP ${response.status}`, response.status, false, true);
      continue;
    }
    return response;
  }
  throw lastError ?? new AddressHttpError(`${url}: request failed`, null, false, true);
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function signatureOf(url: string, response: Response): Signature {
  return {
    url,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    size: numberOrNull(response.headers.get('content-length')),
  };
}

export async function headSignature(url: string, deps: HttpDeps = {}): Promise<Signature | null> {
  const response = await request(url, 'HEAD', deps);
  if (response.status === 404) return null;
  if (!response.ok) throw new AddressHttpError(`${url}: HTTP ${response.status}`, response.status, false, false);
  return signatureOf(url, response);
}

/** 取得元の変化を 1 つの値にまとめる。並び順は呼び出し側で固定する。 */
export function combineSignatures(signatures: ReadonlyArray<Signature | null>): string {
  const parts = signatures.map((s) => (s ? [s.url, s.etag, s.lastModified, s.size] : null));
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

export function latestSourceDate(signatures: ReadonlyArray<Signature | null>): string | undefined {
  let latest = Number.NEGATIVE_INFINITY;
  for (const signature of signatures) {
    const time = signature?.lastModified ? Date.parse(signature.lastModified) : Number.NaN;
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString().slice(0, 10) : undefined;
}

export async function downloadToFile(url: string, destPath: string, deps: HttpDeps = {}): Promise<{ signature: Signature; bytes: number } | null> {
  const response = await request(url, 'GET', deps);
  if (response.status === 404) return null;
  if (!response.ok) throw new AddressHttpError(`${url}: HTTP ${response.status}`, response.status, false, false);
  mkdirSync(dirname(destPath), { recursive: true });
  const part = `${destPath}.part`;
  await Bun.write(part, response);
  renameSync(part, destPath);
  return { signature: signatureOf(url, response), bytes: statSync(destPath).size };
}

export async function fetchText(url: string, deps: HttpDeps = {}): Promise<{ text: string; finalUrl: string }> {
  const response = await request(url, 'GET', deps);
  if (!response.ok) throw new AddressHttpError(`${url}: HTTP ${response.status}`, response.status, false, false);
  return { text: await response.text(), finalUrl: response.url || url };
}

async function resolveLink(page: string, pattern: RegExp, fallback: string, deps: HttpDeps): Promise<string> {
  try {
    const { text, finalUrl } = await fetchText(page, deps);
    const href = text.match(pattern)?.[1];
    if (href) return new URL(href, finalUrl).toString();
  } catch { /* 既知の直 URL に落とす。以降の HEAD で本当の失敗を拾う */ }
  return fallback;
}

/** 日本郵便は URL を動かすことがあるので、ページから zip のリンクを解決する。 */
export async function resolveJapanPostLinks(deps: HttpDeps = {}): Promise<{ kenAll: string; jigyosyo: string }> {
  const [kenAll, jigyosyo] = await Promise.all([
    resolveLink(JAPANPOST_KEN_ALL_PAGE, /href="([^"]*utf_ken_all\.zip)"/, JAPANPOST_FALLBACK.kenAll, deps),
    resolveLink(JAPANPOST_JIGYOSYO_PAGE, /href="([^"]*jigyosyo\.zip)"/, JAPANPOST_FALLBACK.jigyosyo, deps),
  ]);
  return { kenAll, jigyosyo };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `bun test src/services/address_http.test.ts`
Expected: PASS（全件）。

- [ ] **Step 5: 型検査と lint**

Run: `bun run typecheck && bun run lint`
Expected: エラーなし。

- [ ] **Step 6: Commit**

```bash
git add src/services/address_http.ts src/services/address_http.test.ts
git commit -m "feat(address): add upstream signature, download and Japan Post link resolution"
```

## Task 4: zip と CSV、ABR の全国マスターと町字の変換（段A）

**Files:**
- Create: `src/test_fixtures/address/zip.ts`、`src/services/address_csv.ts`、`src/services/address_abr.ts`
- Test: `src/services/address_csv.test.ts`、`src/services/address_abr.test.ts`

**Interfaces:**
- Consumes: `JaJson` `JaPref` `TownEntry` `TownJson` `LngLat`（`address_names.ts`）。
- Produces:
  - `makeZip(entries: Record<string, string | Uint8Array>): Uint8Array`（テスト用。保存のみの zip）
  - `readZipEntry(zipPath: string): Promise<Buffer>`、`readZipText(zipPath: string, encoding?: string): Promise<string>`、`parseCsvRows(text: string): Record<string, string>[]`、`parseCsvMatrix(text: string): string[][]`
  - `type Row = Record<string, string>`、`toPoint(row: Row): LngLat | null`
  - `interface MasterRows { prefs: Row[]; prefPos: Row[]; cities: Row[]; cityPos: Row[] }`
  - `buildJaJson(rows: MasterRows, updated: number): JaJson`
  - `chomeToKanji(chome: string): string | undefined`
  - `buildTownJson(towns: Row[], pos: Row[], updated: number): TownJson`

- [ ] **Step 1: テスト用の zip 書き出しを作る**

`src/test_fixtures/address/zip.ts`:

```ts
/** テスト用。保存のみ（無圧縮）の zip を作る。ファイル名は UTF-8。 */
export function makeZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const body = typeof data === 'string' ? encoder.encode(data) : data;
    const crc = Bun.hash.crc32(body) >>> 0;
    const local = cat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
      u32(crc), u32(body.length), u32(body.length), u16(nameBytes.length), u16(0), nameBytes, body,
    );
    centrals.push(cat(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
      u32(crc), u32(body.length), u32(body.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ));
    locals.push(local);
    offset += local.length;
  }
  const centralBytes = cat(...centrals);
  const end = cat(u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length), u32(centralBytes.length), u32(offset), u16(0));
  return cat(...locals, centralBytes, end);
}
```

- [ ] **Step 2: 失敗するテストを書く（zip と CSV）**

`src/services/address_csv.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip } from '../test_fixtures/address/zip.js';
import { parseCsvMatrix, parseCsvRows, readZipEntry, readZipText } from './address_csv.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'addr-csv-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function zipFile(name: string, entries: Record<string, string | Uint8Array>): string {
  const path = join(dir, name);
  writeFileSync(path, makeZip(entries));
  return path;
}

describe('readZipText', () => {
  test('最初のファイルを UTF-8 で読み、BOM を除く', async () => {
    const path = zipFile('a.zip', { 'sample.csv': '﻿name,value\r\n"a,b",1\r\n' });
    expect(await readZipText(path)).toBe('name,value\r\n"a,b",1\r\n');
  });

  test('Shift_JIS を指定して読める', async () => {
    // 「札幌」を Shift_JIS（cp932）にした 4 バイト
    const path = zipFile('sjis.zip', { 'j.csv': new Uint8Array([0x8e, 0x44, 0x96, 0x79]) });
    expect(await readZipText(path, 'shift_jis')).toBe('札幌');
  });

  test('エントリの無い zip は失敗する', async () => {
    await expect(readZipEntry(zipFile('empty.zip', {}))).rejects.toThrow();
  });

  test('zip ではないファイルは失敗する', async () => {
    const path = join(dir, 'bad.zip');
    writeFileSync(path, 'not a zip');
    await expect(readZipEntry(path)).rejects.toThrow();
  });
});

describe('CSV 解析', () => {
  test('ヘッダーつきで行を連想配列にする（引用符・空行）', () => {
    expect(parseCsvRows('name,value\r\n"a,b",1\r\n\r\nc,\r\n')).toEqual([{ name: 'a,b', value: '1' }, { name: 'c', value: '' }]);
  });

  test('ヘッダー無しで行列にする', () => {
    expect(parseCsvMatrix('13101,"100  ","1000001"\r\n')).toEqual([['13101', '100  ', '1000001']]);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `bun test src/services/address_csv.test.ts`
Expected: FAIL（`Cannot find module './address_csv.js'`）。

- [ ] **Step 4: 実装する（zip と CSV）**

`src/services/address_csv.ts`:

```ts
import Papa from 'papaparse';
import yauzl from 'yauzl';

/** zip の最初のファイルを読む。ABR・日本郵便の配布物は 1 ファイルだけを含む。小さい zip（数MB 以下）向け。 */
export function readZipEntry(zipPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('zip を開けません'));
        return;
      }
      let settled = false;
      const finish = (error: Error | null, value?: Buffer): void => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* すでに閉じている */ }
        if (error) reject(error);
        else resolve(value as Buffer);
      };
      zip.on('error', (error) => finish(error));
      zip.on('end', () => finish(new Error('zip にファイルがありません')));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error('zip のエントリを開けません'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', (error) => finish(error));
          stream.on('end', () => finish(null, Buffer.concat(chunks)));
        });
      });
      zip.readEntry();
    });
  });
}

export async function readZipText(zipPath: string, encoding = 'utf-8'): Promise<string> {
  const buffer = await readZipEntry(zipPath);
  return new TextDecoder(encoding).decode(buffer).replace(/^﻿/, '');
}

export function parseCsvRows(text: string): Record<string, string>[] {
  return Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, delimiter: ',' }).data;
}

export function parseCsvMatrix(text: string): string[][] {
  return Papa.parse<string[]>(text, { skipEmptyLines: true, delimiter: ',' }).data;
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `bun test src/services/address_csv.test.ts`
Expected: PASS（全件）。Shift_JIS のバイト列が違うときは、`iconv` の出力に合わせてテストを直す。

- [ ] **Step 6: 失敗するテストを書く（ABR の変換）**

`src/services/address_abr.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildJaJson, buildTownJson, chomeToKanji, toPoint, type Row } from './address_abr.js';

const pos = (lg: string, lon: string, lat: string, srid = 'EPSG:6668'): Row => ({ lg_code: lg, rep_lon: lon, rep_lat: lat, rep_srid: srid });

describe('toPoint', () => {
  test('対応する座標参照系だけ [経度, 緯度] にする', () => {
    expect(toPoint(pos('1', '139.7', '35.6'))).toEqual([139.7, 35.6]);
    expect(toPoint(pos('1', '139.7', '35.6', 'EPSG:4326'))).toEqual([139.7, 35.6]);
    expect(toPoint(pos('1', '139.7', '35.6', 'EPSG:3857'))).toBeNull();
    expect(toPoint(pos('1', '', ''))).toBeNull();
  });
});

describe('buildJaJson', () => {
  const prefs: Row[] = [
    { lg_code: '010006', pref: '北海道', pref_kana: 'ホッカイドウ', pref_roma: 'Hokkaido' },
    { lg_code: '130001', pref: '東京都', pref_kana: 'トウキョウト', pref_roma: 'Tokyo' },
  ];
  const prefPos = [pos('010006', '141.347906782', '43.0639406375'), pos('130001', '139.691717', '35.689568')];
  const city = (lg: string, prefName: string, name: string, ward = '', county = ''): Row => ({
    lg_code: lg, pref: prefName, county, county_kana: '', county_roma: '', city: name, city_kana: `${name}カナ`, city_roma: `${name}-roma`,
    ward, ward_kana: ward ? `${ward}カナ` : '', ward_roma: ward ? `${ward}-roma` : '',
  });
  const cities: Row[] = [
    city('011002', '北海道', '札幌市'),
    city('011011', '北海道', '札幌市', '中央区'),
    city('012025', '北海道', '函館市'),
    city('131016', '東京都', '千代田区'),
    city('132012', '東京都', '八王子市'),
    city('133019', '東京都', '中井町', '', '足柄上郡'),
  ];
  const cityPos = [
    pos('011002', '141.354374', '43.061972'), pos('011011', '141.35389', '43.061414'), pos('012025', '140.728', '41.768'),
    pos('131016', '139.753634', '35.694003'), pos('133019', '139.2', '35.3'),
  ];

  test('都道府県ごとに市区町村を並べ、code は数値、空の項目は省く', () => {
    const ja = buildJaJson({ prefs, prefPos, cities, cityPos }, 1_700_000_000);
    expect(ja.meta.updated).toBe(1_700_000_000);
    expect(ja.data.map((p) => [p.code, p.pref])).toEqual([[10006, '北海道'], [130001, '東京都']]);
    const hokkaido = ja.data[0]!;
    expect(hokkaido).toMatchObject({ pref_k: 'ホッカイドウ', pref_r: 'Hokkaido', point: [141.347906782, 43.0639406375] });
    expect(JSON.parse(JSON.stringify(hokkaido.cities[1]))).toEqual({
      code: 12025, city: '函館市', city_k: '函館市カナ', city_r: '函館市-roma', point: [140.728, 41.768],
    });
  });

  test('区のある政令市の親行は除き、位置参照が無い市区町村は捨てる', () => {
    const ja = buildJaJson({ prefs, prefPos, cities, cityPos }, 0);
    expect(ja.data[0]!.cities.map((c) => [c.code, c.city, c.ward])).toEqual([[11011, '札幌市', '中央区'], [12025, '函館市', undefined]]);
    expect(ja.data[1]!.cities.map((c) => c.city)).toEqual(['千代田区', '中井町']);
    expect(ja.data[1]!.cities[1]!.county).toBe('足柄上郡');
    expect(ja.data[1]!.cities[1]!.county_k).toBeUndefined();
  });

  test('都道府県の代表点が無ければ失敗する', () => {
    expect(() => buildJaJson({ prefs, prefPos: [], cities, cityPos }, 0)).toThrow('代表点');
  });
});

describe('chomeToKanji', () => {
  test('算用数字（全角を含む）の丁目を漢数字にする', () => {
    expect(chomeToKanji('１４丁目')).toBe('十四丁目');
    expect(chomeToKanji('2丁目')).toBe('二丁目');
    expect(chomeToKanji('一丁目')).toBe('一丁目');
    expect(chomeToKanji('')).toBeUndefined();
  });
});

describe('buildTownJson', () => {
  const town = (id: string, extra: Partial<Row> = {}): Row => ({
    lg_code: '131016', machiaza_id: id, oaza_cho: '', oaza_cho_kana: '', oaza_cho_roma: '', chome: '', chome_number: '',
    koaza: '', koaza_kana: '', koaza_roma: '', rsdt_addr_flg: '0', ...extra,
  });

  test('町字の項目を Geolonia 形式にし、位置参照を結合する', () => {
    const json = buildTownJson(
      [
        town('0005001', { oaza_cho: '永田町', oaza_cho_kana: 'ナガタチョウ', oaza_cho_roma: 'Nagatacho', chome: '１丁目', chome_number: '1', rsdt_addr_flg: '1' }),
        town('0000104', { koaza: '半蔵門', koaza_kana: 'ハンゾウモン' }),
        town('0006000', { oaza_cho: '千代田' }),
      ],
      [
        { lg_code: '131016', machiaza_id: '0005001', rep_lon: '139.746306', rep_lat: '35.675895', rep_srid: 'EPSG:6668' },
        { lg_code: '131016', machiaza_id: '0005001', rep_lon: '1', rep_lat: '1', rep_srid: 'EPSG:6668' }, // 重複キーは最初の行を使う
        { lg_code: '131016', machiaza_id: '0000104', rep_lon: '139.745856', rep_lat: '35.683737', rep_srid: 'EPSG:3857' }, // 対応外の座標参照系は点なし
      ],
      1_700_000_000,
    );
    expect(json.meta.updated).toBe(1_700_000_000);
    expect(JSON.parse(JSON.stringify(json.data))).toEqual([
      { machiaza_id: '0005001', oaza_cho: '永田町', oaza_cho_k: 'ナガタチョウ', oaza_cho_r: 'Nagatacho', chome: '一丁目', chome_n: 1, rsdt: true, point: [139.746306, 35.675895] },
      { machiaza_id: '0000104', koaza: '半蔵門', koaza_k: 'ハンゾウモン' },
      { machiaza_id: '0006000', oaza_cho: '千代田' },
    ]);
  });
});
```

- [ ] **Step 7: テストが失敗することを確認する**

Run: `bun test src/services/address_abr.test.ts`
Expected: FAIL（`Cannot find module './address_abr.js'`）。

- [ ] **Step 8: 実装する（ABR の変換）**

`src/services/address_abr.ts`:

```ts
import { kanji2number, number2kanji } from '@geolonia/japanese-numeral';
import type { JaCity, JaJson, JaPref, LngLat, TownEntry, TownJson } from './address_names.js';

export type Row = Record<string, string>;

/** ABR の代表点の座標参照系。JGD2011 / JGD2000 / WGS84 は実質同じ値なので変換しない。 */
const SUPPORTED_SRID = new Set(['EPSG:6668', 'EPSG:4612', 'EPSG:4326']);

const opt = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

export function toPoint(row: Row): LngLat | null {
  if (!SUPPORTED_SRID.has(row.rep_srid)) return null;
  const lon = Number.parseFloat(row.rep_lon);
  const lat = Number.parseFloat(row.rep_lat);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

export interface MasterRows {
  prefs: Row[];
  prefPos: Row[];
  cities: Row[];
  cityPos: Row[];
}

/** Geolonia 生成器の 01（都道府県・市区町村）の移植。 */
export function buildJaJson(rows: MasterRows, updated: number): JaJson {
  const prefPos = new Map(rows.prefPos.map((row) => [row.lg_code, row] as const));
  const cityPos = new Map(rows.cityPos.map((row) => [row.lg_code, row] as const));
  const data: JaPref[] = [];
  const byName = new Map<string, JaPref>();
  for (const row of rows.prefs) {
    const position = prefPos.get(row.lg_code);
    const point = position ? toPoint(position) : null;
    if (!point) throw new Error(`都道府県 ${row.lg_code} の代表点を使えません`);
    const pref: JaPref = {
      code: Number.parseInt(row.lg_code, 10), pref: row.pref, pref_k: row.pref_kana, pref_r: row.pref_roma, point, cities: [],
    };
    data.push(pref);
    byName.set(pref.pref, pref);
  }
  for (const row of rows.cities) {
    const pref = byName.get(row.pref);
    const position = cityPos.get(row.lg_code);
    const point = position ? toPoint(position) : null;
    if (!pref || !point) continue;
    const city: JaCity = {
      code: Number.parseInt(row.lg_code, 10),
      county: opt(row.county), county_k: opt(row.county_kana), county_r: opt(row.county_roma),
      city: row.city, city_k: row.city_kana, city_r: row.city_roma,
      ward: opt(row.ward), ward_k: opt(row.ward_kana), ward_r: opt(row.ward_roma),
      point,
    };
    pref.cities.push(city);
  }
  for (const pref of data) {
    const all = pref.cities;
    // 区のある政令市の「区名が無い」親行は出力しない（同じ市名で区のある行が他にあれば親）。
    pref.cities = all.filter((city) => city.ward !== undefined || all.filter((other) => other.city === city.city).every((other) => other.ward === undefined));
  }
  return { meta: { updated }, data };
}

const CHOME = /([０-９0-9]+)(丁目?)/;

/** `１４丁目` を `十四丁目` にする。漢数字のものはそのまま。 */
export function chomeToKanji(chome: string): string | undefined {
  if (chome === '') return undefined;
  const match = chome.match(CHOME);
  if (!match) return chome;
  return number2kanji(kanji2number(match[1] ?? '')) + (match[2] ?? '');
}

/** Geolonia 生成器の 02（町字）の移植。本体と位置参照を (lg_code, machiaza_id) で左結合する。 */
export function buildTownJson(towns: Row[], pos: Row[], updated: number): TownJson {
  const points = new Map<string, LngLat>();
  for (const row of pos) {
    const key = `${row.lg_code}|${row.machiaza_id}`;
    if (points.has(key)) continue;
    const point = toPoint(row);
    if (point) points.set(key, point);
  }
  const data = towns.map((row): TownEntry => ({
    machiaza_id: row.machiaza_id,
    oaza_cho: opt(row.oaza_cho), oaza_cho_k: opt(row.oaza_cho_kana), oaza_cho_r: opt(row.oaza_cho_roma),
    chome: chomeToKanji(row.chome ?? ''),
    chome_n: opt(row.chome_number) === undefined ? undefined : Number.parseInt(row.chome_number, 10),
    koaza: opt(row.koaza), koaza_k: opt(row.koaza_kana), koaza_r: opt(row.koaza_roma),
    rsdt: row.rsdt_addr_flg === '1' ? true : undefined,
    point: points.get(`${row.lg_code}|${row.machiaza_id}`),
  }));
  return { meta: { updated }, data };
}
```

- [ ] **Step 9: テストが通ることを確認する**

Run: `bun test src/services/address_abr.test.ts`
Expected: PASS（全件）。

- [ ] **Step 10: 型検査と lint**

Run: `bun run typecheck && bun run lint`
Expected: エラーなし。

- [ ] **Step 11: Commit**

```bash
git add src/test_fixtures/address/zip.ts src/services/address_csv.ts src/services/address_csv.test.ts src/services/address_abr.ts src/services/address_abr.test.ts
git commit -m "feat(address): read ABR zips and build master and town data"
```

## Task 5: 郵便番号の解析・SQLite・町字への結びつけ

**Files:**
- Create: `src/services/postal_code.ts`、`src/test_fixtures/address/jigyosyo.ts`
- Test: `src/services/postal_code.test.ts`

**Interfaces:**
- Consumes: `parseCsvMatrix`（`address_csv.ts`）。
- Produces:
  - `type PostalKind = 'general' | 'office' | 'po_box'`
  - `interface PostalRowInput { zip; kind; lg5; pref; city; town; townRaw; annotation; detail; office }`、`interface PostalRow extends PostalRowInput { id: number }`
  - `splitTown(raw: string): { town: string; annotation: string }`
  - `parseKenAll(text: string): PostalRowInput[]`、`parseJigyosyo(text: string): PostalRowInput[]`
  - `buildPostalDb(path: string, rows: readonly PostalRowInput[]): void`
  - `class PostalReader { constructor(path); byZip(zip): PostalRow[]; byLg5(lg5): PostalRow[]（一般の行のみ）; close() }`
  - `foldName(input: string): string`
  - `parseChomeRange(annotation: string): { lo: number; hi: number } | null`
  - `annotationMatchesNumber(annotation: string, addr: string): boolean | null`
  - `interface TownRef { machiaza_id: string; oaza_cho?: string; koaza?: string; chome?: string; chome_n?: number; point?: [number, number] }`
  - `interface PostalLink { machiazaIds: string[]; exact: boolean }`
  - `linkPostalRows(rows: readonly PostalRow[], towns: readonly TownRef[]): Map<number, PostalLink>`（キーは `PostalRow.id`）
  - `interface ZipMatch { row: PostalRow; exact: boolean; fallback: boolean }`
  - `zipsForTown(rows, links, machiazaId, addr?): ZipMatch[]`

- [ ] **Step 1: テスト用の固定データを作る**

`src/test_fixtures/address/jigyosyo.ts`（事業所の個別郵便番号の Shift_JIS。1 行目は札幌の事業所、2 行目は私書箱。実際の配布データの形式で作った 301 バイト）:

```ts
export const JIGYOSYO_SJIS_HEX = '30313130312c2228b6ccde2920c6ceddb9b2bbdeb2bcddccdeddbcd420bbc2cedfdbbcbcd4222c228a948eae89ef8ed0814093fa967b8c6f8dcf905695b78ed081408e4496798e788ed0222c22966b8a4393b9222c228e4496798e739286899b8be6222c22966b88ea8ff090bc222c228255929a96da8250817c82518341815b836f8393836c836283678e4496798372838b82518265222c2230363038363231222c223036302020222c228e4496799286899b222c302c302c300d0a31333130312c22bcbbc2badeb3c3bdc4222c228e848f9194a0836583588367222c22938c8b9e9373222c2290e791e393638be6222c228adb82cc93e0222c228251929a96da8256817c8251222c2231303038373939222c223130302020222c22938c8b9e9286899b222c312c302c300d0a';

export function jigyosyoText(): string {
  return new TextDecoder('shift_jis').decode(Buffer.from(JIGYOSYO_SJIS_HEX, 'hex'));
}

export function jigyosyoBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(JIGYOSYO_SJIS_HEX, 'hex'));
}
```

- [ ] **Step 2: 失敗するテストを書く**

`src/services/postal_code.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jigyosyoText } from '../test_fixtures/address/jigyosyo.js';
import {
  PostalReader, annotationMatchesNumber, buildPostalDb, foldName, linkPostalRows, parseChomeRange, parseJigyosyo, parseKenAll,
  splitTown, zipsForTown, type PostalRow, type TownRef,
} from './postal_code.js';

const KEN_ALL = [
  '13101,"100  ","1000001","トウキョウト","チヨダク","チヨダ","東京都","千代田区","千代田",0,0,1,0,0,0',
  '01101,"060  ","0600000","ホッカイドウ","サッポロシチュウオウク","イカニケイサイガナイバアイ","北海道","札幌市中央区","以下に掲載がない場合",0,0,0,0,0,0',
  '01101,"060  ","0600042","ホッカイドウ","サッポロシチュウオウク","オオドオリニシ(1-19チョウメ)","北海道","札幌市中央区","大通西（１〜１９丁目）",0,0,1,0,0,0',
  '01101,"064  ","0640820","ホッカイドウ","サッポロシチュウオウク","オオドオリニシ(20-28チョウメ)","北海道","札幌市中央区","大通西（２０〜２８丁目）",0,0,1,0,0,0',
  '13101,"100  ","1006801","トウキョウト","チヨダク","オオテマチ","東京都","千代田区","大手町ＪＡビル（１階）",0,0,0,0,0,0',
  '20209,"394  ","3940001","ナガノケン","オカヤシ","オカヤシノツギニバンチガクルバアイ","長野県","岡谷市","岡谷市の次に番地がくる場合",0,0,0,0,0,0',
  '13361,"100  ","1000301","トウキョウト","トシマムラ","トシマムラ","東京都","利島村","利島村一円",0,0,0,0,0,0',
].join('\r\n') + '\r\n';

describe('KEN_ALL', () => {
  test('町域の括弧注記と、町域を持たない行を整理する', () => {
    const rows = parseKenAll(KEN_ALL);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({
      zip: '1000001', kind: 'general', lg5: '13101', pref: '東京都', city: '千代田区',
      town: '千代田', townRaw: '千代田', annotation: '', detail: '', office: '',
    });
    expect(rows[1]).toMatchObject({ zip: '0600000', town: '', townRaw: '以下に掲載がない場合', annotation: '' });
    expect(rows[2]).toMatchObject({ zip: '0600042', town: '大通西', townRaw: '大通西（１〜１９丁目）', annotation: '１〜１９丁目' });
    expect(rows[4]).toMatchObject({ town: '大手町ＪＡビル', annotation: '１階' });
    expect(rows[5]).toMatchObject({ zip: '3940001', town: '', annotation: '' });
    expect(rows[6]).toMatchObject({ town: '利島村一円', annotation: '' });
  });

  test('7 桁でない行や短い行は読み飛ばす', () => {
    expect(parseKenAll('13101,"100  ","100000","a","b","c","東京都","千代田区","千代田"\r\nshort\r\n')).toEqual([]);
  });

  test('splitTown', () => {
    expect(splitTown('以下に掲載がない場合')).toEqual({ town: '', annotation: '' });
    expect(splitTown('境町の次に番地がくる場合')).toEqual({ town: '', annotation: '' });
    expect(splitTown('常盤（その他）')).toEqual({ town: '常盤', annotation: 'その他' });
    expect(splitTown('川上町（３６４９、３６６１）')).toEqual({ town: '川上町', annotation: '３６４９、３６６１' });
    expect(splitTown('永田町')).toEqual({ town: '永田町', annotation: '' });
  });
});

describe('JIGYOSYO', () => {
  test('Shift_JIS の事業所番号と私書箱を読む', () => {
    const rows = parseJigyosyo(jigyosyoText());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      zip: '0608621', kind: 'office', lg5: '01101', pref: '北海道', city: '札幌市中央区', town: '北一条西', townRaw: '北一条西',
      annotation: '', detail: '６丁目１－２アーバンネット札幌ビル２Ｆ', office: '株式会社　日本経済新聞社　札幌支社',
    });
    expect(rows[1]).toMatchObject({ zip: '1008799', kind: 'po_box', lg5: '13101', office: '私書箱テスト' });
  });
});

describe('SQLite', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'addr-postal-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('郵便番号と市区町村コードで引ける。市区町村の引き当ては一般の行だけ', () => {
    const path = join(dir, 'postal.sqlite');
    buildPostalDb(path, [...parseKenAll(KEN_ALL), ...parseJigyosyo(jigyosyoText())]);
    const reader = new PostalReader(path);
    try {
      expect(reader.byZip('1000001')).toEqual([expect.objectContaining({ id: 1, zip: '1000001', town: '千代田', townRaw: '千代田', kind: 'general' })]);
      expect(reader.byZip('0608621')[0]).toMatchObject({ kind: 'office', office: '株式会社　日本経済新聞社　札幌支社' });
      expect(reader.byZip('9999999')).toEqual([]);
      expect(reader.byLg5('01101').map((row) => row.zip)).toEqual(['0600000', '0600042', '0640820']);
    } finally {
      reader.close();
    }
  });
});

describe('foldName', () => {
  test('全角・漢数字・「大字」「字」・表記ゆれをそろえる', () => {
    expect(foldName('北１条西')).toBe(foldName('北一条西'));
    expect(foldName('猪高町大字猪子石字猪々道')).toBe(foldName('猪高町猪子石猪々道'));
    expect(foldName('一ノ井町')).toBe(foldName('一之井町'));
    expect(foldName('上賀茂蝉ヶ垣内町')).toBe(foldName('上賀茂蝉ケ垣内町'));
    expect(foldName('永田町　一丁目')).toBe('永田町1');
    expect(foldName('千代田')).toBe('千代田');
  });
});

describe('注記の解釈', () => {
  test('丁目の範囲', () => {
    expect(parseChomeRange('１〜１９丁目')).toEqual({ lo: 1, hi: 19 });
    expect(parseChomeRange('２０～２８丁目')).toEqual({ lo: 20, hi: 28 });
    expect(parseChomeRange('その他')).toBeNull();
    expect(parseChomeRange('１〜１０番地')).toBeNull();
  });

  test('番地の範囲と列挙は住所の番地が入るかで判定し、解釈できない注記は null', () => {
    expect(annotationMatchesNumber('１〜１０番地', '3-4')).toBe(true);
    expect(annotationMatchesNumber('１〜１０番地', '12')).toBe(false);
    expect(annotationMatchesNumber('１１〜２０番地', '12-3')).toBe(true);
    expect(annotationMatchesNumber('３６４９、３６６１', '3661')).toBe(true);
    expect(annotationMatchesNumber('３６４９、３６６７−３', '3667-3')).toBe(true);
    expect(annotationMatchesNumber('３６４９、３６６７−３', '3667-4')).toBe(false);
    expect(annotationMatchesNumber('１階', '12')).toBeNull();
    expect(annotationMatchesNumber('その他', '12')).toBeNull();
    expect(annotationMatchesNumber('１〜１０番地', 'あ')).toBeNull();
  });
});

function postalRow(id: number, lg5: string, raw: string, zip = String(1000000 + id)): PostalRow {
  const { town, annotation } = splitTown(raw);
  return { id, zip, kind: 'general', lg5, pref: '', city: '', town, townRaw: raw, annotation, detail: '', office: '' };
}
const t = (machiaza_id: string, oaza_cho: string, extra: Partial<TownRef> = {}): TownRef => ({ machiaza_id, oaza_cho, ...extra });

describe('linkPostalRows', () => {
  test('町域名を同じ市区町村の町字に結びつける（丁目は全部に）', () => {
    const towns = [t('a1', '永田町', { chome: '一丁目', chome_n: 1 }), t('a2', '永田町', { chome: '二丁目', chome_n: 2 }), t('b', '千代田')];
    const links = linkPostalRows([postalRow(1, '13101', '永田町'), postalRow(2, '13101', '千代田')], towns);
    expect(links.get(1)).toEqual({ machiazaIds: ['a1', 'a2'], exact: true });
    expect(links.get(2)).toEqual({ machiazaIds: ['b'], exact: true });
  });

  test('丁目の範囲は chome_n で絞る。算用数字・漢数字の揺れも吸収する', () => {
    const towns = [1, 19, 20, 28].map((n) => t(`n${n}`, '北１条西', { chome: `${n}丁目`, chome_n: n }));
    const links = linkPostalRows([postalRow(1, '01101', '北一条西（１〜１９丁目）'), postalRow(2, '01101', '北一条西（２０〜２８丁目）')], towns);
    expect(links.get(1)).toEqual({ machiazaIds: ['n1', 'n19'], exact: true });
    expect(links.get(2)).toEqual({ machiazaIds: ['n20', 'n28'], exact: true });
  });

  test('「その他」は、丁目の範囲の行が取らなかった町字を受ける', () => {
    const towns = [1, 2, 3, 4, 5].map((n) => t(`c${n}`, '常盤', { chome_n: n }));
    const links = linkPostalRows([postalRow(1, '01101', '常盤（１〜３丁目）'), postalRow(2, '01101', '常盤（その他）')], towns);
    expect(links.get(1)?.machiazaIds).toEqual(['c1', 'c2', 'c3']);
    expect(links.get(2)).toEqual({ machiazaIds: ['c4', 'c5'], exact: true });
  });

  test('大字・字・小字・「一円」を扱い、建物別の行と解釈できない注記を区別する', () => {
    const towns = [t('k1', '猪高町大字猪子石', { koaza: '字猪々道' }), t('j', '利島村'), t('m', '岩作')];
    const links = linkPostalRows(
      [postalRow(1, '23101', '猪高町猪子石猪々道'), postalRow(2, '13361', '利島村一円'), postalRow(3, '23101', '岩作（１〜１０番地）'), postalRow(4, '13101', '岩作ビル（１階）')],
      towns,
    );
    expect(links.get(1)).toEqual({ machiazaIds: ['k1'], exact: true });
    expect(links.get(2)).toEqual({ machiazaIds: ['j'], exact: true });
    expect(links.get(3)).toEqual({ machiazaIds: ['m'], exact: false });
    expect(links.has(4)).toBe(false);
  });

  test('結びつかない行と、市区町村の既定行は結果に含めない', () => {
    const links = linkPostalRows([postalRow(1, '13101', '存在しない町'), postalRow(2, '13101', '以下に掲載がない場合')], [t('a', '千代田')]);
    expect(links.size).toBe(0);
  });
});

describe('zipsForTown', () => {
  const towns = [t('m', '岩作')];
  const rows = [postalRow(1, '23101', '岩作（１〜１０番地）', '4801103'), postalRow(2, '23101', '岩作（１１〜２０番地）', '4801104'), postalRow(3, '23101', '以下に掲載がない場合', '4801100')];
  const links = linkPostalRows(rows, towns);

  test('番地が分かれば、範囲の合う郵便番号を exact にして先頭に置く', () => {
    expect(zipsForTown(rows, links, 'm', '12-3').map((m) => [m.row.zip, m.exact, m.fallback])).toEqual([['4801104', true, false]]);
  });

  test('番地が無ければ、範囲つきの行はどれも exact にならない', () => {
    expect(zipsForTown(rows, links, 'm').map((m) => [m.row.zip, m.exact, m.fallback])).toEqual([['4801103', false, false], ['4801104', false, false]]);
  });

  test('どの範囲にも入らなければ全部を exact でなく返す', () => {
    expect(zipsForTown(rows, links, 'm', '99').map((m) => [m.row.zip, m.exact])).toEqual([['4801103', false], ['4801104', false]]);
  });

  test('専用の番号が無い町字は、市区町村の既定番号を fallback で返す', () => {
    expect(zipsForTown(rows, links, 'unknown').map((m) => [m.row.zip, m.exact, m.fallback])).toEqual([['4801100', false, true]]);
  });

  test('同じ郵便番号は 1 件にまとめる', () => {
    const dup = [postalRow(1, '13101', '永田町', '1000014'), postalRow(2, '13101', '永田町（１〜２丁目）', '1000014')];
    const matches = zipsForTown(dup, linkPostalRows(dup, [t('x', '永田町', { chome_n: 1 })]), 'x');
    expect(matches).toHaveLength(1);
  });
});
```

注: 上の `zipsForTown` の「番地が無ければ…」のテストで、`exact` が false になるのは、番地の範囲の注記（解釈できない注記）の行は `linkPostalRows` が `exact: false` で結びつけるため。

- [ ] **Step 3: テストが失敗することを確認する**

Run: `bun test src/services/postal_code.test.ts`
Expected: FAIL（`Cannot find module './postal_code.js'`）。

- [ ] **Step 4: 実装する**

`src/services/postal_code.ts`:

```ts
import { Database, type Statement } from 'bun:sqlite';
import { kanji2number } from '@geolonia/japanese-numeral';
import { parseCsvMatrix } from './address_csv.js';

export type PostalKind = 'general' | 'office' | 'po_box';

export interface PostalRowInput {
  zip: string;
  kind: PostalKind;
  lg5: string;
  pref: string;
  city: string;
  /** 括弧の注記と「以下に掲載がない場合」を除いた町域。市区町村の既定行では空。 */
  town: string;
  /** 原文の町域（括弧の注記つき）。 */
  townRaw: string;
  /** 括弧の中身（丁目・番地の範囲、階、その他）。 */
  annotation: string;
  /** JIGYOSYO の小字・丁目・番地等。 */
  detail: string;
  /** JIGYOSYO の事業所名。 */
  office: string;
}

export interface PostalRow extends PostalRowInput {
  id: number;
}

// ---------- 解析 ----------

export function splitTown(raw: string): { town: string; annotation: string } {
  if (raw === '以下に掲載がない場合' || raw.endsWith('の次に番地がくる場合')) return { town: '', annotation: '' };
  const match = raw.match(/^([^（]*)(?:（(.*)）)?$/);
  return { town: match?.[1] ?? raw, annotation: match?.[2] ?? '' };
}

/** 日本郵便の utf_ken_all.csv（UTF-8、ヘッダー無し、15 列）。 */
export function parseKenAll(text: string): PostalRowInput[] {
  const rows: PostalRowInput[] = [];
  for (const r of parseCsvMatrix(text)) {
    const zip = r[2] ?? '';
    if (r.length < 9 || !/^\d{7}$/.test(zip)) continue;
    const raw = r[8] ?? '';
    const { town, annotation } = splitTown(raw);
    rows.push({ zip, kind: 'general', lg5: r[0] ?? '', pref: r[6] ?? '', city: r[7] ?? '', town, townRaw: raw, annotation, detail: '', office: '' });
  }
  return rows;
}

/** 日本郵便の事業所の個別郵便番号（JIGYOSYO.CSV。Shift_JIS を復号した文字列、13 列）。 */
export function parseJigyosyo(text: string): PostalRowInput[] {
  const rows: PostalRowInput[] = [];
  for (const r of parseCsvMatrix(text)) {
    const zip = r[7] ?? '';
    if (r.length < 11 || !/^\d{7}$/.test(zip)) continue;
    rows.push({
      zip, kind: r[10] === '1' ? 'po_box' : 'office', lg5: r[0] ?? '', pref: r[3] ?? '', city: r[4] ?? '',
      town: r[5] ?? '', townRaw: r[5] ?? '', annotation: '', detail: r[6] ?? '', office: r[2] ?? '',
    });
  }
  return rows;
}

// ---------- SQLite ----------

interface DbRow {
  id: number;
  zip: string;
  kind: PostalKind;
  lg5: string;
  pref: string;
  city: string;
  town: string;
  town_raw: string;
  annotation: string;
  detail: string;
  office: string;
}

const toRow = (r: DbRow): PostalRow => ({
  id: r.id, zip: r.zip, kind: r.kind, lg5: r.lg5, pref: r.pref, city: r.city,
  town: r.town, townRaw: r.town_raw, annotation: r.annotation, detail: r.detail, office: r.office,
});

export function buildPostalDb(path: string, rows: readonly PostalRowInput[]): void {
  const db = new Database(path, { create: true });
  try {
    db.run(`CREATE TABLE postal (
      id INTEGER PRIMARY KEY, zip TEXT NOT NULL, kind TEXT NOT NULL, lg5 TEXT NOT NULL, pref TEXT NOT NULL, city TEXT NOT NULL,
      town TEXT NOT NULL, town_raw TEXT NOT NULL, annotation TEXT NOT NULL, detail TEXT NOT NULL, office TEXT NOT NULL)`);
    const insert = db.prepare('INSERT INTO postal (zip, kind, lg5, pref, city, town, town_raw, annotation, detail, office) VALUES (?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => {
      for (const r of rows) insert.run(r.zip, r.kind, r.lg5, r.pref, r.city, r.town, r.townRaw, r.annotation, r.detail, r.office);
    })();
    db.run('CREATE INDEX postal_zip ON postal(zip)');
    db.run('CREATE INDEX postal_lg5 ON postal(lg5)');
  } finally {
    db.close();
  }
}

export class PostalReader {
  private readonly db: Database;
  private readonly byZipStatement: Statement<DbRow, [string]>;
  private readonly byLg5Statement: Statement<DbRow, [string]>;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
    this.byZipStatement = this.db.prepare<DbRow, [string]>('SELECT * FROM postal WHERE zip = ? ORDER BY id');
    this.byLg5Statement = this.db.prepare<DbRow, [string]>("SELECT * FROM postal WHERE lg5 = ? AND kind = 'general' ORDER BY id");
  }

  byZip(zip: string): PostalRow[] {
    return this.byZipStatement.all(zip).map(toRow);
  }

  /** 市区町村（5 桁コード）の一般の行。事業所・私書箱は含めない。 */
  byLg5(lg5: string): PostalRow[] {
    return this.byLg5Statement.all(lg5).map(toRow);
  }

  close(): void {
    this.db.close();
  }
}

// ---------- 町域名の照合 ----------

const FOLD_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['大字', ''], ['字', ''], ['ヶ', 'ケ'], ['ヵ', 'カ'], ['ッ', 'ツ'], ['ノ', '之'], ['の', '之'], ['丁目', ''], [' ', ''], ['　', ''],
];

/** KEN_ALL の町域名と ABR の町字名を比べるために、表記の違いをそろえる。 */
export function foldName(input: string): string {
  let text = input.normalize('NFKC').replace(/[〇一二三四五六七八九十百]+/g, (run) => {
    try {
      return String(kanji2number(run));
    } catch {
      return run;
    }
  });
  for (const [from, to] of FOLD_REPLACEMENTS) text = text.split(from).join(to);
  return text;
}

export function parseChomeRange(annotation: string): { lo: number; hi: number } | null {
  const match = annotation.normalize('NFKC').match(/^(\d+)[〜~\-－−ー]\s*(\d+)丁目$/);
  return match ? { lo: Number(match[1]), hi: Number(match[2]) } : null;
}

/**
 * 番地の範囲（「１〜１０番地」）や番地の列挙（「３６４９、３６６１」）の注記に、住所の番地が入るか。
 * 番地を判定できない注記（階・建物・地割・「その他」など）や、番地の無い住所は null。
 */
export function annotationMatchesNumber(annotation: string, addr: string): boolean | null {
  const head = addr.match(/^(\d+)/)?.[1];
  if (!head) return null;
  const text = annotation.normalize('NFKC').replace(/[−‐‑–—ー－]/g, '-');
  const range = text.match(/^(\d+)[〜~](\d+)(?:番地?)?$/);
  if (range) {
    const n = Number(head);
    return n >= Number(range[1]) && n <= Number(range[2]);
  }
  if (/^\d+(?:-\d+)*(?:[、,]\d+(?:-\d+)*)*$/.test(text)) {
    return text.split(/[、,]/).some((entry) => addr === entry || addr.startsWith(`${entry}-`));
  }
  return null;
}

// ---------- 町字への結びつけ ----------

export interface TownRef {
  machiaza_id: string;
  oaza_cho?: string;
  koaza?: string;
  chome?: string;
  chome_n?: number;
  point?: [number, number];
}

export interface PostalLink {
  machiazaIds: string[];
  /** 注記（丁目の範囲など）まで解釈できて、この町字に当たること。 */
  exact: boolean;
}

/**
 * 同じ市区町村の一般の郵便番号の行を、ABR の町字に名前で結びつける。
 * 建物別の行（階の注記）、市区町村の既定行、町字に当たらない行は結果に含めない。
 */
export function linkPostalRows(rows: readonly PostalRow[], towns: readonly TownRef[]): Map<number, PostalLink> {
  const index = new Map<string, TownRef[]>();
  const add = (key: string, town: TownRef): void => {
    if (!key) return;
    const list = index.get(key);
    if (!list) index.set(key, [town]);
    else if (!list.includes(town)) list.push(town);
  };
  for (const town of towns) {
    const oaza = town.oaza_cho ?? '';
    const koaza = town.koaza ?? '';
    const chome = town.chome ?? '';
    add(foldName(oaza), town);
    if (koaza) {
      add(foldName(koaza), town);
      add(foldName(oaza + koaza), town);
    }
    if (chome) add(foldName(oaza + chome), town);
  }

  const items: Array<{ row: PostalRow; key: string }> = [];
  for (const row of rows) {
    if (row.kind !== 'general' || row.town === '' || row.annotation.includes('階')) continue;
    // 「一円」は漢数字の「一」を含むので、照合名にそろえる前に外す。
    const base = row.town.endsWith('一円') ? row.town.slice(0, -2) : row.town;
    items.push({ row, key: foldName(base) });
  }

  const links = new Map<number, PostalLink>();
  const taken = new Map<string, Set<string>>();
  // 丁目の範囲つきの行を先に結びつけ、「その他」の行が残りを受ける。
  for (const { row, key } of items) {
    const range = parseChomeRange(row.annotation);
    if (!range) continue;
    const ids = (index.get(key) ?? [])
      .filter((town) => town.chome_n !== undefined && town.chome_n >= range.lo && town.chome_n <= range.hi)
      .map((town) => town.machiaza_id);
    if (ids.length === 0) continue;
    links.set(row.id, { machiazaIds: ids, exact: true });
    const set = taken.get(key) ?? new Set<string>();
    for (const id of ids) set.add(id);
    taken.set(key, set);
  }
  for (const { row, key } of items) {
    if (links.has(row.id)) continue;
    const candidates = index.get(key) ?? [];
    if (candidates.length === 0) continue;
    if (row.annotation === '') {
      links.set(row.id, { machiazaIds: candidates.map((town) => town.machiaza_id), exact: true });
    } else if (row.annotation === 'その他') {
      const used = taken.get(key);
      const ids = candidates.filter((town) => !used?.has(town.machiaza_id)).map((town) => town.machiaza_id);
      if (ids.length > 0) links.set(row.id, { machiazaIds: ids, exact: true });
    } else if (parseChomeRange(row.annotation) === null) {
      links.set(row.id, { machiazaIds: candidates.map((town) => town.machiaza_id), exact: false });
    }
  }
  return links;
}

export interface ZipMatch {
  row: PostalRow;
  exact: boolean;
  /** 町字の専用番号が無く、市区町村の既定番号を返したこと。 */
  fallback: boolean;
}

/** 町字（と、分かれば住所の番地）に当たる郵便番号。exact のものを先に、同じ番号は 1 件にまとめる。 */
export function zipsForTown(
  rows: readonly PostalRow[],
  links: ReadonlyMap<number, PostalLink>,
  machiazaId: string,
  addr?: string,
): ZipMatch[] {
  const linked = rows.filter((row) => links.get(row.id)?.machiazaIds.includes(machiazaId));
  let matches: ZipMatch[];
  if (linked.length > 0) {
    matches = linked.map((row) => ({ row, exact: links.get(row.id)?.exact ?? false, fallback: false }));
    if (addr !== undefined) {
      const judged = matches.map((match) => ({ match, hit: annotationMatchesNumber(match.row.annotation, addr) }));
      const kept = judged.filter((item) => item.hit !== false);
      matches = kept.length > 0
        ? kept.map(({ match, hit }) => (hit === true ? { ...match, exact: true } : match))
        : matches.map((match) => ({ ...match, exact: false }));
    }
  } else {
    matches = rows.filter((row) => row.kind === 'general' && row.town === '').map((row) => ({ row, exact: false, fallback: true }));
  }
  const seen = new Set<string>();
  const result: ZipMatch[] = [];
  for (const match of [...matches].sort((a, b) => Number(b.exact) - Number(a.exact))) {
    if (seen.has(match.row.zip)) continue;
    seen.add(match.row.zip);
    result.push(match);
  }
  return result;
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `bun test src/services/postal_code.test.ts`
Expected: PASS（全件）。失敗した場合は、`foldName` の置換の順序、`parseChomeRange` の区切り文字、`linkPostalRows` の「その他」の扱いを見直す（テストの意図は変えない）。

- [ ] **Step 6: 型検査と lint**

Run: `bun run typecheck && bun run lint`
Expected: エラーなし。

- [ ] **Step 7: Commit**

```bash
git add src/services/postal_code.ts src/services/postal_code.test.ts src/test_fixtures/address/jigyosyo.ts
git commit -m "feat(address): parse postal data, store it in SQLite and link it to ABR towns"
```

## Task 6: テスト用の偽の取得元と、構築ジョブ

**Files:**
- Create: `src/test_fixtures/address/harness.ts`、`src/services/address_jobs.ts`
- Test: `src/services/address_jobs.test.ts`

**Interfaces:**
- Consumes: `AddressStore`・`BuildJob`・`jobArtifactId`（Task 2）、`headSignature` `downloadToFile` `combineSignatures` `latestSourceDate` `resolveJapanPostLinks` `ABR_BASE` `HttpDeps` `FetchFn`（Task 3）、`readZipText` `parseCsvRows`（Task 4）、`buildJaJson` `buildTownJson` `Row`（Task 4）、`parseKenAll` `parseJigyosyo` `buildPostalDb`（Task 5）。
- Produces（`address_jobs.ts`）:
  - `interface JobMinimum { prefs; cities; towns; general; office }`、`DEFAULT_MINIMUM`
  - `interface JobDeps { store: AddressStore; http?: HttpDeps; minimum?: Partial<JobMinimum>; nowSeconds?: () => number }`
  - `runBuildJob(job: BuildJob, deps: JobDeps): Promise<void>`（取得元が変わっていなければ HEAD だけで終える。失敗は `markError` してから投げ直す）
- Produces（`harness.ts`）:
  - `class FakeUpstream { routes; requests; set(url, route); setZip(url, entries, meta?); count(method, pattern?); fetchFn: FetchFn }`
  - `csv(header, rows): string`、`abrUrl(path): string`、`sampleUpstream(): FakeUpstream`、`SMALL_MINIMUM`、`CHIYODA_LG = '131016'`、`SAPPORO_LG = '011011'`、`KEN_ALL_FIXTURE: string`

- [ ] **Step 1: 偽の取得元を作る**

`src/test_fixtures/address/harness.ts`:

```ts
import {
  ABR_BASE, JAPANPOST_FALLBACK, JAPANPOST_JIGYOSYO_PAGE, JAPANPOST_KEN_ALL_PAGE, type FetchFn,
} from '../../services/address_http.js';
import { jigyosyoBytes } from './jigyosyo.js';
import { makeZip } from './zip.js';

export interface FakeRoute {
  body: Uint8Array | string;
  etag?: string;
  lastModified?: string;
  status?: number;
  /** リダイレクト後の URL（Response.url）。 */
  finalUrl?: string;
}

/** URL ごとの応答を返す偽の fetch。HEAD は本文なし。登録の無い URL は 404。 */
export class FakeUpstream {
  readonly routes = new Map<string, FakeRoute>();
  readonly requests: Array<{ method: string; url: string }> = [];

  set(url: string, route: FakeRoute): this {
    this.routes.set(url, route);
    return this;
  }

  setZip(url: string, entries: Record<string, string | Uint8Array>, meta: Omit<FakeRoute, 'body'> = {}): this {
    return this.set(url, { body: makeZip(entries), ...meta });
  }

  count(method: string, pattern?: string): number {
    return this.requests.filter((r) => r.method === method && (!pattern || r.url.includes(pattern))).length;
  }

  readonly fetchFn: FetchFn = async (url, init) => {
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url });
    const route = this.routes.get(url);
    if (!route) return new Response(null, { status: 404 });
    const status = route.status ?? 200;
    const body = typeof route.body === 'string' ? new TextEncoder().encode(route.body) : route.body;
    const headers: Record<string, string> = { 'content-length': String(body.length) };
    if (route.etag) headers.etag = route.etag;
    if (route.lastModified) headers['last-modified'] = route.lastModified;
    const response = new Response(method === 'HEAD' || status >= 400 ? null : body, { status, headers });
    Object.defineProperty(response, 'url', { value: route.finalUrl ?? url });
    return response;
  };
}

export function csv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const quote = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return `${[header, ...rows].map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
}

export const abrUrl = (path: string): string => `${ABR_BASE}/${path}.csv.zip`;

export const CHIYODA_LG = '131016';
export const SAPPORO_LG = '011011';
export const ABR_LAST_MODIFIED = 'Fri, 02 Oct 2026 15:40:53 GMT';
export const POSTAL_LAST_MODIFIED = 'Wed, 30 Sep 2026 07:46:52 GMT';
/** 固定データの大きさに合わせた、構築結果の最小値。 */
export const SMALL_MINIMUM = { prefs: 2, cities: 2, towns: 1, general: 3, office: 2 } as const;

const POS_HEADER = ['lg_code', 'rep_lon', 'rep_lat', 'rep_srid', 'rep_scale'];
const CITY_HEADER = ['lg_code', 'pref', 'pref_kana', 'pref_roma', 'county', 'county_kana', 'county_roma', 'city', 'city_kana', 'city_roma', 'ward', 'ward_kana', 'ward_roma'];
const TOWN_HEADER = ['lg_code', 'machiaza_id', 'oaza_cho', 'oaza_cho_kana', 'oaza_cho_roma', 'chome', 'chome_number', 'koaza', 'koaza_kana', 'koaza_roma', 'rsdt_addr_flg'];
const TOWN_POS_HEADER = ['lg_code', 'machiaza_id', 'rep_lon', 'rep_lat', 'rep_srid'];

const city = (lg: string, pref: string, name: string, ward = ''): string[] =>
  [lg, pref, `${pref}カナ`, `${pref}-roma`, '', '', '', name, `${name}カナ`, `${name}-roma`, ward, ward ? `${ward}カナ` : '', ward ? `${ward}-roma` : ''];
const town = (lg: string, id: string, oaza: string, chome: string, n: string, rsdt: string): string[] =>
  [lg, id, oaza, `${oaza}カナ`, `${oaza}-roma`, chome, n, '', '', '', rsdt];

/** 千代田区と札幌市中央区の町字。札幌は ABR と同じ全角数字の大字名（北１条西）にしてある。 */
export const CHIYODA_TOWNS = [
  town(CHIYODA_LG, '0006000', '千代田', '', '', '1'),
  town(CHIYODA_LG, '0005001', '永田町', '一丁目', '1', '1'),
  town(CHIYODA_LG, '0005002', '永田町', '二丁目', '2', '1'),
];
const CHIYODA_POS = [
  [CHIYODA_LG, '0006000', '139.752145', '35.684052', 'EPSG:6668'],
  [CHIYODA_LG, '0005001', '139.746306', '35.675895', 'EPSG:6668'],
  [CHIYODA_LG, '0005002', '139.74317', '35.67412', 'EPSG:6668'],
];
const SAPPORO_TOWNS = [
  town(SAPPORO_LG, '0013001', '北１条西', '１丁目', '1', '0'),
  town(SAPPORO_LG, '0013002', '北１条西', '２丁目', '2', '0'),
  town(SAPPORO_LG, '0013020', '北１条西', '２０丁目', '20', '0'),
  town(SAPPORO_LG, '0014001', '大通西', '１丁目', '1', '0'),
  town(SAPPORO_LG, '0014020', '大通西', '２０丁目', '20', '0'),
];
const SAPPORO_POS = [
  [SAPPORO_LG, '0013001', '141.3544', '43.0630', 'EPSG:6668'],
  [SAPPORO_LG, '0013002', '141.3541', '43.0640', 'EPSG:6668'],
  [SAPPORO_LG, '0013020', '141.3010', '43.0650', 'EPSG:6668'],
  [SAPPORO_LG, '0014001', '141.3548', '43.0610', 'EPSG:6668'],
  [SAPPORO_LG, '0014020', '141.3020', '43.0620', 'EPSG:6668'],
];

const kenAll = (lg5: string, zip: string, pref: string, city: string, town: string): string =>
  `${lg5},"${zip.slice(0, 3)}  ","${zip}","カナ","カナ","カナ","${pref}","${city}","${town}",0,0,0,0,0,0`;

export const KEN_ALL_FIXTURE = `${[
  kenAll('13101', '1000001', '東京都', '千代田区', '千代田'),
  kenAll('13101', '1000014', '東京都', '千代田区', '永田町'),
  kenAll('13101', '1006801', '東京都', '千代田区', '大手町ＪＡビル（１階）'),
  kenAll('13101', '1000000', '東京都', '千代田区', '以下に掲載がない場合'),
  kenAll('01101', '0600000', '北海道', '札幌市中央区', '以下に掲載がない場合'),
  kenAll('01101', '0600001', '北海道', '札幌市中央区', '北一条西（１〜１９丁目）'),
  kenAll('01101', '0640821', '北海道', '札幌市中央区', '北一条西（２０〜２８丁目）'),
  kenAll('01101', '0600042', '北海道', '札幌市中央区', '大通西（１〜１９丁目）'),
  kenAll('01101', '0640820', '北海道', '札幌市中央区', '大通西（２０〜２８丁目）'),
].join('\r\n')}\r\n`;

const JP_BASE = 'https://www.post.japanpost.jp/service/search/zipcode/download';

/** 全国マスター、千代田区と札幌市中央区の町字、日本郵便の郵便番号データを持つ偽の取得元。 */
export function sampleUpstream(): FakeUpstream {
  const up = new FakeUpstream();
  const abr = (path: string, header: readonly string[], rows: readonly (readonly string[])[]): void => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    up.setZip(abrUrl(path), { [`${name}.csv`]: csv(header, rows) }, { etag: `"${path}"`, lastModified: ABR_LAST_MODIFIED });
  };
  abr('mt_pref/mt_pref_all', ['lg_code', 'pref', 'pref_kana', 'pref_roma'], [
    ['010006', '北海道', 'ホッカイドウ', 'Hokkaido'], ['130001', '東京都', 'トウキョウト', 'Tokyo'],
  ]);
  abr('mt_pref_pos/mt_pref_pos_all', POS_HEADER, [
    ['010006', '141.347906782', '43.0639406375', 'EPSG:6668', '0'], ['130001', '139.691717', '35.689568', 'EPSG:6668', '0'],
  ]);
  abr('mt_city/mt_city_all', CITY_HEADER, [
    city('011002', '北海道', '札幌市'), city('011011', '北海道', '札幌市', '中央区'), city(CHIYODA_LG, '東京都', '千代田区'),
  ]);
  abr('mt_city_pos/mt_city_pos_all', POS_HEADER, [
    ['011002', '141.354374', '43.061972', 'EPSG:6668', '0'], ['011011', '141.35389', '43.061414', 'EPSG:6668', '0'], [CHIYODA_LG, '139.753634', '35.694003', 'EPSG:6668', '0'],
  ]);
  abr(`mt_town/city/mt_town_city${CHIYODA_LG}`, TOWN_HEADER, CHIYODA_TOWNS);
  abr(`mt_town_pos/city/mt_town_pos_city${CHIYODA_LG}`, TOWN_POS_HEADER, CHIYODA_POS);
  abr(`mt_town/city/mt_town_city${SAPPORO_LG}`, TOWN_HEADER, SAPPORO_TOWNS);
  abr(`mt_town_pos/city/mt_town_pos_city${SAPPORO_LG}`, TOWN_POS_HEADER, SAPPORO_POS);

  up.set(JAPANPOST_KEN_ALL_PAGE, { body: '<a href="utf/zip/utf_add_2609.zip">差分</a><a href="utf/zip/utf_ken_all.zip">全国</a>', finalUrl: `${JP_BASE}/utf-zip.html` });
  up.set(JAPANPOST_JIGYOSYO_PAGE, { body: '<a href="zip/jigyosyo.zip">全国</a>', finalUrl: `${JP_BASE}/office/index-zip.html` });
  up.setZip(JAPANPOST_FALLBACK.kenAll, { 'utf_ken_all.csv': KEN_ALL_FIXTURE }, { lastModified: POSTAL_LAST_MODIFIED });
  up.setZip(JAPANPOST_FALLBACK.jigyosyo, { 'JIGYOSYO.CSV': jigyosyoBytes() }, { lastModified: POSTAL_LAST_MODIFIED });
  return up;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`src/services/address_jobs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ABR_LAST_MODIFIED, CHIYODA_LG, FakeUpstream, SAPPORO_LG, SMALL_MINIMUM, abrUrl, sampleUpstream,
} from '../test_fixtures/address/harness.js';
import { JAPANPOST_FALLBACK } from './address_http.js';
import { runBuildJob, type JobDeps } from './address_jobs.js';
import { AddressStore } from './address_store.js';
import { PostalReader } from './postal_code.js';

let dir: string;
let store: AddressStore;
let up: FakeUpstream;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'addr-jobs-'));
  store = new AddressStore(dir);
  up = sampleUpstream();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = (): JobDeps => ({ store, http: { fetchFn: up.fetchFn, sleep: async () => undefined }, minimum: SMALL_MINIMUM, nowSeconds: () => 1_700_000_000 });
const readJson = (id: string, file: string): any => JSON.parse(readFileSync(join(store.current(id)!.path, file), 'utf8'));

describe('master', () => {
  test('全国マスターから ja.json を作って公開する', async () => {
    await runBuildJob({ kind: 'master' }, deps());
    const ja = readJson('master', 'ja.json');
    expect(ja.meta.updated).toBe(1_700_000_000);
    expect(ja.data.map((p: any) => p.pref)).toEqual(['北海道', '東京都']);
    expect(ja.data[0].cities.map((c: any) => `${c.city}${c.ward ?? ''}`)).toEqual(['札幌市中央区']);
    expect(store.current('master')?.meta.sourceDate).toBe('2026-10-02');
  });

  test('取得元が変わっていなければダウンロードせず、確認日時だけ進める', async () => {
    await runBuildJob({ kind: 'master' }, deps());
    const seq = store.read().seq;
    await runBuildJob({ kind: 'master' }, deps());
    expect(up.count('GET', 'mt_pref/mt_pref_all')).toBe(1);
    expect(up.count('HEAD', 'mt_pref/mt_pref_all')).toBe(2);
    expect(store.read().seq).toBe(seq);
  });

  test('想定より小さい結果は公開せず、旧版を維持して失敗を記録する', async () => {
    await runBuildJob({ kind: 'master' }, deps());
    const before = store.current('master')!.meta;
    up.setZip(abrUrl('mt_pref/mt_pref_all'), { 'mt_pref_all.csv': 'lg_code,pref,pref_kana,pref_roma\r\n130001,東京都,トウキョウト,Tokyo\r\n' }, { etag: '"changed"', lastModified: ABR_LAST_MODIFIED });
    await expect(runBuildJob({ kind: 'master' }, deps())).rejects.toThrow('想定より小さい');
    expect(store.current('master')?.meta.ver).toBe(before.ver);
    expect(store.read().artifacts.master?.error).toContain('想定より小さい');
  });

  test('国外からの接続拒否（403）は失敗として記録する', async () => {
    up.set(abrUrl('mt_city/mt_city_all'), { body: '', status: 403 });
    await expect(runBuildJob({ kind: 'master' }, deps())).rejects.toThrow('HTTP 403');
    expect(store.read().failures.master?.message).toContain('HTTP 403');
    expect(store.current('master')).toBeNull();
  });
});

describe('city', () => {
  test('町字と位置参照から town.json を作る', async () => {
    await runBuildJob({ kind: 'city', lgCode: CHIYODA_LG }, deps());
    const town = readJson(`city:${CHIYODA_LG}`, 'town.json');
    expect(town.data.map((t: any) => [t.machiaza_id, t.oaza_cho, t.chome ?? null])).toEqual([
      ['0006000', '千代田', null], ['0005001', '永田町', '一丁目'], ['0005002', '永田町', '二丁目'],
    ]);
    expect(town.data[1]).toMatchObject({ chome_n: 1, rsdt: true, point: [139.746306, 35.675895] });
  });

  test('位置参照が無い市区町村でも、座標なしで作る', async () => {
    up.routes.delete(abrUrl(`mt_town_pos/city/mt_town_pos_city${SAPPORO_LG}`));
    await runBuildJob({ kind: 'city', lgCode: SAPPORO_LG }, deps());
    const town = readJson(`city:${SAPPORO_LG}`, 'town.json');
    expect(town.data).toHaveLength(5);
    expect(town.data.every((t: any) => t.point === undefined)).toBe(true);
  });

  test('ABR に無い市区町村と不正なコードは失敗として記録する', async () => {
    await expect(runBuildJob({ kind: 'city', lgCode: '999999' }, deps())).rejects.toThrow('999999');
    expect(store.read().failures['city:999999']?.message).toContain('999999');
    await expect(runBuildJob({ kind: 'city', lgCode: 'abc' }, deps())).rejects.toThrow('不正');
  });

  test('取得元が変わっていなければ再構築しない', async () => {
    await runBuildJob({ kind: 'city', lgCode: CHIYODA_LG }, deps());
    const seq = store.read().seq;
    await runBuildJob({ kind: 'city', lgCode: CHIYODA_LG }, deps());
    expect(store.read().seq).toBe(seq);
    expect(up.count('GET', `mt_town_city${CHIYODA_LG}`)).toBe(1);
  });
});

describe('postal', () => {
  test('一般と事業所の郵便番号を postal.sqlite にまとめる', async () => {
    await runBuildJob({ kind: 'postal' }, deps());
    const reader = new PostalReader(join(store.current('postal')!.path, 'postal.sqlite'));
    try {
      expect(reader.byZip('1000001')).toHaveLength(1);
      expect(reader.byZip('0608621')[0]).toMatchObject({ kind: 'office', city: '札幌市中央区' });
      expect(reader.byZip('1008799')[0]).toMatchObject({ kind: 'po_box' });
      expect(reader.byLg5('01101')).toHaveLength(5);
    } finally {
      reader.close();
    }
    expect(store.current('postal')?.meta.sourceDate).toBe('2026-09-30');
  });

  test('サンプルの郵便番号 1000001 が無いデータは公開しない', async () => {
    const line = (zip: string, town: string) => `13101,"100  ","${zip}","カナ","カナ","カナ","東京都","千代田区","${town}",0,0,0,0,0,0\r\n`;
    up.setZip(
      JAPANPOST_FALLBACK.kenAll,
      { 'utf_ken_all.csv': line('1000014', '永田町') + line('1000000', '以下に掲載がない場合') + line('1000002', '皇居外苑') },
      { lastModified: 'Wed, 30 Sep 2026 07:46:52 GMT', etag: '"x"' },
    );
    await expect(runBuildJob({ kind: 'postal' }, deps())).rejects.toThrow('1000001');
    expect(store.current('postal')).toBeNull();
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `bun test src/services/address_jobs.test.ts`
Expected: FAIL（`Cannot find module './address_jobs.js'`）。

- [ ] **Step 4: 実装する**

`src/services/address_jobs.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJaJson, buildTownJson, type Row } from './address_abr.js';
import { parseCsvRows, readZipText } from './address_csv.js';
import {
  ABR_BASE, combineSignatures, downloadToFile, headSignature, latestSourceDate, resolveJapanPostLinks, type HttpDeps,
} from './address_http.js';
import { jobArtifactId, type AddressStore, type BuildJob } from './address_store.js';
import { buildPostalDb, parseJigyosyo, parseKenAll } from './postal_code.js';

export type { BuildJob } from './address_store.js';

/** 構築結果がこれより小さければ、取得元の形式が変わったとみなして公開しない。 */
export interface JobMinimum {
  prefs: number;
  cities: number;
  towns: number;
  general: number;
  office: number;
}
export const DEFAULT_MINIMUM: JobMinimum = { prefs: 47, cities: 1500, towns: 1, general: 100_000, office: 15_000 };

export interface JobDeps {
  store: AddressStore;
  http?: HttpDeps;
  minimum?: Partial<JobMinimum>;
  nowSeconds?: () => number;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const seconds = (deps: JobDeps): number => (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
const limits = (deps: JobDeps): JobMinimum => ({ ...DEFAULT_MINIMUM, ...deps.minimum });

/** 1 つの構築ジョブを同じプロセスの中で実行する。子プロセスの入口とテストから呼ぶ。 */
export async function runBuildJob(job: BuildJob, deps: JobDeps): Promise<void> {
  try {
    if (job.kind === 'master') await buildMaster(deps);
    else if (job.kind === 'postal') await buildPostal(deps);
    else await buildCity(job.lgCode, deps);
  } catch (error) {
    await deps.store.markError(jobArtifactId(job), errorText(error)).catch(() => undefined);
    throw error;
  }
}

const MASTER_FILES = {
  prefs: 'mt_pref/mt_pref_all',
  prefPos: 'mt_pref_pos/mt_pref_pos_all',
  cities: 'mt_city/mt_city_all',
  cityPos: 'mt_city_pos/mt_city_pos_all',
} as const;

async function buildMaster(deps: JobDeps): Promise<void> {
  const { store, http } = deps;
  const keys = Object.keys(MASTER_FILES) as Array<keyof typeof MASTER_FILES>;
  const urls = keys.map((key) => `${ABR_BASE}/${MASTER_FILES[key]}.csv.zip`);
  const signatures = await Promise.all(urls.map((url) => headSignature(url, http)));
  if (signatures.some((signature) => signature === null)) throw new Error('ABR の全国マスターが見つかりません');
  const sig = combineSignatures(signatures);
  const sourceDate = latestSourceDate(signatures);
  if (store.current('master')?.meta.sig === sig) {
    await store.markChecked('master', sourceDate);
    return;
  }
  const work = store.makeWorkDir();
  try {
    const rows = {} as Record<keyof typeof MASTER_FILES, Row[]>;
    for (const [index, key] of keys.entries()) {
      const zip = join(work, `${key}.zip`);
      if (!(await downloadToFile(urls[index] as string, zip, http))) throw new Error(`ABR の ${MASTER_FILES[key]} が見つかりません`);
      rows[key] = parseCsvRows(await readZipText(zip));
    }
    const ja = buildJaJson(rows, seconds(deps));
    const min = limits(deps);
    const cityCount = ja.data.reduce((sum, pref) => sum + pref.cities.length, 0);
    if (ja.data.length < min.prefs || cityCount < min.cities) {
      throw new Error(`ABR の全国マスターが想定より小さい（都道府県 ${ja.data.length}、市区町村 ${cityCount}）`);
    }
    const out = join(work, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'ja.json'), JSON.stringify(ja));
    await store.publish('master', out, { sig, sourceDate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function buildCity(lgCode: string, deps: JobDeps): Promise<void> {
  const { store, http } = deps;
  if (!/^\d{6}$/.test(lgCode)) throw new Error(`不正な市区町村コード: ${lgCode}`);
  const id = `city:${lgCode}`;
  const townUrl = `${ABR_BASE}/mt_town/city/mt_town_city${lgCode}.csv.zip`;
  const posUrl = `${ABR_BASE}/mt_town_pos/city/mt_town_pos_city${lgCode}.csv.zip`;
  const [townSig, posSig] = await Promise.all([headSignature(townUrl, http), headSignature(posUrl, http)]);
  if (!townSig) throw new Error(`ABR に ${lgCode} の町字データがありません`);
  const sig = combineSignatures([townSig, posSig]);
  const sourceDate = latestSourceDate([townSig, posSig]);
  if (store.current(id)?.meta.sig === sig) {
    await store.markChecked(id, sourceDate);
    return;
  }
  const work = store.makeWorkDir();
  try {
    const townZip = join(work, 'town.zip');
    if (!(await downloadToFile(townUrl, townZip, http))) throw new Error(`ABR に ${lgCode} の町字データがありません`);
    let posRows: Row[] = [];
    if (posSig) {
      const posZip = join(work, 'pos.zip');
      if (await downloadToFile(posUrl, posZip, http)) posRows = parseCsvRows(await readZipText(posZip));
    }
    const town = buildTownJson(parseCsvRows(await readZipText(townZip)), posRows, seconds(deps));
    if (town.data.length < limits(deps).towns) throw new Error(`ABR の ${lgCode} の町字データが空です`);
    const out = join(work, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'town.json'), JSON.stringify(town));
    await store.publish(id, out, { sig, sourceDate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function buildPostal(deps: JobDeps): Promise<void> {
  const { store, http } = deps;
  const links = await resolveJapanPostLinks(http);
  const signatures = await Promise.all([headSignature(links.kenAll, http), headSignature(links.jigyosyo, http)]);
  if (signatures.some((signature) => signature === null)) throw new Error('日本郵便の郵便番号データが見つかりません');
  const sig = combineSignatures(signatures);
  const sourceDate = latestSourceDate(signatures);
  if (store.current('postal')?.meta.sig === sig) {
    await store.markChecked('postal', sourceDate);
    return;
  }
  const work = store.makeWorkDir();
  try {
    const kenZip = join(work, 'ken_all.zip');
    const jigZip = join(work, 'jigyosyo.zip');
    const kenDone = await downloadToFile(links.kenAll, kenZip, http);
    const jigDone = await downloadToFile(links.jigyosyo, jigZip, http);
    if (!kenDone || !jigDone) throw new Error('日本郵便の郵便番号データが見つかりません');
    const general = parseKenAll(await readZipText(kenZip));
    const office = parseJigyosyo(await readZipText(jigZip, 'shift_jis'));
    const min = limits(deps);
    if (general.length < min.general || office.length < min.office) {
      throw new Error(`郵便番号データが想定より小さい（一般 ${general.length}、事業所 ${office.length}）`);
    }
    if (!general.some((row) => row.zip === '1000001')) throw new Error('郵便番号データに 1000001 がありません');
    const out = join(work, 'out');
    mkdirSync(out);
    buildPostalDb(join(out, 'postal.sqlite'), [...general, ...office]);
    await store.publish('postal', out, { sig, sourceDate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `bun test src/services/address_jobs.test.ts`
Expected: PASS（全件）。

- [ ] **Step 6: 型検査と lint**

Run: `bun run typecheck && bun run lint`
Expected: エラーなし。

- [ ] **Step 7: Commit**

```bash
git add src/test_fixtures/address/harness.ts src/services/address_jobs.ts src/services/address_jobs.test.ts
git commit -m "feat(address): add build jobs for master, postal and city data"
```

## Task 7: 実データでの通し確認と全件テスト

**Files:** なし（確認のみ。使い捨ての確認用スクリプトはスクラッチパッドに置き、コミットしない）。

**Interfaces:**
- Consumes: Task 2〜6 のすべて。
- Produces: 構築層が、偽の取得元ではなく実際の ABR・日本郵便のデータで動くという確認結果。

- [ ] **Step 1: 実データの確認スクリプトを書く**

スクラッチパッドに `address_build_smoke.ts` を置く（保存先は第 1 引数のディレクトリ。リポジトリの外にする）:

```ts
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { AddressStore } from '/home/ikeno/.worktrees/Sora/geo-address-data/src/services/address_store.ts';
import { runBuildJob, type BuildJob } from '/home/ikeno/.worktrees/Sora/geo-address-data/src/services/address_jobs.ts';
import { PostalReader, linkPostalRows } from '/home/ikeno/.worktrees/Sora/geo-address-data/src/services/postal_code.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: bun address_build_smoke.ts <dir>');
const store = new AddressStore(dir);
const jobs: BuildJob[] = [{ kind: 'master' }, { kind: 'city', lgCode: '131016' }, { kind: 'city', lgCode: '011011' }, { kind: 'city', lgCode: '261041' }, { kind: 'postal' }];
for (const job of jobs) {
  const t0 = performance.now();
  await runBuildJob(job, { store });
  console.log(JSON.stringify(job), `${(performance.now() - t0).toFixed(0)}ms`);
}
const read = (id: string, file: string) => JSON.parse(readFileSync(join(store.current(id)!.path, file), 'utf8'));
const ja = read('master', 'ja.json');
console.log('都道府県', ja.data.length, '市区町村', ja.data.reduce((n: number, p: any) => n + p.cities.length, 0));
const reader = new PostalReader(join(store.current('postal')!.path, 'postal.sqlite'));
for (const [lg6, lg5] of [['131016', '13101'], ['011011', '01101'], ['261041', '26104']] as const) {
  const towns = read(`city:${lg6}`, 'town.json').data;
  const rows = reader.byLg5(lg5);
  const links = linkPostalRows(rows, towns);
  const target = rows.filter((r) => r.town !== '' && !r.annotation.includes('階'));
  const linked = target.filter((r) => links.has(r.id)).length;
  console.log(lg6, '町字', towns.length, '郵便番号の行', rows.length, '町域あり', target.length, '結びつき', linked, `${((100 * linked) / Math.max(1, target.length)).toFixed(1)}%`);
}
console.log('1000014', JSON.stringify(reader.byZip('1000014').map((r) => `${r.city}${r.townRaw}`)));
reader.close();
```

- [ ] **Step 2: 実行する（日本のホストで。通信あり）**

```bash
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy
bun --no-env-file /tmp/claude-1000/-home-ikeno/e1702966-c1e8-40ca-94a0-4630dcdd01ef/scratchpad/address_build_smoke.ts /tmp/claude-1000/-home-ikeno/e1702966-c1e8-40ca-94a0-4630dcdd01ef/scratchpad/address-smoke
```

Expected:
- 5 つのジョブが成功し、master は数百ミリ秒〜数秒、各 city は 1 秒未満、postal は数秒で終わる。
- `都道府県 47`、`市区町村 1898`。
- 千代田区・札幌市中央区・京都市中京区の「町域あり」の行のうち、町字に結びついた割合がおおむね 95% 以上（試作の実測は全体で 97.3%）。大きく下回る場合は、`foldName` や `linkPostalRows` の規則を見直す（仕様書 5.4）。
- `1000014` が `千代田区永田町` を含む。

注: `261041` は京都市中京区の ABR の全国地方公共団体コード。ABR に無いコードなら、全国マスターの `ja.json` から京都市中京区の `code` を引いて 6 桁に直したものに置き換える。

- [ ] **Step 3: 全件のテスト・型検査・lint**

```bash
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy
export NODE_ENV=test SORA_DB_PATH=:memory: CHROME_PATH=/nix/store/kvy6drb6mr45j7vjhl6dpy13c7kb66kj-chromium-148.0.7778.167/bin/chromium
bun run typecheck
bun run lint
bun test --timeout 120000
```

Expected: 型検査と lint がエラーなし。テストは、基準（1607 pass / 29 skip / 0 fail）に、この計画で足した件数が加わって全件 pass。

- [ ] **Step 4: 計画の差分を反映して Commit**

実装中に計画から外れた点があれば、この計画書の該当箇所を直してから、まとめて Commit する。

```bash
git add docs/superpowers/plans/2026-10-13-address-data-foundation.md
git commit -m "docs(address): add the data foundation implementation plan"
```

### 実行結果（2026-10-13）

- Task 1〜6 は計画どおり、テストを先に書いて失敗を確かめてから実装した。全タスクで型検査と lint が通り、1 タスク 1 コミット。
- 実データ（この日本のホスト、通信あり）の通し確認:
  - 全国マスター 489ms（47都道府県、1,898市区町村）。市区町村の段A は 1 件 176〜234ms。郵便番号 1.7 秒（zip 2.9MB、保存形式は SQLite で 18MB）。
  - 郵便番号の行を町字に結びつけた割合（町域のある行、建物別の行を除く）: 千代田区 100%（60/60）、札幌市中央区 100%（88/88）、世田谷区 100%（61/61）、京都市中京区 98.8%（493/499）。
  - 未結合は京都市中京区の 6 行（「滕屋町」「西大文字町」「西ノ京塚本町」「西ノ京日扇町」など）。
- 計画から変えた点:
  - 型: Bun の型定義では `Uint8Array<ArrayBufferLike>` が `Response` の本文に渡せないため、テスト補助の本文の型を `BodyInit` / `Uint8Array<ArrayBuffer>` にした（`respond`、`makeZip`、`FakeRoute.body`、`jigyosyoBytes`）。
  - lint: 型にしか使わない import に `type` を付けた（`address_jobs.test.ts`）。
  - 実データで分かった注記の扱い（`postal_code.ts` に反映済み、テストあり）: 「次のビルを除く」は町全体の番号として `exact` にする（東京の中心部に 33 件）。「８丁目」のような 1 つの丁目だけの注記を丁目の範囲として扱う。
- 実データの注記の内訳（一般の行 6,479）: 階 3,437、その他の注記 2,143（「南」「北」「二俣」など）、その他 562、番地の範囲・列挙 169、丁目の範囲 126、「…を除く」37、地割 3、「…を含む」2。
- 後続の計画に送るもの:
  - 京都の通り名の注記（「油屋町（蛸薬師通麸屋町西入、…）」。中京区で 80 行が `exact` でない）は、入力住所の通り名と突き合わせて郵便番号を選ぶ。
  - 「その他の注記」（小字や方角）を、ABR の小字名との照合で絞り込むかは、必要性を見て判断する。
  - 未結合の 1.2%（中京区）の原因調査は急がない（順引きでは使える）。
