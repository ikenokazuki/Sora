# v4.1.0 の残りの細かい指摘を直す 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `2026-11-06-v4-1-param-fixes.md` の作業で、作業ごとのレビューと最後のレビューが「今は直さなくてよい」として残した細かい指摘を、v4.1.0 を出す前にすべて直す。

**Architecture:** 同じブランチ（`fix/v4-1-param-fixes`、まだ出していない v4.1.0）に積む。分野ごとに Task を分け、最後の Task で生成するクライアント・リリースノート・全体の確認を行う。

**Tech Stack:** Bun（CI は 1.4.2）・TypeScript・zod 4・cheerio・bun:test

## Global Constraints

- `2026-11-06-v4-1-param-fixes.md` の Global Constraints をそのまま守る（公開リポジトリなので特定の利用者のサービスの名前を書かない、依存を足さない、既定の値を変えない、REST の応答の形は項目を足すだけ、引数を消すときの決まり、説明は短く、TDD、外への要求は最小、Conventional Commits、「skip ci」と書かない）。
- キャッシュの版: このブランチの v4.1.0 はまだ出していないので、このブランチで既に上げたキー（`scrape:v10`・`search:integrated:v13`・`search:realtime:json-v3`・`search:web:v2`・`map:v2`・`weather:v3`・`disaster:warning:v3`・`disaster:earthquake:v2`・`transit:v2`・`traffic:v3`・`traffic:flight:v2`・`img_inspect:v2`・`country-intel:provider:v2`）は、さらに上げなくてよい。まだ上げていないキーで、v4.0.0 と中身が変わるものは版を上げる。
- 最初に見える 14 ツールのツール単位の説明は合計 3,495 字（上限 3,500）。足すときは同じだけ削る。引数の説明は数えない。

---

### Task 1: 天気・警報・場所

対象: `src/services/life.ts`、`src/services/disaster.ts`、`src/jma_areas.ts` と `scripts/jma-areas/`、`src/city_map.ts`、`src/routes/public_data.ts`、`src/mcp/tools_life.ts`・`tools_disaster.ts`、`src/types.ts`、関係するテスト、README。

1. **気象庁の気温の地点を全部持つ。** 今は予報区ごとに最初の地点だけを表に持つので、ほかの 29 地点（大野・湯沢・池田・上野・津川・田島・古川など）は地点名として守られず、候補のエラーや別の県・部分一致での偶然の解決になる。`scripts/jma-areas/` の生成で、各予報区のすべての気温の地点（短期予報と週間予報の地点）を予報区に結び付けて表に入れ、city_map の地点名の守り（テスト）をすべての地点に広げる。保存済みの予報の JSON で作り直し、生成したファイルが再現できることを確かめる。
2. **都道府県名の短い形と正式名で、天気の予報区をそろえる。** 例: 天気で「山口」は 350020（中部）、「山口県」は 350010（西部）。47 都道府県で、正式名（○○県・都・府、北海道）の city_map の値を短い形の値にそろえる（表は足さない）。違っていたものの一覧を report に書く。警報は都道府県名なら県全体なので変わらない。
3. **警報で、気象台が複数ある県（北海道・鹿児島・沖縄）のエラーの文に、市町村名・地方名でも引けることを書く**（今は 6 桁の気象台の番号だけを求めている。`disaster.ts:118` 付近）。
4. **`search_disaster_warnings` で、`areaCode` を渡したときは `city` が空白でも誤りにしない**（`areaCode` が優先されるため）。`city` が空白で `areaCode` も無いときは、今のとおり入力の誤り。
5. **合わせた警報の重複を、種類（code）で 1 つにする。** 今は `code:status` で重複を除くので、予報区を合わせたときに「雷注意報 発表」と「雷注意報 継続」が並ぶ。同じ code は 1 つにし、status は発表を継続より優先する。
6. **`POST /weather` の 500 の応答を、ほかのルートと同じ `formatError` の形にする**（今は `{ error }` だけ。`public_data.ts:50` 付近）。項目を足すだけにする。
7. **`public_data.ts` の `strictQueryNumber` と `queryNumber` を 1 つにする**（数でないものの扱いを、ルートの要る形に合わせて引数で選べるようにするか、1 つにそろえる）。
8. **MCP の get_elevation の範囲外（999）を、実際に呼んで拒まれることをテストする**（今は tools/list の範囲だけを見ている）。
9. **場所の解決の関数（`AreaInputError`・`resolveMunicipality`・`prefectureOf`・`resolvePlace` など）を、`life.ts` から 1 つの小さなモジュール（例 `src/services/jma_area.ts`）に移す。** 振る舞いは変えない。
10. **警報の段階の振り分けの三項演算子の重複をなくし、`LEVELED_KINDS` の情報を `WARNING_KINDS` の行に入れる**（`disaster.ts`）。振る舞いは変えない。
11. **`life_weather.test.ts:1168` 付近のテストの題を、地点を名前で選ぶ今の動きに合わせる。**

テスト: 1・2・3・4・5・6・8 は先に失敗するテストを書く。9・10 は既存のテストが通ること。

外への要求: なし（保存済みの予報の JSON を使う。足りなければ気象庁に 10 回まで）。

### Task 2: 乗換・飛行機・道路

対象: `src/services/traffic.ts`、`src/types.ts`、README。

1. **`resolveAirport` のあいまいな一致を締める。** 今は `key.includes(k) || k.includes(key)` で、「o」「羽」も羽田になる。表の別名と完全に一致するか、表の空港名・別名を含む入力（例「羽田空港国際線ターミナル」）だけを受け、短すぎる入力（2 字未満のかな・英字など）や部分の文字だけの入力はエラーにする。羽田・成田・伊丹・関西・中部と、その別名・コード（HND など）は今のとおり解決する。
2. **OpenAPI の飛行機の要約（「主要空港」の言い方、`types.ts:3523`・`:3543`・`:3566` 付近）を「5 空港」に直す。**
3. **README §3.11 の道路の例を、応答の形と合わせる**（今は `{pref:"東京都", road:"東名高速"}` が都道府県のページの経路になるのに、例の応答は道路ごとの形）。

外への要求: なし。

### Task 3: 検索

対象: `src/services/yahoo.ts`、`src/integrated_search_host_response.ts`、関係するテスト。

1. **`splitRealtimeQueryParts`（`yahoo.ts:1374` 付近）で、閉じていない括弧（`A (B` など）の断片を `missingTerms` に入れない。`foo-(bar)` の `-` を除外の記号として飲み込まない。**
2. **X のタイムラインの判定に、末尾のスラッシュ（`https://x.com/name/`）と `mobile.twitter.com` のテストを足す**（処理は今も対応している）。

外への要求: なし。

### Task 4: scrape・crawl・map・webhook

対象: `src/scraper.ts`、`src/routes/scrape.ts`、`src/mcp/tools_web.ts`、`src/enrichment.ts`、`src/types.ts`、関係するテスト、README。

1. **maskPii で隠した表の見出しがぶつかったとき、列をまとめない**（`Object.fromEntries` で同じ名前の列が 1 つになる）。ぶつかった見出しに番号を付けるなどして、列を残す。
2. **`maskPiiDeep` で、`jsonLd`・`events` の中の URL の文字列（`http(s)://` で始まり `@` を含まないもの）は隠さない**（今は URL の中の 0 から始まる 10〜11 桁を電話番号として隠す）。README の「URL は隠さない」の書き方と合わせる。`socialLinks`・`ogImage`・`twitterHandle` を隠さないことも README に書く。
3. **`/scrape/stream` で、入力の誤り（renderJs と fastOnly の同時指定、壊れた removeSelectors）を、ストリームを開く前に 400 で返す**（今は `SCRAPE_ERROR` のイベント）。
4. **静的な本文が 50 字未満のページ（SPA の扱い）で、スクリーンショットを求めていてブラウザが失敗したときは、例外にせず、静的な結果に画像を取れなかった旨の `warnings` を付けて返す。** スクリーンショットを求めていない SPA の失敗は今のまま。
5. **`scrape_batch` の webhook の中身を、応答と同じ整形後の結果にする**（`/crawl` は整形後になっている）。README に、各 webhook の中身の形を書く。
6. **`POST /map` を `MapRequestSchema` で検証する**（`dropNullFields` を使う。`limit`・`timeoutMs` の範囲外は 400）。
7. **`map_site` の日付での絞り込みで、読むサイトマップの URL の上限（5,000）をテストで確かめる。子のサイトマップを 1 つずつ取るのを、数を限って並べて取る**（例 3 つずつ）。
8. **webhook のテストで、1 回だけ届くことを確かめる**（最初の 1 件で待つのをやめ、少し待ってから件数が 1 であることを見る）。
9. **crawl_site の各ページに `warnings` が付くことをテストで確かめる。**
10. **README に、crawl_site で screenshot を求めると各ページ（最大 50）の全画面の画像が付き、応答が大きくなることを書く。**

外への要求: なし（手元のページだけ）。

### Task 5: browser_action・inspect_image

対象: `src/browser_session.ts`、`src/services/image_inspect.ts`、`src/routes/media.ts`・`src/mcp/tools_media.ts`、関係するテスト、README。

1. **スクリーンショットの指定なしで作ったセッションは、画像・Web フォントを読まない設定のままなので、あとの呼び出しの clipSelector・screenshot の画像が空白になる。** あとの呼び出しで画像が要るときは、そのセッションのページで画像の読み込みを有効にしてから撮る。
2. **inspect_image の「画像ではありません」のエラーを、REST（`MEDIA_ERROR`）と MCP（`isError`）の両方で確かめるテストを足す。**
3. **説明の文字列の一部を見ているテスト（「ページ遷移」「1 文字」など）を、言い換えで壊れない形にする**（例: 説明の中の環境変数名・引数名などの決まった語を見る）。
4. **README §1 の表の「スクショ/JS実行」（README.md:351 付近）に、JS の実行は `ALLOW_BROWSER_EVALUATE=true` のときだけであることを、表の形を崩さずに足す**（注記を表の下に付けてもよい）。

外への要求: なし。

### Task 6: 貿易・監視・国会・国の情報

対象: `src/services/watch.ts`、`src/services/trade.ts`、`src/types.ts`・`src/mcp/tools_gov.ts`、`src/services/country_intel/region.ts`、関係するテスト、README。

1. **`watch_check` で、変化のあった対象の webhook を 1 つずつ待たず、まとめて送ってから待つ**（`Promise.all` など。待ち時間は最も遅い 1 つで決まるようにする）。応答の `webhookSent` は対象ごとに今のとおり。
2. **watch のテストで出る、想定どおりの `console.warn` の 3 行を、テストの中で受け止めて出さない**（出たことはテストで確かめてよい）。
3. **CPSC の未掲載の答えで、「CPSC公式に個別確認」が 3 つの項目に繰り返されるのを、1 か所にまとめる**（ほかの項目は別の言い方で要点だけにする）。
4. **国会の議事録の「keyword・speaker・nameOfMeeting のどれか 1 つが要る」ことを、引数の説明（keyword など）と OpenAPI の 400 の応答に書く。**
5. **日本語の国名の前方一致の最短の長さを 4 字にする**（3 字では「アラブ」がアラブ首長国連邦になる。「アメリカ」は今のとおり解決し、「サウジ」は解決しなくなる）。
6. **国名の照合で、空白と全角・半角の違いを無視する**（「ミャンマー(ビルマ)」が ICU の「ミャンマー (ビルマ)」に当たるようにする）。「中華人民共和国」は、ICU に正式名が無く、香港・マカオの名前の先頭と重なるため、表を持たない方針では解決しない（今のまま。report に理由を書く）。

外への要求: なし。

### Task 8: 地名の一部の一致で別の県に当たらないようにする

Task 1 のレビューで見つかった。対象: `src/services/jma_area.ts`、`src/city_map.test.ts`、関係するテスト、README。

1. **「〜島」の名前が、一部の一致で別の県の市町村に当たらないようにする。** 例: 「小浜島」（沖縄県竹富町）が福井県の小浜市に当たり、福井の天気・警報になる。入力が「島」で終わり、一部の一致で当たった名前が「島」で終わらないときは、一部の一致を使わない（見つからない旨のエラーにする）。同じように、別の県の名前に一部の一致で当たる入力をデータから洗い出し（例: 予報区・市町村の名前の後ろに島・岳・湖などが付いた形）、別の県に当たるものは一部の一致を使わない。直した入力の一覧を report に書く。
2. **city_map の地点名の守りのテストを、市町村のデータから導く形にする**（今は city_map に無いことから「ほかの市町村と重なる地点」を決めている。表を作り直して新しく重なる地点が出たときに、テストが落ちるようにする）。
3. **入力の中の空白の扱いを、候補を返す処理と市町村の表を引く処理でそろえる**（「上 野」が候補のエラーを飛ばして上野村に当たる）。

外への要求: なし。

### Task 7: 全体の確認

Task 8 のあとに行う。

1. `bun run gen:client` で `client/` を作り直す。
2. `bun run typecheck`・`bun run lint`・`bun run schema:notation` を通す。
3. 全件のテストを、手元の Bun と Bun 1.4.2 の両方で通す（プロキシの変数を外す）。
4. `RELEASE_NOTES.md` の v4.1.0 の節に、この計画で変わった呼び出し側から見える点を足す（短く）。
5. MCP の定義の大きさを測り直し、`RELEASE_NOTES.md` と `docs/code-execution.md` の数を更新する。

外への要求: なし。

---

## 直さないもの（理由）

- 古い計画の文書（`docs/superpowers/plans/2026-10-03-api-schema-notation-fix.md`）に `intervalSeconds` が残っていること: その時点の記録なので変えない。
- commit 549d552 から f0311d6 の間だけ `schema-notation` のテストが落ちること（bisect のときの穴）: 公開済みのコミットを書き換えないため、マージの方法（squash など）で扱う。
