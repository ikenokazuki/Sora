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

## 統合後（v5.0.0、33 ツール）

2026-11-12、`results-v5.json`。ツールの定義は 33 個、57,540 字（統合前の 64,085 字から約 10% 減）。

| モデル | 統合前（基準線） | 統合後 1 回目 | 統合後（説明の冒頭を調整したあと） |
|---|---|---|---|
| Haiku 5.5 | 86/88（hard は 26/26） | 85/88（hard は 24/26） | 87/88（hard は 26/26） |
| Haiku 4.5 | 84/88（hard は 24/26） | 84/88（hard は 25/26） | 87/88（hard は 26/26） |
| モードを選ぶ引数（5.5 / 4.5） | — | 36/38 / 38/38 | 38/39 / 39/39 |

- 合格の目安（同じモデルで基準線より 1 問を超えて下がらない・引数の正答率 90% 以上）は、1 回目で満たしていました（5.5 は 1 問減、4.5 は同じ）。調整後は、どちらも基準線以上です。
- 1 回目に増えた誤りは 4 件でした: `hard-04`（座標から住所を聞かれて `get_place_info`）、`search-10`（ニュースの見出しで `search_deep`。4.5）、`trade-05`（FDA の規制の対象かで `lookup_hts`。4.5）、`hard-25`（流行語で `search_deep`。どれを選んでも妥当な依頼）。統合で名前が一般的になったツール（`get_place_info`・`search_media`・`check_regulations`）と、近い名前のツールの説明の冒頭に、使い分けの手がかり（住所そのものは返さない・ニュースを先頭に・規制の判定は `check_regulations`）を足して回し直したところ、4 件とも直りました。
- 残る誤りは `search-01`（`search_web` のところ `search_deep`。基準線でも同じで、依頼の言い方でどちらも妥当）と、5.5 の引数 `music-02`（「代表曲とアルバムの一覧」で `entity: "album"`。期待は `musicArtist`）です。
- 1 回目の引数の誤り `life-06`（`city` ではなく `areaCode: "23"` で呼んだ）は、`areaCode` の 2 桁が都道府県として使える仕様なので誤りではなく、期待値が厳しかっただけです。
- 同じ設定でも、1〜2 問は回すたびに揺らぎます。1 問の差には意味がありません。
- 効果は、正答率が統合前より下がらず（調整後は上がり）、全ツールを渡す利用側の文脈が約 10% 小さくなることです。改善は、基準線が高いので測りにくい点は、上の「読み方」のとおりです。
