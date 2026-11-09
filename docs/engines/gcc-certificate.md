# 一般適合証明書（GCC）と通関の書類を作る

一般適合証明書（GCC。General Certificate of Conformity）は、米国の CPSC（消費者製品安全委員会）の規則 16 CFR Part 1110 が定める書類です。証明者が、製品が挙げた規則に適合していると述べます。載せる要素は、製品の特定、規則、証明者、記録の担当、製造、試験、証明の文の 7 つです（16 CFR 1110.11(a)(1)〜(7)）。

ひな形に値を流し込むだけの道具だと、足りない値を作り話で埋めた「完成した証明書」ができてしまうことがあります。Sora の `generate_gcc_certificate` は、呼び出し側が記録から渡した値だけを載せます。足りなければ、証明書にせず下書きにして、足りない項目を示します。GCC が要らない品と、GCC でなく CPC（子供用製品証明書）が要る品も区別します。

Sora は ACE（米国税関の通関システム）にも CPSC にも、何も送りません。適合も保証しません。証明書の中身が正しいことの責任は、証明者（輸入者など）にあります（応答の `disclaimer`）。

## 使うツール

- MCP: `generate_gcc_certificate`（モジュール `trade` の遅延ツールです。`search_tools` で有効化します）。
- REST: `POST /trade/gcc-generate`。入力も応答も MCP と同じです。
- 入力は `items`（1〜50 件、1 件 1 製品）と、全品に共通の `certifier`（証明者）・`recordCustodian`（試験の記録を持つ人）・`orderNumber`・`awbNumber`・`carrier`・`invoiceNumber`・`allowDraft` です。品ごとに、`htsCode`（10 桁）と `productName`（英語）が必須です。
- 出力は、JSON の要約と、印刷用の HTML（`packageHtml`）です。Markdown は返しません。

## 手元のデータと外への問い合わせ

手元のデータは、次のものです。

- CPSC の判定（[cpsc-certificate.md](cpsc-certificate.md)）が使う、HTS コードの一覧と条文の写しです。
- 16 CFR 1110.11(a)(7) の証明の文の写しです。
- FDA が関わる品の注記を作る表です（[fda-regulated.md](fda-regulated.md)）。注記は、HTS コードと `foodContact` から言えることだけを書き、FDA への適合は書きません。

読まないものもあります。HTS の全件と、CBP の判例は読みません。HTS コードが実在するかも確かめず、10 桁であること（数字・点・空白・ハイフンだけ）だけを見ます。

外に出るのは、品に `url`（商品ページ）を付けたときだけです。

- `url` を付けた品のうち、下書きになり、`identifier` が無い品だけ、商品ページをブラウザなしの静的な取得で読みます。1 回に付けられるのは 5 件まで、1 品 10 秒までです。
- ページの商品データ（JSON-LD）から、番号などの候補（`suggestions`）を返すだけです。証明書には載せません。読めなかったときは、`warnings` に書いて進みます。

証明者と記録の担当は、呼び出し側の値か、サーバーの環境変数 `SORA_GCC_CERTIFIER`・`SORA_GCC_CUSTODIAN`（JSON）の値を、丸ごと使います。項目ごとに混ぜません。共有のサーバーでは、設定しないでください（省いた全ての呼び出しの証明書に入るためです）。

## 決め方

1. 入力を確かめます。商品ページを読む前に行います。
   - `url` を付けた品が 6 件以上なら 400 です。`hasBattery: false` と `batteryType: "button_coin"` は矛盾なので、400 です。
   - 見本・仮置きに見える値は、400 `UNVERIFIED_PLACEHOLDER_INPUT` です。値全体が `TBD`・`N/A` のような語のとき、`<…>`・`[…]`・`{{…}}` の差し込み口のとき、`example.com` などの予約されたメールのドメインや `test@test.com` のとき、`@` が 1 つでないメールやドメインに点が無いメールのとき、電話が数字と `+()-. ` 以外を含むか、7 桁未満か、同じ数字が 7 つ以上続くときです。語が値の一部にあるだけの `Sample & Co. GmbH` は通します。州・県が無い国の `state` の `N/A`・`NA`・`-`・`None` も通します。一覧は完全ではありません。
   - 日付は、`manufacture.date` が `YYYY-MM` か `YYYY-MM-DD`、`testing.date` が `YYYY-MM-DD` で、実在し、未来でないことが条件です（地球でいちばん進んだ時刻帯の今日までは許します）。誤りは 400 `INVALID_INPUT` です。
   - 証明書に載る値は、ラテン文字だけです（16 CFR 1110.9(a)）。漢字・かな・ギリシャ文字などは 400 `INVALID_INPUT` で、項目の場所を示します。
2. 品ごとに判定します。上から見て、最初に当たったもので決めます。
   1. `htsCode` が 10 桁で、`productName` があり、`citations` に空の文字列も、`16 CFR` を 2 回書いた文字列も無いことを確かめます。誤りは 400 です。
   2. CPSC の判定を、その品の情報で行います。
   3. 12 歳以下なら `cpc_required_instead` です。CPC は作りません。
   4. `targetAge` が無ければ、年齢を聞く下書きです。見出し 6111・6209（乳児の衣類）で `adult` のときも、年齢を聞く下書きです。
   5. Sora が当てはまると判断する規則を決めます。ボタン・コイン電池の 16 CFR 1263 と、衣料の 16 CFR 1610 です（帽子・手袋・履物の見出しは、条件で決まるので 1610 を求めません）。
   6. `citations` を省いたときです。大人の衣料で 16 CFR 1610.1(d) の免除に当たれば、`exempt_disclaim_b` です（ACE に送る免責の区分の Disclaim B を送れます。送るかどうかは任意で、送るときは Intended Use Code（用途の番号）130.006 が要ります）。ただし、電池の種類が分からなければ、先に種類を聞く下書きです。免除に当たらなければ、GCC の道に進み、`citations` を聞く下書きにします。
   7. `citations: []`（当てはまる規則が無いと証明者が確かめた、という答え）のときです。上の 5 で決めた規則があれば、`citations` に足すよう聞く下書きです。電池の種類が分からないときも、下書きです。そうでなければ `exempt_no_gcc_needed` です。CPSC の一覧にあるコードは Disclaim A（Disclaim B と並ぶ免責の区分です。送れます。任意です。送るには Intended Use Code が要ります）で、無いコードは、CPSC のデータを送らない案内です。
   8. `citations` に規則があるときです。1263 か 1610 が当てはまると Sora が判断したのに、`citations` に無ければ、下書きです。それ以外は GCC の道に進みます。
3. GCC の道の品は、次の記録がそろうかを見ます。
   - `identifier`（SKU・型番・GTIN など）。
   - `manufacture.date`、と製造者の 7 項目（`name`・`street`・`city`・`state`・`country`・`email`・`phone`）。
   - `testing.date`、と試験した者（1 者以上）の 7 項目。ただし、引用した規則が全て 1610.1(d) の試験の除外で、試験の記録が渡されていないときは、試験の日付と場所の代わりに除外を書きます（16 CFR 1110.11(c)）。
   - 証明者と記録の担当の 7 項目。
   - 電池の種類が分からない品（`hasBattery: true` で `batteryType` が無い品、一覧の `Button Cell & Coin Batteries` のコード）は、種類を聞きます。空気亜鉛電池は 1263 の対象外なので、`other` を書きます。
   そろえば `generated`、足りなければ `draft_needs_info` です。
4. 下書きがあるときは、既定（`allowDraft: false`）では 422 `MISSING_REQUIRED_GCC_FIELDS` です。`allowDraft: true` なら、200 で下書きを返します。
5. ID と状態を付けます。`generated` の品に、`GCC-` と 12 桁の 16 進数の `certificateId` を付けます。全体には `PKG-` と 12 桁の `packageId` です。どちらも内容のハッシュで、生成の時刻は入りません。同じ記録なら、同じ ID です。全体の状態は、CPC が 1 品でもあれば `cpc_required`、下書きがあれば `partial_or_draft`、GCC があれば `ready`、それ以外は `exempt` です。
6. 印刷用の HTML を作ります。品が 2 つ以上か、注文の項目（`orderNumber` など）があれば、表紙も付けます。呼び出し側の値は、全て HTML のエスケープを通します。下書きの証明書は、足りない項目を `[MISSING: 項目]` と書き、`DRAFT — NOT VALID` の印を付け、証明の文を付けません。FDA の注記は、`fdaNote` として品に付けます。表紙では、同じ注記を表の下に 1 回だけ出します。

## 決められないとき

品の状態は 5 つです。`generated`（GCC ができた）、`draft_needs_info`（足りない記録がある下書き）、`exempt_disclaim_b`（16 CFR 1610.1(d) の免除の大人の衣料）、`exempt_no_gcc_needed`（証明者が、当てはまる規則は無いとした）、`cpc_required_instead`（12 歳以下で CPC が要る）です。

足りないものは、品ごとの `missingFields`・`clarifyingQuestions` と、全体の `missingFields`（`certifier.*`、`recordCustodian.*`）で返します。次の入力は、製造者の連絡先・試験の記録・記録の担当が足りません。証明者と `citations` は渡してあります。

```json
{
  "items": [{ "htsCode": "6506.10.60.45", "productName": "Bicycle helmet", "identifier": "HEL-001",
              "targetAge": "adult", "citations": ["16 CFR 1203"], "manufacture": { "date": "2026-03" } }],
  "certifier": { "name": "Acme Imports LLC", "street": "100 Example Street", "city": "Anytown", "state": "CA",
                 "country": "United States", "email": "compliance@acme-imports.test", "phone": "+1-202-555-0101" }
}
```

既定では、次の 422 が返ります（`error`・`status`・`retryable` は省きました）。

```json
{ "code": "MISSING_REQUIRED_GCC_FIELDS",
  "details": {
    "missingFields": ["recordCustodian.name", "recordCustodian.street", "recordCustodian.city", "recordCustodian.state",
                      "recordCustodian.country", "recordCustodian.email", "recordCustodian.phone"],
    "items": [{ "line": 1, "htsCode": "6506.10.60.45", "productName": "Bicycle helmet", "identifier": "HEL-001",
                "missingFields": ["manufacture.name", "manufacture.street", "manufacture.city", "manufacture.state",
                                  "manufacture.country", "manufacture.email", "manufacture.phone",
                                  "testing.date", "testing.parties"] }]
  } }
```

`allowDraft: true` なら、同じ内容を `overallStatus: "partial_or_draft"` の 200 で返し、HTML の下書きに足りない項目を示します。MCP では `isError` の応答で、同じ `code` と `details` です。

エラーは、400 `INVALID_INPUT`（形の誤り・日付・ラテン文字以外・矛盾）、400 `UNVERIFIED_PLACEHOLDER_INPUT`（見本・仮置き）、422 `MISSING_REQUIRED_GCC_FIELDS` です。サーバーの環境変数 `SORA_GCC_CERTIFIER`・`SORA_GCC_CUSTODIAN` が JSON として読めないときは、GCC の品がある呼び出しだけ、500 `TRADE_ERROR` です。

## 限界

- 規則の正しさは確かめません。`citations` は証明者の答えです。Sora が確かめるのは、1263 と 1610 が入っているかだけです。CPSC の eFiling の規則の名前の一覧は同梱していません。
- 試験を実際に行ったか、報告書の番号や試験機関が本物かは、確かめません。HTS コードの実在も、分類の正しさも、確かめません。連絡先が実在するかも確かめません。
- 見本・仮置きの検出は、語と形の一覧です。完全ではないので、記録の値を渡す責任は呼び出し側に残ります。サーバーの環境変数の値は確かめません。
- 16 CFR 1610.1(c)(4)（芯地）は扱いません。ボタン電池のある大人の衣料は、電池の判定が先に返るので、1610.1(d) の試験の除外を自動では付けません。
- 帽子の見出し（6504〜6506）は HTS の桁で判断します。そのため、CPSC の一覧で別の区分（Bicycle Helmets）のコードにも、帽子の条件（1610.1(c)(1)）の文が付くことがあります。
- 証明書に載せるのは英語（ラテン文字）だけです。
- 応答は大きくなります。目安は、10 品で約 3 万字、50 品で約 14 万字です。応答を長さで切るクライアントでは、品を分けて呼んでください。
- 商品ページの候補は、出荷する品と同じとは限りません。確かめてから `identifier` に入れてください。

## 実装とテスト

- `src/services/gcc.ts`（入力の確かめ、品ごとの判定、記録の完全さ、ID、商品ページの候補）
- `src/services/gcc_html.ts`（印刷用の HTML）
- `src/services/trade.ts`（CPSC・FDA の判定）、`src/types.ts`（入力と応答のスキーマ）
- `src/mcp/tools_trade.ts`、`src/routes/trade.ts`
- テスト: `src/services/gcc.test.ts`（判定・記録の完全さ・免除の文・見本の検出・商品ページの候補・MCP）、`src/services/trade.test.ts`

[判断エンジンの一覧に戻る](README.md)
