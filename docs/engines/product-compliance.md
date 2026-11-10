# 商品 1 つを関税・FDA・CPSC まとめて診断する

米国へ商品を送るときは、HTS コード（関税率表の番号）と関税率、FDA の規制、CPSC の証明書という 3 つを確かめます。個別のツールを呼ぶと、前の答えを次へ渡す手順を呼び出し側が間違えます。たとえば、確度の低い HTS コードのまま FDA・CPSC の判定へ進んだり、素材や年齢を文章から勝手に決めたりします。

`check_product_compliance` は、HTS コードの確定、実在確認、FDA、CPSC を一度に回し、全体の状態と通関前の手順（`actionPlan`）を返します。どこで止めるか、どの警告を出すかは Sora が決めます。

## 使うツール

- MCP: `check_product_compliance`（モジュール `trade`。このモジュールの中で、最初から見える唯一のツールです。ほかの `trade` のツールは遅延ツールで、`search_tools` で有効化します）。
- REST: `POST /trade/compliance`。
- 入力は、商品ページの `url`、または英語の `productName`・`description`・`material`・`productCategory` です。ほかに、`htsCode`・`targetAge`・`foodContact`・`hasBattery`・`batteryType`・`fabricSurface`・`fabricWeightOzPerSqYd` を渡せます。
- 一般適合証明書（GCC）は、このツールでは作りません。作るには `generate_gcc_certificate` を使います（[gcc-certificate.md](gcc-certificate.md)）。

## 手元のデータと外への問い合わせ

このツール自身はデータを持たず、次のエンジンのデータを使います。

- HTS コードの推測と実在確認: [hts-prediction.md](hts-prediction.md)（HTS 全件の手元のコピーと、CBP の分類判例の照会）
- FDA の判定: [fda-regulated.md](fda-regulated.md)（コードに書いた表。外への問い合わせなし）
- CPSC の判定: [cpsc-certificate.md](cpsc-certificate.md)（同梱の一覧と条文。外への問い合わせなし）

外に出るのは、次の 2 つです。

- `url` を渡したときの、商品ページの取得です。Sora の通常のスクレイプで、本文を 5,000 字まで読みます。静的な取得で足りなければ、ブラウザに切り替えることがあります。
- 推測のときの、CBP の判例の照会です。`htsCode` を渡した場合も、商品情報から推測した章との食い違いを調べるために推測を試すので、照会が起きます。判例の検索が使えなくても、HTS の全文検索だけで進みます。

## 決め方

1. `hasBattery: false` と `batteryType: "button_coin"` は矛盾なので、400 `INVALID_INPUT` で止めます。
2. `url` があれば、商品ページを読みます。題名は `productName` が無いときだけ、説明は `description` が無いときだけ採ります（ページの説明が無ければ、本文の先頭 1,000 字）。読めなくても止めず、渡された情報だけで進みます。
3. 名前・説明・カテゴリ・素材をつないだ文が空なら、`needs_more_info` で止めます（`missingInputs: ["productDetails"]`）。
4. HTS コードの推測を行います。`htsCode` を渡しても行います。
5. `htsCode` が無いときは、推測できなかったか、確度が `low` なら、`needs_more_info` で止めます。`low` でなければ、最有力のコードを使います。確度が `medium` のときも先へ進みます。
6. 次の 3 つを並行して行います。HTS の実在確認、FDA の判定、CPSC の判定です。`targetAge` が無ければ `unknown` として渡します。年齢と素材を文章から推定することはしません。
7. 3 つの答えを、全体の状態にまとめます。
   - CPSC の証明書か eFiling が要るなら、`action_required` です。証明書の種類（GCC か CCC）、eFiling、当たる規則を `actionPlan` に並べます。大人の衣料で 16 CFR 1610.1(d) の免除なら、要約に書くだけで、状態は上げません。CPSC が `unknown` で確認事項があれば、`potential_action_required` です。
   - FDA の規制対象の可能性があれば、`action_required` です。Prior Notice（FD4 は必須、FD3 は食品用途なら）と、プログラムごとの手順（化粧品・医療機器・医薬品・食品に触れる物質）を足します。
   - HTS コードが表に完全一致すれば、一般関税率と、追加関税（Chapter 99）を通関士に確認する旨を足します。一致しなければ、`potential_action_required` にして、近いコードの確認を足します。
   - どれにも当たらなければ `likely_exempt` です。
8. 電池の注意を 1 行足します。`batteryType: "button_coin"` なら 16 CFR 1263 の確認、`hasBattery: true` と `batteryType: "other"` なら、DOT/PHMSA の危険物表示の確認です。状態は変えません。
9. `htsCode` を渡していて、推測（確度が `low` でない。判例を参照できないときは `low` なので比べない）の章が、渡されたコードの章（先頭 2 桁）と違えば、`【HTSコード乖離注意】` の警告を `actionPlan` の先頭と `impactExplanation` に足します。状態は変えません。
10. 推測（`htsCode` が無いときだけ）・CPSC・FDA・HTS の実在確認が返した不足情報と質問を、重複を除いてまとめます。

## 決められないとき

状態は 4 つです。`action_required`（対応が要る）、`potential_action_required`（対応が要るかもしれない）、`likely_exempt`（対応は要らないと見られる）、`needs_more_info`（質問を返して止めた）です。

`needs_more_info` になるのは、次の場合です。

- 商品の情報が何も無いとき。「商品名または商品説明を教えてください」と返します。
- `htsCode` を省いていて、商品名・説明が日本語のときも、`needs_more_info` です。英語の語が無いと推測できないので、商品の一般名・素材・用途を英語にして渡すよう促します。HTS も判例も英語だからです。

  ```json
  { "productName": "おもちゃ" }
  ```

- `htsCode` を省いていて、推測できなかったとき（該当する品目が見つからないなど）と、推測の確度が `low` のとき。確度が `low` のときは、推測の候補（`htsPrediction`）と、分岐点の質問を返します。

質問の答えは、`description` や `material`・`targetAge` に足して、再実行します。

`likely_exempt` の例は、大人用のポリエステルの T シャツです。`productName: "Adult Polyester T-Shirt"`、`htsCode: "6109.90.10.07"`、`targetAge: "adult"`、`material: "100% polyester"` を渡すと、CPSC は免除、FDA は対象外、HTS コードは表に実在するので、`likely_exempt` になります。

## 限界

- `htsCode` を省いたときの精度は、[hts-prediction.md](hts-prediction.md) の限界のとおりです。確度が `low` のとき（判例を参照できないときを含む）は先へ進まず、`needs_more_info` で聞き返します。`medium` のときは先へ進むので、`htsPrediction.bestMatch.confidence` を見て、`medium` は人が確かめてください。
- 追加関税（Section 301、アンチダンピング税、相殺関税など）は対象外です。`likely_exempt` は、何も規則が当たらないという意味ではありません。CPSC と FDA の判定がそれぞれの表の範囲で当たらない、という意味です。
- 章の食い違いの警告は、章（先頭 2 桁）だけを比べます。同じ章の中の違いは検知しません。
- 商品ページの題名には、宣伝文句やブランド名が入ります。推測が外れやすくなるので、英語の一般名を `productName` に渡すほうが確かです。
- CPSC と FDA の限界も、そのまま引き継ぎます（[cpsc-certificate.md](cpsc-certificate.md)、[fda-regulated.md](fda-regulated.md)）。
- 参考情報で、法的助言でも通関の確定情報でもありません（応答の `disclaimer`）。

## 実装とテスト

- `src/services/trade.ts`（`checkProductCompliance`、`buildIntegratedActionPlan`）
- `src/mcp/tools_trade.ts`、`src/routes/trade.ts`、`src/types.ts`（入力のスキーマ）
- テスト: `src/services/trade.test.ts`（統合の判定を含む）、`src/trade_tracking_watch_params.test.ts`（引数名）、`src/response_schema_contract.test.ts`（応答の形）

[判断エンジンの一覧に戻る](README.md)
