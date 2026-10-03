# API表記ゆれ・契約不一致の修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP・REST(OpenAPI)の入力定義で、説明文に書かれた既定値・選択肢・範囲をスキーマ上でも宣言し、MCPとRESTの同じパラメータを一致させる。あわせて、監査で見つかった「入力が無視される」「応答定義が実際と違う」不具合を直す。

**Architecture:** まず `scripts/schema-notation/scan.ts` に表記ゆれ検出器を作り、実際のMCP `listTools` とOpenAPI文書を走査する。検出結果がゼロであることを `bun test` の契約テストで固定し、以後の再発をCIで止める。既定値は `.meta({ default })` で宣言し、parse結果（省略時 `undefined`）を変えない。後半は監査レポートの項目を1件ずつ回帰テスト付きで直す。

**Tech Stack:** Bun 1.3、TypeScript、zod 4.4（`z.toJSONSchema`、`.meta()`、`z.literal([...])`）、Hono、`@modelcontextprotocol/sdk` 1.30（入力スキーマは zod 4 の `toJSONSchema` で変換される）。

## Global Constraints

- 作業ディレクトリは `/home/ikeno/Sora`。ブランチは `main` から `fix/api-schema-notation` を切って作業する。push・デプロイはしない。
- テスト実行は必ず `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test ...`。型検査は `bun run typecheck`。
- 単体テストで外部ネットワークに出ない。外部依存は `deps` 注入・`spyOn`・純粋関数の切り出しで置き換える。
- 既定値の宣言は **`.meta({ default: 値 })` だけ** を使う。`.default()` は使わない（省略時の値が `undefined` から変わり、実装の分岐が変わるため）。既に `.default()` が付いている項目はそのまま残す。
- **既定値は実装に合わせる。** 説明文を写すのではなく、実装で省略時に使われる値（`?? X`、`|| X`、分割代入の `= X`、`!== false` は true、`=== true` は false）を確認してから宣言する。説明文が実装と違えば、説明文を実装の値に直す。
- 説明文の既定値表記は `(デフォルト: 値)` に統一する。文字列は `"..."` で囲む（例: `(デフォルト: "30d")`）。条件付きの既定は「デフォルト」という語を使わず `(省略時: …)` と書く。
- 説明文は日本語のまま。意味を変える書き換えはしない。
- コミットはタスクごと。Conventional Commits（`fix(api): ...` など）。署名行（`Co-Authored-By:` など）は実行するLLMの規約に従う。
- 既存テストを壊さない。各タスクの最後に全テストと型検査を通す。

---

## 背景（2026-10-03 監査で確定した事実）

詳細は [2026-10-03-api-notation-audit.md](../audits/2026-10-03-api-notation-audit.md)。

本番 `fetcher.ikebun.jp` のAPIドキュメントで `formats` や `highlightAlgorithm` の選択肢が出ない問題は、`main`（`f63bfab`・`56fe1f3`）で修正済み。本番イメージはその前のビルドなので、次回デプロイで解消する。

現在の作業ツリーを検出器で走査した結果（ホテル有効時の48ツール、入力項目918件）:

| 種別 | 件数 | 内容 |
| --- | --- | --- |
| `default_undeclared` | 338 | 説明文に「デフォルト: X」があるのにスキーマに `default` がない（定義元は約120箇所） |
| `default_unparseable` | 11 | 「デフォルト: query指定時は…」など条件付き、または `30d` のように引用符なし |
| `unbounded_integer` | 30 | 上限なし整数。ドキュメントに `maximum: 9007199254740991` が出る |
| `range_mismatch` | 6 | 説明文の「最大20件」「1〜30」がスキーマにない |
| `enum_missing` | 2 | `minIntensity` が `10=震度1, 20=…` と列挙しているのに数値enumがない |
| `pair_mismatch` | 11 | MCPツールとRESTルートで上限・既定値・型が違う |

実装と照合して **説明文の既定値が誤っている** と確定したもの（Task 2で必ず直す）:

| 箇所 | 説明文 | 実装 | 根拠 |
| --- | --- | --- | --- |
| REST `/scrape`・`/scrape/stream` の `maxChars` | 10000 | 30000 | `src/scraper.ts:489`（`DEFAULT_MAX_CHARS`、`src/types.ts:12`） |
| MCP `scrape_batch`・REST `/scrape/batch` の `maxChars` | 10000 | 30000 | `scrapeBatchUrls` は `scrapeUrl` に素通し（`src/scraper.ts:933` 付近） |
| REST `/scrape`・`/scrape/stream` の `timeoutMs` | 30000 | 15000 | `src/scraper.ts:492` |
| REST `/browser/action`・`/action` の `extract.screenshotFullPage` | false | true | `src/browser_session.ts:578` |
| REST `/search/news` の `limit` | 10 | 20 | 上流Yahooの省略時件数。2026-10-03に実測で20件 |
| MCP `search_chiebukuro` の `limit` | 20 | 10 | 上流Yahooの省略時件数。2026-10-03に実測で10件 |

実測（2026-10-03、`limit` 省略時）: ニュース20件、知恵袋10件、画像20件、動画20件、サジェスト10件。

実装と一致を確認済み（参考）: `search_deep` の `limit`=5・`scrapeContent`=true・`includeRealtime`=true・`realtimeSort`="recent"・`dedup`=false・`enablePrf`=false・`highlightOverheadTokens`=96・`scrapeBudget`=8（`src/scraper.ts:1470-1512`）、`diversityWeight`=0.7（`src/enrichment.ts:637`）、`highlightMaxCount`=3（`src/scraper.ts:215`）、`chunkSize`=1000（`src/scraper.ts:545`）、crawl の `maxDepth`=2・`maxChars`=15000（`src/scraper.ts:1175-1176`）、`intervalSeconds`=3600（`src/db.ts:310`）、`minIntensity`=10（`src/services/disaster.ts:188`）、batch の `concurrency`=3。

## 判断事項（2026-10-03 ユーザー承認済み: すべて既定案で進める）

1. **上限値の新設**（Task 4）。上限がなかった整数に上限を付けると、超える値のリクエストは400になる。既定案の値は Task 4 の表のとおり。
2. **`/scrape/batch` の `maxChars` 既定値**。既定案は説明文を実装の30000に合わせる。実装を10000に変える案もある。
3. **画像・動画・サジェストの応答**（Task 9）。既定案は、上流Yahooの実際の形にスキーマを合わせる（利用者への影響が小さい）。動画の `source` だけは `"video"` に戻し、上流の値は `platform` に移す。
4. **`/scrape/batch` の `urls` に URL 形式チェックを入れる**（Task 7）。MCPと同じ `z.string().url()` にする。不正なURLは、従来の個別エラーではなく400になる。

## File Structure

| ファイル | 責務 |
| --- | --- |
| `scripts/schema-notation/scan.ts`（新規） | MCP入力スキーマ・OpenAPIを収集し、表記ゆれを検出する。CLIとしても動く |
| `scripts/schema-notation/allowlist.ts`（新規） | 意図的な差の許可リスト。各項目に理由を書く |
| `scripts/schema-notation/scan.test.ts`（新規） | 検出器の単体テスト（合成データ） |
| `scripts/schema-notation/repository.test.ts`（新規） | 実リポジトリに対する契約テスト。検出ゼロを固定する |
| `src/types.ts` | REST入力スキーマ・応答スキーマ・OpenAPI生成。既定値・上限・enumの宣言先 |
| `src/mcp.ts` | MCPツール定義。既定値・上限・enumの宣言先と、ハンドラーの引数転送 |
| `src/services/life.ts` | 乗換の日時解決・キャッシュキー（Task 6） |
| `src/routes/search.ts`、`src/routes/scrape.ts` | RESTハンドラーの引数転送（Task 6・8） |
| `src/scraper.ts` | `/map` の `until`、`noCache` の受け渡し（Task 8） |
| `src/services/yahoo.ts` | `noCache` の下層キャッシュ迂回、動画・画像の `source` 正規化（Task 8・9） |
| `README.md` | 追跡業者数の更新（Task 10） |

---

## Task 0: 作業ツリーの未コミット分を確定する

前のセッションの未コミット変更（TimeTree本文判定・同一投稿統合・OpenAPI変換器の置換・監査レポート）を、計画の作業と混ぜないために先にコミットする。

**Files:**
- Commit: `src/html_parser.ts`、`src/html_parser.test.ts`、`src/response_cleaner.ts`、`src/scraper.ts`、`src/search_compact.ts`、`src/search_compact.test.ts`、`src/search_format_projection.ts`、`src/types.ts`、`src/openapi_schema.test.ts`、`src/scrape_content_quality.ts`、`src/scrape_content_quality.test.ts`、`docs/superpowers/audits/2026-10-03-api-notation-audit.md`、本計画書

- [ ] **Step 1: 変更内容を確認する**

Run: `git -C /home/ikeno/Sora status --short`
Expected: 上記ファイルだけが変更・未追跡として出る。それ以外が出たら作業を止めてユーザーに確認する。

- [ ] **Step 2: 検証する**

Run: `bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: 型エラーなし。`0 fail`（2026-10-03時点で1245 pass、17 skip）。

- [ ] **Step 3: 2つに分けてコミットする**

```bash
git add src/html_parser.ts src/html_parser.test.ts src/response_cleaner.ts src/scraper.ts \
  src/search_compact.ts src/search_compact.test.ts src/search_format_projection.ts \
  src/scrape_content_quality.ts src/scrape_content_quality.test.ts
git commit -m "fix(scrape): restore event details, reject calendar-only bodies, merge identical posts"
git add src/types.ts src/openapi_schema.test.ts docs/superpowers/audits/2026-10-03-api-notation-audit.md \
  docs/superpowers/plans/2026-10-03-api-schema-notation-fix.md
git commit -m "fix(api): generate OpenAPI with zod toJSONSchema and document actual search responses"
```

`src/types.ts` には両方の変更が混在しているため、2つ目のコミットにまとめてよい。

- [ ] **Step 4: 作業ブランチを切る**

```bash
git switch -c fix/api-schema-notation
```

---

## Task 1: 表記ゆれ検出器

**Files:**
- Create: `scripts/schema-notation/scan.ts`
- Create: `scripts/schema-notation/allowlist.ts`
- Create: `scripts/schema-notation/scan.test.ts`
- Modify: `package.json`（`scripts` に1行追加）

**Interfaces:**
- Produces:
  - `parseDocumentedDefault(description: string): DocumentedDefault`
  - `findNotationIssues(params: Param[], pairs: Record<string, { method: string; path: string } | null>, allow?: Record<string, string>): Finding[]`
  - `collectParams(options?: { hotel?: boolean }): Promise<Param[]>`
  - `scanRepository(): Promise<Finding[]>`
  - `type FindingKind = 'default_undeclared' | 'default_mismatch' | 'default_unparseable' | 'enum_missing' | 'range_mismatch' | 'unbounded_integer' | 'pair_mismatch'`
  - `Finding.key` の形式: MCP・RESTの単項目は `"<surface> <owner> <path>"`（例: `"rest POST /scrape maxChars"`、`"rest GET /geo/poi query:limit"`）。`pair_mismatch` は `"<tool> <path>"`（例: `"suggest_keywords limit"`）
  - 許可リストのキー: `"<kind> <key>"`（例: `"pair_mismatch search_road_traffic pref"`）

- [ ] **Step 1: 単体テストを書く**

`scripts/schema-notation/scan.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { findNotationIssues, parseDocumentedDefault, type Param } from './scan.js';

const SAFE = Number.MAX_SAFE_INTEGER;
const kinds = (params: Param[], pairs: Record<string, { method: string; path: string } | null> = {}, allow: Record<string, string> = {}) =>
  findNotationIssues(params, pairs, allow).map((f) => f.kind);

describe('parseDocumentedDefault', () => {
  test.each([
    ['取得件数 (1〜50, デフォルト: 20)', 20],
    ['国コード (デフォルト: "jp")', 'jp'],
    ['出力形式 (デフォルト: ["markdown"])', ['markdown']],
    ['付与するか (デフォルト: false)', false],
    ['並行数 (デフォルト: 3, 最大: 5)', 3],
    ['"rho-select-v2"(デフォルト: 論文版), "legacy"', 'rho-select-v2'],
    ['"auto" (スマート自動判定, デフォルト), "fast"', 'auto'],
    ['"full"(デフォルト全文), "highlights"', 'full'],
  ] as const)('%s', (description, value) => {
    expect(parseDocumentedDefault(description)).toEqual({ found: true, parseable: true, value: value as unknown });
  });

  test('conditional and unquoted string defaults are unparseable', () => {
    expect(parseDocumentedDefault('抽出するか (デフォルト: query指定時はtrue, query未指定時はfalse)')).toEqual({ found: true, parseable: false });
    expect(parseDocumentedDefault('調査期間 (デフォルト: 30d)')).toEqual({ found: true, parseable: false });
  });

  test('descriptions without the word デフォルト have no documented default', () => {
    expect(parseDocumentedDefault('特定の ID (省略時は全件を走査)')).toEqual({ found: false });
  });
});

describe('findNotationIssues', () => {
  const limit = (schema: Record<string, unknown>): Param => ({ surface: 'mcp', owner: 'tool', path: 'limit', schema: { type: 'integer', minimum: 1, maximum: 50, ...schema } });

  test('documented default must be declared with the same value', () => {
    expect(kinds([limit({ description: '件数 (1〜50, デフォルト: 20)' })])).toEqual(['default_undeclared']);
    expect(kinds([limit({ description: '件数 (1〜50, デフォルト: 20)', default: 20 })])).toEqual([]);
    expect(kinds([limit({ description: '件数 (1〜50, デフォルト: 20)', default: 10 })])).toEqual(['default_mismatch']);
  });

  test('value lists without enum are reported', () => {
    const scale = '最小震度 (10=震度1, 20=震度2, 30=震度3)';
    expect(kinds([limit({ description: scale })])).toEqual(['enum_missing']);
    expect(kinds([limit({ description: scale, enum: [10, 20, 30] })])).toEqual([]);
    const mode: Param = { surface: 'rest', owner: 'POST /x', path: 'mode', schema: { type: 'string', description: '"auto"(自動), "fast"(静的)' } };
    expect(kinds([mode])).toEqual(['enum_missing']);
  });

  test('safe-integer bounds and documented ranges must be explicit', () => {
    expect(kinds([limit({ maximum: SAFE })])).toEqual(['unbounded_integer']);
    expect(kinds([limit({ minimum: undefined, maximum: undefined, description: '件数 (1〜30)' })])).toEqual(['range_mismatch']);
    const urls: Param = { surface: 'rest', owner: 'POST /x', path: 'urls', schema: { type: 'array', items: { type: 'string' }, description: 'URL 配列 (最大20件)' } };
    expect(kinds([urls])).toEqual(['range_mismatch']);
  });

  test('MCP tool and REST twin must agree; allowlist suppresses with a reason', () => {
    const mcp: Param = { surface: 'mcp', owner: 'tool', path: 'limit', schema: { type: 'integer', minimum: 1, maximum: 30 } };
    const rest: Param = { surface: 'rest', owner: 'POST /tool', path: 'limit', schema: { type: 'integer', minimum: 1, maximum: 20 } };
    const pairs = { tool: { method: 'POST', path: '/tool' } };
    expect(kinds([mcp, rest], pairs)).toEqual(['pair_mismatch']);
    expect(kinds([mcp, rest], pairs, { 'pair_mismatch tool limit': 'intentional' })).toEqual([]);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test scripts/schema-notation/scan.test.ts`
Expected: FAIL（`Cannot find module './scan.js'`）

- [ ] **Step 3: 許可リストを作る**

`scripts/schema-notation/allowlist.ts`:

```ts
// `${kind} ${key}` -> reason. Every entry must state why the difference is intentional.
export const NOTATION_ALLOWLIST: Record<string, string> = {};
```

- [ ] **Step 4: 検出器を実装する**

`scripts/schema-notation/scan.ts`（このまま作成する。2026-10-03に本リポジトリで動作確認済み）:

```ts
// Input-schema notation scanner: documented defaults / enums / ranges vs declared JSON Schema,
// and MCP tool <-> REST route parity. Pure checks live in findNotationIssues().
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp.js';
import { generateOpenApiDocument } from '../../src/types.js';
import { REST_MAP } from '../tool-health/catalog.js';
import { NOTATION_ALLOWLIST } from './allowlist.js';

export type Surface = 'mcp' | 'rest';
export interface Param { surface: Surface; owner: string; path: string; schema: any }
export type FindingKind =
  | 'default_undeclared' | 'default_mismatch' | 'default_unparseable'
  | 'enum_missing' | 'range_mismatch' | 'unbounded_integer' | 'pair_mismatch';
export interface Finding { kind: FindingKind; key: string; detail: string }
export type DocumentedDefault = { found: false } | { found: true; parseable: false } | { found: true; parseable: true; value: unknown };

const SAFE = Number.MAX_SAFE_INTEGER;
const stripExamples = (text: string) => text.replace(/例\s*[:：][^)）]*/g, '');

export function parseDocumentedDefault(description: string): DocumentedDefault {
  const text = stripExamples(description ?? '');
  if (!text.includes('デフォルト')) return { found: false };
  const strictInline = text.match(/"([^"]+)"\s*[（(]\s*デフォルト/);
  if (strictInline) return { found: true, parseable: true, value: strictInline[1] };
  const explicit = text.match(/デフォルト\s*[:：]\s*(.*)$/s);
  if (explicit) {
    const rest = explicit[1];
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^"([^"]*)"/))) return { found: true, parseable: true, value: m[1] };
    if ((m = rest.match(/^(\[[^\]]*\])/))) {
      try { return { found: true, parseable: true, value: JSON.parse(m[1]) }; } catch { return { found: true, parseable: false }; }
    }
    if ((m = rest.match(/^(true|false)(?![\w])/))) return { found: true, parseable: true, value: m[1] === 'true' };
    if ((m = rest.match(/^(-?\d+(?:\.\d+)?)(?![\d.\w])/))) return { found: true, parseable: true, value: Number(m[1]) };
    return { found: true, parseable: false };
  }
  const looseInline = text.match(/"([^"]+)"\s*[（(][^)）]*デフォルト[^:：]/);
  if (looseInline) return { found: true, parseable: true, value: looseInline[1] };
  return { found: true, parseable: false };
}

const keyOf = (p: Param) => `${p.surface} ${p.owner} ${p.path}`;
const enumOf = (s: any): unknown[] | undefined => s.enum ?? s.items?.enum ?? (s.anyOf ? s.anyOf.flatMap((v: any) => v.enum ?? []) : undefined);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortedEnum = (s: any) => { const e = enumOf(s); return e && e.length ? [...e].map(String).sort() : undefined; };

export function findNotationIssues(
  params: Param[],
  pairs: Record<string, { method: string; path: string } | null>,
  allow: Record<string, string> = {},
): Finding[] {
  const out: Finding[] = [];
  const push = (kind: FindingKind, key: string, detail: string) => {
    if (!allow[`${kind} ${key}`]) out.push({ kind, key, detail });
  };
  for (const p of params) {
    const s = p.schema ?? {};
    const desc: string = s.description ?? '';
    const key = keyOf(p);
    const doc = parseDocumentedDefault(desc);
    if (doc.found && !doc.parseable) push('default_unparseable', key, desc);
    if (doc.found && doc.parseable) {
      if (s.default === undefined) push('default_undeclared', key, `documented ${JSON.stringify(doc.value)}`);
      else if (!same(s.default, doc.value)) push('default_mismatch', key, `declared ${JSON.stringify(s.default)} / documented ${JSON.stringify(doc.value)}`);
    }
    const noEx = stripExamples(desc);
    const hasEnum = !!enumOf(s)?.length;
    const isString = s.type === 'string' || (s.type === 'array' && s.items?.type === 'string');
    if (!hasEnum && isString && (noEx.match(/"[^"]+"\s*[（(]/g) ?? []).length >= 2) push('enum_missing', key, desc);
    if (!hasEnum && (s.type === 'integer' || s.type === 'number') && (noEx.match(/\d+\s*=/g) ?? []).length >= 3) push('enum_missing', key, desc);
    if (s.type === 'integer' || s.type === 'number') {
      if (s.maximum === SAFE || s.minimum === -SAFE) push('unbounded_integer', key, `min ${s.minimum} max ${s.maximum}`);
      const r = noEx.match(/(\d+)\s*[〜~～-]\s*(\d+)/);
      if (r && (s.minimum !== Number(r[1]) || s.maximum !== Number(r[2]))) push('range_mismatch', key, `documented ${r[1]}-${r[2]} / declared ${s.minimum}-${s.maximum}`);
    }
    const max = noEx.match(/最大\s*[:：]?\s*(\d+)/);
    if (max) {
      const declared = s.type === 'array' ? s.maxItems : (s.type === 'integer' || s.type === 'number') ? s.maximum : 'n/a';
      if (declared !== 'n/a' && declared !== Number(max[1])) push('range_mismatch', key, `documented max ${max[1]} / declared ${declared}`);
    }
  }
  const restByOwner = new Map<string, Param[]>();
  for (const p of params) if (p.surface === 'rest') restByOwner.set(p.owner, [...(restByOwner.get(p.owner) ?? []), p]);
  for (const p of params) {
    if (p.surface !== 'mcp') continue;
    const route = pairs[p.owner];
    if (!route) continue;
    const owner = `${route.method.toUpperCase()} ${route.path.replace(/:(\w+)/g, '{$1}')}`;
    const twin = (restByOwner.get(owner) ?? []).find((r) => r.path === p.path || r.path === `query:${p.path}` || r.path === `path:${p.path}`);
    if (!twin) continue;
    const a = p.schema ?? {}, b = twin.schema ?? {};
    const diffs: string[] = [];
    const typeOf = (s: any) => s.type ?? (s.anyOf ? s.anyOf.map((v: any) => v.type).join('|') : undefined);
    if (typeOf(a) !== typeOf(b)) diffs.push(`type ${typeOf(a)}/${typeOf(b)}`);
    if (!same(sortedEnum(a), sortedEnum(b))) diffs.push(`enum ${JSON.stringify(sortedEnum(a))}/${JSON.stringify(sortedEnum(b))}`);
    for (const f of ['default', 'minimum', 'maximum', 'maxItems'] as const) if (!same(a[f], b[f])) diffs.push(`${f} ${JSON.stringify(a[f])}/${JSON.stringify(b[f])}`);
    if (diffs.length) push('pair_mismatch', `${p.owner} ${p.path}`, `mcp/rest ${owner}: ${diffs.join('; ')}`);
  }
  return out;
}

function walk(out: Param[], surface: Surface, owner: string, path: string, schema: any): void {
  if (!schema || typeof schema !== 'object') return;
  if (path) out.push({ surface, owner, path, schema });
  for (const [k, v] of Object.entries<any>(schema.properties ?? {})) walk(out, surface, owner, path ? `${path}.${k}` : k, v);
  if (schema.items?.properties) walk(out, surface, owner, `${path}[]`, schema.items);
}

export async function collectParams(options: { hotel?: boolean } = {}): Promise<Param[]> {
  const out: Param[] = [];
  const previousHotelFlag = process.env.SORA_RAKUTEN_TRAVEL_ENABLED;
  if (options.hotel) process.env.SORA_RAKUTEN_TRAVEL_ENABLED = 'true';
  try {
    await collectInto(out);
  } finally {
    if (previousHotelFlag === undefined) delete process.env.SORA_RAKUTEN_TRAVEL_ENABLED;
    else process.env.SORA_RAKUTEN_TRAVEL_ENABLED = previousHotelFlag;
  }
  return out;
}

async function collectInto(out: Param[]): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false });
  const client = new Client({ name: 'schema-notation', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const tool of (await client.listTools()).tools) {
      if (!tool.name.startsWith('default.')) walk(out, 'mcp', tool.name, '', tool.inputSchema);
    }
  } finally {
    await client.close();
    await server.close();
  }
  const doc: any = generateOpenApiDocument();
  for (const [path, ops] of Object.entries<any>(doc.paths)) {
    for (const [method, op] of Object.entries<any>(ops)) {
      const owner = `${method.toUpperCase()} ${path}`;
      walk(out, 'rest', owner, '', op.requestBody?.content?.['application/json']?.schema);
      for (const prm of op.parameters ?? []) {
        out.push({ surface: 'rest', owner, path: `${prm.in}:${prm.name}`, schema: { ...(prm.schema ?? {}), description: prm.description ?? prm.schema?.description } });
      }
    }
  }
}

export async function scanRepository(): Promise<Finding[]> {
  return findNotationIssues(await collectParams({ hotel: true }), REST_MAP, NOTATION_ALLOWLIST);
}

if (import.meta.main) {
  const findings = await scanRepository();
  const byKind = new Map<string, Finding[]>();
  for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
  for (const [kind, list] of byKind) {
    console.log(`\n## ${kind} (${list.length})`);
    for (const f of list) console.log(`- ${f.key} :: ${f.detail}`);
  }
  console.log(`\nTOTAL ${findings.length}`);
  process.exitCode = findings.length ? 1 : 0;
}
```

- [ ] **Step 5: 単体テストが通ることを確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test scripts/schema-notation/scan.test.ts`
Expected: `14 pass`、`0 fail`

- [ ] **Step 6: CLIスクリプトを登録して実行する**

`package.json` の `scripts` に追加:

```json
"schema:notation": "NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file scripts/schema-notation/scan.ts"
```

Run: `bun run schema:notation > /tmp/schema-notation-baseline.txt; grep -E '^## |TOTAL' /tmp/schema-notation-baseline.txt`
Expected（2026-10-03時点。数値が多少ずれてもよい）:

```
## default_undeclared (338)
## default_unparseable (11)
## unbounded_integer (30)
## enum_missing (2)
## range_mismatch (6)
## pair_mismatch (11)
TOTAL 398
```

このファイルが以降のタスクの作業リストになる。

- [ ] **Step 7: コミットする**

```bash
git add scripts/schema-notation package.json
git commit -m "test(api): add input schema notation scanner"
```

---

## Task 2: 説明文の既定値をスキーマで宣言する

**Files:**
- Modify: `src/types.ts`、`src/mcp.ts`（`default_*` の検出箇所すべて）
- Create: `scripts/schema-notation/repository.test.ts`

**Interfaces:**
- Consumes: `scanRepository()`、`FindingKind`（Task 1）
- Produces: `repository.test.ts` の `expectNoFindings(kinds: FindingKind[])` ヘルパー。Task 3〜5 が同じファイルにテストを追加する

- [ ] **Step 1: 契約テストを書く**

`scripts/schema-notation/repository.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { scanRepository, type Finding, type FindingKind } from './scan.js';

let cached: Promise<Finding[]> | undefined;
const findings = () => (cached ??= scanRepository());

async function expectNoFindings(kinds: FindingKind[]): Promise<void> {
  const remaining = (await findings()).filter((f) => kinds.includes(f.kind)).map((f) => `${f.kind} ${f.key} :: ${f.detail}`);
  expect(remaining).toEqual([]);
}

describe('API input notation (MCP + OpenAPI)', () => {
  test('documented defaults are declared and match', async () => {
    await expectNoFindings(['default_undeclared', 'default_mismatch', 'default_unparseable']);
  }, 30_000);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test scripts/schema-notation/repository.test.ts`
Expected: FAIL。`default_*` が約349件並ぶ。

- [ ] **Step 3: 条件付き・表記不正の11件を書き換える**

検出した説明文の定義元を `rg -n -F '<説明文の先頭20文字>' src` で探して書き換える。

1. `extractHighlights`（`src/mcp.ts` に2箇所、`src/types.ts` に2箇所。`rg -n 'デフォルト: query指定時はtrue' src` で探す）:

   ```ts
   // before
   .describe('… (デフォルト: query指定時はtrue, query未指定時はfalse)')
   // after
   .describe('… (省略時: query指定時はtrue、未指定時はfalse)')
   ```

2. `responseMode`（`rg -n '"full" はデフォルト' src`）: 先頭を次の形に変える。後半の説明はそのまま残す。

   ```ts
   .describe('返却モード (デフォルト: "full")。"full": 従来互換で全文および周辺文脈を保持。"evidence": …（以下は元の文のまま）')
   ```

3. `research_country_context.period`（`rg -n 'デフォルト: 30d' src`）: 実装上の省略時の値を確認し、`30d` なら次のように書く。

   ```ts
   .describe('調査期間 (デフォルト: "30d")').meta({ default: '30d' })
   ```

- [ ] **Step 4: 確定済みの誤記を直す**

「背景」の表の6件を、実装の値に書き換えてから宣言する。例:

```ts
// src/types.ts の ScrapeRequestSchema（REST /scrape・/scrape/stream）
maxChars: z.number().int().min(1).optional().describe('抽出する最大文字数 (デフォルト: 30000)').meta({ default: 30000 }),
timeoutMs: z.number().int().min(1).optional().describe('タイムアウト時間 (ミリ秒, デフォルト: 15000)').meta({ default: 15000 }),

// src/types.ts の BatchScrapeRequestSchema と src/mcp.ts の scrape_batch
maxChars: z.number().int().min(1).max(50_000).optional().describe('各ページの最大文字数 (デフォルト: 30000)').meta({ default: 30000 }),

// src/types.ts:530 の extract（REST /browser/action・/action）。MCP は src/mcp.ts:986 で既に true
screenshotFullPage: z.boolean().optional().describe('フルページスクリーンショットにするか (デフォルト: true)').meta({ default: true }),

// src/types.ts の NewsSearchRequestSchema（REST /search/news）
limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20, 最大: 50)').meta({ default: 20 }),

// src/mcp.ts の search_chiebukuro
limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 10)').meta({ default: 10 }),
```

判断事項2で実装側を10000に変えると決まった場合だけ、`scrapeBatchUrls` に `maxChars = 10000` の既定を入れ、説明は10000のまま宣言する。

- [ ] **Step 5: 残りの `default_undeclared` を宣言する**

`/tmp/schema-notation-baseline.txt` の `default_undeclared` を上から順に処理する。1項目ごとに次の手順を踏む。

1. 定義元を `rg -n -F '<説明文の一部>' src/types.ts src/mcp.ts` で特定する。
2. 実装で省略時に使われる値を確認する。MCPはハンドラー（`src/mcp.ts` の `async ({ ... }) =>`）から呼ぶサービス関数、RESTは `src/routes/*.ts` のハンドラーから呼ぶサービス関数を読む。上流Yahooに素通しする `limit` は「背景」の実測値を使う。
3. 一致すれば `.describe(...)` の直後に `.meta({ default: 値 })` を付ける。違えば説明文を実装の値に直してから付ける。
4. 判断に迷う項目（実装で値が決まらない、上流依存で実測値がない）は、説明文の「デフォルト: X」を `(省略時: <実際の挙動>)` に書き換え、宣言はしない。書き換えた項目はコミットメッセージ本文に列挙する。

`.meta()` は `.optional()` の後、`.describe()` の後に付ける（この順で説明文と既定値の両方が出ることを確認済み）:

```ts
limit: z.number().int().min(1).max(50).optional().describe('取得件数 (デフォルト: 20)').meta({ default: 20 }),
```

同じ説明文を複数のスキーマが共有している場合（`HighlightAlgorithmSchema` など）は、共有元に1回付ければよい。

- [ ] **Step 6: 契約テストが通ることを確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test scripts/schema-notation/repository.test.ts`
Expected: PASS

- [ ] **Step 7: parse結果が変わっていないことを確認する**

Run: `bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: 型エラーなし、`0 fail`。`src/openapi_schema.test.ts` の `documentation defaults do not change omission semantics` も通る。

- [ ] **Step 8: コミットする**

```bash
git add src/types.ts src/mcp.ts scripts/schema-notation/repository.test.ts
git commit -m "fix(api): declare documented defaults and correct defaults that differed from implementation"
```

---

## Task 3: 選択肢（enum）の漏れを埋める

**Files:**
- Modify: `src/types.ts`（`EarthquakeRequestSchema`、`ChiebukuroSearchRequestSchema`、OpenAPIの `/tracking/{carrier}/{number}` パラメータ）
- Modify: `src/mcp.ts`（`search_earthquake`、`search_chiebukuro`）
- Modify: `scripts/schema-notation/repository.test.ts`
- Test: `src/schema_enums.test.ts`（新規）

**Interfaces:**
- Produces: `EARTHQUAKE_SCALE_CODES`（`src/types.ts`、`readonly [10, 20, 30, 40, 45, 50, 55, 60, 70]`）、`EarthquakeScaleSchema`、`ChiebukuroStatusSchema`

- [ ] **Step 1: 契約テストとenumの単体テストを書く**

`scripts/schema-notation/repository.test.ts` の `describe` 内に追加:

```ts
  test('listed values are declared as enum', async () => {
    await expectNoFindings(['enum_missing']);
  }, 30_000);
```

`src/schema_enums.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ChiebukuroSearchRequestSchema, EarthquakeRequestSchema, generateOpenApiDocument } from './types.js';

describe('enumerated inputs', () => {
  test('minIntensity accepts JMA scale codes only', () => {
    for (const code of [10, 20, 30, 40, 45, 50, 55, 60, 70]) expect(EarthquakeRequestSchema.safeParse({ minIntensity: code }).success).toBe(true);
    expect(EarthquakeRequestSchema.safeParse({ minIntensity: 35 }).success).toBe(false);
  });

  test('chiebukuro status is documented', () => {
    expect(ChiebukuroSearchRequestSchema.parse({ query: 'x', status: 'solved' }).status).toBe('solved');
    expect(ChiebukuroSearchRequestSchema.safeParse({ query: 'x', status: 'closed' }).success).toBe(false);
  });

  test('GET /tracking/{carrier}/{number} lists every carrier', () => {
    const doc: any = generateOpenApiDocument();
    const carrier = doc.paths['/tracking/{carrier}/{number}'].get.parameters.find((p: any) => p.name === 'carrier');
    expect([...carrier.schema.enum].sort()).toEqual(['dhl', 'fedex', 'fukutsu', 'japanpost', 'sagawa', 'seino', 'ups', 'yamato']);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/schema_enums.test.ts scripts/schema-notation/repository.test.ts`
Expected: FAIL（3件とも）

- [ ] **Step 3: 震度コードを数値enumにする**

`src/types.ts`（`EarthquakeRequestSchema` の直前）:

```ts
/** P2P地震情報の震度コード。10=震度1 … 45=震度5弱, 50=震度5強, 55=震度6弱, 60=震度6強, 70=震度7 */
export const EARTHQUAKE_SCALE_CODES = [10, 20, 30, 40, 45, 50, 55, 60, 70] as const;
export const EarthquakeScaleSchema = z.literal(EARTHQUAKE_SCALE_CODES);
```

`EarthquakeRequestSchema.minIntensity` と `src/mcp.ts` の `search_earthquake.minIntensity` を同じ定義にする:

```ts
minIntensity: EarthquakeScaleSchema.optional()
  .describe('最小震度コード (10=震度1, 20=震度2, 30=震度3, 40=震度4, 45=震度5弱, 50=震度5強, 55=震度6弱, 60=震度6強, 70=震度7, デフォルト: 10)')
  .meta({ default: 10 }),
```

`z.literal([...])` は OpenAPI で `{"type":"number","enum":[...]}` になる（確認済み）。

- [ ] **Step 4: 知恵袋の `status` を追加する**

`src/services/yahoo.ts:2134` の `status?: 'all' | 'open' | 'vote' | 'solved'` が実装の値。`'all'` のときは上流へ送らない。

`src/types.ts`:

```ts
export const ChiebukuroStatusSchema = z.enum(['all', 'open', 'vote', 'solved']);
```

`ChiebukuroSearchRequestSchema` と `src/mcp.ts` の `search_chiebukuro` の入力に追加:

```ts
status: ChiebukuroStatusSchema.optional()
  .describe('回答状況: "all"(すべて, デフォルト), "open"(回答受付中), "vote"(投票受付中), "solved"(解決済み)')
  .meta({ default: 'all' }),
```

`src/mcp.ts` の `search_chiebukuro` ハンドラーを `async ({ query, limit, status }) =>` にし、`searchYahooChiebukuro({ query, limit, status })` を呼ぶ。RESTハンドラー（`src/routes/search.ts:350`）は既に `status` を渡している。

- [ ] **Step 5: 追跡のGETパスの業者enumを直す**

`src/types.ts:3287` の手書きenumを、POST `/tracking` と同じ業者一覧から `auto` を除いたものにする:

```ts
{ name: 'carrier', in: 'path', required: true, schema: { type: 'string', enum: ['yamato', 'sagawa', 'japanpost', 'seino', 'fukutsu', 'ups', 'fedex', 'dhl'] }, description: '運送会社コード' },
```

`src/routes/tracking.ts:36` のハンドラーが `fedex`・`dhl` を受け付けることを確認する（未対応なら同じ業者判定関数を使うよう直す）。

- [ ] **Step 6: テストを通す**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/schema_enums.test.ts scripts/schema-notation/repository.test.ts`
Expected: PASS

- [ ] **Step 7: 全体を確認してコミットする**

Run: `bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: `0 fail`

```bash
git add src/types.ts src/mcp.ts src/schema_enums.test.ts scripts/schema-notation/repository.test.ts
git commit -m "fix(api): declare earthquake scale, chiebukuro status and tracking carrier enums"
```

---

## Task 4: 数値の範囲・件数上限を明示する

**Files:**
- Modify: `src/types.ts`、`src/mcp.ts`
- Modify: `scripts/schema-notation/repository.test.ts`

- [ ] **Step 1: 契約テストを追加する**

```ts
  test('integer bounds and documented ranges are declared', async () => {
    await expectNoFindings(['unbounded_integer', 'range_mismatch']);
  }, 30_000);
```

- [ ] **Step 2: 失敗を確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test scripts/schema-notation/repository.test.ts`
Expected: FAIL（`unbounded_integer` 約30件、`range_mismatch` 6件）

- [ ] **Step 3: 上限を付ける**

判断事項1の既定案。MCP側に既に上限がある項目は、それに合わせる。

| 項目 | 箇所 | 宣言 |
| --- | --- | --- |
| `maxChars` | REST `/scrape`・`/scrape/stream` | `.min(1).max(100_000)`（MCP `scrape` と同じ） |
| `maxChars` | REST `/scrape/batch`・`/crawl`・`/crawl/stream` | `.min(1).max(50_000)`（MCP `scrape_batch`・`crawl_site` と同じ） |
| `chunkSize` | MCP `scrape`・`scrape_batch`、REST `/scrape`・`/scrape/stream` | `.min(1).max(100_000)` |
| `timeoutMs` | REST `/scrape`・`/scrape/stream`・`/crawl`・`/crawl/stream` | `.min(1).max(120_000)` |
| `retryDelayMs` | REST `/scrape`・`/scrape/stream` | `.min(1).max(30_000)` |
| `maxDepth` | REST `/crawl`・`/crawl/stream` | `.min(1).max(5)` |
| `page` | MCP `search_realtime`、REST `/search/image`・`/search/video`・`/search/news`・`/search/chiebukuro`・`/search/realtime`・`/realtime` | `.min(1).max(100)` |
| `adults` | MCP `search_hotel_availability`、REST `/hotels/availability` | `.min(1).max(10)` |
| `intervalSeconds` | MCP `watch_register`、REST `/watch/register` | `.min(1).max(604_800)` |
| `urls` | REST `/scrape/batch` | `.min(1).max(20)` |
| `concurrency` | REST `/scrape/batch` | `.min(1).max(5)`（実装は5で打ち切る。`src/scraper.ts:934`） |
| `via` | REST `/transit/route` | `.max(3)`（Task 6で共有定義に置き換わる） |

`minIntensity` は Task 3 でenumになっている。

- [ ] **Step 4: GETクエリの `limit` に範囲を付ける**

`src/types.ts` の手書きパラメータ3箇所:

```ts
// /gov/diet-minutes（src/types.ts:3072 付近）
{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 30, default: 10 }, description: '取得件数 (1〜30, デフォルト: 10)' },
// /geo/poi（src/types.ts:3158 付近）
{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 }, description: '最大件数 (1〜50)' },
// /intelligence/context/{contextId}/evidence（src/types.ts:3369 付近）
{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 }, description: '取得件数 (1〜100)' },
```

`/geo/poi` の既定値と `/intelligence/.../evidence` の既定値は、対応するハンドラー（`src/routes/public_data.ts`、`src/routes/intelligence.ts:54-59`）で確認し、値があれば `default` と説明文に入れる。各ハンドラーが範囲外の値を丸めているか確認し、丸めていなければ `Math.min(Math.max(n, 1), 上限)` を入れる。

- [ ] **Step 5: テストを通してコミットする**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test scripts/schema-notation/repository.test.ts && bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: すべてPASS、`0 fail`

```bash
git add src/types.ts src/mcp.ts scripts/schema-notation/repository.test.ts
git commit -m "fix(api): declare integer bounds and documented list limits"
```

---

## Task 5: MCPとRESTの同名パラメータを一致させる

**Files:**
- Modify: `src/types.ts`、`src/mcp.ts`
- Modify: `scripts/schema-notation/allowlist.ts`
- Modify: `scripts/schema-notation/repository.test.ts`

- [ ] **Step 1: 契約テストを「検出ゼロ」に置き換える**

`repository.test.ts` の3つのテストの後に追加:

```ts
  test('MCP tools and REST twins agree', async () => {
    await expectNoFindings(['pair_mismatch']);
  }, 30_000);

  test('no notation findings remain', async () => {
    expect((await findings()).map((f) => `${f.kind} ${f.key}`)).toEqual([]);
  }, 30_000);
```

- [ ] **Step 2: 失敗を確認する**

Run: `bun run schema:notation | grep -A40 '## pair_mismatch'`
Expected: Task 2〜4の後に残った差分が並ぶ。2026-10-03時点で残ると見込まれるもの:

- `suggest_keywords limit`（MCP 最大30、REST 最大20）
- `search_hotel_availability rooms`・`limit`（RESTは `.default(1)`・`.default(5)`、MCPは宣言なし）
- `search_road_traffic pref`（MCPは文字列、RESTは文字列または数値）
- Task 2で片側だけに既定値を宣言した項目。2026-10-03の比較で見つかった候補: `scrape` の `extractSummary`・`extractCitations`・`chunkMarkdown`・`validateLinks`・`formatAsPrompt`・`highlightMatches`・`maskPii`・`includeDiagnostics`・`includeDiscrepancies`・`safeNormalize`（MCPだけ `false` と記載）、`scrape_batch` の `mode`（MCPだけ `"auto"`）、`crawl_site` の `formats`（MCPだけ `["markdown"]`）

- [ ] **Step 3: 差分を解消する**

1. `suggest_keywords.limit`: MCP（`src/mcp.ts:1137`）を `.max(20)` にする（RESTと同じ。上流の省略時は10件）。
2. ホテル: MCP（`src/mcp.ts:1519-1520`）に宣言を足す。MCPハンドラーが省略時に同じ値（1室・5件）を使うことを確認する。
   ```ts
   rooms: z.number().int().min(1).max(1).optional().describe('部屋数（1のみ, デフォルト: 1）').meta({ default: 1 }),
   limit: z.number().int().min(1).max(10).optional().describe('最大施設件数（1〜10, デフォルト: 5）').meta({ default: 5 }),
   ```
3. 片側だけの既定値: もう片側も同じ実装（同じサービス関数）を通ることを確認し、同じ説明表記と `.meta({ default })` を付ける。実装が違う場合は、片方の説明文が誤りなので直す。
4. `search_road_traffic.pref`: 許可リストに登録する（RESTは都道府県コードの数値も受け付ける。MCPはLLMに名前での指定を促すため文字列に限定している）。
   ```ts
   export const NOTATION_ALLOWLIST: Record<string, string> = {
     'pair_mismatch search_road_traffic pref': 'REST accepts a numeric prefecture code; MCP keeps names only so the model passes 都道府県名.',
   };
   ```

許可リストへの追加は、理由が「意図的な仕様差」である場合に限る。直せるものは直す。

- [ ] **Step 4: 検出ゼロを確認する**

Run: `bun run schema:notation`
Expected: `TOTAL 0`、終了コード0

Run: `bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: `0 fail`

- [ ] **Step 5: コミットする**

```bash
git add src/types.ts src/mcp.ts scripts/schema-notation
git commit -m "fix(api): align MCP and REST parameter limits and defaults"
```

---

## Task 6: 乗換案内の日時・条件が無視される不具合（監査 A1〜A3）

**Files:**
- Modify: `src/services/life.ts`（`buildTransitUrl` の公開、日時解決、キャッシュキー）
- Modify: `src/types.ts`（`TRANSIT_ROUTE_INPUT_SHAPE` を新設、`TransitRouteRequestSchema` を置き換え）
- Modify: `src/mcp.ts`（`search_route` の入力を共有定義へ）
- Modify: `src/routes/search.ts`（`/transit/route` で `date`・`time` を転送）
- Test: `src/services/transit_datetime.test.ts`（新規）

**Interfaces:**
- Produces（`src/services/life.ts`）:
  - `export function resolveTransitDateTime(opts: TransitSearchOptions, now?: Date): { year: number; month: number; day: number; hour: number; minute: number }`
  - `export function transitCacheKey(opts: TransitSearchOptions): string`
  - `export function buildTransitUrl(opts: TransitSearchOptions): string`（既存関数を export する）
- Produces（`src/types.ts`）: `export const TRANSIT_ROUTE_INPUT_SHAPE`（zod raw shape）

- [ ] **Step 1: 失敗するテストを書く**

`src/services/transit_datetime.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildTransitUrl, resolveTransitDateTime, transitCacheKey } from './life.js';
import { TransitRouteRequestSchema } from '../types.js';

describe('transit date/time and cache key', () => {
  test('date/time strings drive the Yahoo query', () => {
    const url = new URL(buildTransitUrl({ from: '東京', to: '新宿', date: '20261005', time: '0930' }));
    expect(['y', 'm', 'd', 'hh', 'm1', 'm2'].map((k) => url.searchParams.get(k))).toEqual(['2026', '10', '05', '09', '3', '0']);
  });

  test('omitted date/time resolve in Asia/Tokyo regardless of server TZ', () => {
    expect(resolveTransitDateTime({ from: 'a', to: 'b' }, new Date('2026-10-03T16:05:00Z')))
      .toEqual({ year: 2026, month: 10, day: 4, hour: 1, minute: 5 });
  });

  test('cache key covers every route condition', () => {
    const base = { from: '東京', to: '新宿', date: '20261005', time: '0930' };
    const variants = [base, { ...base, ticket: 'cash' as const }, { ...base, sortBy: 'fare' as const }, { ...base, useShinkansen: false },
      { ...base, seatPreference: 'green' as const }, { ...base, walkSpeed: 'slow' as const }, { ...base, timeType: 'arrival' as const }];
    expect(new Set(variants.map((o) => transitCacheKey(o))).size).toBe(variants.length);
  });

  test('REST schema documents the same inputs as MCP', () => {
    const parsed = TransitRouteRequestSchema.parse({ from: '東京', to: '新宿', date: '20261005', time: '0930', ticket: 'cash', useShinkansen: false });
    expect(parsed).toMatchObject({ date: '20261005', time: '0930', ticket: 'cash', useShinkansen: false });
    expect(TransitRouteRequestSchema.safeParse({ from: 'a', to: 'b', via: ['1', '2', '3', '4'] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/services/transit_datetime.test.ts`
Expected: FAIL（`buildTransitUrl` などが export されていない）

- [ ] **Step 3: 日時解決とキャッシュキーを実装する**

`src/services/life.ts` の `buildTransitUrl` の直前に追加:

```ts
function tokyoNow(now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** date(YYYYMMDD)/time(HHMM) と year..minute を統合し、省略分は東京の現在時刻で埋める。 */
export function resolveTransitDateTime(opts: TransitSearchOptions, now = new Date()) {
  const base = tokyoNow(now);
  const date = opts.date?.match(/^(\d{4})(\d{2})(\d{2})$/);
  const time = opts.time?.match(/^(\d{2})(\d{2})$/);
  return {
    year: opts.year ?? (date ? Number(date[1]) : base.year),
    month: opts.month ?? (date ? Number(date[2]) : base.month),
    day: opts.day ?? (date ? Number(date[3]) : base.day),
    hour: opts.hour ?? (time ? Number(time[1]) : base.hour),
    minute: opts.minute ?? (time ? Number(time[2]) : base.minute),
  };
}

export function transitCacheKey(opts: TransitSearchOptions): string {
  const dt = resolveTransitDateTime(opts);
  return `transit:${JSON.stringify([
    opts.from, opts.to, opts.via ?? [], dt.year, dt.month, dt.day, dt.hour, dt.minute,
    opts.timeType ?? 'departure', opts.ticket ?? 'ic', opts.seatPreference ?? '', opts.walkSpeed ?? '', opts.sortBy ?? 'time',
    opts.useAirline !== false, opts.useShinkansen !== false, opts.useExpress !== false,
    opts.useHighwayBus !== false, opts.useLocalBus !== false, opts.useFerry !== false,
  ])}`;
}
```

`buildTransitUrl` を `export function buildTransitUrl` にし、日時部分（`src/services/life.ts:29-35`）を置き換える:

```ts
  // 日時
  const dt = resolveTransitDateTime(opts);
  params.set('y', String(dt.year));
  params.set('m', String(dt.month).padStart(2, '0'));
  params.set('d', String(dt.day).padStart(2, '0'));
  params.set('hh', String(dt.hour).padStart(2, '0'));
  params.set('m1', String(Math.floor(dt.minute / 10)));
  params.set('m2', String(dt.minute % 10));
```

`searchTransitRoute`（`src/services/life.ts:168`）の先頭で日時を1回だけ解決し、キーとURLに同じ値を使う:

```ts
export async function searchTransitRoute(input: TransitSearchOptions): Promise<any> {
  const opts = { ...input, ...resolveTransitDateTime(input) };
  const cacheKey = transitCacheKey(opts);
```

関数内の残りは `opts` をそのまま使う。

- [ ] **Step 4: 入力定義を共有する**

`src/mcp.ts` の `search_route` の入力オブジェクト（`from` から `useFerry` まで、`src/mcp.ts:1334-1353`）を `src/types.ts` に `export const TRANSIT_ROUTE_INPUT_SHAPE = { … };` として移す。`from`・`to` の説明は「出発駅・バス停・施設名 (例: "東京", "新大阪")」「到着駅・バス停・施設名 (例: "新宿", "京都")」にする。`src/mcp.ts` では `TRANSIT_ROUTE_INPUT_SHAPE` を渡す。

```ts
export const TransitRouteRequestSchema = z.object(TRANSIT_ROUTE_INPUT_SHAPE);
```

`src/routes/search.ts` の `/transit/route` ハンドラーで、`searchTransitRoute` に `date: body.date, time: body.time` を追加する。既存の `year`〜`minute` の転送は互換のため残す。

- [ ] **Step 5: テストを通す**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/services/transit_datetime.test.ts`
Expected: PASS

Run: `bun run schema:notation && bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: `TOTAL 0`、`0 fail`

- [ ] **Step 6: コミットする**

```bash
git add src/services/life.ts src/services/transit_datetime.test.ts src/types.ts src/mcp.ts src/routes/search.ts
git commit -m "fix(transit): honor date/time, resolve now in Asia/Tokyo, key cache on all conditions"
```

---

## Task 7: `scrape` の `fullPage` と `/scrape/batch` の入力欠落（監査 A4〜A6）

**Files:**
- Modify: `src/mcp.ts`（`scrape` ハンドラー、`scrape_batch` の入力定義）
- Modify: `src/types.ts`（`SCRAPE_BATCH_INPUT_SHAPE` を新設、`BatchScrapeRequestSchema` を置き換え）
- Test: `src/scrape_inputs.test.ts`（新規）

**Interfaces:**
- Produces: `export const SCRAPE_BATCH_INPUT_SHAPE`（`src/types.ts`）

- [ ] **Step 1: 失敗するテストを書く**

`src/scrape_inputs.test.ts`:

```ts
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as scraper from './scraper.js';
import { createMcpServer } from './mcp.js';
import { BatchScrapeRequestSchema } from './types.js';

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

describe('scrape inputs reach the implementation', () => {
  test('MCP scrape forwards fullPage', async () => {
    const spy = spyOn(scraper, 'scrapeUrl').mockResolvedValue({ url: 'https://example.com', title: 't', content: 'c', isTruncated: false, contentType: 'text/html', source: 'web' } as any);
    restore.push(() => spy.mockRestore());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ deferTools: false });
    const client = new Client({ name: 'scrape-inputs', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);
    try {
      await client.callTool({ name: 'scrape', arguments: { url: 'https://example.com', formats: ['screenshot'], fullPage: false } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(spy.mock.calls[0][0]).toMatchObject({ fullPage: false });
  });

  test('REST batch keeps every MCP batch option and enforces limits', () => {
    const parsed = BatchScrapeRequestSchema.parse({ urls: ['https://example.com'], maskPii: true, retries: 1, headers: { a: 'b' }, chunkMarkdown: true, noCache: true });
    expect(parsed).toMatchObject({ maskPii: true, retries: 1, headers: { a: 'b' }, chunkMarkdown: true, noCache: true });
    expect(BatchScrapeRequestSchema.safeParse({ urls: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`) }).success).toBe(false);
    expect(BatchScrapeRequestSchema.safeParse({ urls: ['https://example.com'], concurrency: 6 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/scrape_inputs.test.ts`
Expected: FAIL（`fullPage` が `undefined`、`maskPii` などが除去される）

- [ ] **Step 3: `fullPage` を転送する**

`src/mcp.ts` の `scrape` ハンドラーの引数分割（`async ({ url, maxChars, ... })`）に `fullPage` を加え、`src/mcp.ts:593` の `scrapeUrl({ ... })` 呼び出しに `fullPage` を加える。

- [ ] **Step 4: batchの入力定義を共有する**

`src/mcp.ts` の `scrape_batch` の入力オブジェクト（`src/mcp.ts:622` の `urls` から始まるブロック全体）を `src/types.ts` に `export const SCRAPE_BATCH_INPUT_SHAPE = { … };` として移し、`src/mcp.ts` ではそれを渡す。RESTは共有定義にREST専用の項目を足す:

```ts
export const BatchScrapeRequestSchema = z.object({
  ...SCRAPE_BATCH_INPUT_SHAPE,
  noCache: z.boolean().optional().describe('キャッシュをバイパスするか (デフォルト: false)').meta({ default: false }),
});
```

`SCRAPE_BATCH_INPUT_SHAPE` に `verbose` が無ければ、上の `z.object` に既存の `verbose` 定義（`src/types.ts:498`）も足す。`src/routes/scrape.ts:105` は `parsed.data` を展開して渡しているので変更不要。`scrapeBatchUrls` の型（`src/scraper.ts:888-930`）は13項目と `noCache` を受け付ける。

- [ ] **Step 5: テストを通してコミットする**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/scrape_inputs.test.ts && bun run schema:notation && bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: PASS、`TOTAL 0`、`0 fail`

```bash
git add src/mcp.ts src/types.ts src/scrape_inputs.test.ts
git commit -m "fix(scrape): forward fullPage and share batch inputs between MCP and REST"
```

---

## Task 8: `/map` の `until`・`noCache` と、Yahoo検索の `noCache`（監査 A7・A8）

**Files:**
- Modify: `src/scraper.ts`（`mapSiteUrl`、深層検索の `searchYahooWeb` 呼び出し）
- Modify: `src/routes/scrape.ts`（`/map`）
- Modify: `src/mcp.ts`（`map_site` に `until`）
- Modify: `src/services/yahoo.ts`（`searchYahooWeb` に `noCache`）
- Modify: `src/search_web_formats.ts`
- Test: `src/map_and_nocache.test.ts`（新規）

**Interfaces:**
- Produces:
  - `export function filterSitemapEntriesByDate<T extends { lastmod?: string }>(entries: T[], since?: string, until?: string): T[]`（`src/scraper.ts`）
  - `searchYahooWeb(options: { …既存, noCache?: boolean }, deps?)`

- [ ] **Step 1: 失敗するテストを書く**

`src/map_and_nocache.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { filterSitemapEntriesByDate } from './scraper.js';
import { searchYahooWeb } from './services/yahoo.js';

describe('map date filter', () => {
  const entries = [{ url: 'a', lastmod: '2026-07-01' }, { url: 'b', lastmod: '2026-08-15' }, { url: 'c', lastmod: '2026-09-30' }, { url: 'd' }];
  test('since and until are inclusive; entries without lastmod are kept', () => {
    expect(filterSitemapEntriesByDate(entries, '2026-08-01', '2026-09-01').map((e) => e.url)).toEqual(['b', 'd']);
    expect(filterSitemapEntriesByDate(entries, undefined, '2026-08-15').map((e) => e.url)).toEqual(['a', 'b', 'd']);
  });
});

describe('Yahoo web noCache', () => {
  test('noCache bypasses the fresh cache', async () => {
    let calls = 0;
    const deps = { fetchYahooWebDirect: async () => { calls++; return [{ title: 't', url: 'https://example.com/a', snippet: 's' }]; } } as any;
    const query = `nocache-probe-${Date.now()}`;
    await searchYahooWeb({ query, disableFallback: true }, deps);
    const afterFirst = calls;
    await searchYahooWeb({ query, disableFallback: true }, deps);
    expect(calls).toBe(afterFirst);
    await searchYahooWeb({ query, disableFallback: true, noCache: true }, deps);
    expect(calls).toBeGreaterThan(afterFirst);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/map_and_nocache.test.ts`
Expected: FAIL

- [ ] **Step 3: `/map` を直す**

`src/scraper.ts` に追加し、`mapSiteUrl` の `since` だけを見ている絞り込み（`src/scraper.ts:1091-1094`）をこの関数に置き換える:

```ts
export function filterSitemapEntriesByDate<T extends { lastmod?: string }>(entries: T[], since?: string, until?: string): T[] {
  const sinceTime = since ? new Date(since).getTime() : NaN;
  const untilTime = until ? new Date(until).getTime() : NaN;
  return entries.filter((e) => {
    if (!e.lastmod) return true;
    const t = new Date(e.lastmod).getTime();
    if (!Number.isNaN(sinceTime) && t < sinceTime) return false;
    if (!Number.isNaN(untilTime) && t > untilTime) return false;
    return true;
  });
}
```

`mapSiteUrl` の引数型に `until?: string` を加え、キャッシュキー（`src/scraper.ts:1055`）に `${options.until || ''}` を加える。`src/routes/scrape.ts` の `/map` で `until: body.until, noCache: body.noCache` を渡す。`src/mcp.ts` の `map_site` に `until` を追加して渡す（説明は REST `MapRequestSchema.until` と同じ）。

- [ ] **Step 4: Yahoo検索の `noCache` を通す**

`src/services/yahoo.ts` の `searchYahooWeb`:

```ts
export async function searchYahooWeb(options: {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  updated?: 'all' | 'day' | 'week' | 'year';
  disableFallback?: boolean;
  noCache?: boolean;
}, deps?: { callYahooMcp?: typeof callYahooMcp }): Promise<any> {
  const flightKey = yahooWebSearchFlightKey(options);
  const fresh = options.noCache ? null : getYahooFreshCache<any>(flightKey);
```

`yahooWebSearchFlightKey` が `noCache` をキーに含めないことを確認する（含めると、同時に走る同一検索の合流が分かれる）。呼び出し側に `noCache` を渡す:

- `src/search_web_formats.ts:23`: `deps.searchYahooWeb({ query: o.query, includeDomains: o.includeDomains, excludeDomains: o.excludeDomains, updated: o.updated, noCache: o.noCache })`
- `src/scraper.ts:1520` と `:1545`: 引数オブジェクトに `noCache` を加える

- [ ] **Step 5: テストを通してコミットする**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/map_and_nocache.test.ts && bun run schema:notation && bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: PASS、`TOTAL 0`、`0 fail`

```bash
git add src/scraper.ts src/routes/scrape.ts src/mcp.ts src/services/yahoo.ts src/search_web_formats.ts src/map_and_nocache.test.ts
git commit -m "fix(search): implement map until/noCache and bypass Yahoo fresh cache on noCache"
```

---

## Task 9: 応答スキーマを実際の応答に合わせる（監査 B1〜B7）

**Files:**
- Modify: `src/types.ts`（画像・動画・サジェスト・天気・地震・監視の応答スキーマ）
- Modify: `src/services/yahoo.ts`（画像・動画の `source` 正規化を純粋関数へ切り出し）
- Test: `src/response_schemas.test.ts`（新規）

**Interfaces:**
- Produces（`src/services/yahoo.ts`）: `export function normalizeYahooMediaItems(json: any, source: 'image' | 'video'): any`

- [ ] **Step 1: 失敗するテストを書く**

フィクスチャは 2026-10-03 に実取得した応答の形（値は短縮）。

`src/response_schemas.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  EarthquakeSearchResultSchema, ImageSearchResponseSchema, SuggestResponseSchema, VideoSearchResponseSchema,
  WatchCheckResponseSchema, WatchTargetRecordSchema, WeatherDayForecastSchema,
} from './types.js';
import { normalizeYahooMediaItems } from './services/yahoo.js';

const image = { ok: true, provider: 'yahoo', vertical: 'image', query: '東京タワー', page: 1, count: 1, next_page: 2, related_queries: [], source: 'image',
  items: [{ id: 'c9d5', title: '東京タワー', file_format: 'jpeg', source_site: 'www.tokyotower.co.jp', source_url: 'https://www.tokyotower.co.jp/',
    original: { url: 'https://www.tokyotower.co.jp/a.jpg', width: 1000, height: 1000 }, thumbnail: { url: 'https://msp.c.yimg.jp/t', width: 225, height: 225 },
    cached: { url: 'https://msp.c.yimg.jp/c', width: 1000, height: 1000 } }] };
const video = { ok: true, provider: 'yahoo', vertical: 'video', query: '東京タワー', page: 1, count: 1,
  items: [{ id: 'd255', title: '東京タワー公式チャンネル - YouTube', url: 'https://www.youtube.com/channel/x', duration: '0:11', summary: 's',
    thumbnail: 'https://s.yimg.jp/t', upload_date: '6日前', uploader: '東京タワー公式チャンネル', source: 'YouTube' }] };

describe('documented responses match actual payloads', () => {
  test('image search', () => {
    expect(ImageSearchResponseSchema.safeParse(normalizeYahooMediaItems(structuredClone(image), 'image')).success).toBe(true);
  });

  test('video search keeps the platform and reports source "video"', () => {
    const out = normalizeYahooMediaItems(structuredClone(video), 'video');
    expect(out.items[0]).toMatchObject({ source: 'video', platform: 'YouTube' });
    expect(VideoSearchResponseSchema.safeParse(out).success).toBe(true);
  });

  test('suggestions are objects', () => {
    const suggest = { ok: true, provider: 'yahoo', vertical: 'suggest', query: '東京タワー', count: 1, source: 'suggest',
      suggestions: [{ keyword: '東京タワー ライトアップ', search_url: 'https://search.yahoo.co.jp/search?p=x' }] };
    expect(SuggestResponseSchema.safeParse(suggest).success).toBe(true);
  });

  test('weekly weather days have no detail block', () => {
    const day = { date: '2026-10-06', dateLabel: '4日後', telop: '晴れ', reliability: 'A', temperature: { min: '18℃', max: '26℃' },
      chanceOfRain: { allDay: '10%', T00_06: '10%', T06_12: '10%', T12_18: '10%', T18_24: '10%' } };
    expect(WeatherDayForecastSchema.safeParse(day).success).toBe(true);
  });

  test('earthquake result uses the earthquakes array', () => {
    expect(EarthquakeSearchResultSchema.safeParse({ count: 0, earthquakes: [] }).success).toBe(true);
  });

  test('watch check returns one result or an array, and stored targets may hold null', () => {
    const one = { targetId: 'wt_1', url: 'https://example.com', changed: false, currentHash: 'h', checkedAt: '2026-10-03T00:00:00Z' };
    expect(WatchCheckResponseSchema.safeParse(one).success).toBe(true);
    expect(WatchCheckResponseSchema.safeParse([one]).success).toBe(true);
    const target = { id: 'wt_1', url: 'https://example.com', title: null, selector: null, last_hash: null, last_content: null, webhook_url: null,
      interval_seconds: 3600, last_checked_at: null, created_at: 1 };
    expect(WatchTargetRecordSchema.safeParse(target).success).toBe(true);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/response_schemas.test.ts`
Expected: FAIL

- [ ] **Step 3: 画像・動画の `source` を正規化する**

`src/services/yahoo.ts` に追加し、`searchYahooImage`・`searchYahooVideo` の `json.source = …` と `items.map` の2行をこの関数の呼び出しに置き換える（`return normalizeYahooMediaItems(json, 'image')`）:

```ts
/** 上流の item.source（例: "YouTube"）は platform に移し、Sora の source を固定する。 */
export function normalizeYahooMediaItems(json: any, source: 'image' | 'video'): any {
  json.source = source;
  if (Array.isArray(json.items)) {
    json.items = json.items.map((item: any) => ({
      ...item,
      ...(item.source && item.source !== source ? { platform: item.source } : {}),
      source,
    }));
  }
  return json;
}
```

- [ ] **Step 4: 応答スキーマを書き換える**

`src/types.ts`:

```ts
const YahooEnvelopeShape = {
  ok: z.boolean().optional().describe('上流の成功フラグ'),
  provider: z.string().optional().describe('上流プロバイダ名'),
  vertical: z.string().optional().describe('検索種別'),
  query: z.string().optional().describe('検索クエリ'),
  page: z.number().optional().describe('ページ番号'),
  count: z.number().optional().describe('取得件数'),
};
// related_queries の要素型と next_page の型は 2026-10-03 の実測では確定できなかったため緩く定義する。
// 実応答で型が分かったら狭めてよい。
const YahooImageRefSchema = z.object({ url: z.string(), width: z.number().optional(), height: z.number().optional() });

export const ImageSearchItemSchema = z.object({
  id: z.string().optional().describe('画像ID'),
  title: z.string().describe('画像タイトル・周辺テキスト'),
  source_url: z.string().optional().describe('画像掲載元ページのURL'),
  source_site: z.string().optional().describe('掲載元ドメイン'),
  file_format: z.string().optional().describe('画像形式 (例: "jpeg")'),
  original: YahooImageRefSchema.optional().describe('元画像'),
  thumbnail: YahooImageRefSchema.optional().describe('サムネイル'),
  cached: YahooImageRefSchema.optional().describe('Yahoo キャッシュ画像'),
  platform: z.string().optional().describe('上流が返した配信元'),
  source: z.literal('image').describe('ソース ("image")'),
});
export const ImageSearchResponseSchema = z.object({
  ...YahooEnvelopeShape,
  next_page: z.number().nullable().optional().describe('次ページ番号'),
  related_queries: z.array(z.unknown()).optional().describe('関連検索語'),
  source: z.literal('image').describe('ソース ("image")'),
  items: z.array(ImageSearchItemSchema).describe('画像検索結果一覧'),
});

export const VideoSearchItemSchema = z.object({
  id: z.string().optional().describe('動画ID'),
  title: z.string().describe('動画タイトル'),
  url: z.string().describe('動画ページ URL'),
  duration: z.string().optional().describe('動画の長さ (例: "10:30")'),
  summary: z.string().optional().describe('概要'),
  thumbnail: z.string().optional().describe('サムネイル画像 URL'),
  upload_date: z.string().optional().describe('投稿日 (上流表記。例: "6日前")'),
  uploader: z.string().optional().describe('投稿者'),
  platform: z.string().optional().describe('配信プラットフォーム (例: "YouTube")'),
  source: z.literal('video').describe('ソース ("video")'),
});
export const VideoSearchResponseSchema = z.object({
  ...YahooEnvelopeShape,
  source: z.literal('video').describe('ソース ("video")'),
  items: z.array(VideoSearchItemSchema).describe('動画検索結果一覧'),
});

export const SuggestResponseSchema = z.object({
  ...YahooEnvelopeShape,
  source: z.literal('suggest').describe('ソース ("suggest")'),
  suggestions: z.array(z.object({
    keyword: z.string().describe('候補キーワード'),
    search_url: z.string().optional().describe('Yahoo検索URL'),
  })).describe('キーワード補完候補'),
});
```

天気（`WeatherDayForecastSchema`、`src/types.ts:1505`）: `detail` を `.optional()` にし、説明を「天候詳細情報（3日目以降の週間予報では省略）」にする。`reliability: z.string().optional().describe('週間予報の信頼度 (A/B/C)')` を追加する。`chanceOfRain` に `allDay: z.string().optional()` が無ければ追加する。

地震（`EarthquakeSearchResultSchema`、`src/types.ts:1577`）を実装（`src/services/disaster.ts:186`）に合わせる:

```ts
export const EarthquakeSearchResultSchema = z.object({
  count: z.number().describe('取得件数'),
  earthquakes: z.array(EarthquakeItemSchema).describe('地震情報履歴配列 (新着順)'),
});
```

`EarthquakeItemSchema` の必須項目が `src/services/disaster.ts` の組み立てと合っているか確認し、常に入らない項目は `.optional()` にする。

監視:

```ts
// WatchTargetRecordSchema の title, selector, last_hash, last_content, webhook_url, last_checked_at を
// .optional() から .nullable().optional() に変える
export const WatchCheckResponseSchema = z.union([WatchCheckResultSchema, z.array(WatchCheckResultSchema)])
  .describe('id 指定時は単一の結果、省略時は全ターゲットの結果配列');
```

OpenAPIの `/watch/check` の200応答（`src/types.ts:2740` 付近）を `zodToOpenApiSchema(WatchCheckResponseSchema)` にする。

- [ ] **Step 5: テストを通してコミットする**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/response_schemas.test.ts && bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: PASS、`0 fail`

```bash
git add src/types.ts src/services/yahoo.ts src/response_schemas.test.ts
git commit -m "fix(api): document actual image, video, suggest, weather, earthquake and watch responses"
```

---

## Task 10: MCPツール説明の「返却」注記とREADME（監査 C1・C6）

**Files:**
- Modify: `scripts/schema-notation/scan.ts`（注記の照合を追加）
- Modify: `scripts/schema-notation/scan.test.ts`、`scripts/schema-notation/repository.test.ts`、`scripts/schema-notation/allowlist.ts`
- Modify: `src/mcp.ts`（各ツール説明の「返却:」）
- Modify: `README.md:209`

**Interfaces:**
- Produces（`scan.ts`）: `export function topLevelKeys(note: string): string[]`、`export async function scanReturnNotes(): Promise<Finding[]>`。`FindingKind` に `'return_note_mismatch'` を追加する

- [ ] **Step 1: 失敗するテストを書く**

`scan.test.ts` の既存の `import { ... } from './scan.js'` に `topLevelKeys` を加え、末尾に追加:

```ts
describe('topLevelKeys', () => {
  test('reads only the outermost keys of a 返却 note', () => {
    expect(topLevelKeys('{ query, suggestions: [...] }')).toEqual(['query', 'suggestions']);
    expect(topLevelKeys('{ routes: [{ index, totalTime }], note }')).toEqual(['routes', 'note']);
    expect(topLevelKeys('{ status, hotels: [{ id, plans: [{ planId }] }], failures }')).toEqual(['status', 'hotels', 'failures']);
  });
});
```

`repository.test.ts` の既存の `import { ... } from './scan.js'` に `scanReturnNotes` を加え、`describe` 内に追加:

```ts
  test('MCP 返却 notes name keys that the documented response has', async () => {
    expect((await scanReturnNotes()).map((f) => `${f.key} :: ${f.detail}`)).toEqual([]);
  }, 30_000);
```

- [ ] **Step 2: 照合処理を実装する**

`scan.ts` の `FindingKind` に `| 'return_note_mismatch'` を加え、次を追加する:

```ts
export function topLevelKeys(note: string): string[] {
  const start = note.indexOf('{');
  if (start < 0) return [];
  const keys: string[] = [];
  let depth = 0;
  let token = '';
  const flush = () => {
    const k = token.replace(/[:?].*$/s, '').trim();
    if (/^\w+$/.test(k)) keys.push(k);
    token = '';
  };
  for (const ch of note.slice(start)) {
    if (ch === '{' || ch === '[') { if (depth === 1) flush(); depth++; continue; }
    if (ch === '}' || ch === ']') { if (depth === 1) flush(); depth--; if (depth === 0) break; continue; }
    if (depth === 1 && ch === ',') { flush(); continue; }
    if (depth === 1) token += ch;
  }
  return keys;
}

/** MCP description の「返却: { … }」の最上位キーが、対応RESTの200応答スキーマに存在するか。 */
export async function scanReturnNotes(): Promise<Finding[]> {
  const previousHotelFlag = process.env.SORA_RAKUTEN_TRAVEL_ENABLED;
  process.env.SORA_RAKUTEN_TRAVEL_ENABLED = 'true';
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ deferTools: false });
  const client = new Client({ name: 'schema-notation-notes', version: '1.0.0' });
  const out: Finding[] = [];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const doc: any = generateOpenApiDocument();
    for (const tool of (await client.listTools()).tools) {
      const note = (tool.description ?? '').match(/返却[:：]\s*(\{.*)$/s)?.[1];
      const route = REST_MAP[tool.name];
      if (!note || !route) continue;
      const op = doc.paths[route.path.replace(/:(\w+)/g, '{$1}')]?.[route.method.toLowerCase()];
      const props = Object.keys(op?.responses?.['200']?.content?.['application/json']?.schema?.properties ?? {});
      if (!props.length) continue;
      const missing = topLevelKeys(note).filter((k) => !props.includes(k));
      const key = `${tool.name} 返却`;
      if (missing.length && !NOTATION_ALLOWLIST[`return_note_mismatch ${key}`]) {
        out.push({ kind: 'return_note_mismatch', key, detail: `missing ${JSON.stringify(missing)} in ${JSON.stringify(props)}` });
      }
    }
  } finally {
    await client.close();
    await server.close();
    if (previousHotelFlag === undefined) delete process.env.SORA_RAKUTEN_TRAVEL_ENABLED;
    else process.env.SORA_RAKUTEN_TRAVEL_ENABLED = previousHotelFlag;
  }
  return out;
}
```

CLI（`if (import.meta.main)`）の `findings` を `[...(await scanRepository()), ...(await scanReturnNotes())]` にする。

- [ ] **Step 3: 失敗を確認する**

Run: `NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test scripts/schema-notation`
Expected: `topLevelKeys` はPASS。注記の照合は、Task 9 完了後の時点で次のツールを中心にFAILする（2026-10-03の試行で28注記中15件）: `search_news`、`search_chiebukuro`、`search_realtime`、`search_trend`、`get_weather`、`search_road_traffic`、`search_earthquake`、`search_song`、`search_artist`、`search_music`、`search_laws`、`get_law_text`、`search_diet_minutes`、`check_product_compliance`。

- [ ] **Step 4: 注記を直す**

各ツールについて、`src/mcp.ts` のハンドラーが MCP に返している値を読み、注記を実際のキー名に直す。REST と MCP で同じサービス関数の戻り値をそのまま返している場合、キーは REST の応答スキーマと同じになる。

確定済みの書き換え:

```text
search_route:     返却: { source, from, to, routeCount, routes: [{ index, totalTime, transfers, fare, sections, summary }] }
get_weather:      返却: { source, cityId, title, publishedTime, overview, forecasts: [{ date, dateLabel, telop, temperature: { min, max }, chanceOfRain }] }
search_earthquake: 返却: { count, earthquakes: [{ id, time, hypocenter: { name, magnitude, depthKm }, maxScale, tsunami, points }] }
search_news:      返却: { source, query, count, items: [{ title, url, publisher, publishedTime, snippet }] }
search_chiebukuro: 返却: { source, query, count, items: [{ title, url, status, bestAnswer, snippet }] }
```

`search_route` は最上位キーが一致しているため検出器では引っかからないが、内側のキーが誤っているので直す。

MCP と REST で包み方が違うもの（例: REST `/search/realtime` は `data` で包む）は、MCP の実際の戻り値に合わせて注記を書き、照合が通らない場合だけ許可リストに理由付きで登録する:

```ts
'return_note_mismatch search_realtime 返却': 'REST wraps the payload in { data }; MCP returns the realtime payload itself.',
```

- [ ] **Step 5: READMEを直す**

`README.md:209` の「主要6社（ヤマト・佐川・日本郵便・西濃・福山・UPS）」を「主要8社（ヤマト・佐川・日本郵便・西濃・福山・UPS・FedEx・DHL）」にする。

- [ ] **Step 6: テストを通してコミットする**

Run: `bun run schema:notation && bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test`
Expected: `TOTAL 0`、`0 fail`

```bash
git add scripts/schema-notation src/mcp.ts README.md
git commit -m "fix(mcp): correct 返却 notes against documented responses and update carrier count"
```

---

## Task 11: 最終確認

- [ ] **Step 1: 全体検証**

Run: `bun run typecheck && NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test && bun run schema:notation`
Expected: 型エラーなし、`0 fail`、`TOTAL 0`

- [ ] **Step 2: OpenAPIの変化を目視で確認する**

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file -e 'import { generateOpenApiDocument } from "./src/types.ts"; console.log(JSON.stringify(generateOpenApiDocument(), null, 1))' > /tmp/openapi-after.json
grep -c '"default"' /tmp/openapi-after.json
grep -c '9007199254740991' /tmp/openapi-after.json
```

Expected: `"default"` が多数（宣言した数）。`9007199254740991` は 0。

- [ ] **Step 3: 監査レポートに結果を追記する**

`docs/superpowers/audits/2026-10-03-api-notation-audit.md` の末尾に「対応状況」節を足し、A1〜A8、B1〜B7、C1〜C6 のそれぞれに対応したコミットを書く。対応しなかった項目は理由を書く。

- [ ] **Step 4: コミットし、ユーザーに報告する**

```bash
git add docs/superpowers/audits/2026-10-03-api-notation-audit.md
git commit -m "docs: record notation audit resolution"
```

報告に含めること: コミット一覧、判断事項1〜4で採用した案、許可リストに入れた項目と理由、Task 2 Step 5で「省略時: …」に書き換えた項目。マージ・push・本番反映はユーザーの指示を待つ。
