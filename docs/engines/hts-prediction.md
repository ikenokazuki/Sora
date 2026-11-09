# 商品名から HTS コードを推測する

米国へ輸出する商品には、10 桁の HTS コード（Harmonized Tariff Schedule。米国の関税率表の番号）が要ります。先頭の 6 桁は国際共通の HS コードで、残りは米国の細分です。商品名で関税率表を検索するだけでは、"wallet" や "wristwatch" のような普段の言葉と、表の用語が離れているので外します。

Sora の `predict_hts_code` は、英語の商品名・説明から、10 桁のコード・一般関税率・関連する規制の候補を決めます。公式の関税率表の全文検索と、米国税関（CBP）の分類判例（CROSS）の二つを、6 桁の単位で合わせます。決めきれないときは、公式の階層の分かれ目を選択肢にした質問を返します。

同じ関税率表を使う `verify_hts_code`（渡されたコードが表に実在するかの確認）も、このページで説明します。

## 使うツール

- MCP: `predict_hts_code`、`verify_hts_code`（どちらもモジュール `trade` の遅延ツールです。`search_tools` で有効化します）。
- REST: `POST /trade/hts-predict`、`POST /trade/hts-verify`。
- `check_product_compliance`（`POST /trade/compliance`）も、内部でこの二つを使います（[product-compliance.md](product-compliance.md)）。

## 手元のデータと外への問い合わせ

手元のデータは、USITC（米国国際貿易委員会）が公開する HTS の全件です。

- Sora には同梱していません。この機能が初めて使われたときに、USITC の公開エクスポートをダウンロードし、SQLite のファイルに保存します（保存先は `SORA_HTS_DIR`、既定は `SORA_DB_PATH` のあるディレクトリの下の `hts`）。ダウンロードは約 12MB、保存したファイルは約 21MB です。取得の時間切れは 90 秒です。
- 説明だけの中間行（"Other:" など）も含む完全な木として持ちます。各行に、祖先の説明（`path`）と、継承した関税率（`rateFrom`）を付けます。10 桁の行の多くは自分の行に率を持たず、いちばん近い祖先の率が適用されるためです。
- 全文検索の対象は、申告に使う行（これより細かい行を持たず、コードが 8 桁以上で、第 98・99 類でない行）で、約 2 万行です。SQLite の全文検索機能（FTS5）で引きます。語の語幹をそろえ、BM25（語の出現数と行の長さから点を付ける、検索で広く使う式）で並べます。
- 更新は 7 日ごとです。7 日を過ぎたあとの最初の利用では、古い表で答えながら、裏で取り直しを始めます。取り直しに失敗したら、1 時間は再試行しません。起動時の取得や定期の処理はありません。初回の取得に失敗したときは、その呼び出しがエラーになり、次の呼び出しで取り直します。

外への問い合わせは、CROSS だけです。

- `predict_hts_code` が呼ばれたときだけ、CBP の判例検索に問い合わせます。`verify_hts_code` は手元の表だけで答えます。
- 1 回の問い合わせは 5 秒で時間切れにします。結果は 24 時間キャッシュします。1 回失敗すると、60 秒は問い合わせません。
- 分類の判例だけを使い、取り消された判例は除きます。1 回に見る判例は 10 件までです。
- 失敗しても止まりません。HTS の全文検索だけで答え、`evidence.crossStatus` に `unavailable`（失敗）か `no_rulings`（該当なし）を残します。

## 決め方

`predict_hts_code` の手順です。

1. 入力を確かめます。`productName` と、`description`・`productCategory`・`material` をつないだ文に、英語の語が 1 つも無ければ、REST では 400（`INVALID_INPUT`）、MCP では `isError` の応答です。HTS も判例も英語だからです。
2. 否定された語（"not ceramic"、"without battery"、"non-..."）は検索語から外します。`hasBattery` が `true` のときだけ、検索語に `battery` を足します。
3. 次の二つを並行して行います。
   - HTS の全文検索（上位 60 行）。説明の語を、祖先の説明の語の 3 倍の重みで数えます。
   - CROSS の照会。照会語は、具体的なものから順に、品名の全ての語、前置詞（for・with など）より前の名詞句、その後ろ 4・3・2・1 語です。`material` があれば、素材つき（"plastic coaster"）を先頭に置きます。10 件集まるまで続けます。照会は AND 条件で、語が多いと 0 件になるためです。ヒットが 2,000 件を超える語は上位が無関係になるので、そこで打ち切ります。
4. 判例が挙げたコードを、現行の表にある 6 桁に直します。改訂で番号が変わったコードは、上位 5 桁が同じ 6 桁へ、なければ見出し（4 桁）の下の 6 桁へ振り分けます。振り分け先が 6 個を超えるときは使いません。
5. 判例に票を付けます。判例の重みは 1/(順位+1) で、1 件の判例が複数の 6 桁を挙げたら等分します。
6. 候補の 6 桁を作ります。判例の票の多い順に 6 個、全文検索の上位から 6 個を合わせます。どちらも空なら 400 です。
7. 6 桁ごとに点数を付けます。`0.7 × 判例の票の割合 + 0.3 × 全文検索の点数` です。全文検索の点数は、候補の 6 桁の中だけで測り直した値を、最大値で割ります。商品の語が表に無いと、全体の検索は無関係な行に引かれるためです。この重み 0.7 は、評価セットの dev で決めました。
8. 部品・付属品を減点します。見出しが "Parts" で始まる 6 桁は、商品の語に部品・付属品を示す語（part・accessory・case・cover・strap・charger など）が無いとき、点数を 0.5 倍にします。
9. 点数が最も高い 6 桁を採り、その中の 10 桁の行を選びます。入力から読める年齢・性別（"men's"、"aged 3+"、"toddler" など。`targetAge: child` も使います）と、公式の行の説明文（"Men's"、"Under 3 years of age" など。10 本の正規表現で読みます）を突き合わせ、合わない行を除きます。そのうえで、次の順に最初に見つかった行を採ります。
   - 判例が挙げた行（票の多い順）。
   - 判例が挙げた 8 桁の下の、全文検索の上位の行。
   - 最有力の 6 桁の中の、全文検索の上位の行。
   - 年齢・性別に合う行。
   - 最後の行（多くは "Other"）。
10. 確度（`confidence`）を決めます。しきい値は、dev と test の 103 件で適合率を測って決めました。
    - `high`: 全文検索の 1 位、判例の 1 位、最終の 6 桁が同じで、判例の票の割合が 0.4 以上。
    - `low`: 1 位と 2 位の点数（0〜1 の値）の差が 0.1 未満、または全文検索の 1 位も判例の 1 位も最終の 6 桁でない。ただし、年齢・性別で 10 桁を決められ、どちらかの 1 位が最終の 6 桁なら `medium`。
    - `medium`: それ以外。
11. 候補（6 桁ごとの代表の行、最大 5 件）を作ります。確度が `high` でなければ、分岐点の質問も作ります。候補の行が公式の階層で最初に分かれる位置を探し、その位置の公式の説明文を選択肢（最大 6 個、各 160 字まで）にします。6 桁が競っている（2 位が 1 位の 0.6 倍以上）ときは 6 桁の代表どうしを、そうでなければ最有力の 6 桁の下の全ての行を比べます。商品の語を含まない行も選択肢になります（自転車用ヘルメットは "Athletic, recreational and sporting headgear" で、"helmet" の語を含みません）。
12. 最有力のコードで、CPSC と FDA の判定を呼び、足りない情報を質問にまとめます（[cpsc-certificate.md](cpsc-certificate.md)、[fda-regulated.md](fda-regulated.md)）。

`verify_hts_code` の手順です。

1. コードから点を除きます。8 桁以上で、表に行があれば `matchLevel: exact` です。公式の説明・階層での位置・率（継承した率を含む）を返します。8 桁の行にこれより細かい 10 桁の行があるときは、細かい行（30 件まで）を `nearbyCandidates` に入れ、10 桁を確かめる質問を返します。
2. 行がなくても、先頭 6 桁の下に行があれば `6-digit-category`（`verified: false`）です。近い行を返し、10 桁を確かめる質問を返します。
3. どちらもなければ `unmatched` です。`productDescription` は必須ですが、判定には使わず、根拠の記録として応答に返します。

## 決められないとき

- 英語の語が無い入力と、該当する品目が見つからない入力は、REST では 400 `INVALID_INPUT`、MCP では `isError` の応答です。`/trade/compliance` は、`htsCode` を省いたときに限り、エラーにせず `needs_more_info` で英訳を促します。
- 確度が `high` でないときは、`decisionPoints`（選択肢つきの質問）と `clarifyingQuestions` を返し、`missingInputs` に `classificationDetail` を入れます。利用者の答えとなる区分の語を `description` に足して、再実行します。

  ```json
  { "productName": "Bicycle Helmet", "description": "Protective helmet for road cycling" }
  ```

  この入力では、確度 `medium`、最有力は `6506.10.60.45` で、次の質問が付きます（README の実行例から抜粋。選択肢は 6 個のうち、(1) と (3) だけ）。

  ```
  分類の確認: 公式の区分「Safety headgear」のうち、商品が当たるのはどれですか？
  (1) Other › Other › Athletic, recreational and sporting headgear [6506.10.60.45, Free]
  (3) Other › Motorcycle helmets [6506.10.60.30, Free]
  ```

- 確度が `high` でなく `material` が無いときは、素材の指定を促す質問を足します。同じ品名でも、素材で章が分かれるためです（plastic coaster は 3924.10、textile coaster は 6304.93、ceramic coaster は 6912）。

## 限界

評価は、日本からの輸出が多い品目を中心にした 150 件（dev 52・test 51・保留 47、英語）で行いました。正解の 6 桁は作者が 1 人で付けたので、誤りが残っているかもしれません。10 桁の選択は測っていません。

| | 1 位の 6 桁が正解 |
|---|---|
| 全体（150 件。調整に使った dev を含む） | 72.0% |
| 調整に使っていない保留（47 件） | 68.1%（信頼区間は約 ±13 ポイント） |
| 判例なし（HTS の全文検索だけ） | 37.3%（`high` は付かない） |

- 候補（上位 5 つの 6 桁）に正解が入る割合は 89.3% です（保留では 85.1%）。
- 確度ごとの的中率は、`high` 94%（31/33）、`medium` 79%（59/75）、`low` 43%（18/42）です。しきい値の決定に使った件を含みます。
- 商品の語が HTS にも判例にも乏しい品目（laptop・toothpaste・webcam など）や、同じ見出しの兄弟（磁器と陶器、靴の底の材質）は外れやすいです。調整を重ねても、1 位の一致率は上がりませんでした。評価の詳細は [docs/evaluations/hts-predict/results.md](../evaluations/hts-predict/results.md) にあります。
- 入力は英語だけです。長い出品タイトルは判例に当たらないことがあり、そのときは全文検索だけで答えます。
- HTS は最大 7 日古いことがあります。判例の検索が止まっている間は、精度が下がります。
- 一般関税率だけを返します。Chapter 99 の追加関税（通商法 301 条など）は計算せず、通関士への確認を案内するだけです。
- このツールは分類の確定ではありません。自動で採用してよいのは `high` のときだけにしてください（`check_product_compliance` は `medium` も先へ進めます）。通関に使う前に、`evidence.rulings` の判例と CROSS で確かめてください。

## 実装とテスト

- `src/services/trade.ts`（`predictHtsCode`、`verifyHtsCode`、`crossQueriesFor`、`stripNegations`、`buildDecisionPoint`）
- `src/services/hts_data.ts`（HTS の取得・保存・全文検索）
- `src/services/cbp_cross.ts`（CROSS の照会）
- `src/mcp/tools_trade.ts`、`src/routes/trade.ts`
- テスト: `src/services/trade.test.ts`、`src/services/hts_data.test.ts`、`src/services/cbp_cross.test.ts`。テストの入力は、実際の関税率表と判例の応答の抜粋です（`src/test_fixtures/usitc_export_excerpt.json`、`src/test_fixtures/cross_search_excerpt.json`）。
- 評価: `eval/hts_predict_cases.json`、`scripts/eval-hts-predict.ts`

[判断エンジンの一覧に戻る](README.md)
