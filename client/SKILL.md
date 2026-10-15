---
name: sora-client
description: >
  Sora の型付き TypeScript クライアントを、コードを実行できる環境から使う手順。Sora のツール（検索・本文取得・住所・天気など）を
  MCP で直接呼ぶ代わりに関数として呼び、結果をコード側で絞って必要な項目だけ出力する。大きな結果をモデルの文脈に入れたくないときに使う。
---

# Sora クライアント

コードを実行できる環境（シェル、サンドボックス）から Sora に届くなら、MCP のツールを直接呼ぶより、この型付きクライアントを使う。結果の絞り込み・集計・連鎖をコードで行い、モデルには必要な分だけ返せる。

## いつ使うか

- コードを実行でき、その環境から Sora の URL に届く: クライアントを使う。
- コードを実行できない、または Sora に届かない: MCP のツールを直接呼ぶ（`search_tools` で必要なものを探す）。
- 結果の本文全体を読んで判断する必要がある: 直接呼ぶ。絞るのは、必要な項目が決まっているとき。

## 取得

```bash
base=${SORA_URL:-http://127.0.0.1:3016}
auth=(); [ -n "$SORA_API_KEY" ] && auth=(-H "Authorization: Bearer $SORA_API_KEY")
mkdir -p sora-client && cd sora-client
curl -s "${auth[@]}" "$base/client" | grep -o '"[^"]*\.[a-z]*"' | tr -d '"' \
  | while read -r f; do mkdir -p "$(dirname "$f")"; curl -s "${auth[@]}" "$base/client/$f" -o "$f"; done
```

`GET /client` が配布するファイルの一覧（`manifest.json`）を返し、`GET /client/<path>` が各ファイルを返す。

## 使い方

1. `README.md` と `catalog.json` を読む（ツール名、関数名、カテゴリ、説明）。
2. ツールを探す: `searchTools('住所', 'names')`（`search.ts`）。
3. 使うツールの `servers/sora/<tool>.ts` を読む。入力型 `XxxInput` と出力型 `XxxOutput`、説明コメントがある。
4. 関数を呼ぶコードを書いて実行し、必要な項目だけ出力する。

```ts
import { searchDeep } from './servers/sora/index.js';

const r = await searchDeep({ query: 'TypeScript 5.5 新機能', limit: 3 });
console.log(r.results.map((x) => `${x.title}\n${x.url}`).join('\n\n'));
```

## 絞り方の原則

- 結果を丸ごと `console.log` しない。題名・URL・要点など、判断に要る項目だけ出す。
- 複数の呼び出しはコードで連鎖させる（検索 → 絞り込み → 本文取得）。途中の結果はモデルに戻さない。
- 失敗は `SoraError { code, status, retryable, details }` として投げられる。`retryable` が真のときだけ、間を置いて再試行する。
- `SORA_URL`（既定 `http://127.0.0.1:3016`）と `SORA_API_KEY` を環境変数で渡す。

## 注意

- クライアントは OpenAPI から生成されている。ツールや引数が変わったら、再取得する。
- 調査の進め方（確認事項の分解、出典・日時の確認、取得失敗と0件の区別）は `sora-deep-research` に従う。このスキルは呼び出し方だけを扱う。
