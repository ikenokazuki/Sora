# 「MCP でコード実行」の改修 実装計画

> 設計: [2026-10-15-code-execution-with-mcp-design.md](../specs/2026-10-15-code-execution-with-mcp-design.md)。実装は TDD（テストを先に書き、落ちることを確かめてから実装）。各タスクの終わりに `bun run typecheck && bun run lint` と関連テストを通し、英語の Conventional Commits でコミットする（Claude の attribution 行は付けない）。リリースと本番反映は範囲外。

**テストの実行**: `export NODE_ENV=test SORA_DB_PATH=:memory:`、プロキシ変数を外す。全件は切り離して `bun test --timeout 60000`（このホストでは Chromium のテストが 5 秒で落ちるため）。

## 共通の約束

- 既存の応答の既定の形は変えない。変えるのは `search_tools` の任意引数と、新しい `/client` だけ。
- 数字の根拠は HTTP の経路（`POST /mcp`）の実測。2026-10-15 の基準値: 既定 `tools/list` 24,457 文字（14 ツール）、全ツール 59,988 文字（50 ツール）、`instructions` 8,494 文字、`search_tools` 応答 約 470 文字。

## タスク 1: 文脈の計測と回帰ガード（A2）

**ファイル**: 新規 `scripts/measure-context.ts`、新規 `src/context_budget.test.ts`、`src/test_fixtures/mcp_http.ts`（HTTP の `POST /mcp` を呼ぶ共通の補助。`initialize` → `tools/list`、`tools/call`）。

- [ ] 補助 `mcpHttp(app, { defer })` を作る（セッションを開き、`rpc(method, params)` を返す。SSE の `data:` 行も読む）。`scripts/measure-context.ts` はこれを使い、既定と全ツールの `tools/list` の文字数、`instructions` の文字数、`search_tools` の応答の文字数を JSON で標準出力に出す。
- [ ] `context_budget.test.ts`: 既定 `tools/list` ≤ 25,000、全ツール ≤ 61,500、`instructions` ≤ 8,500（既存の `llm_contract_sync` と重複しないよう、ここは `tools/list` の2つだけ）。失敗時のメッセージに「意識して上げる」手順を書く。
- [ ] 実行して通ることを確かめ、コミット: `test: pin the size of tools/list as seen over HTTP`

## タスク 2: `search_tools` の詳細度（A1）

**ファイル**: `src/mcp.ts`（`ToolCatalogEntry` に `inputSchema` を持たせ、`registerTool` で保存。`search_tools` に `detail`・`activate`）、新規 `src/mcp_tool_search.ts`（整形の純粋関数）、新規 `src/mcp_tool_search.test.ts`、`src/mcp.test` 系（既存の search_tools のテスト）。

- [ ] テスト（先に書く）: `formatToolMatches(entries, { detail, activate })` が、`names` は名前・カテゴリ・タグだけ、`summary` は現在と同じ形式、`schema` は入力スキーマ（`tools/list` と同じ整形）を含み、9 件以上や合計 20,000 文字超では打ち切って件数と案内を付けること。`activate: false` ではセッションの有効化状態とツール一覧が変わらないこと（MCP クライアントで `tools/list` の件数が不変）。引数なしの呼び出しの出力は従来とバイト単位で同じ。
- [ ] 実装: `registerTool` が `toJsonSchemaCompat(normalizeObjectSchema(schema))` を `slimListedTool` と同じ整形（`sanitizeJsonSchemaForGemini`）で `entry.inputSchema` に保存。`search_tools` が新しい引数を受け、`formatToolMatches` を使う。説明文（【…】）に `detail`・`activate` を 1 文で足す（`tools/list` が増える分は、タスク 1 のしきい値を実測で更新して反映）。
- [ ] 通ることを確かめ、コミット: `feat(mcp): let search_tools return names, summaries or schemas without activating`

## タスク 3: クライアントの生成器（B）

**ファイル**: 新規 `scripts/gen-client/` （`index.ts`、`openapi_to_ts.ts`、`render.ts`）、新規 `scripts/gen-client/openapi_to_ts.test.ts`、`package.json` の `gen:client`。

インターフェース:
```ts
export function schemaToTs(schema: OpenApiSchema | undefined, name: string): string; // オブジェクト・配列・列挙・nullable・任意・oneOf（共用体）・不明は unknown
export function generateClient(doc: OpenApiDoc, restMap: Record<string, {method: string; path: string}>, tools: ToolMeta[]): Record<string, string>; // パス → 内容
```
- [ ] テスト（先に書く）: `schemaToTs` の各ケース。`generateClient` を最小の OpenAPI で呼び、ツールごとの関数の形（POST は本文、GET は query、`:id` と `{id}` の両方のパスパラメータ）、入力なしの関数（`watch_list`）、解決できないツールがあると例外になること、`catalog.json`・`manifest.json` の内容、出力が決定的（順序固定）であること。
- [ ] 実装: `REST_MAP`（`scripts/tool-health/catalog.ts`）と `generateOpenApiDocument()`（`src/types.ts`）、ツールの説明・カテゴリ・キーワード（`createMcpServer` の `toolCatalog` を `deferTools:false` で作って読む）から生成する。`client/runtime.ts` と `client/search.ts` は固定のテンプレートとして出力に含める（`callSora`: `SORA_URL`、`SORA_API_KEY` を `Authorization: Bearer` で送る、タイムアウト、エラーは `SoraError{code,status,retryable,details}`）。
- [ ] コミット: `feat(client): generate typed client functions from the OpenAPI document`

## タスク 4: 生成物のコミットと一致テスト（B）

**ファイル**: `client/**`（生成物）、新規 `src/client_sync.test.ts`、`tsconfig.json`（`client` を含める）。

- [ ] `bun run gen:client` で `client/` を生成してコミット対象にする。
- [ ] `client_sync.test.ts`: いま生成したものとコミット済みの `client/` が一致すること（落ちたときのメッセージに `bun run gen:client` を書く）。偽の fetch を差し込んだ `callSora` で、代表 6 ツール（`searchWeb`、`searchDeep`、`searchPoi`、`normalizeAddress`、`getCountryContext`＝パスパラメータ、`watchList`＝入力なし）の呼び出しの形（メソッド・URL・本文／query・ヘッダー）とエラーの扱いを確かめる。
- [ ] `bun run typecheck` が `client/` を含めて通ること。コミット: `feat(client): commit the generated client and keep it in sync with the OpenAPI document`

## タスク 5: `/client` の配布（B）

**ファイル**: 新規 `src/routes/client.ts`、`src/index.ts`（ルートのマウント）、`src/types.ts`（OpenAPI に 2 つの GET）、`Containerfile`（`COPY --from=builder /app/client /app/client`）、`src/docs_contract.test.ts` の対象、新規 `src/routes/client.test.ts`。

- [ ] テスト（先に書く）: `GET /client` が `manifest.json` の内容を返す。`GET /client/servers/sora/search_web.ts` が本文を `text/plain; charset=utf-8` で返す。`manifest.json` に無いパス、`..`・`%2e%2e`・先頭 `/`・NUL を含むパス、ディレクトリは 404。API キー設定時に無認証は 401（他の REST と同じ）。
- [ ] 実装: `client/` を `import.meta.url` からの相対で解決し、`manifest.json` の一覧と照合してから読む（`PUBLIC_PATHS` には入れない）。
- [ ] コミット: `feat(server): serve the generated client read-only under /client`

## タスク 6: 文書と実測

**ファイル**: 新規 `docs/code-execution.md`、`README.md`（該当節）、`docs/operations/` へのリンク。

- [ ] 実測: `search_deep` の同じ質問を、(a) 直接 MCP（`limit: 3`）、(b) `responseMode: "evidence"`、(c) `client/` でコードから呼び、タイトル・URL・要点だけに絞って出力、の文字数を測る（実通信。結果を文書に記録）。
- [ ] 文書: 記事の考えと Sora の対応、`client/` の取得（`curl`）と使い方（環境変数、TypeScript の例）、絞り込み・連鎖・ポーリングの例、タスク 1 と 6 の実測値、しきい値の上げ方。`docs_contract` の対象外のコード例は動くことを手元で確かめる。
- [ ] コミット: `docs: explain using Sora from code execution environments, with measurements`

## タスク 7: コードの整理（動きを変えない）

**ファイル**: `src/mcp.ts` → `src/mcp/`（カテゴリごとの登録ファイル）、`any` の多いファイル（`services/yahoo.ts`、`scraper.ts`、`html_parser.ts`、`services/life.ts`、`browser_stealth.ts`）、未使用コード・依存。

- [ ] 整理の前に、基準を保存する: HTTP の `tools/list`（既定と全ツール）と `generateOpenApiDocument()` の JSON を `scratchpad` に保存する（コミットしない）。
- [ ] 分割は機械的な移動のみ。登録の順序・ツール名・説明は変えない。分割ごとに保存した基準と比べ、`tools/list` と OpenAPI が**バイト単位で同じ**であること。
- [ ] 未使用の export・依存を調べて削除する（調べるツールは一時的に実行し、依存に足さない）。`any` は外部の応答の解析から `unknown` と絞り込みに置き換え、そのファイルのテストで確かめる。
- [ ] 小さなコミットに分ける。各コミット後に関連テスト、最後に全件、型検査、lint、手元の候補イメージで実 API 検査。

## 最終確認

- [ ] 全テスト（`--timeout 60000`）、型検査、lint、`schema:notation`。
- [ ] `tools/list`・OpenAPI の差分が、意図した追加（`search_tools` の引数、`/client`）だけであること。
- [ ] 手元で候補イメージを作り、実 API 検査（`fail=0`）。
- [ ] リリース・push・本番反映は、別途指示を受けてから。
