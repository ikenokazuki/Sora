# ツール選びの評価

MCP のツールを統合すると、LLM がツールを選び間違えにくくなるかを測ります（設計メモ: `docs/superpowers/specs/2026-11-11-tool-consolidation-design.md`）。

## 何を測るか

日本語の依頼（`prompts.json`、88 問）ごとに、**全ツールの定義**（名前・説明・引数）を渡して、モデルに**最初に呼ぶツールを 1 つ**選ばせます（実行はしません）。

- `family: hard` の 26 問は、ツールの名前や説明の言葉をそのまま使わない、くだけた言い方の依頼です。
- `old` は統合前（v4）で正しいツール、`new` は統合後（v5）で正しいツールです。配列は、どれを選んでも正解です。
- 統合後は、ツールの名前に加えて、モードを選ぶ主な引数（`new_args`）も確かめます。`"*"` は指定されている、`null` は指定されていない、`"!true"` は true ではない、それ以外はその値と等しい。

測らないもの: 遅延ツールを `search_tools` で見つける段階（本番では、コア以外のツールは最初は見えない）、複数のツールを順に呼ぶ流れ、ツールの実際の動き。

## 使い方

```sh
# 1. ツールの定義を書き出す（統合の前と後で 1 回ずつ）
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file docs/evaluations/tool-selection/snapshot.ts /tmp/tools-new.json

# 2. SDK を、リポジトリの外に入れて、この隣の node_modules にリンクする（node_modules は、この隣の .gitignore が無視する）
npm install --prefix /tmp/eval-sdk @anthropic-ai/sdk
ln -sfn /tmp/eval-sdk/node_modules docs/evaluations/tool-selection/node_modules

# 3. 評価する（鍵は ANTHROPIC_API_KEY か、ANTHROPIC_KEY_FILE のファイル）
bun docs/evaluations/tool-selection/run.ts --tools /tmp/tools-new.json --surface new --out /tmp/results-new.json --model claude-haiku-5-5
```

ツールの定義は、最後の 1 つにキャッシュの印を付けて渡すので、1 回の評価（88 問）は、ツールの定義が約 3 万 9 千トークンで、費用は数十円です。

## 基準線（統合前、53 ツール）

2026-11-11、`baseline-v4.json`。ツールの定義は 53 個、約 6 万 4 千字（約 3 万 9 千トークン）。

| モデル | 正解 | 誤り |
|---|---|---|
| Haiku 5.5 | 86/88（hard は 26/26） | `search-01`（`search_web` のところ `search_deep`）、`music-03`（アルバムの収録曲で `search_artist`） |
| Haiku 4.5 | 84/88（hard は 24/26） | 上の 1 件目に加えて、`trade-01`（総合診断で `predict_hts_code`）、`hard-09`（商品ページの URL で `scrape`）、`hard-26`（FDA・CPSC の両方を聞かれて `verify_hts_code`） |

## 読み方

- 統合前でも、全ツールが見えていれば、正答率はすでに 95% 以上です。この問いの難しさでは、統合による**改善は測りにくく**、測れるのは**悪化していないこと**です。
- 統合の合格の目安: 同じモデルで、統合後の正答率が基準線より 1 問を超えて下がらないこと。モードを選ぶ引数の正答率は、90% 以上。
- 差が出やすいのは、貿易（`check_product_compliance` と個別のツール）と、検索の本流（`search_web` と `search_deep`）です。
- 統合の効果は、正答率のほかに、定義の大きさ（字数）でも見ます。全ツールを渡す利用側の文脈が、それだけ小さくなります。
