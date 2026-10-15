# コード実行環境から Sora を使う

Anthropic の記事「[Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)」の考え方を、Sora でどう使うかをまとめる。

## 記事の考えと Sora の対応

| 記事の考え | Sora の対応 |
|---|---|
| ツール定義を全部読み込まず、必要なときに探す（段階的開示） | 既定で 14 ツールだけを公開し、残りは `search_tools` で探す。`detail`（`names` / `summary` / `schema`）と `activate:false` で、有効化せずに名前や入力スキーマだけを調べられる。 |
| ツールをコードの API として扱い、結果をコードで絞る | `GET /client` が配る型付きの TypeScript クライアント（`client/`）。結果の絞り込み・集計・連鎖をコード側で行い、モデルには必要な分だけ返す。 |
| コードの実行環境はクライアント側に置く | Sora はコードを実行しない。サンドボックスは利用者側で用意する。 |

Sora の MCP サーバーは、これまでどおり MCP だけで使える。コードを実行できる呼び出し側には、クライアントを優先して使わせる。

## LLM がクライアントを見つける経路

- **instructions**: 「コードを実行できるなら型付きクライアント（`GET /client`、リソース `sora-client://guide`）を使い、必要な項目だけ出力する。できなければ MCP のツールを直接呼ぶ」という一行を載せている。
- **MCP リソース `sora-client://guide`**: 取得手順（一覧の取得、各ファイルのダウンロード、`README.md` / `catalog.json` / `search.ts` の読み方、呼び出し例、環境変数）。`resources/list` に出る。
- **`search_tools` の応答**: どの `detail` でも、末尾に同じ案内の一文が付く。ツールを探しに来た LLM が、直接呼ぶ前に目にする。

どれも `tools/list` を増やさない（既定 24,671 文字のまま）。

## クライアントを取得する

```bash
mkdir sora-client && cd sora-client
base=http://127.0.0.1:3016            # Sora の URL
auth=()                                # API キーがあるときは auth=(-H "Authorization: Bearer $SORA_API_KEY")
curl -s "${auth[@]}" $base/client | bun -e 'const m = await Bun.stdin.json(); console.log(m.files.join("\n"))' \
  | while read -r f; do mkdir -p "$(dirname "$f")"; curl -s "${auth[@]}" "$base/client/$f" -o "$f"; done
```

`GET /client` は配布するファイルの一覧（`manifest.json`）を返し、`GET /client/<path>` が一覧に載ったファイルを返す。認証は他の REST と同じ。

## 使い方

```ts
import { searchDeep } from './servers/sora/index.js';

const r = await searchDeep({ query: 'TypeScript 5.5 新機能', limit: 3 });
console.log(r.results.map((x) => `${x.title}\n${x.url}`).join('\n\n'));
```

- `SORA_URL`: Sora の URL（既定 `http://127.0.0.1:3016`）。`SORA_API_KEY`: `Authorization: Bearer` で送る。
- エラーは `SoraError { code, status, retryable, details }` として投げられる。
- ツールを探すとき: `searchTools('住所', 'names')`（`search.ts`）。

絞り込みと連鎖の例（検索結果から公式ドメインだけを選び、本文の先頭だけを出力する）:

```ts
import { searchWeb, scrape } from './servers/sora/index.js';

const hits = await searchWeb({ query: 'Bun 1.3 リリースノート', limit: 10 });
const official = hits.data.items.filter((h) => new URL(h.url).hostname.endsWith('bun.sh')).slice(0, 2);
for (const h of official) console.log((await scrape({ url: h.url })).content.slice(0, 500));
```

`client/` は OpenAPI と `REST_MAP` から `bun run gen:client` で生成し、リポジトリにコミットしている。ツールや引数を変えたら再生成する（`src/client_sync.test.ts` が、コミット済みの内容との差を検出する）。

## 実測

2026-10-15 に実際の通信で測った。文字数は、クライアントが受け取る HTTP 本文の長さ。

**固定で文脈に載る量（`tools/list`、`bun scripts/measure-context.ts`）**

| | 文字数 |
|---|---|
| 既定（14 ツール） | 24,671 |
| 全ツール（50 ツール） | 60,202 |
| `instructions` | 8,494 |

`search_tools` の応答（クエリ「住所」）: 既定 504、`names` 245、`summary` 449、`schema` 2,362 文字。

**`search_deep`（「TypeScript 5.5 新機能」、上位 3 件）**

| 受け取り方 | モデルに入る文字数 |
|---|---|
| 直接（`limit: 3`） | 27,892 |
| 引数で絞る（`includeRealtime: false`、`extractHighlights: true`、`maxChars: 1500`） | 12,273 |
| クライアントでコードから絞る（題名・URL・要点 2 つだけを出力） | 934 |

直接呼ぶ場合でも引数で大きさは減らせる。コードで絞る方法は、必要な項目が決まっているときに最も小さい。モデルが本文全体を読んで判断する必要がある場合は、直接呼ぶ。

## しきい値の上げ方

`src/context_budget.test.ts` が `tools/list` の大きさ（既定 25,000 文字、全ツール 61,500 文字）を守る。ツールや引数の説明を増やして超えたときは、増やす理由を確かめたうえで `bun scripts/measure-context.ts` で現在の値を測り、しきい値を上げて、コミットメッセージに理由を書く。
