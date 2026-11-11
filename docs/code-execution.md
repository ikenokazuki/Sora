# コード実行環境から Sora を使う

Anthropic の記事「[Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)」の考え方を、Sora でどう使うかをまとめる。

## 記事の考えと Sora の対応

| 記事の考え | Sora の対応 |
|---|---|
| ツール定義を全部読み込まず、必要なときに探す（段階的開示） | 既定で 14 ツールだけを公開し、残りは `search_tools` で探す。`detail`（`names` / `summary` / `schema`）と `activate:false` で、有効化せずに名前や入力スキーマだけを調べられる。REST では `GET /tools`（一覧）と `GET /tools/<name>`（1 つの定義）が同じ役目をする。 |
| ツールをコードの API として扱い、結果をコードで絞る | REST を直接呼ぶ。言語は問わない（curl・Python・Node など、HTTP が話せればよい）。結果の絞り込み・集計・連鎖をコード側で行い、モデルには必要な分だけ返す。 |
| コードの実行環境はクライアント側に置く | Sora はコードを実行しない。サンドボックスは利用者側で用意する。 |

Sora の MCP サーバーは、これまでどおり MCP だけで使える。コードを実行できる呼び出し側には、REST の直接呼び出しを優先して使わせる。

## LLM が REST の入口を見つける経路

- **instructions**: 「コードを実行できるなら REST を直接呼ぶ（`GET /tools` で一覧、`GET /tools/<name>` で入力のスキーマ。手順はスキル `sora-client`、リソース `sora-skill://sora-client`）。できなければ MCP のツールを直接呼ぶ」という一行を載せている。
- **スキル `sora-client`**: つなぎ方、`GET /tools` → `GET /tools/<name>` → 呼ぶ、の 3 手、curl と Python の例、絞り方の原則、エラーの扱い。次の 3 か所に同じ内容で置いてある。
  - プラグイン `plugins/sora-deep-research/skills/sora-client/`（Skills 対応環境に自動で認識される）
  - MCP リソース `sora-skill://sora-client`（`resources/list` に出る）
  - `client/SKILL.md`（`GET /client/SKILL.md` で取れる）
- **`search_tools` の応答**: どの `detail` でも、末尾に同じ案内の一文が付く。ツールを探しに来た LLM が、直接呼ぶ前に目にする。

どれも `tools/list` を増やさない。

## 使い方

認証は他の REST と同じ（`Authorization: Bearer` または `X-API-Key`。キーを設定していないサーバーは認証なし）。

```bash
base=http://127.0.0.1:3016            # Sora の URL
auth=()                                # API キーがあるときは auth=(-H "Authorization: Bearer $SORA_API_KEY")

curl -s "${auth[@]}" -G "$base/tools" --data-urlencode "q=郵便番号"     # 1. 操作を探す（q は空白で区切った語をすべて含むものだけ。category でも絞れる）
curl -s "${auth[@]}" "$base/tools/search_postal_code"                    # 2. 入力を見る（応答のスキーマも要るときは ?response=true）
curl -s "${auth[@]}" -H 'Content-Type: application/json' \
  -d '{"zipcode":"100-0014"}' "$base/geo/postal-code"                    # 3. 呼ぶ
```

- `GET /tools` は `{ count, tools: [{ name, method, path, category, summary }] }`（既定のモジュールで約 7KB）。`name` は OpenAPI の `operationId` と同じ。`ENABLED_MODULES` で無効なモジュールの操作は出ない。
- `GET /tools/<name>` は、本文のスキーマ（`request.schema`）、path・query の引数（`parameters`）、文書にあるエラー（`errors`）、別名や GET の形（`alternatives`）を返す。応答のスキーマは大きいことがある（中央値 約 1.9KB、最大 約 70KB）ので、`?response=true` のときだけ付く。
- 失敗は HTTP の 4xx / 5xx と、`{ error, code, status, retryable, details? }` の JSON（認証の 401、日次上限の 429、Origin の検査の 403、本文が 10MB を超える 413 も同じ形）。`retryable` が true のときだけ再試行する。
- OpenAPI（`GET /openapi.json`、約 600KB）の各操作には、`operationId`・`tags`（カテゴリ）・共通のエラー応答・認証（Bearer と `X-API-Key`、キー未設定のサーバーは認証なし）を宣言している。スキーマは各操作の中に直接あり（`$ref` なし）、1 つの操作の定義だけで完結する。

Python（標準ライブラリだけ）で、検索結果から題名と URL だけを出す例:

```python
import json, os, urllib.error, urllib.request

base = os.environ.get("SORA_URL", "http://127.0.0.1:3016")
key = os.environ.get("SORA_API_KEY")

def sora(method, path, body=None):
    headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})}
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, data=data, method=method, headers=headers), timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:      # 失敗は { error, code, status, retryable, details? }
        raise RuntimeError(e.read().decode())

r = sora("POST", "/search/deep", {"query": "TypeScript 5.5 新機能", "limit": 3})
print("\n\n".join(f"{x['title']}\n{x['url']}" for x in r["results"]))
```

絞り込みと連鎖の例（検索結果から公式ドメインだけを選び、本文の先頭だけを出力する）:

```python
from urllib.parse import urlparse

hits = sora("POST", "/search/web", {"query": "Bun 1.3 リリースノート", "limit": 10})
official = [h for h in hits["data"]["items"] if urlparse(h["url"]).hostname.endswith("bun.sh")][:2]
for h in official:
    print(sora("POST", "/scrape", {"url": h["url"]})["content"][:500])
```

## 型付き TypeScript クライアント（`GET /client`）

v2.40.0 から配っていた型付き TypeScript クライアント（`client/`）は、REST の直接呼び出しに置き換わった。**案内はやめた。当面は残すが、v5.0.0 で廃止する予定。** 言語や、TypeScript・bun の有無に依存するため。

- `GET /client` が配布するファイルの一覧（`manifest.json`）を返し、`GET /client/<path>` が一覧に載ったファイルを返す。認証は他の REST と同じ。
- `client/` は OpenAPI と `REST_MAP` から `bun run gen:client` で生成し、リポジトリにコミットしている。ツールや引数を変えたら再生成する（`src/client_sync.test.ts` が、コミット済みの内容との差を検出する）。

## 実測

文字数は、呼び出し側が受け取る HTTP 本文の長さ（型付きクライアントでも REST の直接呼び出しでも、同じ本文を受け取る）。

**固定で文脈に載る量（`tools/list`、`bun scripts/measure-context.ts`）**

2026-11-11 に測り直した（案内を REST に書き換えた後。前の値は 2026-11-09 の既定 22,269・全ツール（53 ツール）63,529・`instructions` 8,948）。

| | 文字数 |
|---|---|
| 既定（14 ツール） | 22,273 |
| 全ツール（53 ツール） | 63,607 |
| `instructions` | 8,989 |

`search_tools` の応答（クエリ「住所」）: 既定 649、`names` 390、`summary` 594、`schema` 2,624 文字（末尾の案内の一文が 30 字長くなった。前の値は既定 619、`names` 360、`summary` 564、`schema` 2,574）。

以下の `search_deep` の表は、2026-10-26 に実際の通信で測った値（測り直していない）。

**`search_deep`（「TypeScript 5.5 新機能」、上位 3 件）**

| 受け取り方 | モデルに入る文字数 |
|---|---|
| 直接（`limit: 3`） | 27,892 |
| 引数で絞る（`includeRealtime: false`、`maxChars: 1500`） | 12,273 |
| コードから絞る（題名・URL・要点 2 つだけを出力） | 934 |

直接呼ぶ場合でも引数で大きさは減らせる。コードで絞る方法は、必要な項目が決まっているときに最も小さい。モデルが本文全体を読んで判断する必要がある場合は、直接呼ぶ（`responseMode: "full"` を付ける）。

表の数字は、`responseMode` の既定が `full` だったとき（2026-10-26）の測定。いまの既定は `evidence` で、直接呼んだ場合の文字数はこれより小さい（測り直していない）。

## しきい値の上げ方

`src/context_budget.test.ts` が `tools/list` の大きさ（既定 25,000 文字、全ツール 64,000 文字）を守る。ツールや引数の説明を増やして超えたときは、増やす理由を確かめたうえで `bun scripts/measure-context.ts` で現在の値を測り、しきい値を上げて、コミットメッセージに理由を書く。
