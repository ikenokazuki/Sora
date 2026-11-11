---
name: sora-client
description: >
  コードを実行できる環境（シェル、サンドボックス）から、Sora の REST を直接呼ぶ手順。Sora の機能（検索・本文取得・住所・天気など）を
  MCP で直接呼ぶ代わりに HTTP で呼び、結果をコード側で絞って必要な項目だけ出力する。大きな結果をモデルの文脈に入れたくないときに使う。
  言語は問わない（curl・Python・Node・Go など、HTTP が話せればよい）。
---

# Sora を REST で使う

コードを実行できる環境（シェル、サンドボックス）から Sora に届くなら、MCP のツールを直接呼ぶより、REST を直接呼ぶ。結果の絞り込み・集計・連鎖をコードで行い、モデルには必要な分だけ返せる。言語や、TypeScript・bun の有無に依存しない。

## いつ使うか

- コードを実行でき、その環境から Sora の URL に届く: REST を直接呼ぶ。
- コードを実行できない、または Sora に届かない: MCP のツールを直接呼ぶ（`search_tools` で必要なものを探す）。
- 結果の本文全体を読んで判断する必要がある: 直接呼ぶ（`search_deep` は `responseMode: "full"` を付ける。既定の `evidence` は本文を省く）。絞るのは、必要な項目が決まっているとき。

## つなぎ方

- 基点: 環境変数 `SORA_URL`（無ければ `http://127.0.0.1:3016`）。
- 認証: 環境変数 `SORA_API_KEY` があれば `Authorization: Bearer $SORA_API_KEY`（`X-API-Key: $SORA_API_KEY` でもよい）。キーを設定していないサーバーは、認証なしで使える。
- 本文は JSON（POST には `Content-Type: application/json`）。応答も JSON。

## 使い方（3 手）

1. **操作を探す**: `GET /tools` が、全部の操作 `{ name, method, path, category, summary }` を返す（約 7KB）。語で絞るなら `GET /tools?q=郵便番号`（空白で区切った語をすべて含むものだけ。名前・パス・カテゴリ・概要を見る）、カテゴリなら `GET /tools?category=trade`。
2. **入力を見る**: `GET /tools/<name>` が、本文の JSON スキーマ（`request.schema`）、path・query の引数（`parameters`）、別名や GET の形（`alternatives`）を返す。成功時の応答のスキーマも要るときだけ `?response=true`（大きいことがある）。
3. **呼ぶ**: 一覧の `method` と `path` に、スキーマのとおりの JSON を送る。`path` の `{id}` は、その値に置き換える。

```bash
base=${SORA_URL:-http://127.0.0.1:3016}
auth=(); [ -n "$SORA_API_KEY" ] && auth=(-H "Authorization: Bearer $SORA_API_KEY")

curl -s "${auth[@]}" -G "$base/tools" --data-urlencode "q=郵便番号"     # 1. 探す
curl -s "${auth[@]}" "$base/tools/search_postal_code"                    # 2. 入力を見る
curl -s "${auth[@]}" -H 'Content-Type: application/json' \
  -d '{"zipcode":"100-0014"}' "$base/geo/postal-code"                    # 3. 呼ぶ
```

Python（標準ライブラリだけ）:

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

## 絞り方の原則

- 結果を丸ごと出力しない。題名・URL・要点など、判断に要る項目だけ出す（`jq` や、各言語の JSON 処理で選ぶ）。
- 複数の呼び出しはコードで連鎖させる（検索 → 絞り込み → 本文取得）。途中の結果はモデルに戻さない。
- 失敗は HTTP の 4xx / 5xx と、`{ error, code, status, retryable, details? }` の JSON。`retryable` が true のときだけ、間を置いて再試行する。400 は入力の誤りなので、`GET /tools/<name>` のスキーマと突き合わせて直す。
- 一覧にある `name` は、OpenAPI の `operationId` と同じ。`GET /openapi.json` は約 600KB あるので、全体は読まない。

## 注意

- 無効なモジュール（`ENABLED_MODULES`）の操作は、`GET /tools` に出ず、呼んでも 404 になる。
- 調査の進め方（確認事項の分解、出典・日時の確認、取得失敗と 0 件の区別）は `sora-deep-research` に従う。このスキルは呼び出し方だけを扱う。
- 型付き TypeScript クライアント（`GET /client`）は、この REST の直接呼び出しに置き換わった。当面は残るが、案内はやめており、v5.0.0 で廃止する予定。
