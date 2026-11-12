# Sora v5.0.0 — MCP のツールを用途ごとに 53 個から 33 個にまとめ、環境変数の名前を整理した

用途の近い MCP のツールを 1 つにまとめ、53 個を 33 個にしました（初期公開は 14 個から 13 個）。ツールが多いと、LLM が似た名前のツールの中から選び間違えるためです。まとめたツールは、入力（`type`・`action`・`include`・`part`・`agencies`、URL の形、どの引数を渡したか）で使い方を選び、元のツールと同じ処理を呼びます。ツールの統合では、REST と型付きクライアント（`client/`）の関数名を変えていません（v4.2.0 からの REST の変更は、下の `GET /client` の廃止・`search_road_traffic` の `source`・「REST の応答の文」・「v4.2.0 以降に main に入った、そのほかの変更」のとおりです）。`scripts/measure-context.ts` の値は、既定 23,060・全ツール 57,232・`instructions` 8,685 です（v4.2.0 は 22,269・63,529・8,948）。あわせて、環境変数の名前を整理しました（旧名は読みません。「先に気づく変更（運用者）」と「環境変数の整理」）。

## 先に気づく変更（呼び出し側）

- **MCP のツール名が 29 個なくなり、新しい名前 9 個（`search_media`・`search_keywords`・`lookup_address`・`get_place_info`・`get_disaster_info`・`watch`・`lookup_hts`・`check_regulations`・`get_youtube`）ができました。** 旧名の別名は残していません。旧名で呼ぶと、`isError` の `MCP error -32602: Tool <旧名> not found`（例: `MCP error -32602: Tool scrape_batch not found`）です。旧名と新しいツール・引数の対応は、README の「v5.0.0 への移行（旧ツール名 → 新ツール名）」の表にあります。`search_tools` で旧名を検索すると、新しいツールが見つかります（新しいツールの検索語に旧名を入れています）。
- **ツールの統合では、REST を変えていません。** まとめたツールが呼ぶ REST の URL・リクエスト・レスポンスの欄は同じで（応答の文だけ、後の「REST の応答の文」のとおり変えたものがあります）、`GET /tools` の操作の名前（OpenAPI の `operationId`）も旧いツール名のままです。v4.2.0 からの REST の変更は、次の `GET /client` の廃止と `search_road_traffic` の `source`、「REST の応答の文」、「v4.2.0 以降に main に入った、そのほかの変更」（`GET /tools` の追加、エラー応答の形、地震の取得元など）のとおりです。型付きクライアントの関数名（`scrapeBatch`・`mapSite`・`getElevation` など 52 個）も同じです。
- **`GET /client`・`GET /client/{path}` を廃止しました（v4.2.0 以降の変更で deprecated にしていました）。** 代わりは `GET /tools` と `GET /tools/{name}`、および各操作の REST の直接呼び出しです。型が要るときは、OpenAPI から標準のジェネレータで作ってください。リポジトリの `client/` の生成物は残っています（配る経路が無くなっただけです）。`GET /tools` の追加と合わせて、OpenAPI の操作の数は v4.2.0 と同じ 82 です。
- **`search_road_traffic` の応答の `source` が `"jartic"` から `"yahoo-roadway"` になりました**（REST・MCP とも。#70）。実際に読んでいるのは Yahoo! 道路交通情報（`roadway.yahoo.co.jp`）のページで、取得元を JARTIC と表示するのは実態に合わないためです。取得の動きとほかの欄は変えていません。`source` で分岐している呼び出し側は直してください。`search_tools` の検索語には `JARTIC` を残しています。
- **MCP の応答の形が変わるツールがあります。**
  - `lookup_address`・`lookup_hts`・`get_youtube` は、旧ツールの応答の先頭に `mode` 欄が付きます（`normalize` / `reverse` / `postal`、`verify` / `predict`、`video` / `channel`）。ほかの欄は旧ツールと同じです。
  - `get_place_info`（旧 `get_elevation`）は `{ location, elevation, include }` の節に分けます。キャッシュの欄（`cached`・`cachedAt`・`ageSeconds`）は `elevation` の中に入ります。
  - `get_disaster_info` は `{ include, warnings, earthquake }`、`check_regulations` は `{ agencies, cpsc, fda }` の形で、頼んだ節だけを返します。節の中身は旧ツールの応答のままです。2 つとも頼んで片方が失敗すると、その失敗のエラーだけを返します（もう片方の節は返しません）。
- **`get_disaster_info` を引数なしで呼ぶと、最近の地震を返します。** 旧 `search_disaster_warnings` は、地域を省くと東京地方の警報を返していました。警報は `city` か `areaCode` が必要で、`include: ["warnings"]` で地域が無いと入力の誤りです。REST の `/disaster/warnings` は、今までどおり東京地方が既定です。
- **`check_regulations` の判定に CPSC を含むとき（既定）は、`targetAge` が必要です。** 旧 `check_fda_regulated` のように `htsCode` だけで呼ぶと入力の誤りで、`targetAge` を足すか `agencies: ["fda"]` にするよう案内します（不明なら `targetAge: "unknown"`）。
- **`lookup_hts` で HTS コードを照合するときは、商品の説明を `description` で渡します**（旧 `verify_hts_code` の `productDescription`）。REST の `/trade/hts-verify` は `productDescription` のままです。
- **使い方に合わない引数は、入力の誤りになります。** まとめたツールで、選んだ使い方に無い引数を既定と違う値で渡すと（例: `scrape` の `urls` と `fullPage: false`、`search_media` の `type: "news"` と `page: 2`）、`isError` の「入力の誤り: …」に正しい使い方を添えて返します。旧ツールでは、宣言の無い引数は黙って捨てていました。既定と同じ値（LLM がスキーマの既定値をそのまま入れた場合）は通ります。
- **X の個別投稿の取得が、モジュール `web` に移りました。** 旧 `fetch_x_post`（モジュール `yahoo`）は、`fetch_social_post`（`web`）の X の URL・`statusId` になりました。`SORA_MODULES` で `web` を外すと使えず、`yahoo` を外しても使えます。

## 先に気づく変更（運用者）

- **環境変数の名前を整理しました。旧名は別名として読みません。** 旧名 40 個のうち、25 個は名前を変え、8 個は 4 つの名前にまとめ、7 個は廃止しました。よく設定される 2 つは、`ENABLED_MODULES` が `SORA_MODULES`、`SORA_DEFER_TOOLS` が `SORA_MCP_DEFER_TOOLS` です。新しい名前が無く旧名だけがあるとき、10 個（認証キーの `WEB_FETCHER_API_KEY`・`API_KEY`、`ENABLED_MODULES`・`SORA_DEFER_TOOLS` など、無視すると認証が外れる・絞った設定が開く・外への通信やツールの一覧が変わるもの）は起動を拒否し、残りの 30 個は警告して起動を続けます（その設定は効いていません）。対応は「環境変数の整理」の表のとおりです。
  - 切り替えは 1 回で、旧名を新しい名前に書き換えてください。旧名と新しい名前を併記しないでください（v5 は旧名を読まず、消すよう警告し続けます）。
  - v4 に戻すときは、環境変数の設定も、v4 のときのものに丸ごと戻してください。v4 は新しい名前を読まないので、新しい名前のままでは、絞ったモジュールが開き、名前で挙げた `lyrics` などが無効になるなど、動いても設定が違う状態になります。
- **公開イメージの DB の既定の場所が、`/app/data/sora.db` から `/data/sora.db` になりました**（イメージが `SORA_DB_PATH=/data/sora.db` を設定します。住所データと HTS の索引も、その隣の `/data/address`・`/data/hts` です）。`/app/data` に volume を付けていた場合、DB（キャッシュ・サイトごとの Cookie / localStorage・監視対象・API の使用量）は空で始まります。volume を `/data` に付けるか、`SORA_DB_PATH=/app/data/sora.db` で前の場所を指してください。`SORA_DB_PATH` を設定していた場合は影響しません。
  - `/data` は、コンテナの実行ユーザー（イメージは root）が書ける必要があります。書けないと、キャッシュは保存されず（失敗のたびに警告をログに出します。DB を開けないときは `GET /health?detailed=true` が `degraded` です）、監視対象の作成は失敗します。
  - volume を付けずに起動すると、匿名の volume ができます（イメージの `VOLUME ["/data"]`）。
- **起動時に環境変数を検査し、誤りがあれば起動しません。** 不正な値（例: `PORT=abc`・`SORA_BROWSER_IDLE_TTL_MS=5m`・`SORA_MODULES=web,weeb`）、拒否する旧名だけの設定、判例の索引の URL と SHA-256 の片方だけは、全部を標準エラーに出してから、終了コード 1 で止まります。知らない `SORA_*` の名前・効かない旧名・廃止した名前などは、警告して続けます。値の読み方も厳しくなりました（「環境変数の整理」）。

## ツールの統合

- **初期公開の 13 ツールだけで、今まで遅延読み込みだった 3 つの機能も使えます。** `scrape` の `urls`（旧 `scrape_batch`）、`fetch_social_post` の X の投稿（旧 `fetch_x_post`）、`search_laws` の `lawId` による条文の全文（旧 `get_law_text`）です。`search_tools` で有効にする手間が要りません。
- **Web: `scrape` は 1 ページなら `url`、複数（最大 20 件）なら `urls` です**（旧 `scrape_batch`）。`concurrency`・`webhookUrl` は `urls` のとき、`fullPage`・`keepDataImages` は `url` のときだけです。`crawl_site` は `listOnly: true` で URL の一覧だけを返します（旧 `map_site`。`limit`・`since`・`until`）。`fetch_social_post` は X の投稿の `url` か `statusId` も読みます（`commentLimit` は X 以外のときだけ）。
- **Yahoo!: `search_media` は `type`（`image`・`video`・`news`）で選びます**（旧 `search_image`・`search_video`・`search_news`）。`page` は image・video のとき（news は `page: 1` だけ通る）、`transcripts`・`transcriptChars`・`updated`・`platform` は video のときだけです。`search_keywords` は `query` があればサジェスト（旧 `suggest_keywords`）、無ければ急上昇トレンド（旧 `search_trend`）です。`limit` の上限はサジェストが 20、トレンドが 50 で、サジェストで 20 を超えると入力の誤りです（旧 `suggest_keywords` はスキーマの検査の誤りでした）。
- **住所: `lookup_address` は、渡した引数で引き方を選びます**（旧 `normalize_address`・`reverse_geocode`・`search_postal_code`）。`address` があれば正規化、`address` なしで `lat` と `lon` なら逆引き、`zipcode` だけなら郵便番号の住所の候補です。
  - 住所から郵便番号（旧 `search_postal_code` の `address`）は、正規化の応答の `postalCodes` です。入力の写しの欄は `address` でなく `input` です。
  - この経路で郵便番号のデータの取得に失敗したときは、`postalCodes: []` と `incomplete`・`pending` で返します（旧 `search_postal_code` は `Postal code error`）。番地を国土交通省のデータで補ったときは、`dataset` に `mlit:…` も入ります（旧 `search_postal_code` には入らなかった）。
  - `lat` か `lon` の片方だけは、住所と一緒でも、サービスを呼ぶ前に入力の誤りです（旧 `normalize_address` は `Address normalize error`）。
- **地点: `get_place_info` は、`include` で返す情報を選びます**（旧 `get_elevation`。今は `elevation` だけで、既定）。`address` と `lat`・`lon` を同時に渡すと入力の誤りです（旧 `get_elevation` は黙って住所を使っていました）。
- **防災: `get_disaster_info` は、`include` で警報（`warnings`）と地震（`earthquake`）を選びます**（旧 `search_disaster_warnings`・`search_earthquake`）。既定は、`city` か `areaCode` があれば `["warnings"]`、無ければ `["earthquake"]` です。両方は `["warnings", "earthquake"]` で、2 つは順に取るので、所要時間は 2 つの合計になります。説明から P2P地震情報への切り替えの記述を外しました（検索語には残し、各件の `source` で分かります）。
- **法令: `search_laws` は `keyword` で検索、`lawId` で条文の全文です**（旧 `get_law_text`）。`keyword` はスキーマで必須でなくなり、`keyword` と `lawId` のどちらか 1 つを渡します。どちらも無いときは、スキーマの検査の誤りでなく入力の誤りです。
- **音楽: `search_music` は、曲名なら `attribute: "songTerm"`、アーティストの曲・アルバムなら `attribute: "artistTerm"` と `entity` で引きます**（旧 `search_song`・`search_artist`）。旧 `search_song` の失敗の文の題が `Artist search error` になっていた誤りは、`Music search error` に直りました。
- **監視: `watch` は `action`（`register`・`check`・`list`・`delete`）で選びます**（旧 `watch_register`・`watch_check`・`watch_list`・`watch_delete`）。応答とエラーの文は旧ツールと同じです。
- **貿易: `lookup_hts` は、`htsCode` があれば照合（`description` が必須）、省けば推測（`productName` が必須）です**（旧 `verify_hts_code`・`predict_hts_code`）。`check_regulations` は `agencies`（`cpsc`・`fda`、既定は両方）で判定する機関を選びます（旧 `check_cpsc_certificate`・`check_fda_regulated`）。
- **国・地域: `get_country_context` は `part` で、保存したレポート（`report`、既定）・根拠（`evidence`）・差分（`updates`）を選びます**（旧 `get_country_context_evidence`・`get_country_context_updates`）。
  - SDK が和集合の `outputSchema` を受けないので、`get_country_context` の `outputSchema` は `{ contextId, … }` だけの緩いものになりました（`SORA_MCP_OUTPUT_SCHEMA=true` のときだけ見えます）。`structuredContent` の中身は同じです。
  - 保存した中身が part ごとの形に合わないときは、プロトコルの `Output validation error` でなく、`isError` の `Country intelligence error: invalid <part> payload: …` を返します。
- **YouTube: `get_youtube` は `url` の形で選びます**（旧 `get_youtube_transcript`・`get_youtube_channel`）。動画（watch・youtu.be・shorts・live・embed の URL か 11 文字の動画 ID）なら字幕と説明文、チャンネル（URL・`@ハンドル`・`UC…` の ID）なら最新の動画です。どちらでもない `url` は、`YouTube error` でなく、受ける形を挙げた入力の誤りです。

## 入力の扱い（MCP）

- **使わない任意の文字列の引数に `""` を入れても、指定なしとして扱います。** LLM は、使わない引数に空の文字列を入れることがあります。対象は `scrape` の `url`・`webhookUrl`（`urls: []` も）、`watch` の `url`・`webhookUrl`、`browser_action` の `url`、`search_laws` の `keyword`・`lawId`、`check_product_compliance` の `url`、`search_poi` の `query`・`center`・`bbox` です。今までは、多くがスキーマの検査（`Invalid URL`・`Too small`）で断っていました。
- **`include: []`・`agencies: []` は、省いたのと同じ既定になります**（`get_disaster_info`・`get_place_info` の `include`、`check_regulations` の `agencies`）。使えない値は、`include に使えない値があります: ""` のように引用して示します。
- **URL として読めない `url`・`webhookUrl` の誤りの文を変えました。** `scrape`・`watch`・`browser_action`・`check_product_compliance` で、zod の `Invalid URL` でなく「入力の誤り: url は URL として読めません（いま: "example.com/a"）。…」です。
- **`search_poi` で検索語も場所も無い呼び出しは、検索せずに入力の誤りです**（「入力の誤り: query・center・bbox・lat と lon のどれかを指定してください。」）。今までは、サービスの検査の誤りの JSON（`POI search error: [ … ]`）でした。

## 環境変数の整理

環境変数の名前を `SORA_<領域>_<名前>`（`SORA_AUTH_`・`SORA_BROWSER_`・`SORA_FETCH_`・`SORA_TRACKING_` など）にそろえ、値の読み方を 1 つにして、誤った設定を起動時に止めるようにしました。全機能にまたがる 7 つ（`SORA_API_KEY`・`SORA_ALLOW_ANONYMOUS`・`SORA_MODULES`・`SORA_DB_PATH`・`SORA_PUBLIC_URL`・`SORA_ALLOWED_HOSTS`・`SORA_ALLOWED_ORIGINS`）には領域を付けません。標準の名前（`PORT`・`NODE_ENV`・`HTTP_PROXY`・`HTTPS_PROXY`・`ALL_PROXY`・`NO_PROXY`・`CHROME_PATH` など）は変えていません。README §4.3 の表は、コードの登録簿から作るようになり、Sora の設定がすべて載ります（v4.2.0 の表には、載っていない設定がありました）。

- **旧名と新しい名前。** 「旧名だけのとき」は、新しい名前が無く、旧名だけが設定されているときの扱いです。**拒否** は起動しません。警告は起動を続けますが、その設定は効いていません。廃止は、設定しても何も変わりません（警告して続けます）。新しい名前もあるときは、新しい名前を使い、旧名を消すよう警告します。

| 旧名 | 新名 | 旧名だけのとき | 備考 |
|---|---|---|---|
| `ENABLED_MODULES` | `SORA_MODULES` | **拒否** | 旧名を無視すると、絞ったモジュールが開き、名前で挙げた `lyrics` などが消えます。知らないモジュール名は起動時のエラーです（以前は黙って無視） |
| `SORA_DEFER_TOOLS` | `SORA_MCP_DEFER_TOOLS` | **拒否** | 旧名を無視すると、ツールの一覧が変わります。`0`・`off`・`no` でも無効になります（以前は `false` だけ） |
| `WEB_FETCHER_API_KEY` | `SORA_API_KEY` | **拒否** | 旧名を無視すると認証が外れます。stdio は検査しません |
| `API_KEY` | `SORA_API_KEY` | **拒否** | 同上。ほかのプログラムのための値なら、Sora の環境からは外してください |
| `ALLOW_LOCAL_NO_AUTH` | `SORA_AUTH_LOOPBACK_NO_KEY` | 警告 | 旧名を無視すると閉じる側（`401`）です |
| `TRUST_PROXY` | `SORA_AUTH_TRUST_PROXY` | 警告 | 旧名を無視すると閉じる側です |
| `DAILY_REQUEST_LIMIT` | `SORA_AUTH_DAILY_LIMIT` | **拒否** | 旧名を無視すると上限が外れます。stdio は検査しません |
| `LOG_FORMAT` | `SORA_LOG_FORMAT` | 警告 |  |
| `ADMIN_ALERT_WEBHOOK_URL` | `SORA_ALERT_WEBHOOK_URL` | 警告 | 末尾の `/` を保ちます |
| `SORA_TOOL_OUTPUT_SCHEMA` | `SORA_MCP_OUTPUT_SCHEMA` | 警告 |  |
| `MAX_CONCURRENT_BROWSERS` | `SORA_BROWSER_MAX_CONCURRENCY` | 警告 |  |
| `BROWSER_IDLE_TTL_MS` | `SORA_BROWSER_IDLE_TTL_MS` | 警告 | 不正な値は既定の `300000` に読みます（以前は `0` などに読まれた） |
| `ALLOW_BROWSER_EVALUATE` | `SORA_BROWSER_ALLOW_EVALUATE` | 警告 | 旧名を無視すると閉じる側（`evaluate` は遮断）です |
| `ALLOW_LOCAL_FETCH` | `SORA_FETCH_ALLOW_PRIVATE_NETWORK` | 警告 | テスト用途のみ |
| `SORA_DEFAULT_REFERER` | `SORA_FETCH_DEFAULT_REFERER` | **拒否** | 旧名を無視すると、止めた `Referer` が戻ります。`0`・`no`・`false` でも無効になります |
| `RS_TRAFILATURA_PATH` | `SORA_RS_TRAFILATURA_PATH` | 警告 | 公開イメージの `ENV` も新しい名前です |
| `SORA_SCRAPE_DEADLINE_MS` | `SORA_SEARCH_SCRAPE_DEADLINE_MS` | 警告 |  |
| `YAHOO_MCP_PATH` | `SORA_YAHOO_MCP_PATH` | 警告 | 公開イメージの `ENV` も新しい名前です |
| `FXTWITTER_API_BASE` | `SORA_X_DETAIL_BASE_URL` | **拒否** | 旧名を無視すると、自前の FxEmbed でなく公開の FxTwitter に送ります |
| `FXTWITTER_TIMEOUT_MS` | `SORA_X_DETAIL_TIMEOUT_MS` | 警告 |  |
| `SORA_ADDRESS` | `SORA_ADDRESS_MODE` | **拒否** | 旧名を無視すると `lazy` に戻り、`off` にしていても、使われたときに住所データを取得します |
| `CROSS_SOURCE` | `SORA_HTS_CROSS_SOURCE` | 警告 |  |
| `SORA_CROSS_INDEX_URL` | `SORA_HTS_CROSS_INDEX_URL` | **拒否** | 旧名を無視すると、自分の索引でなくリリースの索引を取ります。SHA-256 と組で設定します |
| `SORA_CROSS_INDEX_SHA256` | `SORA_HTS_CROSS_INDEX_SHA256` | **拒否** | 同上 |
| `UPS_CLIENT_ID` | `SORA_TRACKING_UPS_CLIENT_ID` | 警告 | ID と秘密は組で設定します（無ければブラウザで照会） |
| `UPS_CLIENT_SECRET` | `SORA_TRACKING_UPS_CLIENT_SECRET` | 警告 | 同上 |
| `FEDEX_API_KEY` | `SORA_TRACKING_FEDEX_CLIENT_ID` | 警告 | 2 つの旧名を 1 つにしました。ID と秘密は組で読みます（以前は別の組の ID と秘密が混ざりえた） |
| `FEDEX_CLIENT_ID` | `SORA_TRACKING_FEDEX_CLIENT_ID` | 警告 | 同上 |
| `FEDEX_API_SECRET` | `SORA_TRACKING_FEDEX_CLIENT_SECRET` | 警告 | 同上 |
| `FEDEX_CLIENT_SECRET` | `SORA_TRACKING_FEDEX_CLIENT_SECRET` | 警告 | 同上 |
| `DHL_EXPRESS_API_KEY` | `SORA_TRACKING_DHL_API_KEY` | 警告 | 2 つの旧名を 1 つにしました |
| `DHL_API_KEY` | `SORA_TRACKING_DHL_API_KEY` | 警告 | 同上 |
| `SORA_BLUESKY_DIDS` | `SORA_INTEL_BLUESKY_DIDS` | 警告 |  |
| `SORA_YAHOO_THROTTLE` | （廃止） | 廃止（警告） | Yahoo の負荷の制御は常に有効です |
| `SORA_WEB_RETRY_WAIT_MS` | （廃止） | 廃止（警告） | 負荷の制御の初期の間隔は 400 ミリ秒に固定しました（下の「Yahoo の Web 検索の負荷の制御」） |
| `SORA_WEB_NATIVE_RANKING` | （廃止） | 廃止（警告） | 検索元の順位のまま返します（BM25 の全体の並べ替えは消しました） |
| `SORA_RRF_ENABLED` | （廃止） | 廃止（警告） | 2 つの検索の結果は常に加重 RRF でまとめます |
| `SORA_WEB_QUERY_UNION` | （廃止） | 廃止（警告） | 試験的な機能（既定は無効）をコードごと消しました |
| `SORA_X_SOURCE_ISOLATION` | （廃止） | 廃止（警告） | 試験的な機能（既定は無効）をコードごと消しました |
| `SORA_REALTIME_ANCHOR` | （廃止） | 廃止（警告） | X 検索の固有名詞の判定は常に有効です |

- **起動時の検査。**
  - 出力は標準エラーで、行の先頭は `[Sora/Config] エラー:`・`[Sora/Config] 警告:` です。stdio でも、標準出力（MCP の通信）には何も出しません。
  - エラーは、全部を出したあと、件数の行（`環境変数の誤りが N 件あるので、起動しません`）を出して、終了コード 1 で止まります。不正な値は、変数の名前と正しい形を示します（例: `SORA_BROWSER_IDLE_TTL_MS の値（"5m"）は不正です。正しい形: 0 以上の整数`）。
  - 警告（知らない `SORA_*` の名前、効かない旧名・廃止した名前、運送会社の ID と秘密の片方だけ、空白だけの `SORA_API_KEY`、同梱の実行ファイルのパスにファイルが無い）は、出して起動を続けます。
  - 秘密の値（API キー・Webhook の URL・プロキシの URL・運送会社の鍵など）は表示せず、「設定済み、長さ N」とだけ出します。秘密でない URL も、資格情報・問い合わせ・断片を伏せて出します。
  - `SORA_API_KEY` も `SORA_ALLOW_ANONYMOUS` も無いのは、エラーにしません。今までどおり Fail-Open で、認証なしで起動し、最初の要求でキー無しの警告を 1 回出します。
  - stdio は待ち受けも認証もしないので、`PORT` と、認証キー・1 日の上限の旧名（`WEB_FETCHER_API_KEY`・`API_KEY`・`DAILY_REQUEST_LIMIT`）を検査しません（ほかのプログラムの設定かもしれない汎用の名前のため）。ほかの検査は stdio でも効きます。HTTP で起動するときは、旧名の鍵だけなら拒否します。
- **値の読み方が変わるもの。** 読むときは、不正な値を既定に戻し（カンマ区切りの列は正しい要素だけを残し）、起動時の検査がエラーにします。
  - 真偽値は `true`・`false`・`1`・`0`・`on`・`off`・`yes`・`no`（大文字小文字は問わない）です。以前は変数ごとに読み方が違い、`1`・`yes` を真としない変数がありました。たとえば `SORA_ALLOW_ANONYMOUS=TRUE` は真です。`SORA_MCP_DEFER_TOOLS` は `0`・`off`・`no` でも無効、`SORA_FETCH_DEFAULT_REFERER` は `off` のほか `0`・`no`・`false` でも無効、`SORA_X_DETAIL_PROVIDER` は小文字の `off` のほか、`OFF`・前後に空白のある `off`・`false`・`0`・`no` でも無効、`SORA_INTEL_SCRAPE`・`SORA_INTEL_WEB_SEARCH` も `off` のほか `OFF`・`false`・`0`・`no` で止まります。
  - 選択肢の設定（`SORA_HTS_CROSS_SOURCE`・`SORA_ADDRESS_MODE`・`SORA_LOG_FORMAT` など）は、大文字小文字と前後の空白を問いません（以前、`SORA_HTS_CROSS_SOURCE` は小文字の `api` だけを読みました）。パスの設定（`SORA_DB_PATH`・`SORA_HTS_DIR`・`CHROME_PATH` など）は前後の空白を除き、空白だけは未設定です。
  - 整数は、前後の空白を除いた数字だけ（と変数ごとの範囲）です。以前は数に読まれた次の値は、起動時はエラーで、読むときは既定に戻ります: `SORA_X_DETAIL_TIMEOUT_MS` の `-5`・`1e3`・`+5`・`100abc`、`SORA_YAHOO_MIN_INTERVAL_MS`・`SORA_YAHOO_BREAKER_COOLDOWN_MS` の `1e3`・`0x10`・`+5`・`100abc`、`SORA_SEARCH_SCRAPE_DEADLINE_MS` の `1e3`・`+5`・桁の大きい値、`SORA_ADDRESS_MAX_MB`・`SORA_ADDRESS_WAIT_MS`・`SORA_ADDRESS_BUILD_CONCURRENCY` の `5e3`・`5000.0`・`0x1388`。`SORA_BROWSER_IDLE_TTL_MS` の不正な値は、以前は `0`（閉じない）や `1000` などに読まれましたが、起動時はエラーで、読むときは既定の `300000` です。`SORA_AUTH_DAILY_LIMIT` の `2abc`・`1e1` なども、起動時はエラーで、読むときは無制限です（以前は `parseInt` で上限が掛かりました）。`PORT=abc` は、以前は Bun が任意のポートで待ち受けましたが、起動時のエラーになりました。
  - `SORA_MODULES` の `*`・`all` は、値のどこにあっても全部の意味です（例: `web,all`）。知らないモジュール名は起動時のエラーです（以前は黙って無視し、綴りを誤るとツールが消えました）。
  - `SORA_ADDRESS_PRELOAD` の `all` も、列のどこにあっても全国の意味です。以前は値の全体が `all` のときだけで、`13,all` は東京都だけでした。いまは `13,all` で全国を取りに行き、起動時の警告も出ません。全国の事前取得は数 GB のデータになるので、`SORA_ADDRESS_MAX_MB` も増やしてください（`docs/operations/address-data.md` の §4）。範囲外の都道府県コード（`0`・`48`・`99` など）は、起動時はエラーで、読むときは除きます（以前は残しても該当が無く、何もしませんでした）。
  - `SORA_INTEL_BLUESKY_DIDS` に正しい DID が 1 つも無いときは、起動時はエラーで、読むときは全員に開かず、誰の投稿も残しません（読むときの結果は以前と同じ）。
  - `SORA_PROXY_URL` は scheme（`http`・`https`・`socks5`）が必須になりました（`host:3128` のような値は、起動時はエラーで、読むときは標準の `HTTPS_PROXY` などに譲ります）。`SORA_PROXY_LIST` も、その形の要素だけから選びます（以前は要素を検査しませんでした）。標準の `HTTPS_PROXY` などは、標準の名前なので検査しません。
  - `SORA_X_DETAIL_BASE_URL`・`SORA_OPENPOI_BASE_URL` は、前後の空白と末尾の `/` をすべて除き、URL でない値は既定の宛先に戻ります（以前は値をそのまま使い、取得が失敗しました）。`SORA_ALERT_WEBHOOK_URL` は、そのまま呼ぶ宛先なので、末尾の `/` を保ちます。
- **秘密の環境変数は、Chromium・`yahoo-search-mcp`・`rs-trafilatura`・住所データを作る子プロセスに受け継がれなくなりました。** 対象は、登録簿で秘密としている設定（`SORA_API_KEY`・`SORA_ALERT_WEBHOOK_URL`・`SORA_PROXY_URL`・`SORA_PROXY_LIST`・`SORA_TRACKING_*` の鍵・`SORA_TRACKING_PAGE_SECRET`・`SORA_GCC_*`）と、その旧名です。ほかの変数（`PATH`・`HOME`・`SSL_CERT_FILE`・標準のプロキシの変数など）と、登録簿に無い、ほかのプログラムの秘密は、そのまま渡ります。同じユーザーで動くプロセスは親の `/proc/<pid>/environ` を読めるので、子プロセスから秘密を隔てる仕組みではありません（Chromium は `--no-sandbox` で動きます）。
- **Yahoo の Web 検索の負荷の制御で、初期の間隔が 0 から 400 ミリ秒になりました**（以前は、未設定の変数が `Number('')` で `0` に読まれていた不具合）。
  - 2 つ目以降の候補の検索の前の待ちは `min(間隔, 250)` ミリ秒です。起動直後は、成功が 3 回続くまで 250 ミリ秒、4 回目のあとは 200 ミリ秒、5 回目のあとから 150 ミリ秒です（以前は、最初の成功のあとから 150 ミリ秒）。429 以外の失敗のあとも同じ待ちを通ります（起動直後は最大 250 + 250 ミリ秒。以前は 0）。
  - 429 では、間隔が 400 → 800（medium）→ 1600（high）と広がります（以前は 0 のまま）。high の間は、追加検索（adaptive rescue）をしません。
- **廃止した旗と実験。** 戻すための旗 5 個は、設定しても効かず（起動時に警告します）、動きを既定のものに固定しました（検索元の順位のまま返す・2 つの検索の結果は加重 RRF でまとめる・X 検索の固有名詞の判定・Yahoo の負荷の制御と、その初期の間隔の 400 ミリ秒）。既定で無効だった実験 2 個（複数クエリの統合・X の URL ごとの取得）は、コードごと消しました（比べる道具 `scripts/eval-live-ab.ts` も）。診断の `sourceIsolation` の欄も消えました（既定では出ていませんでした）。
- **キャッシュのキーが変わりました。** Web 検索・X 検索・`search_deep` のキャッシュのキーから、旗の値の欄を外しました。更新後の最初の検索はキャッシュに当たりません。古い行は読まれずに消えるので、手で消す必要はありません。
- **組で設定する変数。** `SORA_HTS_CROSS_INDEX_URL` だけ、`SORA_HTS_CROSS_INDEX_SHA256` だけは、起動を拒否します（以前は、URL だけなら初めて使うときのエラー、SHA-256 だけなら黙って無視でした）。`SORA_HTS_CROSS_INDEX_URL` は `https://` か `file://` の URL だけで、`http://…` などは起動時のエラーです（以前はそのまま取得していました）。読むときは、リリースの索引に黙って戻さず、初めて使うときに判例の照会が失敗します（推測は判例なしで答えます）。運送会社（UPS・FedEx）の ID だけ・秘密だけは警告します（API を使わず、ブラウザで照会します）。FedEx の ID と秘密は組で読みます（以前は 2 組の名前が `||` で読まれ、別の組の ID と秘密が混ざりえました）。
- **同梱の実行ファイルのパス。** `SORA_YAHOO_MCP_PATH` のファイルが無いときは、警告して既定の場所（`/usr/local/bin`・リポジトリの `bin`・`PATH`）を探します（以前は、そのパスを使って Yahoo の検索が失敗しました）。`SORA_RS_TRAFILATURA_PATH` のファイルが無いときは、警告して Readability で本文を取り出します。
- **公開イメージの環境変数。** イメージの `ENV` は `SORA_YAHOO_MCP_PATH`・`SORA_RS_TRAFILATURA_PATH` になり、`SORA_DB_PATH=/data/sora.db` を足しました（「先に気づく変更（運用者）」）。これらを上書きしていた派生のイメージは、新しい名前にしてください。
- **文の変更。** 認証の `401` の文の `Bearer <API_KEY>` を `Bearer <key>` にしました（変数の名前と紛れるため）。Webhook の送信に失敗したときのログは、例外の種類（`code` か `name`。例: `UnexpectedRedirect`・`TimeoutError`）だけにしました。プライベートなネットワークの宛先として止めたときの警告にも、URL を出しません（Webhook の URL に秘密が入るため）。REST の文に入っている変数名も新しい名前です: 住所機能を止めたときの 404 `ADDRESS_DISABLED` の `error` は `住所機能は SORA_ADDRESS_MODE=off で無効化されています`（以前は `SORA_ADDRESS=off`）、`/lyrics`・`/music/recognize`・`/trade/hts/releases` の 404 `MODULE_DISABLED` は `Add it to SORA_MODULES by name (e.g. SORA_MODULES=all,lyrics)` の形（以前は `ENABLED_MODULES`）です。文で判定している呼び出し側は直してください。
- **README の `SORA_ALLOW_ANONYMOUS` の説明を、動きに合わせて直しました**（動きは変えていません）。キーを設定していて `SORA_ALLOW_ANONYMOUS=true` のときは、キー無しの要求も、誤ったキーの要求も、匿名として通ります。`401` で断るのは `false` のときだけです。
- **内部の export。** ライブラリとして import していた場合だけ関係します。`resolveMaxMcpSessions`・`DEFAULT_MAX_MCP_SESSIONS` を消し、定数 `YAHOO_MCP_PATH` を `YAHOO_MCP_EXECUTABLE_PATH` にしました。

## REST の応答の文（欄は変えていない）

旧いツール名を書いていた案内の文を、新しいツール名にしました。欄と形は同じです。

- HTS・CPSC の判定の案内の文 3 か所（衣料の生地の質問の案内 2 か所と、HTS コードが見つからないときの質問）が、`check_regulations`・`lookup_hts の htsCode を省く` を挙げます（`/trade/cpsc-check`・`/trade/hts-verify`・`/trade/compliance` など）。
- `POST /intelligence/country` の `limitations` の `response_sampled` の文が、詳細の取り方を `get_country_context (part: evidence)` と書きます。
- `POST /search/video` で検索語が URL のときの `message` が、`YouTube なら get_youtube` と書きます。
- YouTube のページを `scrape` で読んだときの注記（`/scrape`・`/scrape/batch`・`search_deep` など）が、続きの読み方を `get_youtube` と書きます。注記が 11 字短くなった分、長い字幕に使える字数が 11 字増えます。
- OpenAPI の YouTube の抜粋（`reason`・`text`）の説明の文、`SongRecognitionResult.itunes` と `WatchTargetRecord.interval_seconds` の説明の文（MCP のツール名の言及を新しい名前にした）。

## 型付きクライアント（`client/`）

- **配る経路の `GET /client` は廃止しました。** 生成物は、リポジトリの `client/` にだけあります（`bun run gen:client` で作り直す）。
- **ファイルの名前は、まとめたツールの名前になりました**（例: `servers/sora/scrape_batch.ts` は `servers/sora/scrape.ts` の中に入りました）。`servers/sora/index.js` から読む import は、今までどおり動きます。
- **関数名は変えていません**（52 個）。まとめたツールの各ルートは、旧いツールの名前の関数のままです（例: `scrape` の `/scrape/batch` は `scrapeBatch`）。
- **各関数の説明（JSDoc）は、その関数が呼ぶ REST のルートの OpenAPI の `summary`（あれば `description`）から作ります。** 今までは MCP のツールの説明を写していたので、まとめたツールでは REST の応答に無い `mode` などを書いていました。`catalog.json` の `description` は、`searchTools` で探せるように、ツールの説明のままです（1 ルート 1 行）。

## v4.2.0 以降に main に入った、そのほかの変更

- **HTS の版の保存（モジュール `hts-archive`、#68）。** 米国 USITC の HTS の全件の JSON を、版ごとに保存します。`SORA_MODULES=all,hts-archive` のように名前を挙げたときだけ動き（`all` には入らない）、挙げなければ起動時の処理・タイマー・取得はありません。MCP のツールは無く、REST だけです。
  - 起動から 1 分後に 1 回、そのあと 24 時間ごとに `exportList` を取り、`records` の中身（キーを並べ替えた JSON の SHA-256）が最後に保存した版と違うときだけ、`releaseList` で `current` の版の名前を付けて保存します。同じ名前のまま中身が変わったときは、取得の時刻を付けた別の版にします。
  - 保存先は `SORA_HTS_DIR` の `releases/` です（版ごとの gzip と `index.json`）。`GET /trade/hts/releases` で一覧、`GET /trade/hts/releases/:id` で 1 つの版を返します。無効のときは 404 `MODULE_DISABLED` です。
- **住所の座標化で、番地まである住所は国土地理院を先に引きます**（`get_place_info`・`search_poi` の中心地名、#69）。該当が無いときや国土地理院が使えないときは Nominatim に進みます。地名・駅名・施設名は今までどおり Nominatim が先で、国土地理院は Nominatim が「該当なし」のときだけです（Nominatim が HTTP エラーのときは、国土地理院に落とさずエラーです）。Nominatim の間隔（1 秒に 1 回）は Nominatim への問い合わせにだけかけます。
- **地震は、気象庁の公式データ（`bosai/quake/data`）を主にし、取れないときだけ P2P地震情報から返します**（`get_disaster_info` の `earthquake`・`/disaster/earthquake`、#69）。同じ地震の報は 1 件にまとめ、国外の遠地地震は含めません。`minIntensity` の絞り込みは一覧の全件（直近約 1 か月・約 160 件）が対象です。各件の `source`（`jma` / `p2pquake`）で取得元が分かり、両方失敗したら両方の理由を書いたエラーです。応答の形は同じです。
- **ブラウザの TLS とヘッダを、静的取得（wreq-js の `chrome_149`）にそろえました（#73）。** 新しい版の Chromium が足す TLS の拡張（51764）・署名アルゴリズムの GREASE・Accept の `image/jxl` を `--disable-features` で止め、`sec-ch-ua` のブランドの一覧を Chromium の規則で作ります。Chrome を名乗る UA のまま 403 になっていた Cloudflare 系のサイトのうち、通るようになったものがあります（同梱の Chromium 156 で 25 サイト × 3 周を前後で取ると 66/75 → 71/75。Indeed は 0/3 → 3/3、悪化したサイトは無し。G2 は前後とも 0/3 で通らない）。件数が小さく、サイト側の揺れも含むので、数字は目安です。
- **コンテナのイメージを 1.51GB から 750MB にしました**（圧縮して 623MB → 345MB、#74）。最終のイメージに、Chromium が読む共有ライブラリと本番の依存だけを入れます。
- **`SORA_BROWSER_LOW_MEMORY` で、Chromium を低メモリ端末のモード（`--enable-low-end-device-mode`）で起動できます**（既定は無効、#75）。`true`・`1`・`on`・`yes` で有効です。描画中のピークが、ページを 1 つずつ開いたとき約 18%、3 ページ同時で約 14% 下がります。待機中の常駐は変わらず、`navigator.deviceMemory` が 8 から 2 になります。
- **REST の操作の一覧と定義を返す `GET /tools`・`GET /tools/<name>` を足しました（#76）。** `GET /tools` は `{ count, tools: [{ name, method, path, category, summary }] }`（既定のモジュールで 52 件）で、`q`・`category` で絞れます。`GET /tools/<name>` は入力のスキーマ・path と query の引数・文書にあるエラー・別名や GET の形（`alternatives`）を返し、`?response=true` で応答のスキーマも付けます。
  - OpenAPI のすべての操作（この PR の時点で 84、`GET /client` を廃止した v5.0.0 では 82）に `operationId`・`tags`・認証の宣言・共通のエラー応答（`default`）を付け、パスの変数の宣言が無かった操作に `parameters` を足しました。
  - エラー応答の形を `{ error, code, status, retryable, details? }` にそろえました（検索の 12 経路・追跡の 3 経路、認証の 401（`UNAUTHORIZED`、`message` は残す）、本文が 10MB を超える 413（`PAYLOAD_TOO_LARGE`））。`error` の文と HTTP ステータスは変えていません。
  - コードを実行できる LLM への案内（`instructions`・`search_tools` の応答の末尾・スキル `sora-client`）を、型付きクライアントから REST の直接呼び出し（`GET /tools` → `GET /tools/<name>` → 呼ぶ）に替えました。このとき `GET /client`・`GET /client/<path>` を `deprecated` にしました（v5.0.0 で廃止。「先に気づく変更（呼び出し側）」）。

- **静的取得が信頼する root から、鍵が漏れた `emSign ECC Root CA - G3` を外しました（#81）。** 2026-10-20 に eMudhra の中間 CA の秘密鍵の漏えいが確認され、Mozilla がこの root を外しましたが、wreq-js 3.2.0 に同梱の root には残っていました（経路上の攻撃者が、どのサーバーにもなりすませる状態でした）。公開イメージは、イメージのビルドで作った一覧（Debian の root 148 件と、Bun の最新の root 118 件を合わせ、信頼を外した root を除いた 158 件）だけを信頼します（`SORA_FETCH_TRUST_STORE=defaultPaths`）。消えるのは `emSign ECC Root CA - G3` だけです（同じ 75 ホストで、前後の接続の結果は同じ）。ブラウザ（Chromium）の root は対象外です。新しい環境変数 `SORA_FETCH_TRUST_STORE`（`combined`・`mozilla`・`defaultPaths`）の未設定は、従来どおり wreq-js の既定です。
- **静的取得の TLS・HTTP の実装（wreq-js の native）を、イメージのビルドでソースからビルドするようにしました（#82・#83）。** npm のビルド済みの native は、wreq-js が新しい版を公開しないかぎり古いまま残ります（3.2.0 は 2026-08-23 が最後）。#82 は、依存を npm 版と同じにしたビルドで、挙動は変わりません（133 プロファイルの ClientHello が同じ）。#83 は、依存を上流の wreq-util（main）に向け、Chrome 150〜154 のプロファイルを使います（固定の rev と `Cargo.lock` は `vendor/wreq-js/`、作り直しは `bun scripts/wreq-native/update.ts`）。Containerfile などを変える PR だけ、イメージを実際にビルドして確認する CI も足しました。
- **公開イメージが名乗る Chrome の版が、149 から 154 になります（#83）。** UA・`sec-ch-ua`・TLS（拡張 51764・署名アルゴリズムの GREASE・ML-DSA）・ヘッダが、静的取得とブラウザの両方で 154 のものです（実際の Chromium は 156 のままです）。ブラウザの `--disable-features` は、名乗る版で決まります（154 では `JXLImageFormat` だけ止めます）。イメージの中で、Chromium 156 と `chrome_154` の ClientHello は全項目で同じで、HTTP/2 の SETTINGS・接続の窓・疑似ヘッダの並びも同じです。保護されたサイト 20 件では、149 と 154 の結果は 18 件が同じでした（`jp.indeed.com` は 4 回中 1 回から 4 回とも通る、件数が少ないので参考です）。**`SORA_FETCH_MAX_CHROME_PROFILE=149` を渡すと、イメージの作り直しなしに、149 のものに戻ります。** 上限の未設定は 149（npm の wreq-js の native が持つ最新）で、公開イメージは Containerfile で 154 にしています。
- **ブラウザと静的取得の ClientHello を比べる道具を足しました（#78）。** `bun scripts/tls-fingerprint/run.ts` が差を表示します（イメージの中でも動きます。手順は `docs/browser-alignment.md`）。あわせて、Chromium の `--version` の読み取りが distroless のイメージで失敗し、プロファイルの上限に落ちていた不具合（実害はありませんでした）を直しました（#77）。
- **運用の確認を足しました。** 週 1 回、リリースのイメージの Chromium・Bun・distroless の土台と CI の Bun を新しい版と比べ、遅れていれば issue で知らせます（#79）。CI の Bun を 1.4.2 から 1.4.4 に上げました（brotli の範囲外書き込みなど、2026-10 の勧告 3 件の修正を含む版、#80）。

# Sora v4.2.0 — HTS の推測の判例を手元の索引から引くようにし、町名がローマ字の住所を読めるようにした

米国税関（CBP）の判例検索の API が、2026 年 11 月からプログラムの要求を断るようになりました。そこで HTS の推測が票に使う分類判例を、公開データから作った手元の索引から引くようにしました。あわせて、HTS の推測と総合判定の誤りを直し、`normalize_address` が町名をローマ字で書いた住所を読めるようにしました。ツールの数と MCP の定義の大きさは v4.1.1 と同じです（`scripts/measure-context.ts` の値は、既定 22,269・全ツール 63,529・`instructions` 8,948）。

## 先に気づく変更（呼び出し側）

- **更新後の最初の HTS の推測で、取得が 2 つ走ります。** HTS の全件データの保存の形を変えたので、保存済みの `hts.sqlite` を作り直します（USITC から約 12MB、約 20 秒）。あわせて、判例の索引（約 6MB）を Sora の GitHub のリリース `cross-index-1` から取得します。どちらも、`predict_hts_code`・`POST /trade/hts-predict`・`/trade/compliance` が初めて呼ばれたときだけです。起動時の取得はありません。判例の索引の用意ができるまでの呼び出しは、判例なしで答えます（`evidence.crossNote` に「判例の索引を準備中」）。
- **`/trade/compliance`（`check_product_compliance`）が、`htsCode` を省いたときに聞き返すことが増えます。** 判例の票が無い HTS の推測は、確度を `low` にしました（判例なしの `medium` は、評価セットで 25 件中 16 件しか当たっていなかった）。確度が `low` のときは、推測のコードで先へ進まず `needs_more_info` で聞き返します。判例を参照できなかったときは、そのことと、`htsCode` を渡せば判定を進めることを質問に添えます。
- **日本語が主の品目説明では、HTS を推測しません。** 日本語の字が英字より多い `productName`・`description` は、REST では 400 `INVALID_INPUT`、MCP では `isError` です（`/trade/compliance` は `needs_more_info` で英訳を求める）。日本語の商品ページの英字は、ブランド名や単位（mAh・USB・cm）の断片で、無関係な品目の候補を返していたためです。

## HTS の推測と総合判定

- **分類判例を、手元の判例の索引から引きます**（既定。環境変数 `CROSS_SOURCE=local`）。索引は 62,574 件です。
  - CBP の判例の原文（米国政府の著作物）から品名と説明を書き直したもの 45,552 件。
  - Apache-2.0 の ATLAS のデータから作ったもの 17,022 件。判例番号が無いので、票だけに使います。
  - Sora は、索引の SHA-256 を確かめてから、SQLite の全文検索の表にします。照会は CBP の検索と同じく AND 条件で、ヒットが 250 件を超える語では打ち切ります。
  - 評価セット 150 件の 1 位の 6 桁の一致は 72.0% で、CBP の API を使っていたとき（2026-10-15）と同じです。保留 47 件では 68.1%、判例なしでは 37.3% です。応答の速さは中央値 68 ms です（CBP の API のときは 328 ms）。
  - 判例を使ったときは、`evidence.attribution`（任意の項目）に出典を出します。判例番号の無い判例は、`evidence.rulings` には出しません。
  - `CROSS_SOURCE=api` にすると CBP の API を引きます（今は 403 で `unavailable`）。自分で作った索引は、`SORA_CROSS_INDEX_URL`（`file://` も可）と `SORA_CROSS_INDEX_SHA256` で使えます。索引の作り方は `docs/engines/hts-prediction.md`、出典は `NOTICE` にあります。
- **CBP の判例検索に断られた理由を、`evidence.crossNote` に残します**（応答の本文の先頭 200 字）。
- **HTS の木の読み方を直しました。** 字下げが飛んだ直後の兄弟の行を子と読み、コードの無い題の行が直後に来る行を葉と読んでいませんでした。2026 年 Revision 22 で、第 98・99 類を除く商品の葉は 19,913 から 19,926 になりました（2826.90.90.10、電力の 2716.00.00.00 など 13 件が全文検索に入る）。2826.90.90.90 などの祖先の説明の誤りも直りました。
- **ライター（HTS 9613）に、当たる規則 16 CFR 1210・1212 を挙げます。** 使い捨て・ノベルティのライターと、多目的ライターの、5 歳未満の子供が点火できない構造の基準です。CPSC の区分ごとの規則の参考は、確かめた 4 区分になりました。
- **CPSC の一覧の区分の品で、大人向け（`targetAge: "adult"`）には素材を聞かなくなりました。** 聞く理由の鉛・フタル酸エステルの規則は、子供向けの品のものです。`generate_gcc_certificate` の下書きの「足りない項目」からも、大人の品の素材が消えます。

## 住所

- **`normalize_address` が、日本語の都道府県・市区町村のあとに町名をローマ字で書いた住所を読みます**（「東京都千代田区Nagatacho, 1-7-1」→「東京都千代田区永田町一丁目7-1」）。今までは市区町村まで（level 2）で止まっていました。
  - 町名は、手元の町字データにある ABR の英字名と比べます。大文字と小文字、ハイフンと空白、長音の書き方の違いはそろえてから比べます。
  - 郵便番号の逆引きと、座標の解決にも同じ動きが入ります。
  - 都道府県・市区町村もローマ字の住所と、英語の語順の住所は対象外です。

## 検索

- **深い検索の並べ直しで、不要語の表と、「出現の少ない語を意図語の代わりにする処理」をやめました。** 問いに意図語（「料金」「作詞者」など）が無いとき、候補のページで最も出現の少ない語を意図語の代わりにして、その語の無いページを下げていました。この処理が、関係の無いページを上げることがありました。手元の評価（開発用 180 問）で、1 位のページに答えがある割合は 0.906 → 0.933 です（語を並べた問い）。意図語の表は残しています。

# Sora v4.1.1 — search_deep の query の説明を元に戻した

v4.1.0 で足した `search_deep` の `query` の説明を外しました。処理と応答は v4.1.0 と同じです。v4.0.0 からの変更は、下の v4.1.0 の節にあります。

- **`search_deep` の `query` の説明を、v4.0.0 までの文に戻しました。** v4.1.0 では「対象の名前に加えて、知りたいことを表す語も入れる」という案内を足していましたが、効果を確かめるまで外します。変わるのは説明だけです。
- MCP の定義は、この説明の分（89 字）だけ小さくなります。`scripts/measure-context.ts` の値は、既定 22,269・全ツール 63,529・`instructions` 8,948 です。

# Sora v4.1.0 — 引数の監査で見つかった食い違いを直し、警報を気象庁の新しいデータ（r8）に移し、米国 CPSC の一般適合証明書（GCC）を作るツールを足した

全ツール・約 260 の引数を、説明と実際の動きが合っているかで調べ、食い違いを直しました。既定の値は変えていません。REST の応答の形は、項目を足したものと、`crawl_site` の各ページから内部の項目を外したもの以外は変えていません。あわせて、米国 CPSC の一般適合証明書（GCC）を作る `generate_gcc_certificate`（MCP の遅延ツール）と `POST /trade/gcc-generate` を足しました（ツールは 52 → 53、遅延ツールは 39）。

## 先に気づく変更（呼び出し側）

- **知らない地名・空港・都道府県で、東京・羽田の答えを返さず、エラーにしました。** `get_weather` の `city`、`search_disaster_warnings` の `city`・`areaCode` は東京に、`get_flight_status` の `airport` は羽田に、`search_road_traffic` の `pref` は東京都に、黙って替えていました。今は見つからない旨のエラー（REST は 400）です。空白だけの `city` も入力の誤りです（今までは天気・警報とも群馬県南部の答えでした。警報で `areaCode` を渡したときは `areaCode` を使う）。省いたときの既定は東京で、警報は東京地方です（v4.0.0 は伊豆諸島・小笠原を含む東京都全体でした。`city: "東京"` と指定したときは東京都全体です）。`get_flight_status` が答えるのは羽田・成田・伊丹・関西・中部の 5 空港だけです（Yahoo の運航情報がこの 5 つだけのため。新千歳・福岡・那覇などは以前も羽田の答えでした）。空港名の一部だけ（「羽」「o」）・「大阪」・2 つの空港を含む入力もエラーです。英語・ローマ字の名前（「Haneda」「Kansai International Airport」）と全角の英数字は解決し、「東京」「tokyo」だけなら羽田です。
- **同じ名前の町村が複数ある地名は、候補を挙げたエラーにしました。** 「森町」「府中」「川崎」「中野」「草津」「千代田」などは、`get_weather` と `search_disaster_warnings` で「北海道森町、静岡県森町」のように挙げて聞き返します。都道府県名か「市」「町」まで付ければ解決します。ほかの予報区の市町村にも当たる気温の地点の名前（「上野」「池田」「湯沢」「大野」）と「日高」も、市町村と予報区を挙げて聞き返します。都道府県名でない天気の地名で、同じ予報区に「市」「区」を足した市区があるもの（「横浜」「神戸」「札幌」など）は、警報ではその市区（横浜市など）、天気ではその予報区です。郡の付いた住所（「北海道上川郡上川町」）は郡の後ろの町村で引きます（今までは別の県の地名に当たることがあった。地名の読み方は「天気・警報・地震・標高」の節）。地名の表 `city_map.ts` は、気象庁の市町村の表と突き合わせて直しました（97 件を外し、8 件を直し、気温の地点と主な島などの 63 件を足した。例: 石垣島・竹富島・西表島は石垣島地方、小樽は後志地方、日光・鬼怒川は栃木県北部）。
- **今まで通っていた不正な入力が、REST では 400、MCP では検証エラーになります。** 対象は `POST /search`（`/search/deep` などの別名も）、`/search/trend`、`/transit/route`、`/weather`（GET も）、`GET /geo/elevation`、`/crawl`・`/crawl/stream`、`/scrape`・`/scrape/stream`・`/scrape/batch`、`POST /map`、`/gov/diet-minutes`、`/search/music` です。主なものは次のとおりです。`/search` の `limit` が 21 以上（今までは 20 に丸めていた）と、`formats`・`updated`・`highlightMaxCount`・`maxChars` の不正な値。`/search/trend` の `limit` が 1〜50 の整数でないもの。`/weather` の `days` が 1〜8 の整数でないもの（文字列の `"3"` も不可）。標高の `lat`・`lon` の範囲外（lat は -90〜90、lon は -180〜180。MCP の `get_elevation` も同じ）。`/transit/route` の `via` が 4 つ以上。`GET /geo/elevation` の数でない `lat`・`lon`（`35.6abc` など。今までは先頭の数だけを読んだ）。`/crawl` の `maxDepth`（0 と 6 以上）・`maxPages`（51 以上）・`concurrency`（11 以上）・`maxChars`・`timeoutMs` の範囲外（`/crawl/stream` は、ストリームを開く前に 400）。`/scrape` 系で `renderJs` と `fastOnly` の同時指定や壊れた `removeSelectors`（今までは 500 や、`/scrape/batch` では 200、`/scrape/stream` ではストリームの中の `SCRAPE_ERROR`。今はストリームを開く前に 400）、`POST /map` の `limit`（1〜1000）・`timeoutMs`（1〜120000）の範囲外と型の誤り（今までは 1000 を超える `limit` は 1000 に丸め、ほかの値は 500 など）、`scrape_batch` の `webhookUrl` が URL でないもの。`search_diet_minutes` で `keyword`・`speaker`・`nameOfMeeting` のどれも無いもの（今までは REST が 500）。`search_music` の `attribute` が 3 つの値以外のもの。`search_road_traffic` の `pref` の数字以外の混じったコード（`"13abc"`。今までは 13）。`/search`・`/search/trend`・`/crawl`・`/scrape` などのスキーマの誤りは「項目名: 理由」の文で返します（`/weather`・`/transit/route`・`/search/music` などは今までの文と `details`）。JSON として読めない本文は、`/search`（別名も）・`/search/web`・`/search/image` などの Yahoo の検索・`/search/realtime` でも 400 `INVALID_JSON` です（今までは 500）。新しく検証するルート（`/search`・`/search/trend`・`/transit/route`・`/weather`・`/crawl`・`/map`）と `/scrape`・`/scrape/stream`・`/scrape/batch` では、トップレベルの `null` を「指定なし」として扱います（必須の項目が `null` なら 400。`/scrape` 系は今まで 400）。
- **CPSC の判定が変わる品があります**（`check_cpsc_certificate`・`check_product_compliance`・`generate_gcc_certificate` が同じ判定を使います）。大人の衣料（HTS の第 61・62 類と、CPSC の一覧の Clothing・Shoes）は、16 CFR 1610.1(d) の試験の免除で決まります。免除に当たれば証明書も、証明書のデータの eFiling も要らず（`certificateRequired: false`）、81 FR 12587（2016 年 3 月 25 日から）の執行裁量で、ACE では Disclaim B を送れます（任意。送るときは Intended Use Code 130.006 が要ります）。今までは、一覧にある衣料のコードは一律に GCC が要るとし、一覧に無い第 61・62 類のコードは `unknown` でした。繊維の組成は `material` に `"100% polyester"` の形で入れ、acrylic・modacrylic・nylon・olefin・polyester・wool だけなら免除です（別の名前は読みません）。平らな生地は `fabricSurface: "plain"` と `fabricWeightOzPerSqYd` が 2.6 以上で免除です。免除に当たらないと決まれば GCC、足りない事実は `clarifyingQuestions` で聞きます。大人の帽子・手袋・履物の見出し（6504〜6506・6116・6216・6401〜6405）は、16 CFR 1610.1(c) の条件に当たるかで決まるので、`unknown` と条件の説明を返します。乳児の衣類の見出し（6111・6209）で `targetAge: "adult"` は、大人の免除を判定せず `unknown` で年齢を聞きます。ボタン・コイン電池は `hasBattery: true` と `batteryType: "button_coin"` で 16 CFR 1263 を当てます（`button_coin` だけでも電池ありとして扱い、`hasBattery: false` と一緒だと REST は 400、MCP はエラーです）。区分の規則の参考を載せるのは、確かめた 3 区分（Clothing・Infant Sleep Products・Toys）だけで、ほかは `個別規格要確認` です（Infant Sleep Products は 16 CFR 1632/1633 でなく 16 CFR 1236・1218・1241 に直しました。大人の玩具には ASTM F963 などが「当たる」と書かず、年齢で確かめる注記を付けます）。同梱の CPSC の一覧には、PDF の行の折り返しで抜けていた 5 件を足しました（591 件）。
- **消した引数があります。** 送っても、エラーにはならず、黙って無視します。型付きのクライアント（`client/`）の型からは消えました。

| 消した引数 | 対象 | 扱い |
|---|---|---|
| `productCategory`・`description` | check_cpsc_certificate | どこからも読まれていなかった。判定は変わらない。リストに無い HTS コードの案内から、カテゴリを聞く質問を外した（`inputCompleteness` は `complete`。「CPSC公式に個別確認」は `nextActions` の 1 か所だけ） |
| `productDescription` | check_fda_regulated | どこからも読まれていなかった |
| `originCountry`・`destinationCountry` | track_package | 自動判別に使われていなかった（絞り込みは `preferredCarriers`） |
| `verbose` | REST `POST /tracking` | 読まれていなかった |
| `intervalSeconds` | watch_register | 自動で巡回する処理は無い。差分は `watch_check` を呼んだときに前回と比べる。応答の `interval_seconds` は保存した値として残る |
| `page` | REST `POST /search/news` | 同梱の検索処理が `page` に対応していなかった |
| 本文の `ownerToken` | REST `POST /browser/action` | REST は `Authorization` ヘッダーで持ち主を確かめる。MCP の `browser_action` の `ownerToken` は残る |

## 天気・警報・地震・標高

- **`search_disaster_warnings` の警報を、気象庁の新しいデータ（`warning/data/r8/`）から読みます。** 気象庁は 2026 年 5 月下旬に新しい防災気象情報に移り、今まで読んでいた `warning/data/warning/` は 5 月の発表のまま止まっていて、数か月前の警報を今の警報として返していました。すべての報の「発表」「継続」だけを、同じ種類は 1 つ（「発表」を「継続」より先）にして合わせ（「解除」「発表警報・注意報はなし」は除く）、`reportTime` は使った報のうち最も新しい発表日時です。応答の形は同じで、レベル 5・特別警報は `specialWarnings`、警報・危険警報（レベル 4）は `warnings`、注意報は `advisories` です。大雨・土砂災害・高潮には段階 `alertLevel`（2〜5）が付き、名前は気象庁のページと同じ（「大雨危険警報」など）です。旧い洪水警報・注意報（コード 04・18）は返りません。**河川の氾濫（氾濫危険情報など）は対象外です**（気象庁のページは別のデータ `flood/data/r8/flood_xml.json` から読んでおり、Sora は読んでいません）。
- **警報の地名を、市町村の単位で解決します。** 今までは都道府県の予報区をすべて合わせて返していました（新宿区に小笠原・伊豆諸島の警報が混ざっていた）。今は、市町村 → 予報区 → エラーの順に解決し、その範囲の警報だけを返します。都道府県名（「静岡県」と、「静岡」「石川」「東京」などの略称）は、今までどおり県全体です。`areaCode` は 7 桁（市町村）・6 桁（予報区または気象台）・2 桁（都道府県）を受けます。都道府県名と 2 桁の番号は、気象台が複数ある北海道・鹿児島・沖縄では、気象台の番号を挙げ、市町村名・地方名でも引けることを書いたエラーです。気象台の名前（「上川・留萌地方」「八重山地方」など）は、その気象台の範囲全体です。応答の `areaCode`・`areaName`・`prefecture` は解決した値になりました（今までは入力のまま、または「東京」）。気象庁が区域に分けている市（横浜・神戸など）は、区域の番号をカンマでつないだ `areaCode`（例 `1410011,1410012`）で返し、その形を渡すこともできます。名前が市で終わる区域も市全体に入ります（「日光市」の警報に「日光市今市」の区域が入る）。気象庁のデータに解決した番号の欄が無いときは、「警報なし」ではなくエラーです。天気・警報のキャッシュには、最初に引いた入力の地名が残らなくなりました。
- **`get_weather` の気温と週間予報を、その予報区のものにしました。** 今までは気象台の最初の地点・地域で、北九州が福岡の気温、長野県中部・南部が北部の週間予報、青森県下北が津軽の週間予報、伊豆諸島・小笠原が東京の週間の気温でした。今日〜明後日の気温は予報区の地点（応答の `temperatureArea`）、3 日目以降は予報区を含む週間予報の地域（「中部・南部」など）の天気と、予報区の地点（週間予報に無い地点は、その地域の地点）の気温です。北海道・鹿児島・沖縄（27 予報区で 404 だった）と、十勝・奄美も引けるようになりました。秋田県内陸の気温は、気象庁の並びのとおり最初の地点の鷹巣です（横手は 2 つ目の地点）。都道府県名は県の代表の予報区で（「山口県」は「山口」と同じ中部。v4.0.0 は西部）、`"北海道"` だけは予報区の番号と名前を挙げたエラーです。気象庁の予報区の名前（「十勝地方」「下北」、いくつもの県にある「東部」などは「神奈川県東部」）と気温の地点の名前（「古川」「津川」など）はその予報区で、気象台の名前（「上川・留萌地方」）は予報区を挙げたエラーです。`POST /weather`・`GET /weather` の 500 には、ほかのルートと同じ `code`（`WEATHER_ERROR`）・`status`・`retryable` が付きます。
- **地名の一部の一致で、別の県に当たらないようにしました**（天気・警報とも）。後ろに町名などが続く入力はいちばん前の地名で引き（「日光市中宮祠」は山口県の光市でなく日光市）、郡の付いた住所は郡の後ろの町村で引きます（先頭の市・区の後ろの郡は町名。「山口市小郡栄町1丁目」は千葉県の栄町でなく山口市）。先頭の都道府県名は、短い形でもその都道府県の中で後ろを引きます。「〜島」で終わる入力は、都道府県名・市区町村・島の名前で始まるときだけ一部の一致を使い（「小浜島」を福井県の小浜市にしない。主な島は地名の表に足した）、「美ヶ原高原」の「高原」は宮崎県の高原町にしません。いちばん前の地名が 1 つに決まらなければ候補を挙げたエラー、見つからなければ市区町村の名前か都道府県名を付けるよう求めるエラーです。入力の中の空白は無視します。旧国名・地方名などを前に付けた名前（「安芸府中」「東北郡山」）と郡の名前だけ（「足柄上郡」）は、今も前の語や郡の名前の一部が別の県の市町村に当たることがあります（都道府県名を付ければ避けられます）。
- **`search_earthquake` の失敗をエラーにしました**（今までは 0 件の結果で、「地震が無い」と区別できなかった。MCP はエラーの応答、REST は 500。キャッシュしません）。`minIntensity` が既定より大きいときは 100 件取ってから震度で絞るので、`limit` が小さくて 0 件になることがなくなりました。

## 検索

- **`search_realtime` の `page` が `limit` 件ずつ進みます。** 今までは 40 件ずつ進んだため、`limit` 20（既定）の 2 ページ目は 41 件目から始まり、21〜40 件目が抜けていました。今は `(page-1) × limit` 件目から取ります（Yahoo が 40 の倍数でない開始位置を受けることを確かめてあります）。`missingTerms` に、括弧と `URL:` の断片（`(ハロウィン`・閉じていない `(` から後ろ（`A (B C` の `(B C`）・`URL:example.com` など）も入らなくなりました（`foo-(bar)` の `-` は除外の記号として読まない）。
- **MCP の `search_image`・`search_video`・`search_chiebukuro` に `page` を足しました**（REST と同じ）。`page` は `limit` によらず Yahoo のページの大きさ（20 件、知恵袋は 10 件）ずつ進むので、漏れなく続けるには `limit` を省いてください。`limit` の説明は「最大 20 件（知恵袋は 10 件）。大きい値を指定しても 20 件（10 件）」になりました（スキーマの上限は 50 のままで、エラーにはしません）。
- **MCP の Yahoo の 6 ツール（image・video・news・chiebukuro・suggest_keywords・realtime）に、REST と同じキー・時間のキャッシュをかけました。** 同じ検索は REST と MCP で答えを共有し、MCP の応答にもキャッシュに当たったときは `cached`・`cachedAt`・`ageSeconds` が付きます（`search_realtime` は当たらないときも `cached: false`。`verbose` では `executedWaves`・`stopReason`・`requiredTerms`・`coveredTerms` も付きます）。同梱の検索処理が返したエラーの文（Yahoo の 503 など）は、30 分でなく 1 分だけ残します。
- **`search_deep` の `query` の説明に、対象の名前に加えて知りたいことを表す語（出身大学・発売日・価格など）も入れるよう足しました。** evidence のハイライトはこの語で本文の根拠を選ぶため、名前だけでは答えの節を落としやすくなります。
- **`search_deep` の `noCache` が、ページ本文の取得にも届くようになりました**（今までは統合検索のキャッシュだけを迂回していた）。X のタイムライン・プロフィールのページの本文（markdown）は、同じ応答の `realtime.items` に同じアカウントの投稿があるときは省きます（同じ投稿が 2 回入っていた。ハイライトは残す。投稿 1 件の URL、`realtime` が無いとき、`formats` に `markdown` を明示したときは今までどおり）。
- **`search_route` の `sortBy` と `seatPreference` が効くようになりました。** `transfer`（乗換回数順）と `fare`（料金順）が逆に Yahoo へ送られていて、座席の指定は送られていませんでした（省いたときは Yahoo の既定の自由席優先）。`POST /transit/route` は `year`・`month`・`day`・`hour`・`minute` を受ける（日時の解決に使われている）ので、スキーマに足して残しました。
- **`get_flight_status` の行き先・出発地が正しくなりました**（到着の一覧に出発地、出発の一覧に到着地の空港が入っていた。`keyword` の絞り込みも当たらなかった）。
- **`search_road_traffic` が、情報が無いときに「順調」と言わなくなりました**（道路名で絞って 0 件、表に無い道路名、都道府県のページから 1 件も読めない、のとき「この道路の情報は見つかりませんでした」）。`pref` と `road` を両方指定したときは、その都道府県のページを道路名で絞ります（今までは `road` が表に当たると `pref` を無視した）。

## 取得（scrape・crawl・map・browser）

- **`maskPii: true` が、本文とハイライトのほかの文字列にも効きます。** 今までは `content` とハイライトだけで、`html`・`rawHtml`・`title`・`description`・`tables`・`extracted`・`jsonLd`・`events`・`author`・`images` の `alt` など・PDF の `metadata`・動画のチャプターの題は元のままでした。`links` と `images` の `url`、`jsonLd`・`events` の中の URL の文字列は、パスの数字を電話番号と取り違えて壊すため、マスクしません（`socialLinks`・`ogImage`・`twitterHandle` も。`extracted` の中の URL はマスクの対象）。マスクで同じになった表の見出しは、`_2` などを付けて列を残します。`screenshot` の画像はマスクしません。
- **`formats` に `screenshot` があれば、`mode` が `auto`（既定）でもブラウザで画像を撮ります**（`scrape`・`scrape_batch`・`crawl_site`・`search_deep` の本文の取得など）。今までは、静的な取得が通ると画像も警告も付きませんでした。静的に取ったあとでブラウザを使うので、その HTML のページは 2 回取りに行きます。静的に取れたページは、本文と HTTP の状態を静的な取得のまま返し、ブラウザからは画像だけを使います（ボット対策でブラウザだけが 403 の画面に飛ばされても、本文を替えない）。`mode: "fast"`（`fastOnly`）や、ブラウザで撮れなかったとき（本文が 50 字未満の SPA のページも、例外にしない）は、静的に取れた結果に、画像を取れなかった旨の `warnings`（新しい項目）を付けて返し、その結果は 1 分だけキャッシュします。PDF・画像・音声・動画のファイルも、本文を残したまま `warnings` を付けます。`search_web`・`search_deep` の結果にも `warnings` が残ります。
- **`headers` が、ブラウザの経路（`mode: "browser"`・SPA への切り替え・REST の `renderJs`）でも届きます**（今までは静的な取得だけ）。最初のページと同じ送り先には全部、別のオリジンへのページ遷移（リダイレクトなど）には認証用のヘッダー（`Authorization`・`Cookie`・`X-Api-Key` など）を除いて付けます。画像やスクリプトなどの別オリジンへの要求には付けません。`User-Agent` はブラウザでは送りません（`navigator.userAgent` と食い違うため。静的な取得では今までどおり送る）。
- **MCP の `scrape`・`scrape_batch` の `verbose` が `highlightDiagnostics` に届きます**（今までは REST だけ）。
- **`crawl_site`・`POST /crawl` の各ページを、`scrape` と同じ形に整えました。** `formats` に `links` が無ければ `links` を付けず、`quality`・`evidence`・`qualityReasons`・`missingFields` などの内部の項目も付きません。`webhookUrl` の通知の payload は、この整えた結果です（`/crawl/stream` は今まで送られていなかった）。`scrape_batch` の通知も、応答と同じ整えた結果です。REST の `/scrape`・`/scrape/stream`・`/scrape/batch` は、本文に `verbose` が無ければ `?verbose=true` を読みます。`/scrape/stream` は、PDF・画像・動画のページや、ブラウザが失敗して静的な結果を返すときも、結果を `done` のイベントで送ります（今までは `done` を送らずに閉じていた）。
- **`map_site` の `since`・`until` を、日付で絞ってから `limit` で切ります**（今までは先に件数で切るため、`limit` が小さいと 0 件になった）。日付で絞るときは、サイトマップの先頭 5,000 件まで読みます。`lastmod` の無い URL は常に残り、リンクをたどる切り替えのときは効きません。子のサイトマップは、先頭の 1 つを取ってから、まだ足りなければ残りを 3 つずつ並べて取ります（結果は子の並びのまま）。
- **`browser_action` の `extract.clipSelector` だけを指定すると画像が空白になる不具合を直しました。** 画像の指定なしで作ったセッションも、あとの呼び出しで `screenshot`・`clipSelector` を求めれば画像を読み込んで撮ります（開いたままのページの CSS の背景画像と Web フォントは次の遷移から）。`inspect_image` は、画像でない応答（HTML など）を `image/jpeg` の成功として返さず、エラーにします（Content-Type が不正でも中身が画像のものは今までどおり）。

## 貿易・荷物・監視・国会・音楽

- **`watch_check` の `webhookSent` が、通知先が 2xx で受け取ったときだけ `true` になります**（今までは送る前に `true`）。応答を待ちますが、変化のあった対象の通知は保存のあとにまとめて（同時に 5 件まで）送るので、待ち時間はおおむね最も遅い通知先で決まります（1 件あたり最大約 5 秒）。
- **`verify_hts_code` の `productDescription` は必須のままですが、判定には使いません**（根拠の記録として応答に返すだけ）。
- **米国 CPSC の一般適合証明書（GCC）を作る `generate_gcc_certificate`（MCP の遅延ツール）と `POST /trade/gcc-generate` を足しました。** 今の 16 CFR 1110.11 の要素の GCC と、通関の保留に出す一式（表紙・品ごとの GCC・16 CFR 1610.1(d) の免除の説明）を、印刷用の HTML（`packageHtml`）と JSON の要約（`packageId`・`overallStatus`・`counts`・`items`）で返します。Markdown は返しません。`items`（1〜50 件、1 件 1 製品）だけを受け、各品に `htsCode`（10 桁）と `productName`（英語）が要ります。HTS は推測せず、判例も HTS の全件も読みません。証明書に載せる値は呼び出し側が記録から渡したものだけで、規則（`citations`）も呼び出し側の答えです。`citations: []` は「当てはまる規則が無いと証明者が確かめた」という答えで、Sora が当てはまると判断した規則（ボタン・コイン電池の 16 CFR 1263、衣料の 16 CFR 1610）が `citations` に無いと下書きにします。大人の衣料で 16 CFR 1610.1(d) の免除に当たる品は Disclaim B（Intended Use Code 130.006）、`citations: []` で CPSC の一覧にあるコードは Disclaim A（送るには Intended Use Code が要ります）、12 歳以下は GCC でなく CPC が要るので `cpc_required_instead` です。足りない記録は、既定で 422 `MISSING_REQUIRED_GCC_FIELDS`（`allowDraft: true` なら下書きを返す。MCP は `isError` で同じ `code` と `details`）、見本・仮置きに見える値は 400 `UNVERIFIED_PLACEHOLDER_INPUT`（一覧は完全ではありません）、証明書に載る値にラテン文字以外の文字（漢字・かな・ギリシャ文字など）があれば 400 `INVALID_INPUT`（16 CFR 1110.9(a)）です。試験の日（`testing.date`）は `YYYY-MM-DD`、製造の日は年月でも構いません。`url` を付けた品（1 回に 5 件まで。ブラウザなしの静的な取得で、1 品 10 秒まで）は、商品ページから番号などの候補（`suggestions`）を返すだけで、証明書には載せません。証明者と記録の担当は、呼び出し側の値か、サーバーの環境変数 `SORA_GCC_CERTIFIER`・`SORA_GCC_CUSTODIAN`（JSON。共有のサーバーでは設定しない）の値を、項目ごとに混ぜず丸ごと使います。`packageId` と `certificateId` は内容のハッシュで、生成の時刻は入りません。Sora は ACE にも CPSC にも何も送らず、適合も保証しません。証明書の中身が正しいことの責任は証明者（輸入者など）にあります（応答の `disclaimer`）。既知の限界: 応答の大きさは、10 品で約 3 万字、50 品で約 14 万字です（応答を長さで切るクライアントでは、品を分けて呼んでください）。
- **`check_cpsc_certificate` に `hasBattery`・`batteryType`・`fabricSurface`・`fabricWeightOzPerSqYd` を足しました。** `check_product_compliance` にも `fabricSurface`・`fabricWeightOzPerSqYd` を足しました（`hasBattery`・`batteryType` は前からあります）。`batteryType` は、空気亜鉛電池（16 CFR 1263.1(d) で対象外）なら `other` を書きます。生地の重さは oz/sq yd（16 CFR 1610.1(d)(1) の単位。g/m² なら 33.906 で割る）だけで、丸めずに比べます。
- **引数の説明を、実際の動きに合わせて直しました。** 例: `foodContact` は HTS の 4 桁が FCS の表の品目（3924・4419・6911・6912・7013・7323）のときだけ、`hasBattery` は `true` のときだけ検索語に battery を足す、`preferredCarriers` は自動判別のときだけ、`annotateTemporal` は「来週」だけでは注記しない、`browser_action` の `timeout` はページ遷移の待ちだけ、`evaluate` は `ALLOW_BROWSER_EVALUATE=true` のときだけ動く、`search_diet_minutes` は `keyword`・`speaker`・`nameOfMeeting` のどれか 1 つが要る（OpenAPI の 400 にも書いた）、など。README だけの訂正もあります（`search_news` の既定は 20 件、`suggest_keywords` の最大は 20 件、`ALLOW_BROWSER_EVALUATE` の既定は止める側、コードに無い `SAFE_BROWSER_MODE` の記述を削除）。

## 国の情報

- **`research_country_context` の `region` が、日本語の国名を解決します**（「台湾」「日本」「韓国」「アメリカ合衆国」など。ICU の国名から作り、表は持たない）。正式名の先頭だけの入力（「アメリカ」）は、4 文字以上で 1 か国だけに当たるときに `confidence: "medium"` で解決します（「アラブ」「サウジ」は解決しない）。複数に当たるもの（「コンゴ」「ドミニカ」）は解決しません。国名の空白と全角・半角の違いは無視し（「ミャンマー(ビルマ)」）、`USA` も米国になりました（v4.0.0 では解決しなかった）。
- **`social.platforms` を指定すると、`social.queries` の別の SNS も `platforms` の中に絞ります**（今までは `queries` の SNS をすべて検索した）。**`social` を渡したら `includeSocial` を `true` とみなします**（今までは別に渡さないと失敗した。MCP は明示の `false` と既定の `false` を区別できないため、`false` でも `true` になります）。
- **`get_country_context_evidence` の `evidenceIds`（REST は `ids`）で、その報告に無い ID を `missingIds` で返し、`limit` を超える分を `nextCursor` で続け、`cursor` を読みます**（今までは無い ID を黙って落とし、超えた分を `nextCursor` 無しで切り、`cursor` を読まなかった）。古い・別の問い合わせの `cursor` は、REST では 500 でなく 400 です（`/updates` の `cursor` も）。

## そのほか

- 答えを間違えていた 4 件を直しました。`get_flight_status` は、便が 0 件のとき「順調」と言わず、読み取れなかった旨か、条件に合う便が無い旨を返します。`annotateTemporal`・日付を含む問い・`search_realtime` の言い換えで、「来月」「先月」「再来月」が月末にあふれず（1月31日の「来月」は 2月28日）、「一昨日」を 2 日前に読み、「当日券」「当日精算」などの「当日」を日付として注記しません。`track_package` の自動判別は、照会に失敗した会社があって荷物の証拠が無いとき、`not_found` でなく `error`（失敗した会社の名前入り）を返します。`get_lyrics` は、記号だけの曲名が検索結果のどれにでも一致する誤りと、3 文字以下の歌手名の部分一致（「ai」が「mai」に当たる）を直しました。
- キャッシュのキーの版を上げました。入れ替えた直後は、同じ取得・検索でも取り直します: `scrape:v9` → `v10`、`search:integrated:v12` → `v13`、`search:realtime:json-v2` → `json-v3`、`traffic:v2` → `traffic:v3`、`tracking:v3:auto` → `tracking:v4:auto`（自動判別のキーだけ）、`country-intel:provider:v1` → `v2`、版の無かった `map:`・`weather:`・`disaster:warning:`・`disaster:earthquake:`・`transit:`・`traffic:flight:`・`img_inspect:`・`search:web:`・`lyrics:` は、それぞれ `v2`（`weather:` と `disaster:warning:` は `v3`）を付けた形になりました。
- MCP の定義の大きさを、`createMcpServer` の `tools/list` の JSON で測ると（v4.0.0 → v4.1.0）、最初から見える 14 ツールは 21,587 → 23,042 字（+7%）、全ツールは 209,156 字（52 ツール）→ 216,071 字（53 ツール）、`instructions` は 8,881 → 8,948 字です。最初から見える 14 ツールの説明文（`description`）の合計は 3,490 → 3,495 字（上限 3,500 字）で、`generate_gcc_certificate` は遅延ツールなので、これは変わりません。HTTP の経路で測る `scripts/measure-context.ts` の値（既定 22,358・全ツール 63,618・`instructions` 8,948。全ツールの上限は 64,000）は測り方が違うので、これらと一致しません（`docs/code-execution.md` を参照）。
- 天気・警報の地名の表 `src/jma_areas.ts` を作り直すスクリプトを `scripts/jma-areas/` に入れました（手順は README の「開発時の検証」）。
- 型付きのクライアント（`client/`）を作り直しました。`generate_gcc_certificate` を足し、`check_cpsc_certificate`・`check_product_compliance` の新しい引数を入れました。`search_deep` の `realtimeFocus` の説明から「(default)」を外し（省くと検索語から決まる）、`search_trend` の `limit`・`search_deep` の `maxChars`・`realtimeLimit`・`search_tools` の `detail` の説明も実際の動きに合わせました。
- `docs/engines/` に、判断をする機能（HTS コードの推測、CPSC・GCC・FDA の判定、住所の正規化、地名の解決、根拠の選び方など）が答えをどう決めているかの説明を足しました。README の「判断エンジンの一覧」から読めます。

# Sora v4.0.0 — 本文の画像とハイライトの選び方を直し、効いていない引数を消して responseMode にまとめた

## 破壊的な変更（引数）

- **効いていない引数・使われていない引数を消しました。** 消した引数を送っても、REST も MCP もエラーにはならず、黙って無視します。そのため、`onlyHighlights: true` などを明示していた呼び出しは、エラーにならないまま全文が返り、応答が大きくなります。下の表の移行先に替えてください。型付きのクライアント（`client/`）の型からも消したので、TypeScript ではコンパイルエラーになります。
- **`onlyHighlights`・`evidenceMode`・`extractHighlights` を、`responseMode`（`"full"` / `"evidence"`）にまとめました。** `scrape`・`scrape_batch`・`crawl_site` と REST の `/scrape`・`/scrape/batch`・`/crawl` の既定は `"full"`、`search_deep` と `POST /search` は今までどおり `"evidence"` です。scrape 系の `"evidence"` は、検索語に合うハイライトがあれば `content` をハイライトに置き換えます（本文に合う節が無いときは、ページの説明文を補完の証拠として返します）。`query` があれば必ずハイライトを作るので、ハイライトが要らないときは `query` を渡さないでください。`/scrape` と `/scrape/batch` は正しくない値を 400 にし、`/crawl` は `"full"` として扱います。
- **`search_deep`・`POST /search` で `extractHighlights: false` を使って本文を残していた呼び出しは、`responseMode: "full"` か `formats: ["markdown"]` に替えてください。** v3.0.0 のリリースノートで案内していた方法ですが、v4.0.0 では効かず、本文が省かれます。`formats` に `markdown` が無くても `contextSufficiency` が付くようになります。
- **`reorderUFlat` を消しました。** scrape のハイライトには効いていませんでした。`search_deep`・`crawl_site`・`POST /search`・`POST /crawl` では、`true` のとき結果を U 字に並べ替えていました。v4.0.0 では点数順のまま返します。
- **`scrape_batch`・`POST /scrape/batch` の `webhookUrl` の通知は、一括の完了時の 1 回だけになりました**（payload は一括の結果）。今まではページごとの通知もありました。`scrape`・`POST /scrape`・`POST /scrape/stream` の `webhookUrl` は消しました。
- **MCP の `scrape`・`scrape_batch` から `renderJs`・`fastOnly`・`selectors`・`clipSelector`・`removeSelectors` を外しました。** REST と型付きのクライアントには残ります。`renderJs`・`fastOnly` の代わりは `mode` です。MCP からは、`selectors` の結果の `extracted` と、要素のスクリーンショットは得られなくなります。

| 消した引数 | 対象 | 移行先・扱い |
|---|---|---|
| `onlyHighlights: true`・`evidenceMode: "highlights"`・`"contextual_highlights"` | scrape・scrape_batch・crawl_site | `responseMode: "evidence"` |
| `extractHighlights` | scrape 系・search_deep・POST /search | scrape 系: 不要（`query` があればハイライトを作る）。search_deep で本文を残すには `responseMode: "full"` か `formats: ["markdown"]` |
| `includeDiagnostics`・`includeDiscrepancies`・`diversityWeight`・`minimizeTables` | 全ツール | 不要（効いていなかった。MMR の重みは 0.7、表はいつも縮める） |
| `reorderUFlat` | 全ツール | 不要（点数順のまま返す） |
| `extractSummary`・`extractCitations`・`chunkMarkdown`・`chunkSize`・`validateLinks`・`formatAsPrompt`・`highlightMatches`・`filterLinkDensity`・`safeNormalize` | scrape・scrape_batch | 不要（応答の `summary`・`citations`・`chunks`・`promptContext`・`highlightedContent`・`linksWithStatus`・`derivations` も無くなる） |
| `dedup`・`enablePrf` | search_deep・POST /search | 不要（既定はどちらも無効だった。応答の `prf` も無くなる） |
| `webhookUrl`・`retries`・`retryDelayMs` | scrape・POST /scrape・POST /scrape/stream | 再試行は呼び出し側で。通知が要るときは `scrape_batch` の `webhookUrl` |
| `retries` | scrape_batch・POST /scrape/batch | 再試行は呼び出し側で |
| `renderJs`・`fastOnly`・`selectors`・`clipSelector`・`removeSelectors` | MCP の scrape・scrape_batch だけ | `mode`。CSS セレクタは REST か型付きのクライアントで |

MCP の引数は、`scrape` が 38 → 16、`scrape_batch` が 35 → 16、`crawl_site` が 14 → 11、`search_deep` が 32 → 26 になりました。MCP の `tools/list` の JSON で、最初から見える 14 ツールの定義は 24,884 → 21,587 字（−13%）、`scrape` は 5,680 → 3,029 字、`scrape_batch` は 4,449 → 2,622 字です（v3.0.0 のあとの main との比べ）。

## 本文の取り出し

- **rs-trafilatura の経路で、本文の画像が戻るようになりました。** rs-trafilatura が返す本文には img が入らないため、v3.0.0 では、記事以外の種類のページの本文から画像がすべて消えていました。画像があるときだけ、目印を置いた HTML で rs-trafilatura をもう一度走らせ、本文の文字が 1 回目と同じときだけ画像に戻します（6,400 枚まで）。WCXB の F1 は変わりません（dev +0.0001、test −0.00001、Bevendorff らの評価集 −0.00002）。画像が戻る分、一覧のページのトークンは増えます（日本語の 72 ページで推定 +9%、記事以外の 33 ページで +19%、最大 +718%）。画像が要らないときは `includeMedia: false` を使ってください。
- **`removeSelectors` が、rs-trafilatura の経路でも効くようになりました**（REST と型付きのクライアント）。
- **本文のリンクと画像の URL を絶対 URL にしました。** 日本語などの字は、パーセントエンコードせずにそのまま書きます。空白・制御文字・見えない字になる並びと、UTF-8 として読めない並びは、エンコードのまま残します。`#` だけのリンクと `javascript:` のリンクは文字だけにし、`#/`・`#!/` のハッシュの経路のリンクは残します。
- **formats の `html` は、本文の HTML になりました。** 取得したそのままの HTML は `rawHtml` です。`includeMedia: false` のとき、`rawHtml` には img が残り、`html` は rs-trafilatura の本文を使うページ（記事以外）では画像が入りません。
- `search_deep` の `includeMedia: false` を、ページを取る段階にも渡すようにしました（画像を戻すための 2 回目を走らせません）。

## ハイライト

- **ハイライトを、maxChars で切る前の全文（200,000 字まで）から選ぶようになりました。** 本文の後ろのほうにある答えも選べます。Wikipedia の長い記事 10 件で、先頭の 30,000 字より後ろにある事実がハイライトに入ったのは、0 件 → 10 件です。ハイライトの合計は maxChars に収めます（通常のハイライトを順に残し、残りの字数を表・コードなどの大きな節に分けます）。
- `search_deep` の `evidence` は、本文が maxChars で切れた結果では、ハイライトを本文に入れ替えません（本文の外から選んだ答えを捨てないため）。
- 節の中の、リンク先のホストが 6 つ以上あるリンクだけの段落（言語の一覧など）は、ハイライトの候補から外します。同じサイトへのリンクだけの一覧（曲名・作品名など）と、ふつうの SNS の行は残します。
- 日付の注記（`annotateTemporal`）は、ハイライトにも付きます。リンクの飛び先には入れません。ページの description を、ハイライトで置き換えなくなりました。
- 実際の `search_deep` の 40 問で、`full` に答えがあったもののうち `evidence` にも答えが残った割合は、問いが 89.3%（25/28）、ページが 88.9%（80/90）でした（前の測定は 86.2%・85.9%）。本番と同じ rs-trafilatura の経路で測り直すと、ページが 88.8%（79/89）、問いが 85.7%（24/28）でした（新しく落ちた 1 問は、rs-trafilatura が掲示板と判定したページの本文によるものです）。日本語の評価集 JQaRA の dev・test では、選ぶハイライトは v3.0.0 と同じです。

## そのほか

- 長い入力で止まっていた処理を、結果の変わらない形に直しました（200,000 字の数字の並びでハイライトを選ぶ処理 約 10 分 → 35 ms、1 つの図に画像 6,400 枚 267 秒 → 74 ms、並んだ `#` のリンク 16 万個 600 秒超 → 5.9 秒 など）。
- `search_earthquake` の `minIntensity` を、数の enum ではなく範囲で受け取るようにしました。関数の宣言で enum を文字列にしか許さないモデル（Gemini など）で、ツールの一覧ごと 400 になっていました。
- Yahoo の検索の実行ファイルを、`YAHOO_MCP_PATH`・`/usr/local/bin`・リポジトリの `bin/`・`PATH` の順で探すようにしました。
- MCP の instructions に `get_youtube_channel` の案内を足しました。
- キャッシュのキーの版を上げました（`scrape:v8` → `v9`、`search:integrated:v11` → `v12`）。入れ替えた直後は、同じ取得・検索でも取り直します。
- ソースから動かすときは Bun 1.4 以上を使ってください。1.3 系では後読みのある正規表現が遅く、ハイライトを選ぶ処理に約 5 倍の時間がかかります（イメージは影響を受けません）。

評価の詳しい記録は `docs/evaluations/main-content/results.md`（「rs-trafilatura の経路の画像（v4.0.0）」）と `docs/evaluations/v4-highlights/results.md` にあります。

# Sora v3.0.0 — rho-select を廃止し、search_deep の既定を evidence にし、本文の取り出しに rs-trafilatura を使うようにした

- **破壊的変更: rho-select を廃止し、引数 `highlightAlgorithm` と `highlightOverheadTokens` を消しました。** MCP の `scrape`・`scrape_batch`・`search_deep`・`crawl_site` と、REST の `/scrape`・`/scrape/stream`・`/scrape/batch`・`/crawl`・`/crawl/stream`・`POST /search`（`/search/deep`・`/search/integrated`・`/deep-search` も）が対象です。今も送ってくる呼び出し側は、検証エラーにはならず、黙って無視されます（MCP と `/scrape`・`/scrape/stream`・`/scrape/batch` はスキーマが知らない欄を落とし、`/crawl`・`/crawl/stream`・`/search` はその欄を読みません）。`"rho-select"`・`"legacy"` など、どの値を指定していても、新しい選び方になります。`highlightMaxCount`（1〜10）は残っています。verbose の `highlightDiagnostics` は、rho-select の診断（`certificate` など）から、ハイライト選択の診断（`queryCoverage` などの `EvidenceDiagnostics`）に替わりました。型付きのクライアント（`client/`）の型からも、2 つの引数を消しました。
- **破壊的変更: `search_deep`（MCP）と `POST /search`（REST。`/search/deep`・`/search/integrated`・`/deep-search` も）で、`responseMode` の既定を `full` から `evidence` にしました。** `evidence` は、ハイライトのある結果（と、`highlightsSameAs` で別の結果のハイライトを指す結果）から本文の `markdown` を省きます。本文が要る呼び出し側は `responseMode: "full"` を渡してください。`formats: ["markdown"]` や `extractHighlights: false` を明示した呼び出し、X の投稿、スニペットで代替した結果、取得に失敗した結果では、今までどおり本文を省きません。`verbose: true` のときは、`evidence` を指定しても全文で返します。REST では `null` も省略と同じ扱いです（MCP では今までどおり検証エラーです）。MCP の指示文・ツールの説明・README も、新しい既定に合わせました。MCP の利用者は、モデルが `full` を選べます。
- **破壊的変更: `highlightMaxCount` を省いたときのハイライトが増えました。** 今までの説明では既定は 3 件でしたが、実際には既定の rho-select v2 が件数を決めていて、少なめでした（JQaRA の dev で 1 問あたり平均 2.0 件）。今は上位 3 件のあと、合計約 1,600 字まで（8 件まで）節を足し、選んだハイライトに無い検索語を含む節を 1 つと、点が首位の 0.25〜0.35 倍の節も、字数の残りで足します。800 字を超える節（表・コード以外）を窓で切るときは、節の書き出しを 350 字まで前に付けます。1,600 字を超える節（表・コード以外）は、段落を 300 字までまとめた塊も候補にします。`scrape`・`scrape_batch`・`crawl_site` の既定のハイライトも同じように増えます（`onlyHighlights` などでハイライトだけを返すときは、返す本文も長くなります）。`evidence` を明示している呼び出し側でも、返すハイライトは増えます。件数を指定したときは、足す規則を使わず、その件数までを選びます（窓の節に書き出しが付くだけです）。`evidence` では、ハイライトが本文の 0.85 倍以上の長さになった結果は、ハイライトの代わりに本文を返します（`highlightsSameAs` で指される結果と、`maxTotalChars` を指定したときを除きます）。`full` の応答も、ハイライトが長くなる分だけ大きくなります（下の 4 回目の 40 問で、足す規則を入れる前の 3 件と比べて +4.4%）。キャッシュのキーの版を上げたので（`search:integrated:v10` → `v11`、`scrape:v7` → `v8`）、入れ替えた直後は同じ検索・取得でも前のキャッシュは当たらず、取り直します。
- **ハイライトの選び方を、rho-select v2 から、BM25 の節の点に回答値の倍率を掛けて MMR で選ぶ形（`extractQueryHighlightDetails`）に替えました。** 既定のハイライトのほか、`search_deep` の X の投稿の根拠の抜き出しと、SPA でブラウザを起動するかの判定（静的な本文から選んだ 5 件のハイライトの回答カバレッジが 0.5 以上なら起動しない）も、この選び方を使います。そのため、ブラウザを起動するかどうかが変わるページがあります。結果の並べ替え（`rerankByDeepEvidence`）と `contextSufficiency` も、このハイライトを使うので、結果が変わることがあります。上の「足す規則」を入れる前の測定で、日本語の公開評価集 JQaRA の dev（1,737 問）では、選んだ段落のうち正解の割合が 0.330 → 0.531、1 つでも正解を選べた問いが 0.632 → 0.881 になりました（1 問あたりに選ぶ数は 2.0 → 2.9）。チャプターを外した字幕（101 問）では、正解の割合が 0.316 → 約 0.38、1 つでも正解を選べた問いが 0.356 → 0.673 です。チャプター付きの字幕では、1 段落に絞る rho-select のほうが正解の割合が高く（0.951 対 0.835）、1 つでも正解を選べた問いは 0.970 → 0.980 です。rho-select の実装・テスト・文書（11 ファイル、約 5,000 行）は削除しました。
- **段落の BM25（`scorePassage`）の k1・b を、1.5・0.75 から 0.9・0.4 にしました。** 長い段落を強く罰しなくなり、長い段落にある答えを落としにくくなります。JQaRA の dev で決め、test（1,667 問）で nDCG@10 が 0.4287 → 0.4476、MRR@10 が 0.6655 → 0.6896 になりました（公開されている BM25 の値は 0.458）。ハイライトと字幕の段落選びがこの点数を使います。字幕の段落選びの評価は変わりませんでした。
- **チャプターの無い動画の字幕は、話題のつながりを 2 状態の隠れマルコフモデルで見て段落を選ぶようにしました。** `scrape` の YouTube・`search_video` の `transcripts`・`search_deep` の `videos` に効きます。検索語の出ない続きの段落も拾い、離れた所のついでの一言を拾いにくくなります。動画単位で分けた held-out（9 本・52 問。チャプターのある動画からチャプターを外した字幕を使い、正解は説明欄のチャプター）で、正解チャプターの取れた割合が 0.471 → 0.696、1 位が正解の割合が 0.365 → 0.538 になりました。精度（0.408 → 0.438）の差は、信頼区間が 0 をまたぎます。チャプターのある動画は、HMM を使うと精度が 0.704 → 0.637 に下がるので、今までどおりです。
- **本文の取り出しで、一覧のページと、表で段組みした古いページの取り違えを直しました。** Readability の本文が 600 字未満で、同じ形の項目が 3 つ以上並び、その 3 倍以上（300 字以上）の文字がある入れ物があれば、それを本文にします（宣伝の枠やカード 1 枚だけを本文にしていました）。表で段組みしたページは、ナビ・フッターまで本文に入れなくなりました。次の数字は rs-trafilatura を使わない経路（Readability）での値です。英語中心の評価集 WCXB の test（511 ページ）で 0.8225 → 0.8374、別の作者の Bevendorff ら（3,985 ページ）で 0.784 → 0.864（古いニュースの L3S-GN1 は 0.644 → 0.905）です。日本語のページ 38 件では、変わった 7 件のうち 5 件が良くなり、1 件（ローチケの東京のページ）が悪くなりました（残りの 1 件は良し悪しが混ざる）。
- **本文の取り出しに rs-trafilatura（MIT OR Apache-2.0）を組み込み、ページの種類で Readability と振り分けるようにしました。** rs-trafilatura が「記事」と判定したページは Readability の本文を使い（200 字未満のときだけ rs-trafilatura の本文に替えます）、一覧・掲示板・商品・まとめ・技術文書・サービスなど、ほかの種類と判定したページは rs-trafilatura の本文を使います。WCXB では dev が 0.781 → 0.840、test が 0.839 → 0.876 で、test はどの種類も、表の直しの後の Sora 単独より下がりません（掲示板 0.709 → 0.835、商品 0.666 → 0.782 など）。ただし、WCXB は rs-trafilatura と同じ作者が作った評価集なので、割り引いて見る必要があります。別の作者の Bevendorff らでは 0.861 で、表の直しを入れた Sora 単独（0.875）より 0.014 低くなります（古い英語のニュースを「一覧」と判定するため）。日本語のページ 72 件では、変わった 33 件のうち良くなった 14 件・悪くなった 4 件（アメブロのタグの一覧で投稿日時が落ちる、国税庁の作成コーナーの選択肢が落ちる など）・同じくらい 15 件で、トークンは −3% です。rs-trafilatura の本文には画像が入りません（`images` は今までどおりページ全体から取ります）。`/scrape` を既定（`onlyMainContent: true`）で呼ぶ呼び出し側には、この振り分けがそのまま効きます。あわせて、表の変換の不具合を 2 つ直しました（Readability の経路と、構造化した表の `tables` にも効きます）。入れ子の表の行・セルを外の表の行として数え、同じ文が 1 ページで最大 15 回出ていたことと、1 行目にセルの無い表（`<tr></tr>`）で例外になっていたことです。
- **`search_deep` の `evidence` で答えが残るかを、実際の検索で測りました。** 足す規則を決めるのに使っていない 40 問（4 回目）で、`full` に答えのあるページのうち `evidence` にも答えが残ったのは、足す規則を入れる前（#51 の選び方で 3 件）の 72 から 79/92 ページに（途中の版では 75）、問いは 24 から 25/29 に増え、新しく落としたページは 0 でした。`evidence` のトークン（文字数からの見積もり）は `full` の 0.260 倍（275,118 対 1,057,138）で、足す規則を入れる前（229,828）より +20% です。足す規則を入れる前の 1 回目と 2 回目（同じ 40 問で検索語の形を替えたもの）では、`full` に答えがあった 50 問のうち 48 問で `evidence` にも答えが残り、トークンは −74%・−73% でした。詳しくは `docs/evaluations/response-compression/results.md` にあります。
- **既知の限界。** `evidence` は全文と同じではありません。3 回目と 4 回目の測定を合わせると、`full` に答えがあった 54 問のうち 5 問で、`evidence` から答えが落ちました（答えのある節や塊に検索語が無いもの 3 問と、答えの節の点が足す規則の下限（首位の 0.25 倍）に届かない、または字数の目安を先に使い切ったもの 2 問）。3 回目の問いは足す規則を選ぶのに使ったものです。答えが落ちたときも、`contextSufficiency` が `no_gap_detected` のことがあります。結果の並べ替え（`rerankByDeepEvidence`）もハイライトを使うので、並びが変わります。規則を足した 2 段階でそれぞれ測ると、最初の段階では保存した 40 問のうち 4 問で並びが変わり、1 問で答えのある最上位のページが 2 位から 3 位に下がりました。次の段階では 76 問のうち 4 問で変わり、1 問で 3 位から 1 位に上がりました（rho-select のときとは比べていません）。点が首位の 0.25〜0.35 倍の節を足す規則は、4 回目の 40 問では 1 ページも戻さず、トークンを約 4,600 足しただけでした（ほかの評価では上がったので残しています）。
- **イメージに rs-trafilatura のコマンドを入れました。** Containerfile に Rust（`rust:1.91-slim-bookworm`）のビルド段を足し、コミット `2a4f56e` に固定した上流のソースから `extract_stdin` をビルドして、`/usr/local/bin/rs-trafilatura` に置きます。依存の版は `vendor/rs-trafilatura/Cargo.lock` で固定し、ライセンスは `/usr/share/licenses/rs-trafilatura/` に同梱しました。イメージのビルドでは、GitHub から上流のソースを取ります。新しい環境変数 `RS_TRAFILATURA_PATH` は、イメージで設定済みです。`onlyMainContent`（既定 true）のときだけ呼びます。未設定・コマンドが無い・失敗・5 秒を超えたときは、黙って Readability だけの経路に戻ります（イメージを使わない開発環境と CI のテストはこの経路なので、イメージで動かしたときと本文が違うことがあります）。`/metrics` では、時間切れ・異常終了・空の本文を `sora_main_content_rs_empty_total`、起動や出力の読み取りの失敗を `sora_main_content_rs_failed_total` で数えます（未設定・コマンドが無いときは数えません）。
- 評価の記録を `docs/evaluations/` の `term-matching`・`youtube-excerpt`・`main-content`・`response-compression` に、測るためのスクリプトを `scripts/eval-jqara.ts`・`scripts/eval-wcxb.ts`・`scripts/eval-youtube-excerpt.ts` に、字幕の評価のケース（動画 ID・時間帯・検索語）を `eval/youtube_excerpt_cases.json` に足しました。

# Sora v2.53.0 — ブラウザの偽装を Chromium 自身の仕組みに寄せ、静的取得のヘッダ順を Chrome に揃えた

- **ブラウザ（Chromium）の偽装を、JS の上書きから、起動フラグと CDP に寄せました。** 言語は `--accept-lang`（`navigator.language(s)`・Worker・別オリジンの iframe まで揃い、`Accept-Language` が Chrome と同じ位置に入ります）、UA は `--user-agent`（Service Worker・SharedWorker の UA に `HeadlessChrome` が見えていたのを消します。外部の検出サイト CreepJS の headless 判定は、本番イメージで 67% → 0%）、hover / pointer は `--blink-settings`（デスクトップのマウスに揃えます）。タイムゾーンは起動時の `TZ=Asia/Tokyo` にしました（本番のコンテナは UTC で、ロケールの ja-JP と食い違っていました）。
- **JS で上書きするのは、platform と WebRTC のラッパーだけにしました。** 次の上書きは、本来の値の方が本物に近く、Worker や iframe にも届くので削除しました。`navigator.webdriver`（本来は `false`。上書きで `undefined` になり、getter が native でなくなっていました）、`navigator.languages`（`navigator.language` が `en-US` のまま `languages[0]` だけ `ja-JP` になり、Worker は `en-US` でした）、`window.chrome` のスタブ（`runtime: {}` を足していました）、canvas の雑音（`getImageData` だけで `toDataURL` に効きませんでした）、`setExtraHTTPHeaders` で足していた `Accept-Language`（Chrome と違う位置に入っていました）。
- **静的取得のヘッダ順を、Chrome に揃えました。** wreq-js は要求ごとに渡したヘッダを先頭へ移すため、`Accept-Language` が先頭に出ていました。セッションの `emulation` に `accept-language` と `origHeaders`（Chrome の順序と表記）を持たせ、`Accept-Language` と `Referer` が Chrome と同じ位置に入ります。TLS の JA4 と HTTP/2 の指紋は変わりません（tls.peet.ws で確認）。
- **`scrape` の静的取得の 1 回目に、Google の `Referer` と、それに合う `Sec-Fetch-Site: cross-site` を既定で付けるようにしました。** `SORA_DEFAULT_REFERER=off` で無効にできます。呼び出し側が `Referer` を指定したとき、Cookie などの資格情報を運ぶとき、そして robots.txt・sitemap・画像・JSON API には付けません。ブラウザ経路には付けません（`page.goto` の `referer` は `Sec-Fetch-Site` が `none` のままで、Chrome の実際の動きと食い違うため）。有料記事の「Google 経由は無料」を装う形にもなり、アクセス解析には検索流入として数えられるので、気になる場合は `off` にしてください。
- **既知の限界。** Windows の Chrome を名乗るため、Worker の `navigator.platform` は `Linux x86_64` のままです（外部の検出サイト deviceandbrowserinfo は、これを理由に「bot」と判定します）。また、IP で止める CDN（例: `https://www.sanae.gr.jp/` は、どの構成でも CloudFront の 403）は、この変更では通りません。
- 新しいテスト `src/stealth_native.test.ts` で、native の getter・言語・タイムゾーン・hover・Worker / SharedWorker・ヘッダ順・`Referer` を固定しました。canvas の雑音のテストは、機能ごと削除しました。

# Sora v2.52.0 — 楽曲認識で、作り済みの指紋を受け取れるようにした

- **作り済みの音の指紋（SigX）を受け取って曲を特定する `POST /music/recognize/signature` を足しました。** 16 kHz・モノラルの音から作った指紋のバイト列の base64（data URI の接頭辞なし）と長さ（`sampleMs`、3000〜12000）を送ると、`/music/recognize` と同じ形の結果を返します（`attempts` は 1 件、`audio` は無し）。録音そのものを Sora に送らずに済みます。REST だけで、MCP のツールは足していません。モジュール `shazam` を名前で挙げたときだけ有効で、無効なら 404 `MODULE_DISABLED` です。
- **受け取った指紋は、Shazam に送る前に形を確かめます。** 先頭の magic・CRC-32・全長・ヘッダーのサンプル数と `sampleMs` の一致のどれかが合わなければ 400 `INVALID_INPUT` で、送りません。窓は 1 つなので、ずれの大きい当たりは、そのまま `match.uncertain: true` で返します。
- **この入口はキャッシュしません**（読みも書きもせず、同時の要求もまとめません）。ライブの録音は毎回違うので当たりが無く、残すと「この時刻にこの曲」が DB に残るだけになるためです。
- **この入口では、当たっても iTunes とつなぐ問い合わせが失敗したとき（時間切れ・403・429 など）は 502 `SONG_RECOGNITION_UPSTREAM_ERROR` にします。** `itunes: null`（iTunes につなげる曲が無い）と見分けられるので、呼び出し側は指紋を残して照会し直せます。`/music/recognize` と `recognize_song` は今までどおり、`itunes: null` で当たりを返します。
- **iTunes の曲に `artistId`（iTunes のアーティスト ID）を足しました。** `search_song`・`search_artist`・`search_music` の `items` と、楽曲認識の `itunes` に入ります（任意の欄の追加なので、今の利用者は壊れません）。
- 窓ごとの照会の処理を、音声の経路と指紋の経路で共有しました。`/music/recognize` の動きは変わりません。
- **指紋の計算と形の検査を、npm のパッケージ `audio-signature`（`packages/audio-signature/`、MIT）に抜き出しました。** ブラウザ・Bun・Node で動き、端末で指紋を作るアプリも、Sora と同じ計算と検査を使えます。Sora はリポジトリの中のソースをそのまま使い（npm からは取りません）、`/music/recognize` と `/music/recognize/signature` の動きは変わりません。

# Sora v2.51.1 — 楽曲認識で、ずれの大きい当たりを確かでないものとして扱う

- **Shazam が返した当たりのうち、時間・周波数のずれが 0.002 を超えるものは、次の窓で確かめるようにしました。** v2.51.0 の本番前の確認で、君と見るそら「遠回りがいいっ!」の試聴音源の 12 秒目からの窓に、Shazam が別の曲を返しました（周波数のずれ 0.0051。正しい当たりは 0.00012 以下）。確かな当たりが無いときは、その当たりを `match.uncertain: true` と注意の `message` を付けて返します。
- **`match` に `timeSkew`・`frequencySkew`、`attempts` に `uncertain` を足しました。**

# Sora v2.51.0 — 音から曲を特定する recognize_song を足した（名前を挙げたときだけ有効なモジュール shazam）

- **音声・動画ファイルの音から曲を特定する `recognize_song`（`POST /music/recognize`）を足しました。** 音を Shazam で特定し、iTunes の曲（`search_song` と同じ形。trackId・ジャケット・30 秒試聴 URL・Apple Music のリンク）とつないで返します。音は、音声・動画ファイルの URL（20 MB まで）か、REST へのアップロード（multipart の `file`、10 MB まで）で受け取ります。YouTube などの動画のページからは音を取りません。
- **モジュール `shazam` は、歌詞と同じく `ENABLED_MODULES` に名前を挙げたときだけ有効です（`ENABLED_MODULES=all,shazam`）。** 公開された API ではなく、Shazam の iPhone アプリと同じ窓口を使うためです。既定の構成のツール・REST・OpenAPI・指示文は変わりません。
- **[omkarcloud/shazam-scraper](https://github.com/omkarcloud/shazam-scraper)（MIT）の楽曲認識の部分を TypeScript に移植しました。** 音は同梱の Chromium の Web Audio で 16 kHz・モノラルにし（イメージに ffmpeg は足していません）、12 秒の窓から指紋を作って送ります。`offsetSec` を省略すると、長い音は真ん中、続けて先頭から 12 秒ずつ、最大 3 回試します。iTunes とは Shazam が返す Apple の曲 ID でつなぎ、無ければ曲名とアーティストの一致する検索結果を使います。
- **当たらないときは `found: false` と `reason`（`no-match` / `not-audio` / `too-short` / `too-large` / `download-failed`）を返します。** Shazam の拒否・制限・障害は 502 `SONG_RECOGNITION_UPSTREAM_ERROR` です。結果は音のハッシュごとに 30 分（当たらないときは 1 分）キャッシュします。
- **Shazam が返す曲名はローマ字・英語の表記で、日本語の曲名は `itunes` の側に入ります。** Shazam の Apple の曲 ID は、渡した音の元と別の版（シングルとアルバムなど）のことがあります。
- **tool-health の毎日の実 API の検査に、iTunes の試聴音源で 1 回だけ送る検査を足しました**（候補コンテナを `ENABLED_MODULES=all,shazam` で起動します）。

# Sora v2.50.0 — YouTube チャンネルの最新の動画を返すようにした

- **YouTube チャンネルの最新の動画を返す `get_youtube_channel`（`POST /youtube/channel`）を足しました。** チャンネルの URL（`/@ハンドル`・`/channel/UC…`・`/c/名前`・`/user/名前`）、`@ハンドル`、`UC…` のチャンネル ID を渡すと、最新の動画を新しい順に最大 15 件（題名・公開日・更新日・説明文の先頭 500 字・視聴回数）返します。YouTube の公開の Atom フィードを読むので、Yahoo の検索（ほかの利用と分け合う枠）もブラウザも使いません。動画の字幕は、返った `videoId` を `get_youtube_transcript` に渡して読みます。
- **ハンドルのチャンネル ID は、チャンネルのページから読み、24 時間覚えます。** フィードは 30 分（チャンネルが無い・動画が無いときは 60 秒）キャッシュします。チャンネルが無ければ `found: false`（`reason: "channel-not-found"`）です。同意の画面・ブロック・429/5xx・読めない応答は、`found: false` にせずエラー（REST は 502 `YOUTUBE_UPSTREAM_ERROR`）にして、キャッシュしません。
- **YouTube モジュールの中にあり、MCP では遅延ツールです。** `ENABLED_MODULES` が未設定・`all`・`youtube` を含むときに使えます。`search_tools` で「YouTube チャンネル」と探すと有効になります。ツールは 51 から 52、全ツールの一覧は 62,556 から 63,342 文字になりました（初期の一覧は変わりません）。
- **フィードとチャンネルのページの形は、実機で確かめていません。** 公開されているフィードとページの形からの想定で実装し、テストは合成したフィクスチャです。最初に本番へ載せたときに `curl` で確かめてください（手順は `docs/superpowers/specs/2026-10-26-youtube-channel-design.md`）。

# Sora v2.49.2 — 確認の画面のままのページの Cookie を戻し続けないようにした・TikTok の確認の画面を本文にしない

- **ブラウザが待っても確認の画面（ボット対策）のままだったページも、HTTP 400 以上のページと同じに扱うようにしました。** その画面の Cookie と localStorage を保存せず、保存していた分を消して、戻さずに 1 回だけ開き直します。v2.49.1 は 400 以上のページだけを見ていたため、TikTok の確認の画面（"Please wait..."、HTTP 200）で保存した札を戻し続け、毎回確認の画面になることがありました。
- **TikTok の動画が確認の画面のままのときは、`contentStatus: "unavailable"` で返すようにしました。** これまでは、その画面の文（"Please wait..."）を本文として返していました。

# Sora v2.49.1 — エラーの画面から保存した Cookie を戻し続けて、同じサイトが読めなくなる不具合を直した

- **ブラウザで開いたページが HTTP 400 以上を返したときは、そのサイトの Cookie と localStorage を保存せず、保存していた分を消すようにしました。** これまでは、ブロックの画面（403）で受け取った札も保存し、次から毎回それを戻して開くため、同じサイトが読めないままになることがありました。v2.49.0 の本番で、TikTok がこの状態になっていました。
- **保存していた Cookie・localStorage を戻して開いたページがエラーなら、戻さずに 1 回だけ開き直すようにしました。** 古い札が残っていても、その取得で読めます。呼び出し側が Cookie（ログイン状態）を渡した取得は、今までどおりです。

# Sora v2.49.0 — TikTok の動画を、説明文と TikTok の自動字幕で読むようにした

- **`scrape` が TikTok の動画の URL を、説明文・投稿者・投稿日時・長さと、TikTok の自動字幕で返すようになりました。** これまでは、ふつうの取得では TikTok の確認画面しか読めず、ブラウザで開いても本文はパンくずと題名だけでした。今は動画のページを最初からブラウザで開き、ページの埋め込みデータから本文を作ります。字幕は YouTube と同じく約 30 秒ごとの段落にし、`### 1m23s` の見出しで分けます（「TikTok の自動字幕。聞き間違いを含む」と明記）。字幕の無い動画は説明文だけ（`contentStatus: "metadata_only"`）で、話している内容を推測で補わないよう書き添えます。1 本あたり約 10〜13 秒です。
- **`search_deep` の検索語に TikTok の URL を入れたとき、`scrape_batch`、`search_web` の `formats` でも、同じように字幕を読みます。** 新しいツールは足していません。

# Sora v2.48.0 — 検索語の URL はその URL を読むようにした・動画検索に期間と動画サイトを足した

- **`search_deep` は、検索語に URL があると、検索をせずにその URL を読むようになりました。** これまでは URL の文字列を検索語にして Web・X・動画を検索していたため、`videos` を付けると関係ない動画が入り、Yahoo に載っていない URL（X の投稿・画像・新しい動画など）は読めませんでした。今は `scrape` と同じ方法で読みます（YouTube は字幕、X は投稿、PDF は本文、ほかはページ）。URL 以外の語は、ハイライトの選択と十分さの判定（`contextSufficiency`）に使います。`search_video` は、検索語が URL なら検索せず、読み方を `message` で返します。
- **Web 検索の結果が YouTube の動画なら、題名を YouTube の題名にしました。** Yahoo は題名を英語に訳して返すことがあります。
- **`search_video` で、投稿日の期間（`updated`）と動画サイト（`platform`）を指定できるようにしました。** 期間は 1 時間・24 時間・1 週間・1 か月・1 年、動画サイトは YouTube・TikTok・X・Instagram・ニコニコ動画・Dailymotion です。指定したときは、Yahoo の動画検索のページを直接読みます（指定しなければ今までどおり）。`search_deep` の `videos` は YouTube の動画に絞って探し、期間は `updated` を使います。
- **`scrape` が、画像・音声・動画のファイルを文字として読まないようにしました。** 種類と大きさだけを返します（`contentStatus: "unavailable"`）。30MB を超えるファイルも同じです。
- **HTTP の状態が 400 以上のページ（ブロックやエラーの画面）を、本文として扱わないようにしました。** `contentStatus: "unavailable"` にしてハイライトを作らず、`search_deep` では読めたページの後ろに回します。ブラウザで開いたときの状態も見ます（TikTok はブラウザでも 403 を返すことがあります）。

# Sora v2.47.1 — YouTube の字幕から、検索語に関係する段落が選ばれるようにした（長い動画・チャプターのある動画）

- **チャプターのある動画で、目次ではなく字幕の段落が根拠に選ばれるようにしました。** v2.47.0 では、`scrape` と `search_deep` の段落の選び方（rho-select v2）が、説明文の目次（「2:02:02 | 主成分分析 | …」）の節を選び、字幕が選ばれていませんでした。字幕の段落をチャプターの見出しの下に並べ（`### 2h02m02s〜 チャプター名` の下に `#### 2h02m15s`）、説明文からチャプターの行を外しました（チャプターは `media.chapters` に残ります）。講義動画（チャプター 54 件）で、チャプター名で検索して選ばれた段落がそのチャプターに入る割合は、17% から 100% になりました。
- **段落の点数を、見出しの階層ボーナス付き BM25 にしました。** `search_video` の `transcripts` の抜き出しと、次の長い字幕の扱いで、段落が入るチャプターの名前にも加点します（同じ比べ方で 44% → 84%）。
- **長い動画で、字幕の後半も選ばれるようにしました。** `scrape` は本文を `maxChars`（既定 30,000 字）で切ってから段落を選ぶため、長い講義の後半は選ぶ対象になりませんでした。字幕が収まらないときは、切る前に検索語に関係する段落を選んで時刻順に載せます（検索語が無ければ先頭から）。どちらの場合も、載せ方と字幕全体の文字数を本文に書き添えます。
- **AI 向けの指示文（instructions）で、動画を探すときは `search_video` の `transcripts`、調べものには `search_deep` の `videos` を使うよう案内するようにしました。** どちらも既定は 0 です。

# Sora v2.47.0 — 検索（scrape・search_video・search_deep）で YouTube の字幕を使うようにした

- **`scrape` が YouTube の動画 URL を、字幕と説明文から作った本文で返すようになりました。** これまでは動画のページを読み、おすすめ動画の一覧（別の動画の題名）を本文として返していました（約 10 秒）。今は約 1.5 秒で、題名・チャンネル・公開日・長さ・説明文・字幕（自動字幕と明記）を返します。`scrape_batch`、`search_web` の `formats`、`search_deep` も同じです。
  - 字幕の段落は `### 1m23s` の見出しで分け、検索語に関係する段落が選ばれるようにしました。
  - 字幕が無い動画は `contentStatus: "metadata_only"`、取得できない動画は `"unavailable"` です。ページそのもの（`html`・`rawHtml`・`links`・`screenshot`）やブラウザでの描画を求めたときは、今までどおり動画のページを読みます。
- **`search_video` に `transcripts`（0〜5、既定 0）と `transcriptChars`（500〜10,000、既定 2,000）を足しました。** 上位の YouTube 動画の指定した本数に、検索語に関係する字幕の部分（時刻つき）を `transcript` として付けます。検索語を含む段落が無いときは、先頭から返します（`excerpt: "head"`）。全文は `get_youtube_transcript` で読めます。
- **`search_deep` に `videos`（0〜5、既定 0）を足しました。** Web 検索と並行して Yahoo の動画検索を行い、上位の YouTube 動画の字幕を、ほかのページと同じように根拠として `results` に `source: "youtube"` で足します。動画の側はページを読む処理と並行して終わるので、待ち時間はほとんど増えません。既定は 0 で、指定しなければ動画は検索しません（Yahoo の検索と YouTube への問い合わせが増えないように）。

# Sora v2.46.1 — YouTube の字幕の入力から toSec を外し、記号つきのチャプターを読むようにした

- **`get_youtube_transcript` / `POST /youtube/transcript` の入力から `toSec` を外しました。** 省略できる引数に最小値を入れてくる呼び出し側が `toSec: 1` を送ると、冒頭が待機画面の動画では本文が空になり、0 秒から字幕がある動画でも最初の段落だけが `truncated: false` で返っていました。一部だけ読むときは `fromSec` と `maxChars` を使ってください。送られてきた `toSec` は無視します（エラーにはなりません）。出力の `toSec`（返した本文の終わり）はそのままです。
  - `fromSec` が最後の字幕より後のときは、空の `text` に `message` を付けて返します。
- **説明文のチャプターを、字下げや記号で始まる行（`　∟0:33:27`・`- 1:02:54`・`• 1:05:17`）からも読むようにし、時刻の後の区切り（`0:00:00 | 待機画面` の `| `）を題名に含めないようにしました。** `scrape` の `media.chapters` も同じです。

# Sora v2.46.0 — YouTube の動画の字幕・説明文・チャプターを返すようにした

- **YouTube の動画の中身を、Gemini 以外の AI でも要約・抽出できるようにしました。** 新しいツール `get_youtube_transcript`（REST: `POST /youtube/transcript`）に動画の URL か動画 ID を渡すと、題名・投稿者・公開日・長さ・説明文・チャプターと、約 30 秒ごとの段落の先頭に `[m:ss]` を付けた字幕を返します。要約は呼び出し側の AI が書きます（Sora は LLM を呼びません）。
  - 手動の字幕を優先し、無ければ YouTube の自動字幕を返します。自動字幕は `transcript.source: "auto"` と `note` で示します（音声認識なので、聞き間違いを含み、固有名詞や句読点が正しくないことがあります）。言語は `lang`（既定 `ja`）、元の音声の言語、英語の順に選びます。
  - 字幕が無い動画は、`transcript.status: "none"` と理由（`no-captions` 字幕なし、`live-now` 配信中、`language-mismatch` 題名と言語の合わない自動字幕だけ）を返し、話の中身を推測しないよう求めます。YouTube が取得を拒否したとき・通信に失敗したときは `unavailable` で、キャッシュしません。音声認識はしません。
  - 長い動画は `maxChars`（既定 30,000 字）を超えると段落の境目で切り、続きの開始秒 `nextFromSec` を返します。URL の `t=` は `requestedStartSec` に入ります。
  - モジュール `youtube` は既定で有効です（`ENABLED_MODULES=all` に含まれます）。MCP では `search_tools` で有効化する遅延ツールです。呼ばれたときだけ YouTube に問い合わせ、起動時の処理・常駐タイマー・事前取得はありません。
  - 字幕は YouTube の公開 API ではない経路（Android アプリと同じ innertube）から取ります。YouTube の変更で止まることがあります。bot の確認を回避する処理（PO トークンの生成・Cookie）は持ちません。
- **`scrape` の YouTube の URL の判定を直しました。** ホストを完全一致で判定するようにし（`notyoutube.com` などを YouTube とみなさない）、shorts・live の URL にも `media` が付くようになりました。

# Sora v2.45.0 — 「ご不在」の佐川の荷物を自動判別で取りこぼすのを直し、営業所の電話番号を返すようにした

- **荷物状況が「ご不在」の荷物を、再配達待ち（`in_transit`）として扱うようにしました。** これまでは分類できずに `unknown` になり、表示ページには「配達状況を確認できませんでした」と出ていました。さらに `unknown` は確認済みにならないため、運送会社を指定しない自動判別（`track_package` で `carrier` を省く、または `auto`）では佐川の荷物が採用されず、同点で先頭のヤマトの「見つかりません」になっていました。
  - 分類は判定の最後に `不在` を足しただけなので、今分類できている状態は変わりません。この分類はヤマト・日本郵便・西濃・福山・佐川で共通なので、「不在」を含む状態はどの社でも同じ扱いになります。
  - 佐川は、履歴があれば、状態の言葉を分類できなくても確認済みとして扱います。佐川の応答は構造化された JSON で、知らない番号は「該当なし」になるためです。ほかの運送会社の確認ルールは変えていません。
  - 表示ページは、履歴があるときは「確認できませんでした」を出しません。
- **集荷・配達営業所の電話番号を返すようにしました。** `details` に `originPhone`（集荷営業所）と `destinationPhone`（配達営業所）が入ります。運送会社が公開している表記のままで、今は佐川急便だけです。ほかの運送会社は、営業所の情報を読めるようになったら同じ 2 項目に入れます。
  - 表示ページ（`pageUrl`）には、営業所名の下に `TEL`（タップで電話をかけられるリンク）として出ます。数字や括弧以外が混ざる値は、リンクにせず、そのまま（エスケープして）表示します。
  - OpenAPI、MCP の `track_package` の説明、README、生成クライアントを更新しました。

# Sora v2.44.0 — 荷物ごとの表示ページ（pageUrl）を発行できるようにした

- **照会結果に、Sora が発行する荷物ごとの表示ページの URL（`pageUrl`）が付くようになりました。** 佐川急便の新しいお荷物問い合わせサービスには、送り状番号を渡せる URL がありません。EC サイトなどが利用者に「この荷物の配達状況」として案内できる URL を、Sora が用意します（どの運送会社でも使えます）。`trackingUrl`（公式ページ）はそのままです。
  - `SORA_TRACKING_PAGE_SECRET` と `SORA_PUBLIC_URL` の両方を設定したときだけ有効です。未設定なら `pageUrl` は付かず、`GET /t/:carrier/:number` は 404 を返します（起動時の処理はありません）。
  - ページ（`GET /t/:carrier/:number?sig=…`）は、佐川急便の結果画面と同じ並び・項目名で配達状況を表示し、先頭に運送会社の公式ページではないことを示します。運送会社のロゴや配色は使わず、公式ページへのリンクを置きます。
  - API キーは不要で、EC サイトのページやメールのリンクから開けます。Sora が発行した署名が合う URL だけを表示するので、任意の番号の照会には使えません。秘密鍵を変えると、発行済みの URL はすべて無効になります。
  - スクリプトは使わず、表示する文字はすべてエスケープします。ページを開いたときに運送会社へ問い合わせ、照会と同じキャッシュを使います。

# Sora v2.43.3 — 佐川急便の追跡を、新しいお荷物問い合わせサービスから取得するように直した

- **佐川急便の照会が、配達済みの荷物も含めてすべて「該当なし」になっていたのを直しました。** 旧追跡ページ（`k2k.sagawa-exp.co.jp`）は、佐川急便が 9 月 30 日に公表した不正アクセスのあと停止し、どのパスも停止のお知らせを返しています。Sora はこのページを読めずに `not_found` を返していました。10 月 23 日に再開した新しいお荷物問い合わせサービス（`https://e-customer.sagawa-exp.co.jp/k2k`）から取得します。
  - 検索は POST 1 回で、Cookie などは送りません。応答から、現在の状態と履歴（日時・担当営業所）を読みます。履歴の先頭の矢印（`↓`・`⇒`）は外します。
  - `details` に、集荷営業所（`origin`）、配達営業所（`destination`）、配達完了日またはお届け予定日（`deliveryDate`、例: `10月23日 18時00分`）が入るようになりました。
  - 読めない応答（停止・保守のページ、想定外の形、受付のエラー）は、`not_found` ではなく `error` を返します。
  - 佐川のサイトの更新で検索の識別子が変わり、拒否（409）されたときは、ページから新しい識別子を取り直して 1 回だけ再試行します。
  - `trackingUrl` は `https://e-customer.sagawa-exp.co.jp/k2k` です。新しいサービスには送り状番号を URL で渡す方法がないため、開いたあとに番号の入力が必要です。利用者に案内するときは、送り状番号も一緒に伝えてください。
- README と API ドキュメント（OpenAPI、MCP の `track_package`）の荷物追跡の説明を、実装に合わせて書き直しました（対応キャリア、キャッシュ、返却項目、佐川急便の注意点、レスポンス例）。

# Sora v2.43.2 — 結果 0 件・使える中身が無い応答を、30 分ではなく 60 秒だけキャッシュする

- 結果が 0 件の応答や、使える中身が無い応答（`search_deep` の `contextSufficiency` が `no-usable-content`）は、取得失敗・ブロック・制限中・描画できなかったページなど、一時的な不調のことが多いのに、他の応答と同じ 30 分キャッシュされていました。不調が直った後も、空の応答が返り続けていました。これらは **60 秒だけ**残すようにしました。キャッシュしない選択ではなく短くしたのは、同じ検索を連打するループが、毎回元に問い合わせるのを防ぐためです。1 分後の再試行は、元に問い合わせ直します。
  - `search_deep`（`POST /search`）: ページも X の投稿も取れていない、または `no-usable-content` の応答。compact も verbose も同じです。
  - `POST /search/web`、Yahoo 系の REST 検索（画像・動画・ニュース・知恵袋・サジェスト）: 結果が 0 件の応答。
  - `scrape`: 本文を読み取れなかった結果（`contentStatus` が `unavailable`）。
  - 制限中・古い結果の `/search/web` 応答は、v2.43.1 のとおり、保存しません。

# Sora v2.43.1 — Yahoo が制限中の空の検索結果をキャッシュしない。GDELT と Bing の取得の不具合を直した

- **`POST /search/web` が、制限中の空の結果を 30 分キャッシュしていたのを直しました。** Yahoo が 429 を返している間、検索元は `throttled` を付けた空の結果（古い結果なら `stale`）を返します。REST はそれをそのまま保存していたので、検索元が回復した後も、空の結果が `cached: true` で返り続けました。保存する前に、`throttled` か `stale` の応答を除くようにしました（その応答は返しますが、保存しません）。本当に 0 件だった検索は、これまでどおり保存します。`noCache` は、読むのも書くのも避けます。MCP の `search_web` は、もともとキャッシュしていません。
- **GDELT の export（国・地域の調査）**: `lastupdate.txt` が、CDN に載る前の最新ファイルを挙げて 404 になることがあり、そのときは取得に失敗していました。404 のとき、15 分ずつ最大 3 スロット前のファイルに戻ります。404 以外の HTTP エラーは、これまでどおりすぐ失敗にします。
- **Bing News（国・地域の調査）**: 同意画面や CAPTCHA は、200 の HTML で返ることがあります。これまでは 0 件に解析され、「ニュースが無い」扱いでした。RSS/Atom ではないページは、取得の失敗（502）として扱います（空のフィードは、これまでどおり 0 件）。
- 実 API 検査（公開と定期）が、外部サービスの一時的な揺れで毎日落ちていたのを直しました（製品の挙動は変わりません）。普段は必ず中身がある取得元の 0 件を取り直す、SNS 取得の応答（`status`・`failures`）で分類する、エラー文の「timed out」「request failed」を上流の不調として扱う、の 3 点です。運用ドキュメントの判定の説明も、実際のコードに合わせました。

# Sora v2.43.0 — 歌詞の取得元に AWA を足した（`lyrics` モジュール）

- `get_lyrics`（MCP）と `POST /lyrics`（REST）が、LRCLIB で見つからない曲を **AWA の公開の曲ページ**からも引くようになりました。引く順は **LRCLIB → AWA → TuneCore の LinkCore** です。`source` に `awa` が入り、`sourceUrl` は AWA の曲ページです。
  - **順番は実測で決めました。** LRCLIB は Web 検索を使わず、主流の曲なら 0.3〜0.6 秒です。AWA は検索 1 回と曲ページ 1〜2 枚で済み、君と見るそらの 18 曲すべてに歌詞がありました（TuneCore は 10 曲。残りの 8 曲は TuneCore に歌詞が無い）。TuneCore は複数のリリースページをたどるので 3.6〜6.7 秒かかりました。AWA を先にすると、AWA で見つかった曲では TuneCore の検索自体をしません（Delight は約 4.8 秒で、LRCLIB で見つからなかった時間を含みます）。
  - AWA の曲ページは、`__NEXT_DATA__` に曲・歌詞全文・同じ歌手の他の曲の一覧を持っています。名前は `site:s.awa.fm` の Web 検索で曲ページに結び付け、探す曲が検索結果に無ければ、見つけたページの一覧から曲 ID を引いて次のページを読みます。
  - AWA と TuneCore は、どちらも Web 検索（Yahoo）で入口を見つけるので、検索が制限されているときは両方とも引きません（`search-unavailable`）。読めなかった取得元は飛ばして、次の取得元へ進みます。候補（`candidates`）は取得元をまたいで重複を除いて返します。
  - AWA の利用規約は、著作権法で認められた私的利用の範囲を超える複製・公衆送信を禁じています。個人利用に限ってください。`lyrics` モジュールは、これまでどおり `ENABLED_MODULES` に名前を挙げたときだけ有効です。

# Sora v2.42.0 — 歌詞全文の取得（`lyrics` モジュール。自己責任の明示オプトイン）を足した

- 歌手／グループ名と曲名から歌詞全文を取得する `get_lyrics`（MCP）と `POST /lyrics`（REST）を足しました。API キーは要りません。
  - **既定では無効です。** `ENABLED_MODULES` に `lyrics` を名前で挙げたときだけ有効になります（例: `ENABLED_MODULES=all,lyrics`）。`all` や未設定では有効になりません。無効のときは、MCP ツールが登録されず、REST は 404（`MODULE_DISABLED`）を返し、OpenAPI・`GET /`・MCP instructions・`search_tools` にも出ません。起動時の処理・常駐タイマー・事前取得はありません。既存のモジュールの挙動は変わりません。
  - **取得元は 2 つ**です。まず LRCLIB（利用者投稿の歌詞データベース。キー不要）を引き、無ければ TuneCore Japan の LinkCore を引きます。LinkCore は地下アイドル・インディーズ向けで、権利者が TuneCore に歌詞を登録した曲だけが対象です（著作権管理団体の管理曲は出ません）。TuneCore 経由で探すには `artist` が必須です。LinkCore の歌詞ページの URL は歌手名・曲名から導けないため、`site:linkco.re` の Web 検索で同じ歌手のリリースを 1 件見つけ、リリースページ同士のリンクをたどって曲を探します。
  - 君と見るそら（TuneCore 配信、18 曲）で検証しました。LRCLIB は 0 曲、LinkCore は 18 曲すべてのトラックを特定し、歌詞は登録のある 10 曲で取得できました（残り 8 曲は TuneCore に歌詞が無く、`no-lyrics-registered` を返します）。
  - 見つからないときは HTTP 200 で `found: false` と `reason`（`no-match` / `no-lyrics-registered` / `search-unavailable`）、`candidates`（表記ゆれの手がかり）を返します。取得元が使えなかった結果はキャッシュしません。LRCLIB には User-Agent で Sora を名乗り、`Retry-After` を守って 1 回だけ再試行します。
  - 歌詞は著作物です。個人利用の範囲で使い、再配布・公開しないでください。応答の `notice` にも同じ注意を入れています。歌ネットは利用規約がスクレイピングを禁じているため使いません。
- `isModuleActive` に「明示指定のみ」のモジュールの一覧を足しました（`lyrics` だけ）。README の REST の例の照合は、`lyrics` を有効にした OpenAPI で行います。
- 型付きクライアント（`client/`）は既定の構成から生成するため、変更はありません。

# Sora v2.41.2 — HTS 推測で、10桁の行を年齢・性別で選び、字下げの飛びで壊れる祖先の説明を直した

- 本番の会話で見つかった不具合を直しました（積み木の一括判定が `needs_more_info` で止まる）。
  - 6桁（玩具の 9503.00）までは正しいのに、10桁が「3歳未満向け」になっていました。判例は改訂前のコードで年齢の区分が無く、全文検索も「blocks」「wood」では木材パネルと区別できません。
  - **年齢・性別の突き合わせ**: 入力の事実（"men's"、"aged 3+"、"toddler"、`targetAge`）と、候補の行の公式の説明文（"Men's (338)"、"Under 3 years of age"）を突き合わせます。年齢で分かれるのは玩具だけでなく **72 の6桁**（アパレルの男女区分、靴の男女区分、子供用家具など）にあり、品目別の表は持ちません。合う行があれば選び、合わない行は外します。確定できたときは理由に書き、信頼度にも反映します（`low` を避ける）。積み木（3歳以上）は `9503.00.00.73`（3〜12歳向け）になり、一括判定も先に進みます。
  - **字下げの読み替え**: USITC の字下げが中間の段を飛ばすことがあり（`[3]` の下にいきなり `[5]`）、無関係な兄弟行が祖先の説明に入っていました。「直前の行より1つ深い」と読むようにし、全文検索の順位と `officialPath`・`decisionPoints` の文言を正しくしました。
- 評価は変わりません（150 件で 1 位の 6 桁の一致 72.0%、保留 68.1%。10 桁の選択は測っていません）。

# Sora v2.41.1 — HTS 推測で、具体的な語の判例が捨てられる不具合と、否定された語が検索語になる不具合を直した

- 本番の会話で見つかった不具合を直しました（PU レザーのコースターを、無関係な 6304.93（織物）や錫箔などに分類していた）。
  - **判例の集め方**: 照会語を絞りながら試す際、「3件以上の結果が出た最初の語」だけを使っていたため、`leather coaster`（革製品 4205.00 の判例が 2 件）が捨てられ、132 件ヒットの `coaster` だけが使われていました。具体的な語の判例を先頭に残し、足りない分を一般的な語で 10 件まで補います。`evidence.crossQuery` は、使った照会語を ` / ` でつないで返します。
  - **否定された語**: 商品説明の "Not textile, not tin foil, not ceramic" のような否定を、検索語として扱っていました（箔・陶器・靴の候補が出た）。`not` / `no` / `without` / `excluding` / `except` に続く語と `non-` 語を、検索から外します。`description` の説明にも書きました。
  - **日本語の商品ページ**: `/trade/compliance` で、ページの名称・説明が日本語のとき、「該当なし」ではなく、英語の一般名にして再実行するよう伝えます。
  - **素材つきの照会**: `material` を指定しても、判例の検索語に使っていませんでした。`material` があれば、素材つきの照会（`plastic coaster`）を最も具体的なものとして先頭で試します（`coaster` の上位 10 件に無い 3924.10 の判例に当たる）。`material: "plastic"` を渡したコースターは `3924.10.40.00` になります。
  - **素材の質問**: 確度が `high` でなく `material` が未指定のとき、`material` を指定して再実行するよう案内する質問を返します（CPSC が同じ素材を尋ねるときは、1つにまとめます）。
- 評価は変わりません（150 件で 1 位の 6 桁の一致 72.0%、保留 68.1%）。コースターは `6304.93` から `4205.00.80.00`（`medium`）になります。
- 型付きクライアント（`client/`）を再生成しました。

# Sora v2.41.0 — HTS コード推測を、USITC 公式 HTS 全件の全文検索と CBP 分類判例の統合に替えた

- **`predict_hts_code`（`POST /trade/hts-predict`）の精度を上げました。** 品目ごとの規則表（約30品目の正規表現）をやめ、公式の二つのデータを6桁の単位で統合します。代表的な輸出品150件（英語）で、1位の6桁の一致が 18.0% → **72.0%**、調整に使っていない保留の47件では 6.4% → **68.1%** です。候補（上位5つの6桁）の中に正解がある割合は 89.3%（保留 85.1%）です。評価の方法と外れた事例は `docs/evaluations/hts-predict/results.md` にあります。評価は6桁までで、10桁の選択は測っていません。
  - **USITC の HTS 全件**: 初回の呼び出しで全件（約 12MB）を取得し、SQLite に保存します（`SORA_HTS_DIR`、約 21MB）。説明だけの中間行も含む完全な木として持ち、各行に祖先の説明（`path`）を付けて全文検索します（FTS5）。
  - **CBP の分類判例（CROSS）**: 普段の言葉と法令の用語をつなぎます。呼ばれたときだけ照会し、24 時間キャッシュします。判例が挙げるコードは現行の木で照合し、改訂で番号が変わったもの（9503.30 → 9503.00、9405.20 → 9405.21・9405.29）は現行の6桁へ振り分けます。落ちているときは全文検索だけで答えます（精度は約半分、`confidence` は `high` にならない）。`evidence.crossStatus` で分かります。
  - 以前の実装は、規則表に無い品目をすべて 3926.90（プラスチック製品）にし、正規表現が語の一部にも当たる（steel の中の tee で腕時計が T シャツ、clip の中の lip でヘアクリップが口紅）ため、`confidence` が実績と合いませんでした（high 16 件中 8 件が的中）。
  - `confidence` は実績に合うようにしました（評価で `high` の的中 94%、`medium` 79%、`low` 43%）。
  - 候補が公式の階層で分かれるときは、**公式の説明文を選択肢にした質問**（`decisionPoints`）を返します。答えとなる区分の語を `description` に加えて再実行すると絞れます。
- **一般関税率の継承を直しました。** 以前は、10桁の行に率が無いと見出し行の率（多くは空）にし、`Free` と答えていました。10桁の全 19,831 行のうち 7,539 行で率が違いました（陶器のマグが 9.8% のところ `Free`）。最も近い祖先の率を継承し、どの行から継いだかを `rateFrom` に返します。
- **`verify_hts_code`（`POST /trade/hts-verify`）**: 同じ HTS 全件のコピーで照合します。公式の階層での位置（`officialPath`）を返し、8桁の行にこれより細かい行があるときは10桁の確定を促します。
- **`check_product_compliance`（`POST /trade/compliance`）**: キーワード表の既定コードをやめ、`htsCode` が無ければ推測の結果を使います。素材と用途を指定した "Ceramic Coffee Mug" が coffee に反応して食品（2106.90）と判定され、FDA の事前通知が案内される誤りがなくなります。
- 運用:
  - HTS 全件は、`/trade/hts-predict`・`/trade/hts-verify`・`/trade/compliance` が初めて呼ばれたときだけ取得します（約 20 秒）。起動時の取得や常駐処理はありません。7 日を過ぎると次の利用時に裏で更新し、失敗したときは古いコピーのまま答えます。
  - 判例の照会は商品名を絞りながら最大 5 回、順に行います（中央値 0.33 秒、同じ商品の再問い合わせは約 50 ms）。
- **応答の形と動作が変わります**:
  - **入力は英語です。** HTS も判例も英語なので、`productName` と `description` は商品の一般名の英語で渡します（MCP の説明にも書きました）。英語の語が無い入力は、`/trade/hts-predict` が `400 INVALID_INPUT`、`/trade/compliance` が `needs_more_info`（英訳を促す質問）です。
  - `/trade/hts-predict` に項目を足しました: `decisionPoints`、`evidence`、`bestMatch.path`・`rateFrom`、`candidates[].path`・`sources`。`missingInputs` に `classificationDetail` が加わることがあります。`category` は最有力の行の公式の見出しの説明になります（以前は "Toys" などの固定の名前）。`candidates` は異なる6桁ごとの代表の行（最大5件）です。
  - `/trade/hts-predict` は、キーワードによる質問（電池・食品接触・素材・年齢）をやめました。CPSC・FDA の判定が実際に必要とした情報だけを `missingInputs` と `clarifyingQuestions` に返します。
  - `/trade/compliance` は、`targetAge` と `material` を文章から推定しなくなりました。呼び出し側が渡した値だけを使います。分類の確度が `low` のときは、既定のコードで進めず `needs_more_info` を返します。ボタン電池は `hasBattery` と `batteryType: "button_coin"` を渡したときだけ、CPSC の Reese's Law（16 CFR 1263）の確認を `actionPlan` に足します（HTS を差し替えなくなりました）。
- 品質:
  - 評価セット（`eval/hts_predict_cases.json`、150件）と評価スクリプト（`scripts/eval-hts-predict.ts`）を足しました。dev で調整し、test と保留で確かめます。
  - テストの USITC の応答を、実際の関税率表の抜粋と判例の応答の抜粋（`src/test_fixtures`）に替えました。推測の組み立てのテストを `src/services/trade.test.ts` に、取得・検索のテストを `hts_data.test.ts`、`cbp_cross.test.ts` に足しました。
  - tool-health の `trade.predict` は、緑茶が 0902 か 2101 に分類されること、`evidence` の形まで確かめます。
- 型付きクライアント（）を、新しい応答項目に合わせて再生成しました。

# Sora v2.40.1 — コードを実行できる LLM を型付きクライアントへ誘導、スキルの配布を修正

- コードを実行できる LLM が、型付きクライアント（`GET /client`）を優先して使えるようにしました。
  - instructions に「コードを実行できるならクライアントを使い、必要な項目だけ出力する」という一行を足しました。
  - `search_tools` の応答の末尾に、同じ案内を付けました。
  - 新しいスキル `sora-client`（取得手順・使い方・絞り方）を、MCP リソース `sora-skill://sora-client`、プラグイン `sora-deep-research`、生成クライアントの `client/SKILL.md` で配ります。
- 修正: 深層調査スキルの MCP リソース `sora-skill://sora-deep-research` は、これまで本番のイメージでは配られていませんでした（スキルのファイルがイメージに入っておらず、読む場所もバンドル後の配置と合っていませんでした）。イメージに同梱し、読む場所を直しました。
- 整理: 評価実験用の古い試案 `docs/skills/sora-research` を廃止し、`plugins/sora-deep-research` に一本化しました（固有だった「曖昧さの扱い」は取り込みました）。MCP リソースの登録は `src/mcp/resources.ts` に集約しました。

# Sora v2.40.0 — コード実行環境向けの型付きクライアントと、search_tools の段階的な開示

- `search_tools` に任意引数を足しました。`detail`（`names` / `summary` / `schema`）で返す詳しさを選べ、`activate: false` で有効化せずに調べるだけにできます。引数なしの動きと出力は従来どおりです。
- 型付き TypeScript クライアント（全ツール分、`client/`）を `GET /client`（ファイル一覧）と `GET /client/<path>` で配ります。コード実行環境で結果の絞り込みや連鎖をコード側で行い、モデルには必要な分だけ返せます（`search_deep` 上位 3 件で 27,892 → 934 文字）。認証は他の REST と同じです。使い方と実測は `docs/code-execution.md`。
- `tools/list` の大きさ（既定 14 ツール・全 50 ツール）を、実際の HTTP 経路で測って守るテストを足しました。
- 内部の整理（動作は変わりません）: ツール登録をモジュール別のファイルに分け、どこからも使われないコードを削除し、Yahoo 検索のオプションに型を付けました。`tools/list` と OpenAPI は、追加分を除いて整理の前後でバイト単位で同じです。

# Sora v2.39.2 — 座標の無い地番の補完、zipcode での市区町村の補完

- `normalize_address` の `zipcode` パラメータでも、住所に市区町村が無いとき（level 0）、その郵便番号の市区町村を補って解決するようにしました（これまでは住所の先頭に書いた郵便番号だけ）。複数の市区町村にまたがる番号、見つからない番号には補いません。
- ABR の地番は、座標（位置参照）が付いているのが一部だけです（確認した20市区町村で約41%。山形県天童市8%、東京都府中市と千葉県八街市は0.3%）。座標の無い地番で照合できたときは、同じ本番の国土交通省の街区の点で `point` を補います（`point.level: 7`、`pointSource: "mlit"`。`numberSource` は `chiban` のまま）。
- `reverse_geocode` は、ABR の番地・号の点が範囲内に無いときだけ、国土交通省の街区の点を候補にします（`numberSource: "mlit"`、`point.level: 7`）。ABR の点があれば ABR が優先です。地番の街区は近くの複数の番地が1つの代表点を共有するため、共有された点は使いません。点は街区の近似で、番地の特定ではありません。
- MCP の説明とスキーマに、`numberSource`（`mlit` は街区まで・号は未照合）と、座標の精度を示す `point.level` の意味を書きました。
- 公開前の実 API 検査に、街区データで補う住所、`zipcode` で補う住所、座標の無い地番のケースを足しました。

# Sora v2.39.1 — v2.39.0 の公開前検査を通す修正（住所機能は v2.39.0 の内容を含む）

- v2.39.0 は、公開前の実 API 検査の施設検索（`geo.poi`）が外部の OpenPOI API の動きの変化で止まり、イメージもリリースも公開されていません。キーワード付き（例: 「ラーメン」）の検索で、半径を指定しても 6〜14km 先の施設が返るようになったためです（キーワードなしの検索は半径内のままで、2026-10-14 に確認、10 分以上変わらず）。Sora の `search_poi` の動きは変わっていません。
- 公開前の実 API 検査の施設検索を、キーワードなし（中心の地名と半径だけ）に変えました。中心の解決・出典・各施設が半径内にあることの検査はそのままです。
- v2.39.0 の内容（下記）はすべて含みます。

# Sora v2.39.0 — 住所の正規化・郵便番号・逆ジオコーディングを追加

- 住所のツールを 3 つ追加しました（MCP は `search_postal_code`・`normalize_address`・`reverse_geocode`、REST は `/geo/postal-code`・`/geo/address/normalize`・`/geo/reverse`）。ツール数は 47 から 50 になります。外部のジオコーディング API には頼らず、デジタル庁のアドレス・ベース・レジストリ（ABR）と日本郵便の郵便番号データ（一般と事業所）を一次データとして、Sora が自分で取得して使います。
  - `search_postal_code`: 郵便番号から住所の候補を、住所から郵便番号を引きます（座標つき）。
  - `normalize_address`: 住所を番地・号まで正規化し、結合キー・代表点・郵便番号を返します。郵便番号・座標・別の住所との突き合わせ（`checks`）もできます。
  - `reverse_geocode`: 緯度経度から最寄りの住所（住居表示または地番）を返します。
- **使わない環境には何も起こりません。** サーバー起動時の通信・取得・子プロセスはなく、データは市区町村単位で、使われたときだけ取得・構築します（別プロセス・低優先度）。保存先は `SORA_ADDRESS_DIR`（既定は DB と同じ場所の `address/`）、予算は `SORA_ADDRESS_MAX_MB`（既定 2048）で、超えたら古い市区町村から破棄します。`SORA_ADDRESS=off` で 3 ツールを登録しません。詳細は `docs/operations/address-data.md`。
- `get_elevation` と `search_poi` の座標解決は、住所と郵便番号について、取得済みのデータがあればそれを優先します（`geocodingSource: "abr"`）。番地・号が入力にあるのにその点を得られないときは、町字の代表点を返さず、従来の経路（Nominatim → 国土地理院）に回します。地名・駅名・施設名は従来どおりです。`search_poi` の `withAddress` で、各施設の住所を正規化して座標と突き合わせられます。データが揃う前に調べた施設は `addressIncomplete` で分かります。
- ABR で番地・号に届かない住所は、国土交通省の街区レベル位置参照情報で街区符号まで補います（`numberSource: "mlit"`、`point.level: 7`。号は未照合）。住所が解釈できず先頭に 7 桁の郵便番号があるときは、郵便番号から市区町村を補います。街区表記（`6街区21号`）、`線`・`号`・`番` の前の漢数字、葦と芦の異体字は言い換えて再試行します。
- 結果には出典と加工した旨が付きます。地番を使った結果には法務省の登記所備付地図データの出典、街区データを使った結果には国土交通省の出典も付きます。
- `SORA_ADDRESS_PRELOAD`（都道府県コードまたは `all`）で、運用者が事前取得を選べます。指定したときだけ、起動の 10 秒後から低優先度で取得し、予算を超えても破棄しません。実測は鳥取県 28 秒・72MB、東京都 73 秒・109MB です。
- 注意: ABR の配信元は国外 IP からの接続を拒否します。国外のホストでは `SORA_ADDRESS=off` にするか、国内で構築したデータを使ってください。

# Sora v2.38.0 — X 検索で守る固有名詞を指定できるように

- X 検索で守る固有名詞を、呼び出し側から指定できるようにしました（`search_realtime` と `POST /search/realtime` の `anchor`、`search_deep` と `POST /search` の `realtimeAnchor`。100 字まで）。指定がクエリの語に対応すれば推定より優先し、緩和検索でその語を落としません。判定のための Web 検索と X の総ヒット数の取得も省きます。照合では空白・中黒・全角を無視し、複数語の名前（「Snow Man」）はそれに含まれる語に対応づけます。クエリの語に無い指定は無視して、従来どおり推定します。
  - 固有名詞の推定は、意図語・汎用語の語彙と X の総ヒット数に頼っています。語彙は手入れが要り、総ヒット数では見分けられない語もあります（「出演時間」386 件と「君と見るそら」401 件）。クエリの意味が分かる呼び出し側の LLM に任せれば、語彙を足さずに辞書にない新しい名前や記号入りの名前も守れます。
  - 汎用語の語彙を X の総ヒット数による判定に置き換える案も評価セットで試しましたが、採りませんでした。語彙を外すと dev の正解が 26 → 22 に下がり、「ほかより飛び抜けて多い語を外す」規則では「iPhone 重量 Wi-Fi 規格」の iPhone（11,421 件）が外れて誤った語を選ぶためです。語彙は推定の予備として残します。
- MCP の instructions、README、仕組み文書、SKILL.md、`POST /search` の API 説明に使い方を追記しました。
- X 検索のキャッシュキー（`search_realtime`・`search_deep`）に指定を含めました。指定しない呼び出しの結果は変わりません。
- MCP のツール定義と instructions を全体で見直しました。
  - 「返却」の中身が実際の応答と違っていた5ツールを直しました（`search_route` の `routes[]`、`search_earthquake` の震源 `hypocenter` と最大震度 `maxScale`、`search_song` の `title`・`artist`・`artwork`、`search_laws` の `promulgationDate`、`search_diet_minutes` の `meeting`・`speech`・`speechUrl`）。表記の検査（`schema:notation`）が、返却の入れ子のキーまで REST の応答スキーマと照合するようにしました。
  - 「返却」の無かったツールに返却を書きました（`scrape`、`scrape_batch`、`search_deep`、`search_web`、`map_site`、`crawl_site`、`fetch_social_post`、`browser_action`、`search_image`、`search_video`、`watch_*` の4つ、国地域レポートの取得3つ、`search_tools`）。国地域レポートの取得3つには見出し（【…】）を付け、短すぎた説明（画像・動画検索、監視、一括スクレイプなど）に用途と使い分けを足しました。最初に見える14ツールの説明の合計は 3,500 字の上限内（3,473 字）です。
  - instructions に名前の無かった13ツール（`map_site`、`search_news`、`search_image`、`search_video`、`fetch_x_post`、`watch_*` の4つ、`inspect_image`、国地域レポートの取得3つ）を載せました。重複した言い回しを削り、8,500 字の上限内（8,465 字）に収めています。
  - `research_country_context` の `social` の引数（`platforms`、`queries`、`urls`、`lookbackHours`）に説明を足しました（`lookbackHours` の既定は 24 時間）。REST の `/realtime/post` の応答スキーマに `detail.author` と `detail.media` を足しました。
- README の REST の応答例を、実際の応答に合わせて直しました（`/browser/action` は `markdown`・`actionOutputs`、`/transit/route` は `routeCount`・`routes[].index`・`totalTime`・`transfers`、`/tracking` は `events`・`trackingUrl`・`details`）。`/weather` は README の例が正しく、OpenAPI の応答スキーマに `publicTime`・`publishingOffice`・`location`・`description`・`link`・`cached` が抜けていたため足しました。`/browser/action` の `actionOutputs[].step` の説明（0 始まり）は実装どおり 1 始まりに直しました。
- 応答のトークンを減らしました。**応答の形が変わります**:
  - MCP のすべてのツールの応答を整形なし（字下げなし）の JSON にしました。以前は `search_deep` と `search_realtime` だけでした。`verbose` を持つツール（`scrape`・`scrape_batch`・`search_deep`・`search_realtime`・`research_country_context`）は `verbose: true` のときだけ整形します。README の応答例 23 個で測ると文字数は約 2 割減ります（本文の長い応答ほど減る割合は小さく、`search_deep` の実測では約 1 割でした）。応答の文字列を字下げ込みで照合しているクライアントは、JSON として読むようにしてください。
  - `browser_action`（`POST /browser/action`）の応答から、重複していた `content`（`markdown` と同じ本文）と `actionLogs`（`actionOutputs` と同じ操作の記録）を外しました。本文の長いページでは応答がほぼ半分になります。`content` を読んでいたクライアントは `markdown` を、`actionLogs` を読んでいたクライアントは `actionOutputs`（成功は `result: "ok"`、失敗は `error` に理由）を参照してください。
- 検索系の REST の入力を、既存のリクエストスキーマ（OpenAPI と同じもの）で検証するようにしました（`/search/realtime`・`/realtime`、`/search/image`、`/search/video`、`/search/news`、`/search/chiebukuro`、`/search/suggest`）。**スキーマ外の値は 400 になります**: 文字列の `limit`、文字列でない `query`（`/search/realtime` はこれまで黙って無視していました）、100 を超える `page` などです。エラーの文言と状態コードは従来どおりで、`/search/realtime` の `page` の文言だけ `page must be an integer 1-100` に変えました。
- `scrape`・`scrape_batch` の `extractCitations` で、同じサイト内の相対リンク（`/news/1` など）が出典から落ちていた不具合を直しました。ページの URL で絶対 URL に直して含めます。ページ内アンカー（`#...`）と `mailto:`・`javascript:` のリンクは含めません。
- 静的取得（wreq）が `NO_PROXY` を無視し、`HTTPS_PROXY` を設定した環境で localhost や社内ホストへの通信もプロキシへ送っていた不具合を直しました（ホスト名・サブドメイン・`*`・IP・IPv4 CIDR に対応。明示指定の `proxyUrl` はそのまま使います）。
- 品質の改善（動きは変わりません）:
  - テストを外部ネットワークに依存させないようにしました。外部 API は固定応答で確かめ、特定の日付の実データを見るテストは `SORA_LIVE_TESTS` のときだけ走らせます。CI の Bun（1.4.2）と Chrome（141）の版を固定しました。
  - ドキュメントと実装の食い違いを CI で検出するようにしました。README の REST の例を OpenAPI と照合し、実際の応答の全キーが OpenAPI の 200 応答スキーマにあるかを確かめます。これで見つけた抜け（`/health?detailed=true`・`/metrics` の項目、キャッシュ応答の `cached`・`cachedAt`・`ageSeconds`）を OpenAPI に足しました。
  - 使われていないコードと依存（`@hono/mcp`）を削除し、`noUnusedLocals` を有効にしました。MCP のツール処理と REST の入口の `any` を減らしました（src 全体で 577 → 382）。
  - Biome の lint を入れ、CI で実行するようにしました（書式は対象外）。
- 公開前の実 API 検査（tool-health）を見直しました:
  - 公開を止めるのは、取得できたのに中身が壊れているとき（構造変化・解析失敗）、確認できないツールがあるとき、検査の 25% を超えて外部に繋がらないとき（こちら側の故障とみなす）です。外部の一時的な不調（タイムアウト・5xx・429）だけでは止めず、レポートに残します。
  - 普段は必ず中身がある取得元（急上昇一覧、大手のニュース・RSS、World Bank など）が 0 件のときは、構造変化として失敗にします。項目の確認は先頭の1件ではなく全体の 8 割で見ます。
  - 通らなかった項目と理由を、CI のログと Summary に出すようにしました。

# Sora v2.37.4 — 本番で見つけた2件の修正（verbose の予定表示、先頭ナビの扱い）

- v2.37.3 は本番に入れて公開スモークまで回しましたが、次の2件を見つけたため本番には入れず、そのまま直した v2.37.4 を出します。
  - `verbose: true` の `search_deep` は `results[].events` を残す説明でしたが、実装では `schedule` も付かず `results[].events` も外れていました（通常応答の整形が誤って `verbose` にも掛かっていた）。`verbose` では整形をかけず `results[].events` のまま返すよう直しました。
  - `maxTotalChars` の切り詰めで `equal-love.jp` のように先頭に長いナビがあるページは、本文が全部落ちてナビだけ残っていました。一度は「後ろへ回す」方式にしましたが、逆にナビが残るため、ページ先頭のナビは動かさず先頭切り取りで落とす方式に直しました。



- v2.37.0 と v2.37.1 は公開前の検査で止まり、イメージもリリースも公開されていません。v2.37.0 は実 API 検査（楽天トラベルのホテル検索）、v2.37.1 は全件テスト（CI が使う新しい Bun で、環境変数を書き換えたテストの後始末が不十分だったため、後続テストの通信が架空のプロキシへ向かった）で止まりました。v2.37.2 は公開されましたが、本番へ入れる前の検証で固有名詞判定の改善点が見つかったため、本番には入れていません。v2.37.3 はこれらの変更をすべて含み、固有名詞判定を直したものです。
- 実験的なホテル検索（MCP の `search_hotel_availability`、REST の `POST /hotels/availability`、有効化フラグ `SORA_RAKUTEN_TRAVEL_ENABLED`）を廃止しました。楽天トラベルの公開検索に依存し、外部の応答次第で公開前の検査が止まっていたためです。既定では公開されていなかった機能なので、既定のツール数（47）は変わりません。公開前の実 API 検査からホテルのレーンも外しました。
- `search_deep` の通常応答に `schedule` を追加しました。上位ページの `events`（公式サイト・TimeTree・まとめサイトなど）から、開始日（JST）と名称が同じ予定を 1 件にまとめた一覧で、`results` の前に置きます。各予定に載せていたページの URL を `sources` で示し、開催中・今後の予定は近い順、過去の予定はその後ろに並べます（予定は削除しません）。名称が違えば同日・同会場でも別の予定として残します。**応答の形が変わります**: 通常応答ではページごとの `results[].events` は `schedule` に移ります（重複を避けるため）。`verbose: true` では従来どおり `results[].events` に入り、`schedule` は付きません。`maxTotalChars` の対象外です。
- Markdown 冒頭の「📅 イベント情報」が、先頭 1 件だけから、開催中・今後の予定を近い順に（過去の予定はその後ろに）最大 10 件を 1 件 1 行で並べる形になりました。超えた分は「ほか N 件」と件数で示します。以前は TimeTree のように過去の予定が先頭にあると、それだけが出ていました。`events` は従来どおり抽出順で全件を返します。
- `maxTotalChars` で本文を切り詰めるとき、本文の塊を先に残し、短いラベル（16 字以下）のリンクだけの塊（グローバルナビなど）を先に落とすようにしました。ページの先頭にナビがあると、取り分の小さい結果がナビだけになり本文が消えていました（equal-love.jp の例: 4,624 字中 218 字がフロントマターとナビだけ）。本文だけでは空同然にしかならない場合は、従来どおり先頭側を残して切ります。ラベルの長いリンク一覧（ニュース・予定）は本文として扱います。
- X 検索の固有名詞（anchor）の判定を見直しました。語彙は追加していません。サイト名の枠（タイトル末尾）に出る語を重く数え、得点がほぼ同点（最高得点の 85% 以上）の語の中に X の総ヒット数が 3 分の 1 以下の語があればそちらを選びます（クエリに含まれる一般語はタイトルにも出やすいため。本番前の検証で「ライブ 予定 =LOVE」がライブと =LOVE のほぼ同点になり、旧版も含めて別名検索に進めなかったのを直しました）。それ以外で**確信が持てないときは決めません**（従来の緩和検索に任せます）: 最高得点が同点のとき、および X の総ヒット数が全候補分あり、最高得点の語が他のクエリ語より明らかにありふれている（少ない側の半分にも、最少の語の 1.25 倍以内にも入らない）ときです。「Web API デジタル庁」で API を、「アイドルフェス 持ち物 注意点」で持ち物を固有名詞と取り違えていた誤りがなくなりました。評価セット（dev と held の 53 クエリ。上の実データを dev に追加）は 正解 50・決めない 3・誤り 0 です（旧版は 52 クエリで 正解 48・誤り 4。決めない 3 件は固有名詞のないクエリ）。方式を決めた後に、正解を先に決めて集めた検証セット held2（16 クエリ）は、正解 9・決めない 5・誤り 2 でした。誤りは固有名詞なしと決めていた「前方エリア 一般エリア 違い フェス」で「前方エリア」を選んだものです。固有名詞を含むクエリで誤った語を選んだ例はありません。`SORA_REALTIME_ANCHOR=off` で従来の動作に戻せます。
- `search_deep`（`POST /search`）に `includeMedia` を追加しました。`false` で、画像・動画の URL（X 投稿の `media`、各ページの `ogImage` と `media`、本文中の画像記法。alt があれば「[画像: alt]」に置き換え）を応答から省きます。既定は `true`（従来どおり含める）です。`formats` で明示した `images` と `highlights` は省きません。
- `twitterHandle` を、メタタグ（`twitter:site` / `twitter:creator`）で宣言されたアカウントだけにしました。以前は、メタタグが無いと本文中で最初に見つかった x.com のリンクを使っていたため、まとめサイトのフッターにある開発者のアカウントが「公式」の候補になっていました。本文中のリンクは `socialLinks` にだけ残ります。**影響**: メタタグを持たない公式サイトでは、ページ由来の公式 X が決まらなくなります。その場合の `search_deep` の公式枠は、`officialAccountId` の指定か、クエリの固有名詞から Web 検索結果で見つけたアカウントで決まります。
- GitHub Actions の Live tool health の定期実行（毎日）が、2026-10-02 の追加以降ずっと失敗していた問題を直しました。定期実行・手動実行では候補イメージのタグが空になり、実行が始まる前に終了していました。公開時の検査には影響していませんでした。
- MCP の instructions と `POST /search` の API 説明に、`schedule` と `includeMedia` の使い方を追記しました。README の `scrape` 応答例を実際の出力形式（「📍 階層」「📅 イベント情報」の行）に合わせました。
- スクレイプと深層検索のキャッシュ名前空間を更新しました。デプロイ後に旧版の応答が返り続けないためです。

# Sora v2.36.1 — X 検索の誤りの修正と、応答の削減

- X のプロフィールページ（`x.com/アカウント名`）の本文が、別人の投稿にすり替わる不具合を修正しました。タイトルの整形が「＝LOVE_official」を「＝LOVE_off」に切り、無関係な投稿（「LOVE off vocal」）を本文に採用していました。アカウント名が分かれば、そのアカウント本人の投稿（`id:`）だけを使います。
- `search_realtime` と `search_deep` で、1件だけ全語に一致する投稿があると「網羅できた」と判断して検索を終える問題を直しました。全角の「＝LOVE」と書いた1件が全語に一致し、残り19件が記号を無視された別物でも、別名での再検索に進んでいませんでした。全語を含む投稿が半数未満（6件以上のとき）は、固有名詞が壊れていないか確かめます。語が1つだけのクエリ（`=LOVE`）でも別名で検索します。
- 誰の投稿を優先するかを選べるようにしました（`search_realtime` の `focus`、`search_deep` の `realtimeFocus`。`official`＝本人・公式、`public`＝本人以外）。省略時はクエリの語（評判・口コミ・感想・反応・炎上・批判など）から判定し、無ければ従来どおり公式優先です。`public` では評判系の語を必須にせず、投稿にほぼ書かれない語（評判・口コミ）は検索語から外し（「内山優花 評判」は0件、「内山優花」は250件でした）、`search_deep` の公式枠は後ろに最大2件へ下げます。応答の `focus` に適用した方が入ります。`search_deep` の `realtime.intent`（事実系・評判系・どちらとも言えない。結果の並びには使っていませんでした）は、`focus` に置き換えて応答から外しました（`intent` を読んでいるクライアントは `focus` を参照してください）。使われていなかった古い並べ替えのコードも削除しています。
- `search_deep` の公式枠で、自動で見つけたアカウントは、表示名か最近の投稿（3割以上）にクエリの語がある場合だけ公式として扱うようにしました（クエリと無関係なページの X 欄、例えば TimeTree のページの TimeTree 自身のアカウントを使わないため）。`officialAccountId` を指定したときは確認しません。
- 返す X 投稿の上限を `search_realtime` の `limit`（既定20）と `search_deep` の `realtimeLimit`（既定20、公式の枠は別）にそろえました。以前は複数の検索をまとめた結果が上限を超えていました。上限は返す件数にだけ効き、上限内のどの投稿にも無いクエリ語を含む投稿は、上限を超えて最大5件まで残します。省いた件数は `omittedCount` で返します。
- 応答を小さくしました。MCP の `search_deep` と `search_realtime` を整形なしの JSON にし（`verbose: true` のみ整形。同じ内容で約10%少ないトークン）、X 投稿の 0 の反応数と `isOfficial: false` を省き、別のページと同じハイライト（PC版とスマホ版など）の2つ目以降を `highlightsSameAs`（先の結果の URL）に置き換えます。「=LOVE ライブ 予定」の深層検索の一例では 30,084 → 18,869 トークンでした（Web 結果は検索のたびに変わります）。
- 固有名詞の判定で使う X の総ヒット数の取得を、既定の件数に直しました（1件だけ取ると「内山優花」が 250 件のところ 6 件と過少に返っていました）。
- `search_deep` のキャッシュ名前空間を更新しました。デプロイ後に旧版の応答が返り続けないためです。

# Sora v2.36.0 — X 検索のノイズ削減（固有名詞を守る緩和と別名検索）

- `search_realtime` と `search_deep` の X 検索で、原式で全語の揃う投稿が無いときの再検索を見直しました。従来は語を1つずつ落として再検索する際に固有名詞まで落とし、「ライブ 予定」のような無関係な投稿を大量に返していました。Web 検索上位のタイトルと X の総ヒット数から固有名詞を判定し、固有名詞を落とす再検索をしないようにしました（語順は問いません）。最後の再検索は、不足語の単独検索の代わりに固有名詞だけで行います。
- Yahoo が記号を無視して別物を返す固有名詞（`=LOVE` が「LOVE」一般の投稿になる等）は、公式 X アカウントの投稿のハッシュタグから別名（`イコラブ`）を見つけて検索し、固有名詞も別名も含まない投稿を除きます。`search_deep` の公式枠も固有名詞の公式にそろえます（「ライブ 予定 =LOVE」でラブライブ!の公式アカウントを公式枠にしていた不具合の修正）。
- 評価セットの12クエリの実測で、固有名詞か別名を含む投稿の割合が 24% → 100%、X への検索回数が 38 → 30 回になりました。判定に Web 検索を1回使うため、緩和が必要なクエリでは所要時間が約 0.4〜1.3 秒増えます（原式で揃うクエリは変わりません）。`SORA_REALTIME_ANCHOR=off` で従来の動作に戻せます。
- `missingTerms`（1件の投稿に揃わなかったクエリ語。空なら省略）と `aliasTerms`（検索に使った別名）を通常応答にも含めました。OpenAPI と MCP のツール説明にも反映しています。判定した固有名詞（`anchorTerm`）と除外件数（`anchorFiltered`）は `verbose: true` のときだけ返します。
- X 検索の網羅判定を NFKC で行うようにしました（全角の「＝ＬＯＶＥ」も =LOVE として扱います）。
- コンテナで共有 Chromium を閉じた後に、補助プロセスがゾンビとして残り続ける不具合を修正しました（v2.35.0 の無操作時の解放で発生）。イメージに tini を入れて PID 1 にし、孤児になったプロセスを回収します。起動コマンドと公開ポートは変わりません。
- `includeDomains` / `excludeDomains` に空文字列（API ドキュメントの入力フォームが送る `[""]`）があると Web 検索が0件になる不具合を修正しました。
- テストの各ファイルの終了時に共有 Chromium を閉じるようにしました。テスト実行後に Chromium が残ってメモリを圧迫していたためで、本番の動作は変わりません。
- 固有名詞判定の評価セット（`eval/realtime_anchor_cases.json`。設計に使った dev 28 クエリと、設計後に集めた held 24 クエリ）と評価スクリプト（`scripts/eval-realtime-anchor.ts`）を追加しました。判定精度は dev 24/28・held 24/24 です。
- `search_deep` のキャッシュ名前空間を更新しました。デプロイ後に旧版の応答が返り続けないためです。

# Sora v2.35.0 — 検索の待ち時間とコンテキスト量の削減、Chromium のメモリ解放

- MCP の `tools/list` から `outputSchema` を既定で除外しました（全47ツールで約245KB → 約82KB）。stdio も同様です。`tools/call` の構造化出力と検証は変わりません。従来どおり含めたい場合は `SORA_TOOL_OUTPUT_SCHEMA=true` を指定してください。
- `search_deep`（`POST /search`）に、本文合計の上限 `maxTotalChars` と、遅いページの打ち切り `scrapeDeadlineMs` を追加しました。どちらも明示した場合だけ働きます（`scrapeDeadlineMs` の既定は無効）。切り詰めた結果には `markdownTruncated`、打ち切った結果には `deadlineExceeded` が付き、`highlights` は削りません。
- 応答に `contextSufficiency`（根拠が足りているかの信号）を追加しました。応答内容は変わりません。`partial` / `insufficient` の `reasons`（`unmentioned:語` / `unanswered:語` / `few-success`）は不足の根拠になりますが、`no_gap_detected` は十分の保証ではありません。MCP の instructions と OpenAPI にも反映しています。
- ブラウザ描画の待機を改善しました。`networkidle` が来ないページは `load` 後5秒で打ち切り、DOM 静止の判定は DOM の変化ではなく見えている本文の変化で行います。属性だけを書き換え続けるページ（多言語化ウィジェットなど）で上限まで待たなくなり、実サイトの例で約9秒 → 約4秒になりました。取得した本文は変更前と一致しています。
- 共有 Chromium を、無操作5分（`BROWSER_IDLE_TTL_MS`、`0` で無効）で自動的に閉じるようにしました。実測で、描画中の約950MBが解放後は約200MBに戻ります。ブラウザセッションなどが開いている間は閉じません。
- `MAX_CONCURRENT_BROWSERS` の既定を、利用可能メモリ（cgroup の上限、無ければ搭載メモリ）から1〜5で自動算出するようにしました。明示した正の整数が優先されます。数値でない値を指定するとブラウザ描画が永久に待つ不具合を修正しました。
- 回答値の判定で、見出し文（「■チケット料金」）の後ろ2文までの値も回答とみなすようにしました（`DEFAULT_VALUE_LOOKAHEAD`）。保存済みの100ページでハイライトの選抜は98件が不変で、変わった2件は改善でした。
- 深層検索とスクレイプのキャッシュ名前空間を更新しました。デプロイ後に旧版の応答が返り続けないためです。
- README を実測値と実装に合わせて整理しました（起動時間・メモリの記載、比較表、ツール数、章立て）。`docs/search-scrape-mechanics.md` と agent 向け SKILL.md も更新しています。

# Sora v2.34.8 — 旧ハイライト選択アルゴリズム rho-bm25 の廃止

- `highlightAlgorithm` の選択肢から `rho-bm25` を削除しました。指定できる値は `rho-select-v2`（既定）、`rho-select`、`legacy` です。`rho-bm25` を指定したリクエストは入力検証エラーになります。
- 後方互換用の `rho_bm25` モジュールと `RhoBm25*` 型の別名を削除しました。MCP・REST のスキーマ説明（OpenAPI）と README からも記載を削除しています。

# Sora v2.34.7 — 検索・描画待機の高速化と公開カレンダー取得の改善

- deep検索で、Web検索が完了した時点から各ページの本文取得を開始し、独立したXリアルタイム検索と並行して処理します。最終結果には両方の取得結果を統合します。
- ブラウザ描画後に本文が空の場合、同じページで残りの期限内に描画を待つようにしました。再ナビゲーションを減らし、Loadingや読み込み中の表示だけで取得を完了する判定も改善しています。
- 非表示要素の除去をDOMのコピー上で行い、元ページのJavaScriptによる更新を維持します。Shadow DOMの再取得ではコピーを更新し、表やgrid内の主要な本文を保持する抽出も改善しました。
- 日本のWebをAIエージェントから利用するSelf-hosted MCP / REST統合サーバーとして、TimeTree公開カレンダーの接続処理を追加しました。公開ページ自身が受信した予定レスポンスから、予定名・日付・説明・会場・URL・画像を既存のscrapeとsearch_deepで取得できます。追加のAPI通信・APIキー・LLM呼び出しは不要です。
- TimeTree固有処理は対象の公開カレンダーと同じカレンダーのレスポンスに限定します。予定データがない場合は通常のDOM抽出を使用します。取得範囲はページが読み込んだ公開予定で、全月巡回や非公開予定の取得には対応していません。ページ内APIの形式変更への追従が必要です。
- MCPの説明文を、モデルが利用できるツールの直接呼び出しとホスト側のツール検索を優先する内容へ修正しました。配送・国地域ツールでも不要なsearch_tools呼び出しを要求しません。
- 旧キャッシュの再利用を防ぐためscrapeとdeep検索のキャッシュ名前空間を更新しました。responseModeの既定値は引き続きfullです。特定モデルへの依存や新しい公開ツール・引数は追加していません。

# Sora v2.34.6 — APIドキュメントの表示とテスト初期値の統一

- APIドキュメントの列挙値を、型・enum・DefaultとValues枠内のチップで表示する形式に統一しました。表示ライブラリのバージョンを固定し、外部更新による表示の変化を防ぎます。
- GETとPOSTの入力定義を共通化し、型・範囲・既定値・選択肢・説明を揃えました。荷物追跡GETには、実装が受け付ける自動判別指定のautoも記載します。
- POI検索のテスト入力に、有効な「カフェ・原宿」のサンプルを設定しました。半径5000メートル、最大10件、キャッシュ利用から試せます。地名と座標を同時に含む無効な自動生成サンプルを避けます。
- キャッシュ回避の既定値falseを明示し、APIドキュメントとOpenAPI定義を更新時に再検証するようにしました。
- GET/POSTの定義一致とテスト初期値を確認する回帰テストを追加しました。APIの検索処理や入力省略時の動作は変更していません。

# Sora v2.34.5 — API仕様と位置情報検索の改善

- MCPとREST/OpenAPIの入力・出力仕様を整合させました。整数の範囲、列挙値、既定値を明示し、画像・動画・候補語・週間天気・地震などのレスポンス定義を実際の返却内容に合わせています。
- Yahoo!路線情報で指定した日付・時刻を検索に反映し、省略時は日本時間を使用します。経路検索のキャッシュキーにもすべての検索条件を含めました。Yahoo! Web検索とサイトマップ取得では、指定したキャッシュ回避・日付条件を反映します。
- スクレイピングの`fullPage`指定とバッチ入力を処理に渡すよう修正しました。イベントの説明・終了時刻・公開日時の抽出を改善し、カレンダーの操作部分だけを本文として扱う誤判定を防ぎます。統合検索では同じ投稿の重複も除去します。
- 地名からの座標取得をNominatim（OpenStreetMap）へ切り替え、見つからない住所は国土地理院の住所検索で補完します。駅名・ランドマーク・番地を含む住所の検索に対応し、候補が複数の都道府県にまたがる場合は確認が必要な結果として返します。
- `search_poi`と`get_elevation`の結果に、使用した位置情報サービスの出典情報を追加しました。OpenPOIの施設情報にも出典を付け、クライアントが結果とともに帰属表示を提示できるようにしています。
- APIの表記検査と、駅名・住所・位置情報の出典表示を確認する回帰テストを追加しました。

## クライアント側の確認事項

監視チェックのREST応答は、単件を`{ result }`、複数件を`{ results }`で返します。監視結果を直接参照していたクライアントは、ラッパー内の結果を参照してください。

# Sora v2.34.4

- 公開gateをsoft hold化。`fail`/`unavailable`（破損シグナル）は公開停止を維持し、`unverified`/`blocked`のみ残存時は記録付きで公開進行（runner exit 3）。資格情報・test dataなし運用に対応。

# Sora v2.34.3

- live改善: 公開SNS投稿の既定test data（4 platform＋X、秘密上書き可）、運航の国際fallback、外部tool caseのunverified再試行。機能変更なし。

# Sora v2.34.2

- CI安定化: 追跡テストのChromium有無・WAF変動・60秒上限に対応（旧unknown固定期待の更新、browser取得の時間上限）。機能変更なし。

# Sora v2.34.1

- CI修正: 国際追跡のブラウザ取得をCIの60秒上限内に収める（ups/fedex分割・描画上限30秒・遷移待ち上限20秒）。機能変更なし。

# Sora v2.34.0

- 新規MCPツール `search_poi`（OpenPOI直結・全国施設POI検索、座標付き）と REST `POST/GET /geo/poi` を追加。OpenAPIに登録し、README・件数表記を全47ツール（hotel有効時48）へ同期。
- 国際3社（UPS・FedEx・DHL）の追跡をキーなし動作化。資格情報があれば公式API優先、なし時はステルスブラウザ取得、それも不可なら公式URL案内へフォールバック。DHL追跡URLを現行化。
- MCPのHost/Origin検証（不正は403）、本文抽出の情報欠落修正（aside置換・表列重複・lazy画像）、国地域SNS入力の保持、SNS失敗の誤キャッシュ防止、監視selector不在のbaseline保護。
- 全ツール live CI harness（`scripts/tool-health`）：本体検査＋候補コンテナ実取得＋provider別確認＋JSON/Markdown/JUnit報告。公開は同一image検査通過が条件。
- 検証: 全test 1204 pass / 0 fail、typecheck成功。live通常lane 82 pass・0 fail（資格情報・test data不足分はunverified/blockedとして記録）。

# Sora v2.33.1

- MCPの遅延ツール有効化状態をセッションごとに分離。同じAPIキーや匿名接続でも、別セッションと再接続は初期公開14ツールから開始します。
- セッションIDを付けない単発呼び出しは、指定ツールをその要求内だけで有効化。正式名・`default.`互換名を利用でき、他の要求や接続へ状態を持ち越しません。
- MCPセッションは作成時と同じテナントからのみ利用可能。別APIキーや認証を外した要求ではセッションを使用できません。
- 接続間の分離・再接続・単発呼び出しの回帰テストを公開イメージのCI検証に追加。版数検証の古い固定値を除去し、READMEの接続手順を更新しました。
- CIでHTTP403になるe-Gov実通信の4テストを、既存の`SORA_LIVE_TESTS=1`ライブ試験へ分離。入力不正の400応答は通常テストで検証します。e-Gov上流の403自体はこの修正の対象外です。

# Sora v2.33.0

- X個別投稿の全文取得: MCP `fetch_x_post`（遅延ツール）と REST `POST /realtime/post` を追加し、OpenAPIに登録。ステータスIDまたは投稿URLからFxTwitter経由の検証済み全文を取得。`search_realtime` で見つけた投稿の深掘り用。
- X全文補完の検査窓を上位5件から10件に拡大（外部取得は2件のまま）。切詰め疑いの見逃しを減らす。
- 実験的楽天トラベル宿泊検索を `SORA_RAKUTEN_TRAVEL_ENABLED=true` 背後に追加（東京駅・京都駅・草津温泉のみ、施設名は未対応のため null）。既定の公開範囲・ツール数に影響なし。
- ツール数は46（コア14不変）。

# Sora v2.32.0

- 証拠スコアリング: 回答値検出・entity関連・表/定義構造・時間関連・明示日付の年照合・相対日解決。言及/回答カバレッジ診断と 12-24-48 段階候補投入。
- 辞書分離: intent語・stopwords・時間語を retrieval lexicons に集約し、スコア倍率を EVIDENCE_WEIGHTS 一表化。dead RRF削除、enrichment循環import解消。
- 評価: live 10件収集＋機械的事前ラベル、5件にAI一次ラベル（要人手確認）。
- API: `adaptiveScrape` と `scrapeBudget` を REST・MCP・OpenAPI 共通スキーマに接続。型・範囲を検証し、指定値を内部検索へ渡します。既定は引き続き追加取得なしです。
- ドキュメント: README・API説明・検索処理の説明を更新。日付の基準と年省略時の仮定、`updated` と開催日の違い、検索精度評価の未完了範囲を明記。OpenAPI は整数制約を `integer` として出力します。
- CI: Google News fixtureの経時失敗、MCP有効化状態・環境変数のテスト間漏れ、バージョン不整合を修正。配送会社の実応答テストを `SORA_LIVE_TESTS=1` に分離し、佐川の未登録・HTTPエラー・通信失敗は固定応答で検証。失敗ログとJUnitを保存します。
# Sora v2.31.0

- 検索 v2: Yahoo プロバイダー圧力制御（AIMD・サーキット・予算）、構造化 429 と Retry-After 対応、stale キャッシュ、検索 singleflight、回答カバレッジ停止、抽出エスカレーション＋遅延ブラウザスキップ。
- API: `GET /metrics` にセキュリティ・検索カウンタを JSON と Prometheus の両形式で公開。OpenAPI の表記を日本語化。`search_deep` の適応パラメータを README に文書化し、検索・スクレイプの仕組みを `docs/search-scrape-mechanics.md` に整理。
- 品質: strict typecheck 修復、JMA 週間予報テストの提供日数変動への対応。フルスイート 1073 pass / 4 skip / 0 fail、Hermetic gate 207 pass。

# 監査対応パッチ (unreleased)

- Yahoo 路線情報フライト一覧の Next.js 化（__NEXT_DATA__）に対応。旧 table 解析はフォールバックとして維持。
- 詳細ヘルスが SORA_VERSION を返すよう修正。L2 キャッシュの作成時刻を永続化値から復元。古い API 使用量・監視履歴の定期 purge を追加。
- 外部依存のライブテストを SORA_LIVE_TESTS=1 背後に分離し、CI に bun test ワークフローを追加。
- README のツール数・モジュール・環境変数表を実態に更新。GET / 一覧に tracking/social を追加。未使用の Dockerfile・ベンチ・ゴミファイルを削除。

# 公開SNS取得（Weibo/Threads/Instagram/Facebook）(unreleased)

- MCPに `search_social_posts`（Weibo新着検索・Meta公開投稿の発見＋本文取得）と `fetch_social_post`（既知投稿の本文・日時・反応）を追加。追加費用・ログイン不要。Xは対象外のため `search_realtime` を使う。
- RESTに POST /social/search・POST /social/fetch を追加し、OpenAPIへ登録。
- 国地域インテリジェンスに `social_posts` プロバイダーを追加。`includeSocial: true`＋`social` 指定で実行し、締め切りは55秒。単独SNS結果はDB保存しない。

# Global Intelligence v2 — live evidence without Yahoo realtime (unreleased)

Country Intelligence restores event content instead of counts: GDACS real-shape parsing (url objects, affected countries, severity), GDELT Events export ingestion with region filtering and honest period gaps, USGS/EONET/global feeds, 6 World Bank indicators with full series, holiday scope details, and article-body extraction.

- Report v2 (schemaVersion 2, additive): domainContext facts per domain, provider limitations, refreshState, actualWindows with gaps, persisted evidence details with cursor paging and change diffs.
- MCP intel: research_country_context now returns text JSON plus validated structuredContent; new get_country_context, get_country_context_evidence, get_country_context_updates. REST adds the matching evidence and updates endpoints. Yahoo realtime is never used on this path.
- Collection durability: evidence details, source cursors, and change history persist (migration v3); single-owner collector lease; stale/unknown/clock-anomaly freshness instead of silent success.

# 🧭 Sora Release v2.27.0

## Xリアルタイム検索の直接JSON移行 (unreleased)
- `search_realtime` / `POST /search/realtime` / `POST /realtime` / `search_deep` 内のX取得・X投稿URL解決が、Yahoo MCPバイナリ経由からYahooのJSON取得の直接呼び出しに切り替わりました。Yahoo HTMLのトップ枠 (`bestTweet`) にだけ存在した投稿の取りこぼしを解消します。
- Yahoo公式の検索演算子 (`id:` / `@` / `#` / `-` / `(A B)` / `URL:` / URL直接入力) と複数語・アカウント指定の併用に対応し、OR・URL条件を含む式の意味を変える自動relaxは行いません。
- 構造化 `url` は `URL:` 演算子として送信するよう修正しました (従来は通常語として追加)。
- `page` は公開1始まり・Yahoo側40件固定幅、`limit` は1〜40・デフォルト20。provider障害はHTTP 502 / MCPエラーとして返し、一部失敗時は `partial` 付きで成功分を返します。
- Web・画像・動画・ニュース・知恵袋の取得は従来どおりMCPバイナリを使用し、バイナリ配置も維持します。
- Country Intelligence 側は geo 正規化・provenance・検証済み two-pass・metric/signal 基盤・domain view・default runtime を追加しました (詳細は intel 実装メモ)。

### Realtime compact default + Country Intelligence v1

- `search_realtime` / `search_web` / `search_deep` return compact responses by default (answer-required fields only); pass `verbose: true` for retrieval diagnostics (`retrievalQueries` / `contributingQueries` / `resultsMerged` etc.). REST `/search/realtime` and `/search/web` behave the same with cache keys separated by verbosity.
- `search_realtime` description shortened to stay within the 400-char initial tools/list budget (33 contract tests pass).

### Country Intelligence v1 — evidence-backed country context

- New `POST /intelligence/country` + `GET /intelligence/context/:contextId`, and deferred MCP tool `research_country_context` (`intel` module, `search_tools` keyword `国地域`).
- Deterministic pipeline: conservative region resolution, isolated providers with timeout/retry/cache, normalized evidence, conservative event clustering, factual temporal/relation context, SQLite persistence.
- Report counts keep articles, event clusters, and independent sources separate; publisher country never leaks into event country; ambiguous regions stay low-confidence.
- Partial-report semantics: a single provider 429/timeout degrades coverage instead of failing the report.
- Explicitly no sentiment, hostility, anti-Japan, safety, or risk classifiers or scores.
- Persistence requires `SORA_DB_PATH=/data/sora.db` on a mounted `/data` volume (`VOLUME ["/data"]` declared in Dockerfile/Containerfile). Opt-in smoke: `bun run test:intel:live`.

# 🌤️ Sora Release v2.25.0

### MCP 遅延ツールの LibreChat 互換修正

- 再接続時の有効化状態保持に加え、有効化した遅延ツールの `default.` 付き互換名を公開。LibreChat が `default.search_trend` 等を完全一致で検索する場合も、再初期化後に定義取得・呼び出しできるよう対応。
- 初期公開は12ツールを維持。遅延ツール1件の有効化で正式名と互換名の2定義を追加（同じ引数検証・処理を使用）。無効モジュールは公開しない。
- キーワード検索のランキングを維持しつつ、明示的なカテゴリ検索では3件制限を適用せず、カテゴリ内の全ツールを有効化。
- 有効化状態の保持は同一プロセス内。プロセス再起動・別レプリカへの接続では再度 `search_tools` が必要。

伝票番号の形式衝突と投機競合（first-response-wins）を排除し、決定論的かつ高信頼な配送追跡を実現する **Tracking v2 アーキテクチャ** を導入したメジャー・マイナー機能リリースです。

> **原則: Detect locally. Verify narrowly. Never guess.**
> （推測するな。観測せよ。最速応答は勝者ではない。確実な配送エビデンスのみを採用する。）

### 🌟 主な機能と改善 (Highlights)

1. **Carrier Adapter & Registry 刷新 (8キャリア対応)**
   - 運送会社ごとの追跡・検証責任をアダプタへ完全分離。
   - 国内 5 大キャリア（ヤマト運輸、佐川急便、日本郵便、西濃運輸、福山通運）に加えて、国際配送（UPS、FedEx、DHL Express）の計 8 社へ正式対応。

2. **Ranked Local Detection (非推測・完全ローカル判定)**
   - ネットワーク通信を一切行わず、全キャリアアダプタの形式ルール・チェックディジット・正規表現に基づきスコアと強度を判定・順位付け。
   - **UPS 1Z Exclusive**: UPS 固有の `^1Z[0-9A-Z]{16}$` は他社候補を一切呼び出さず単一照会。
   - **UPU S10 国際郵便**: 公式重みベクトル `[8, 6, 4, 2, 3, 5, 9, 7]` によるチェックディジット検証と `postal` メタデータ付与。外国発行（US 等）の EMS 番号も日本郵便国際追跡へ安全にルーティング。

3. **Bounded Wave Verification (最大 4 回制限・段階的並行照会)**
   - 候補上位から最大 2 社ずつ並列照会（Wave 1: Top 2、Wave 2: Next 2）。
   - Wave 1 で確実なエビデンス（`strong`）が確認された時点で後続 Wave を即時中止（Short-circuit）。
   - ネットワーク照会は最大 4 回に厳格制限し、外部サービスへの不要な高負荷やレイテンシ遅延を防止。

4. **Verified Carrier Adoption (Fastest Is Not Winner)**
   - 最速で返ってきたこと自体を勝者決定の理由とせず、配送イベント履歴や詳細情報が存在する `verification.level === 'strong'` の結果のみを勝者として採用。
   - API クレデンシャル未設定時の Web URL 案内（URL-only）が auto winner になることを厳格に防止。

5. **Multiple Strong Conflict 判定**
   - 同一伝票番号で複数社が有効な配送実績を返した場合、単一キャリアを推測・偽装せず `ambiguous: true` / `status: 'unknown'` として安全に競合をユーザーへ通知。

6. **REST / MCP / OpenAPI 契約同期**
   - MCP `track_package` および REST `/tracking` において 8 社キャリアコード（`fedex`, `dhl` を含む）と `preferredCarriers`, `originCountry`, `destinationCountry` ヒントパラメータを完全サポート。
   - 初期 12 コアツール構成（Two-Tier Tool Architecture）とコンテキストトークン効率を維持。

---

# 🌤️ Sora Release v2.24.3

コアツール枠（厳格な初期 12 ツール構成）の復元と、遅延ツール動的有効化（Two-Tier Tool Architecture）の LLM 誘導プロンプトを強化した Hotfix リリースです。

- **初期コアツール枠の復元（12 ツール制限の厳格な遵守）**: `track_package` を初期 CORE ツールから元の遅延読み込み（`defaultEnabled: deferredDefault`）へ戻し、初期 `tools/list` のツール数を 12 ツール（11 コア + `search_tools`）に復元。コンテキストトークン効率を最優先とする設計原則を徹底。
- **動的有効化誘導プロンプトの強化**: `buildSoraMcpInstructions` 内の Tier 1 指示において、`track_package` が初期非表示の遅延ツール（DEFERRED）であることを明記し、利用前に必ず `search_tools(query: '荷物追跡')` を呼び出して動的有効化してから使用することを LLM に一意に指示・誘導。
- **コントラクトテストの整合性担保**: 初期 12 ツール構成および `track_package` の動的有効化フローに対するテストアサーションを同期（29 tests 全件 PASS）。

---

# 🌤️ Sora Release v2.24.1

v2.24.0 で導入した X long-form enrichment に対する Hotfix リリースです。

- **post-merge X long-form detail selection**: Yahoo official/public マージ後に全文取得候補を選定
- **Yahoo truncation gate**: Yahoo 本文が切断疑い（`text.length >= 240`）の投稿のみを Gate 通過
- **max two Fx detail calls**: 上位 5 件をローカル評価し、FxTwitter HTTP 呼び出しは最大 2 件に制限
- **query relevance selection**: original semantic query relevance に基づき Fx detail 候補を選択
- **canonical X text response**: `text` を唯一の canonical 本文に一本化
- **canonical author_name/author_handle response**: `author_name` + `author_handle` を canonical author 表現とし、`@` を除去
- **removal of redundant long-form response fields**: 通常レスポンスから `snippet`, `markdown`, `originalText`, `author`, `author_url`, `siteName` を完全に除外し、レスポンスサイズを大幅に削減（`verbose: true` のみ `detailDiagnostics` を付与）
- **URL normalization**: host-facing X URL から Yahoo トラッキングパラメータ（`utm_source`, `utm_medium`, `utm_campaign`）を自動除去
- **Yahoo/Fx fail-soft挙動の維持**: 外部 API エラーやタイムアウト時もエラーを発生させず安定フォールバック

---

# 🌤️ Sora Release v2.24.0

荷物追跡の信頼性・レイテンシを飛躍的に高める **Fail-fast Package Tracking** と、X (旧 Twitter) の長文投稿（Note Tweet 等）を正確かつ安全に補完する **Bounded X Long-form Enrichment** を統合したメジャー・マイナー機能リリースです。

各種 MCP ツールと REST API の全レイヤー（`search_deep` / `/search/deep`, `search_realtime` / `/realtime`, `scrape` / `/scrape`, `track_package` / `/tracking`）においてマルチサーフェスな動作整合性を完全担保しました。

---

## 🌟 v2.24.0 主なハイライト (Highlights)

### 1. 📦 荷物追跡の信頼性・レイテンシ改善 (Track B)
- **並行投機照会の Fail-fast 化**: 複数キャリアの並行探索において、確実な配送結果（`delivered`, `in_transit`, `registered`, `returned`）が確定した瞬間に即座に早期 return。遅延キャリアやタイムアウト待ちによるレイテンシを大幅に削減。
- **UPS フォールバックの適正化**: API 認証情報（`UPS_CLIENT_ID` / `UPS_CLIENT_SECRET`）が未設定の場合に従来の `status: 'registered'`（虚偽の追跡完了リスク）を廃止し、安全な `status: 'unknown'` と公式追跡 Web リンク案内へ是正。
- **伝票番号の候補推定適正化**: 汎用的な未知伝票番号から UPS を除外し、UPS 固有の形式（`^1Z[0-9A-Z]{16}$`）のみ候補として自動判定。

### 2. 𝕏 X 長文投稿 (Note Tweet) の適応的全文補完
- **Yahoo Realtime Discovery の維持**: 広範な即時検索・トレンド把握は Yahoo! リアルタイム検索の高速性を維持し、不要な外部 API コールを排除。
- **語彙観測に基づく Bounded Enrichment**: クエリ要求とスニペットの語彙照合（`tokenizeAndSelectTerms`）および省略記号（`…` や `...`）による切り捨て検知を行い、情報欠落の兆候がある上位候補のみ FxTwitter v2 API（最大 2 件、通常 0〜1 件）で全文補完。
- **Direct X Status URL への直結**: X ポスト URL（`/status/:id`）が指定された場合、Yahoo 検索を待たずに直接 FxTwitter detail を試行し、Note Tweet の完全な長文本文・正確な著者名・投稿日時を 1 回で抽出。
- **100% Fail-soft & プライバシー保護**: 外部 API のタイムアウト（1,500ms）・レート制限・HTTP エラー時もエラー落ちせず Yahoo スニペットを維持。FxTwitter へは numeric statusId のみ送信し、ユーザーの生クエリやセッション情報は一切非送信。5分 TTL キャッシュと single-flight 重複排除を内蔵。

### 3. 🔁 MCP & REST Multi-surface Parity
- **REST `/realtime` エイリアス**: クライアント互換性のため、`POST /search/realtime` に加えて `POST /realtime` も同一ハンドラでマウント。
- **Deep 統合検索・単一スクレイプ連携**: `search_deep`（MCP）および `/search/deep`（REST）の速報枠や Web 記事スクレイプ、`scrape`（MCP）および `/scrape`（REST）のすべてで X ポストの全文抽出がシームレスに機能。
- **包括的統合テストスイート**: REST と MCP の全サーフェスを検証する `src/services/mcp_rest_deep_realtime.test.ts` を追加し、全件グリーンを恒久保証。

---

# 🌤️ Sora Release v2.23.1

v2.23.0 で導入された各種機能と runtime 挙動を、MCP スキーマ・ツール説明・指示文（`SORA_MCP_INSTRUCTIONS`）・REST・OpenAPI・ドキュメント間で 100% 整合させる **LLM-facing Contract Synchronization & Discovery Refinement** リリースです。

検索・retrieval・ranking・ρSelect v2 の精度経路は変更せず、LLM が迷わず正確にツールを選択・発見・活用できるプロトコル契約を強化しました。

---

## 🌟 v2.23.1 主なハイライト (Highlights)

### 1. 🔁 `search_deep` スキーマの Single-Source 化 & 完全パリティ
- `src/mcp.ts` 内の手動インラインスキーマ定義を撤廃し、共有スキーマ `INTEGRATED_SEARCH_INPUT_SHAPE` に一本化。
- OpenAPI 生成における Zod 3.24+ の enum 欠落バグを修正し、REST / MCP / OpenAPI 間の全 enum・default・境界値の一致をテストで恒久保証。
- `search_web` の `limit` 説明文言をランタイム挙動（最大: 20。formats指定時: 5。未指定時: provider 既定件数維持）と完全同期。

### 2. 🧩 Module-Aware な MCP ガイダンス & 厳格な分離
- `buildSoraMcpInstructions(activeModules)` を導入し、有効なモジュールのみ Tier 1 ディレクティブおよびツールガイダンスを動的生成。
- `life` モジュールと `disaster` モジュールの instructions 定義を完全に分離し、片方のみ有効な構成でも他方のツール名が漏出しないよう適正化。
- `search_tools` の候補なしメッセージに表示される「利用可能なカテゴリ」も現在アクティブなモジュールのみ動的反映。

### 3. 🔍 段階的ツール発見 (Progressive Discovery) の品質向上
- `search_tools` の自然言語判定における逆包含処理を 2 文字以上（`[...kLower].length >= 2`）に限定。「歌手」で「歌」を含む `search_song` が誤活性化される 1 文字誤マッチを排除。
- `search_tools` の description から固定ツール名（`search_deep 等`）を削除し、モジュール無効構成でも矛盾しない client-neutral な案内に統一。
- 初期 12 コアツールの定義文字数を 19,963 文字、instructions を 6,102 文字に最適化（初期コンテキスト消費を全登録比約 70% 削減）。

### 4. ⚡ MCP Standard Streamable HTTP 通知の E2E 実証
- MCP SDK 標準の Streamable HTTP（GET SSE ストリーム）経由で、`search_tools` 実行時に `notifications/tools/list_changed` が確実にクライアントへ届き、同一セッション内で `tools/list` が動的リフレッシュされる E2E 通信を実証。

---

# 🌤️ Sora Release v2.23.0

MCP / REST の検索レスポンス整合性を保ちながら、必要なクライアントだけ返却量を大幅に削減できる **Evidence Response Mode**、`search_web` の共通 format 契約、Host-facing highlights 正規化、および検索診断の安全な拡張を統合したリリースです。

既存互換性を優先し、`search_deep` の `responseMode` は引き続き **`full` がデフォルト**です。`evidence` は明示 opt-in であり、取得・ρSelect v2・Deep Evidence Rerank の精度経路は変更しません。

---

## 🌟 v2.23.0 主なハイライト (Highlights)

### 1. 📦 `search_deep` Evidence Response Mode（明示 opt-in）
- `responseMode: "full" | "evidence"` を MCP / REST の双方で利用可能。
- `full` は従来互換のデフォルト。
- `evidence` は query-selected `highlights` を保持し、安全条件を満たす結果だけ重複する全文 `markdown` を省略。
- `markdown` を highlights で上書きせず、`highlights` も削除しません。
- `formats:["markdown"]` の明示指定、`extractHighlights:false`、highlights 不在、scrape fallback/error、X ソースでは全文 Markdown を保持します。
- 決定論的な real MCP + REST E2E fixture では、対象情報を保持したまま返却文字数を約 91% 削減しました（fixture 実測値であり、一般ワークロードの保証値ではありません）。

### 2. 🔁 MCP / REST の検索契約整合性
- `search_deep` の full / evidence で stable semantic surface の MCP / REST parity を実 E2E で検証。
- `search_web` に共通 `formats` 契約を導入し、MCP / REST の双方で `markdown`, `tables`, `links`, `jsonLd` 等を同一方針で取得可能。
- `formats` 未指定時の `search_web` は従来の軽量検索パスを維持し、追加スクレイプを行いません。
- requested format 以外の payload を漏らさない Host projection を追加。

### 3. 🎯 Host-facing highlights の正規化
- 外部向けの標準 surface を `highlights` に統一。
- 内部用 `highlightItems` は Deep Evidence Rerank まで保持し、通常レスポンスでは露出させません。
- `verbose` 時のみ診断用内部情報を維持します。

### 4. 🔎 安全な検索診断と実験機能
- verbose-only の query lineage / evidence diagnostics を追加。通常レスポンス・順位決定には影響しません。
- Web Query Union と X Source Isolation は引き続き **明示 opt-in / デフォルトOFF**。
- Study 2B の実験実装は production candidate から除外済みで、本リリースには含めません。

### 5. 🧪 回帰安全性
- ρSelect v2 canonical tests: 23 tests / 422 assertions。
- ρSelect v2 1,000-seed stress: 5 tests / 4,588 assertions。
- ソライロ / 季節外れのリナリア / SPARK の precision fixtures を release gate に固定。
- real MCP + REST Evidence E2E、real MCP + REST `search_web formats` E2E、build、version contract をリリース前に実行。
- main と release candidate の full test suite を同一隔離環境で比較し、candidate-only failure がないことを確認してからリリースします。

---

# 🌤️ Sora Release v2.22.0

気象庁公式オープンデータによる週間天気予報（最大7日先＝計8日間）の統合、および不要な個人ボランティアAPI（tsukumijima）フォールバックの完全撤廃アップデート（v2.22.0）です。

---

## 🌟 v2.22.0 主なハイライト (Highlights)

### 1. 🌦️ 気象庁公式 週間天気予報（7日先＝計8日分）の統合
- **日別マージエンジンの新設**:
  - 気象庁 API の短期予報（今日・明日・明後日）と週間予報（3日後〜7日後）を自動統合し、指定地域（例: 「山中湖」190020）において最大 8 日分（今日〜7日後）の日別予報（天気コード・日本語テロップ・降水確率・予想最高/最低気温・予報信頼度 A/B/C）をシームレスに取得可能になりました。
- **`days` パラメータ拡張**:
  - `days: 1〜8`（デフォルト: 7）へ拡張し、MCP ツール `get_weather` および `/weather` エンドポイントで週間予報をワンショット取得可能にしました。

### 2. 🛡️ OSS開発倫理・健全性の向上（個人APIフォールバックの完全撤廃）
- **一次ソース（気象庁公式 CDN）への一本化**:
  - 個人開発者がボランティア運用している外部サーバーへの自動フォールバック処理を完全削除しました。
  - 共倒れリスクと外部への不要な負荷集中を根絶し、Akamai CDN 等で高可用配信される気象庁公式データのみを直接参照する堅牢で倫理的なアーキテクチャに整理しました（オッカムの剃刀）。

---

# 🌤️ Sora Release v2.19.0

最新の数理最適化研究に基づく証拠選択エンジン **「ρSelect v2 (Canonical Engine)」** の完全導入および深層エビデンス駆動リランキング機能の搭載アップデート（v2.19.0）です。連続スコア $r_{it} \in [0, 1]$ に対する Graded Max-Evidence 則と座標単調効用関数 $\Phi(y)$、Safe Dominance 剪定、および Exact Observed-Rank DP / Adaptive Refinement 二段階ハイブリッドソルバーを実装しました。全クエリに対して数学的オプティマイザ証明書（`certificate`: $LB \le \rho^* \le UB$）を発行し、外部監査レポート（v0.35）の全指摘事項を是正するとともに、実クエリでの偽陽性を根絶する深層エビデンス駆動リランキングおよび Markdown リスト構造保護パースを導入しました。

---

## 🌟 v2.19.0 主なハイライト (Highlights)

### 1. 🎯 ρSelect v2: 数学的オプティマイザ証明書付き証拠選択エンジン
- **連続スコア評価と Graded Max-Evidence**:
  - 連続値 $r_{it} \in [0, 1]$ の適合スコアを直接扱う数理モデルへ刷新。
- **Canonical Unconstrained Mode（自律的疎性最適化）**:
  - ハード上限 $K$ を前提とせず、State-Witness Sparsity 定理（$|S^*| \le m$）と分数目的関数に基づき、必要最小限かつ情報密度の高い証拠集合を自律選出。
- **Safe Dominance 剪定による状態空間 22.7倍（95.59%）削減**:
  - パレート劣位候補を探索前に安全にパージ。実測において状態数を 1,678 → 74 へ劇的削減（レイテンシ約 52 倍 高速化）。
- **二段階ハイブリッド・ソルバー & 数学的証明書 (`certificate`)**:
  - Exact DP と Adaptive Refinement により大域的最適性を数学的に証明。各レスポンスに `certificate`（$LB \le \rho^* \le UB$）を添付。
- **1,000 Seeds ストレス回帰テストスイートの完走**:
  - 1,000 決定論的シード（4,588 assertions）による厳格な数学的性質（Exact vs Brute-force、AR Bounds、$\epsilon=0$ 収束、Dominance不変性、Ties、Fail-closed）を 100% 検証。

### 2. 🔍 深層エビデンス駆動リランキング (`rerankByDeepEvidence`)
- **スニペット段階での偽陽性の根絶**:
  - 検索エンジンの合成スニペットに別文脈の単語が含まれていた場合の誤1位判定を解消。
- **多層エビデンス順位補正**:
  - 深層スクレイピング完了後、本文およびハイライトのクエリ単語カバレッジ、意図キーフレーズ（末尾語・特異語）充足、および ρSelect v2 ハイライトスコアを総合評価し、真に回答根拠を含むページを 1 位へ自動浮上。

### 3. 📝 Markdown 空行区切りリスト構造保護パース
- **クレジット・定義リストの泣き別れ防止**:
  - `- 作詞者\n\n 内山優花` のような空行区切りインデントリストが空行で別セクションに分断されるのを防ぎ、同一セクションブロックに結合保持。

### 4. 📚 監査・仕様ドキュメントの最新化
- 理論解説: [`docs/rho_select.md`](docs/rho_select.md)
- LLM向けハンドオーバー仕様書: [`docs/rho_select_v2_llm_handover.md`](docs/rho_select_v2_llm_handover.md)
- 監査指摘是正・新機能実装報告書: [`docs/rho_select_v2_audit_response.md`](docs/rho_select_v2_audit_response.md)

---

# 🌤️ Sora Release v2.18.0

日本の主要運送会社および国際便の横断追跡機能（`/tracking`、`track_package` MCP ツール）の新規搭載、およびトークン効率的証拠選択エンジン「ρSelect」におけるボイラープレート・メタデータ自動排除とリスト内見出し階層認識の機能強化を含む大型アップデート（v2.18.0）です。

---

## 🌟 v2.18.0 主なハイライト (Highlights)

### 1. 📦 日本主要5社＋UPS 荷物追跡 API & MCP ツール (`POST /tracking`, `track_package`)
- **対応キャリア**:
  - ヤマト運輸（クロネコヤマト）
  - 佐川急便
  - 日本郵便（ゆうパック・書留）
  - 西濃運輸（カンガルー便）
  - 福山通運
  - UPS（United Parcel Service / 国際便）
- **高精度キャリア自動判別**:
  - 伝票番号の桁数（10/11/12/13/18桁等）やハイフン位置、Modulus 7 および Luhn チェックサムによる自動キャリア識別。
  - キャリア指定なし（`"carrier": "auto"`、または `GET /tracking/:number`）でも即座に対象キャリアを判定して追跡。
- **5分間インメモリ LRU キャッシュ**:
  - 同一伝票番号への重複問い合わせを防止し、外部サーバーへの負荷を抑制（キャッシュヒット時レイテンシ <0.5ms）。
- **REST & MCP 両対応**:
  - REST API: `POST /tracking`, `GET /tracking/:carrier/:number`, `GET /tracking/:number`
  - MCP ツール: `track_package`（Module 4: Japan Daily Life & Transit に統合）

### 2. ⚡ ρSelect: ボイラープレート・メタデータ自動排除 & リスト内見出し認識
- **Frontmatter & パンくずメタデータの自動排除**:
  - Markdown 先頭の YAML frontmatter（`--- publishedTime: ... ---`）やサイト共通ナビゲーション（`> 📍 **階層**: ...`）が候補セクションに混入してハイライト選択を歪める問題を根本解決。
- **リスト内見出し階層認識 (`- ### [記事見出し]`)**:
  - 朝日新聞トピックスや Yahoo!ニュース等のポータルサイトで頻出する、箇条書きリスト要素内に埋め込まれた Markdown 見出し記号を正確に境界認識。一覧記事の各トピックを独立した候補セクションとして精密に分離・スコアリング。
- **スニペットの Frontmatter クレンジング**:
  - 検索結果レスポンスの `snippet` および `description` に混入した YAML frontmatter やパンくず文字列を事前サニタイズ。

---

# 🌤️ Sora Release v2.16.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」の最新機能アップデート（v2.16.0）です。

本バージョンでは、現代の情報検索（Information Retrieval: IR）理論と最新 RAG 研究に基づく **3大 IR アルゴリズム（Lost in the Middle 対策 U字型リオーダリング、MMR 多様性選択、インメモリ PRF 適合性フィードバック）**、時間軸ハルシネーションを防止する **Temporal Context Anchor（相対日時の絶対タイムスタンプ自動解決）**、および大規模な表構造をインテリジェントに要約・圧縮する **Smart Table Minimizer** を新規実装しました。

すべてのアルゴリズムは **ゼロ・ミドルウェア（外部 LLM・外部ベクトル DB 不要、完全インメモリ <0.05ms）** で動作し、LLM コンテキスト窓の劇的な節約とエージェントの推論精度向上を両立します。

---

## 🌟 v2.16.0 主なハイライト (Highlights)

### 1. 🧠 情報検索 (IR) 理論に基づく 3 大アルゴリズム (Zero-Middleware IR Engine)

外部の重厚なベクトル検索エンジンや Re-ranking LLM を一切導入せず、スクレイピング・検索結果の本文チャンクに対して純粋な数理的インメモリ処理（純粋 TypeScript / Bun）で最高水準の検索精度を実現しました。

- **① Lost in the Middle 対策: U字型リオーダリング (`reorderUshaped: true`)**
  - **背景**: 大規模言語モデル（LLM）は、プロンプトの先頭（Primacy Bias）と末尾（Recency Bias）にある情報を強くアテンションし、中央部の情報を忘却・見落としやすい特性（Lost in the Middle 現象）を持ちます。
  - **解決策**: BM25 や検索スコア順に上位から並べる従来の直線的配置を刷新。最重要チャンク（Rank 1, 2）を先頭と末尾に配置し、中央部に向かってスコアが緩やかに低下する **U 字型順序（$R_1, R_3, \dots, R_4, R_2$）** へ自動再配置。LLM による中央部情報の見落としを数理的に防止します。
- **② Carbonell & Goldstein (1998) 準拠: MMR 多様性選択 (`useMmr: true`)**
  - **背景**: 単純な類似度・BM25 スコアのみで上位チャンクを抽出すると、ほぼ同一内容の文章（ヘッダー、重複した免責事項、定型句など）が連続して選択され、限られたコンテキスト窓を浪費します。
  - **解決策**: クエリとの関連性（$\text{Sim}_1$）と、すでに選択されたチャンク群との最大類似度（$\text{Sim}_2$）のトレードオフを数式 $\text{MMR} = \operatorname{argmax} \left[ \lambda \cdot \text{Sim}_1(d_i, q) - (1 - \lambda) \max_{d_j \in S} \text{Sim}_2(d_i, d_j) \right]$ に基づいて動的評価。$\lambda = 0.7$（デフォルト）により、関連性を維持しながら重複情報を強力に排除し、多様な情報源からチャンクを網羅採択します。
- **③ Rocchio 適合性フィードバック: インメモリ PRF (`usePrf: true`)**
  - **背景**: ユーザーの検索キーワードと Web ページの記述表現の揺らぎ（Vocabulary Mismatch）により、重要な本文が従来の単語一致検索から漏れる問題があります。
  - **解決策**: 一次検索で高スコアを獲得した上位チャンク（Top-K）のテキストから、TF-IDF + サブワード境界スコアリングによって特異的キーワードをインメモリで自動抽出。クエリ重みベクトルを $q_{\text{new}} = \alpha \cdot q + \beta \cdot \text{keywords}$ で自動拡張して再スコアリング。重い Embedding モデル不要で検索適合率を大幅に向上させます。

### 2. ⏳ Temporal Context Anchor（相対日時の絶対タイムスタンプ自動解決）
- **背景**: Web 記事やプレスリリース、ブログ、SNS では「明日」「来週」「3日前」「今週末」といった相対日時表現が多用されます。LLM はスクレイピング日時や記事執筆日時を知らないため、時間軸のハルシネーション（過去のイベントを未来と誤認するなど）を頻発させます。
- **解決策**:
  - 記事の公開日時（HTML メタタグ `article:published_time`、Schema.org JSON-LD `datePublished` 等）またはスクレイピング実行日時を「基準アンカー日時（Anchor Time）」として自動設定。
  - 本文中の相対日時表現を正規表現とカレンダー演算により動的検知し、インラインで絶対日時を付与（例: `来週水曜日 [2026-09-16 (水)] に開催予定`）。LLM が一切の推測なしに確定日時を認識できます。

### 3. 📊 Smart Table Minimizer（表トークンのインテリジェント圧縮）
- **背景**: 仕様表、比較表、運行スケジュール等の Markdown テーブルは、空セル（`-`, `N/A`, `なし`）や定型ヘッダー、重複列が多く、LLM のコンテキスト窓を極度に浪費します。
- **解決策**:
  - 表全体の空セル率が 50% を超えるスパースな表や、低情報密度の列・行を自動検出。
  - 重要なデータ行を維持しながら、コンパクトなキー・バリュー形式や省略フォーマットへ自動圧縮。表データの可読性と意味的完全性を保ちながら、トークン消費量を **最大 60% 削減** します。

### 4. ♿ Evidence-Preserving Accessibility Hints（根拠データプレーン）
- 画像リンク、アイコンボタン、装飾的ナビゲーションなど、テキストが少なくアクセシビリティ属性（`aria-label`, `alt`, `title`）にのみ意味情報が含まれる HTML 要素から、根拠テキストを自動抽出し Markdown 出力に統合。視覚情報・補助テキストの欠落を防ぎます。

### 5. ⚡ 圧倒的なパフォーマンス・ベンチマーク (Zero-Middleware)
- すべての処理を外部サービスや重厚なミドルウェアに依存せず、純粋な TypeScript / Bun インメモリ環境で完結。
- 実測レイテンシ：
  - **U-shaped Reordering**: **1.2 µs**
  - **MMR 多様性選択 (10チャンク)**: **28.4 µs**
  - **インメモリ PRF 適合性フィードバック**: **42.1 µs**
  - **Temporal Anchor (相対日時解決)**: **15.6 µs**
  - **Smart Table Minimizer**: **8.3 µs**
  - 合計オーバーヘッドは 0.1ms 未満であり、既存のスクレイピング・検索速度に一切影響を与えません。

### 6. 🧪 テスト・検証実績 (Testing & Verification)
- **自動テストスイート**: **全 292 テスト 100% PASS**（2,843 件の expect アサーション）
  - 新規 IR アルゴリズム、Temporal Anchor、Table Minimizer の単体・統合テストを完全網羅。
  - 既存の全 REST エンドポイント・MCP ツール仕様と 100% 完全互換。
- **コンテナ**: v2.16.0 のイメージで稼働確認済み（`curl http://127.0.0.1:3016/health` → `200 OK`）。

---

# 🌤️ Sora Release v2.13.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」の最新機能アップデート（v2.13.0）です。

本バージョンでは、商用 LLM（Claude / ChatGPT 等）やローカル LLM（Llama / Qwen / Ollama 等）における**回答拒絶（Over-Specialization による過剰拒否）の完全根絶（Zero-Refusal Policy）**、**2層構造ツール決定フレームワーク (Two-Tier Tool Decision Framework)**、および Google（Passage Chunking）や Firecrawl のベストプラクティスに基づく**本文精読（Search → Scrape ループ）の義務化** を実装しました。

---

## 🌟 v2.13.0 主なハイライト (Highlights)

### 1. 🛡️ 回答拒絶の完全防止ポリシー (Zero-Refusal Policy)
- **過剰適合による回答拒絶の根本解決**:
  - LLM に多数の専門ツールを提供した際、「ライブ日程専用ツール」「営業時間専用ツール」「発売日専用ツール」等が存在しないことを理由に、LLM が「ツールがないためお答えできません」と勝手に決めつけて回答を拒絶する問題（Over-Specialization Bias）を根絶。
  - MCP 初期化ハンドシェイク（`initialize`）時に配布される `instructions` において、「専用ツールの不在を理由とした回答拒絶・推測放棄」を全面的に禁止。

### 2. 🗺️ 2層構造ツール決定フレームワーク (Two-Tier Tool Decision Framework)
- **Tier 1 (公式専門データ直結ツール・強制呼び出し)**:
  - 以下の 6 大ドメインについては、モデル自前の知識推測や一般 Web 検索を禁止し、必ず Sora の専用公式ツールを実行：
    1. **米国貿易・通関・規制判定**: `predict_hts_code`, `verify_hts_code`, `check_cpsc_certificate`, `check_fda_regulated`, `check_product_compliance`
    2. **日本法令・国会審議録**: `search_laws`, `get_law_text`, `search_diet_minutes`
    3. **気象庁防災・地震・道路交通**: `get_weather`, `search_disaster_warnings`, `search_earthquake`, `search_road_traffic`
    4. **国内路線乗換・フライト・標高**: `search_route`, `get_flight_status`, `get_elevation`
    5. **SNS速報・知恵袋・トレンド**: `search_realtime`, `search_trend`, `search_chiebukuro`, `suggest_keywords`
    6. **音楽メタデータ**: `search_song`, `search_artist`, `search_music`
- **Tier 2 (万能深層Web検索ツール・全実世界データ調査)**:
  - 上記以外のあらゆる最新事実・スケジュール・実世界データ（ライブ・公演・イベント日程、新製品・発売日、店舗営業時間、人物・企業動向、時事ニュース、技術ドキュメント等）は、**`search_deep`（推奨一次ツール）** を呼び出し、Clean Markdown 本文まで深く読み込んで包括的かつ根拠ある回答を構築。

### 3. 🔍 Google & Firecrawl 式の本文精読（Search → Scrape ループ）ルール
- **スニペットによる中途半端な推測の防止**:
  - 検索スニペット（1〜2行の抜粋）はメタ情報に過ぎず、開場時間やチケット発売日、詳細規約は本文（Main Content）にしか存在しません。
  - `search_web`（URL・概要スニペット探索）を使用した場合でも、スニペットだけで詳細が不確定な場合は推測で終わらせず、必ずヒットした公式 URL を `scrape` ツールで精読して本文を確認することを規約化。

### 4. 🏷️ 万能ツールの検索キーワード & Description 強化
- **動的ツール発見（`search_tools`）の精度向上**:
  - `search_deep`: 「【万能深層Web検索・最新事実/スケジュール/イベント調査】」を明記し、`['スケジュール', 'イベント', 'ライブ日程', '発売日', '営業時間', '最新情報']` をキーワードに追加。
  - `search_web`: 「【万能Web検索・候補探索】」を明記し、`['イベント検索', '告知検索', 'スケジュール']` をキーワードに追加。
  - `search_artist`: 「ライブ・公演日程や最新の出演スケジュール・最新活動情報は search_deep または search_realtime を使用してください」との相互誘導を明記。
  - `search_realtime`: アイドルのライブ出演・物販タイテ・緊急告知・イベント現地の生の声への最適性を明記。

### 5. ⚡ 次世代スクレイピング＆抽出エンジン（8大機能強化）
- **BrowserContext 軽量セッション分離**: 常駐 Chromium インスタンスに対し軽量な一時コンテキストをオンデマンド生成・即時破棄。プロセスの起動・終了待機ゼロとセッションごとの完全な Cookie / キャッシュ隔離を両立。
- **インテリジェント・アセット遮断**: 不要な画像バイナリ、メディア、Webフォント、3Dモデル、広告・解析トラッカーをネットワーク層（Request Interception）で即座に abort。CSS・JS を維持して正確な DOM レイアウトと不可視要素判定を保持しつつ、転送量 99% 削減とロード時間半減を達成。
- **DOM Quiescence（静止検知）SPA待機**: 固定スリープを廃止し、`MutationObserver` により 200ms の DOM 静止を動的検知して即座に完了。テスト実行時間を 106s から 90s へ大幅短縮。
- **イベント・スケジュール構造化抽出**: Schema.org `Event` / `MusicEvent` を自動解析し、構造化データ（JSON）および Markdown 冒頭コールアウトとして出力。
- **パンくずリスト（階層コンテキスト）抽出**: サイトの階層ナビゲーションを抽出し、ページの文脈パス（Breadcrumb）を Markdown に自動付加。
- **テーブル結合セル正規化**: `colspan` / `rowspan` を 2D マトリクスで自動補完・展開し、複雑な表構造の崩れを防止。
- **重要画像スコアリング**: フライヤー・タイテ・図表等の画像メタデータを検出し、不要アイコンと区別して優先抽出。
- **Clean Content Sanitizer & DNS Pinning**: プロンプトインジェクション用制御トークンや不可視ゼロ幅文字のサニタイズ、末尾ドット FQDN 表記による SSRF 回避の厳格な防御。

---

# 🌤️ Sora Release v2.12.0

### 1. 📋 MCP Instructions ＆ 専門ツール強制ディレクティブの導入
- MCP 初期化ハンドシェイク時に配布されるクライアント向けシステム指示書（`SORA_MCP_INSTRUCTIONS`）を整備。
- 各ツールの説明文に「【必須・推測回答厳禁】」「【公式直結】」等の強制ディレクティブを付与し、モデル自身の不確実な学習知識によるハルシネーションを防止。

### 2. 🪶 入力・出力の分離と軽量返却キー注記 (Return Annotations)
- 巨大な JSON 出力スキーマによるトークン爆発やローカル LLM の KV キャッシュ枯渇を防ぎつつ、各ツール説明文末尾に `返却: { status, overallStatus, ... }` の軽量アノテーションを付与してエージェントの戻り値認識性を最適化。

---

# 🌤️ Sora Release v2.11.0

### 1. 🛡️ 米国貿易コンプライアンスにおける多層防御（Dynamic Clarifying Questions）
- `check_product_compliance` や `predict_hts_code` において、主素材や対象年齢、飲食接触の有無などの重要パラメータが不足している場合、モデルが勝手に推測せず、AI エージェントがユーザーにヒアリングするための動的質問リスト（`clarifyingQuestions`）と `inputCompleteness: "partial"` を返却する多層防御機構を実装。

---

# 🌤️ Sora Release v2.10.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」の機能拡張アップデート（v2.10.0）です。

本バージョンでは、米国輸出通関・越境 EC 支援において極めて重要な**「商品情報からの HTS/HS コード推測エンジン（`predict_hts_code` / `POST /trade/hts-predict`）」**の新設、**2026 HTS Revision 18 & Chapter 99 特別追加関税リスク対応**、**2026年7月 CPSC 完全義務化 & ACE Disclaimer（免責申告コード）の反映**、および **FDA 実務 PGA フラグ（FD1〜FD4）判定ロジックの刷新** を実施しました。

---

## 🌟 v2.10.0 主なハイライト (Highlights)

### 1. 🎯 商品情報からの HTS/HS コード推測エンジン (`predict_hts_code` / `POST /trade/hts-predict`)
- **2段階ハイブリッド推測アルゴリズム**:
  - 米国通関申告に必須となる 10 桁統計細分コードを特定するため、商品名・説明文・素材・用途・対象年齢からセマンティックスコアリングでサブヘディング（6 桁）を高速に特定。
  - 米国国際貿易委員会（USITC）公式現行関税率表 API（`hts.usitc.gov`）とリアルタイム連携し、該当サブヘディング配下の全 10 桁統計細分コード、品目名、一般関税率を展開してセマンティック照合を実施。
- **実測精度**:
  - 玩具、陶磁器食器、化粧品、綿衣料、ヘルメット、食品（緑茶）、電子機器（急速充電器）等の代表品目において、**6 桁 HS コード特定率 100%、10 桁 HTS 完全一致 71%、上位 2 位以内特定率 100%** の高精度を実証。
- **PGA 規制判定とのシームレス連動**:
  - 推測された最有力 HTS コードに基づき、連動する CPSC 適合証明書要件（CCC/GCC・eFiling）および FDA 規制要件（FD1〜FD4 フラグ・Prior Notice・MoCRA）を自動で並行評価。

### 2. 📜 2026 HTS Revision 18 & Chapter 99 特別追加関税リスクのガイダンス追加
- **大統領布告・通商条約への即応**:
  - 2026年9月公開の 2026 HTS Revision 18（大統領布告 PP 11059/11055）や通商法 301 条（中国原産品追加関税等）に基づく **Chapter 99 特別追加関税** の適用リスクと通関士確認手順を判定レポートに追加。

### 3. 🛡️ CPSC 2026年7月8日 eFiling 完全義務化 & ACE Disclaimer（免責コード）対応
- **完全義務化ステータスの反映**:
  - 2026年7月8日より施行された米国税関（CBP）ACE システムへの電子申告（eFiling: フル PGA メッセージセット送信、または CPSC Product Registry 事前登録による参照送信）完全義務化（De Minimis 適用除外なし）を明記。
- **ACE 免責申告（Disclaimer）の案内**:
  - 規制対象外品目や類似コード品目に対して、通関保留エラー（P00/PU2）を防止するための **ACE Disclaimer コード（A: 非規制品、B: 適用規格免除等）** の申告ガイダンスを追加。

### 4. 🏥 FDA 実務 PGA フラグ（FD1〜FD4）判定ロジックの刷新
- **通関実務仕様への完全移行**:
  - 従来の粗い Chapter 2 桁判定から、CBP/FDA 実務で機械的に使用される PGA フラグ体系（FD1〜FD4）へ全面刷新：
    - **FD4**（食品必須）: 米国到着前の FDA 事前通知（Prior Notice / PNC 確認番号取得）絶対必須。
    - **FD2**（食品以外必須）: 化粧品（MoCRA / Cosmetics Direct 施設登録・製品リスティング）、医療機器（510(k) / Listing）、医薬品（NDC コード取得）。
    - **FD1**（用途により該当）: 食器・調理器具等の食品接触物質（FCS）。`foodContact` パラメータと連動し、食品接触用途なら FDA 安全基準適合要件、装飾用等の非接触用途なら ACE 免責（Disclaimer）申告を自動案内。

### 5. 🛠️ 全 38 MCP ツールへの拡張 & Gemini 100% 互換性維持
- 新規 MCP ツール `predict_hts_code` を含め、全 38 ツールの inputSchema が Gemini の Tool Calling 仕様（`exclusiveMinimum`、`const`、`array` 型禁止）に 100% 適合（1,412 項目検査パス）。

---

# 🌤️ Sora Release v2.9.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」のメジャーアップデート（v2.9.0）です。

本バージョンでは、LLM エージェント連携における**トークン消費量の大幅削減（Compact Response Mode & Base64 画像パージ）**、**SSRF 難読化 IP の数学的正規化によるセキュリティ完全防御**、**SPA 描画の適応型待機最適化**、**共有ブラウザ自動ローテーション & グレースフルシャットダウン**、および **REST ルーターのドメイン別モジュール分割（コードベース 91% スリム化）** を実施しました。

---

## 🌟 主なハイライト (Highlights)

### 1. 🪶 Compact Response Mode（LLM トークン消費量を 50% 以上削減）
- **デフォルト出力の軽量化**:
  - スクレイピング API (`/scrape`, `/scrape/stream`, `/search` 等) において、AI エージェントのコンテキスト窓を圧迫していた内部品質評価データ（`quality`, `completeness`, `qualityReasons`, `missingFields`, `evidence`, `renderedWithBrowser` 等）をデフォルトで自動除外。
  - レスポンスのペイロードサイズと LLM のトークン消費量を **50% 以上削減** し、高速かつ低コストなエージェント運用を実現。
- **オンデマンド詳細出力 (`verbose: true`)**:
  - 品質デバッグやハルシネーション検証で内部評価データが必要な場合は、リクエストに `"verbose": true`（または `/search?verbose=true`）を指定することで、完全な出処根拠（Provenance）やスコアを常時取得可能。

### 2. 🧹 Base64 インライン画像の自動パージ & 置換
- **コンテキスト窓の浪費防止**:
  - Web サイト内に埋め込まれた長大なインライン画像（`data:image/png;base64,...`）を自動検知し、Markdown 変換時に `![画像: alt属性]` へ自動置換してパージ。
- **画像保持オプション (`keepDataImages: true`)**:
  - Base64 データをそのまま保持したい場合は、`"keepDataImages": true` を指定することで置換をバイパス可能。

### 3. 🔒 SSRF 難読化 IP の 32bit 整数正規化 & IPv6 埋め込み完全遮断
- **バイパス攻撃の完全無力化**:
  - 8進数（`0177.0.0.1`）、16進数（`0x7f000001`）、32bit整数（`2130706433`）、省略記法（`127.1`）、および IPv4-mapped IPv6（`::ffff:127.0.0.1`）などの難読化されたプライベート IP 表現をすべて 32bit 符号なし整数へと数学的に正規化。
  - DNS 解決および HTTP リクエスト送信前に内部プライベート空間（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, CGNAT `100.64.0.0/10`）へのアクセスを確実に遮断。

### 4. ⚡ SPA 描画待機最適化 & Chromium 自動クリーンローテーション
- **動的適応待機（最大 850ms 短縮）**:
  - TimeTree や React/Next.js 等の SPA 描画時、本文要素の出現とローディングスピナーの消失をリアルタイム監視し、描画完了の瞬間に 350ms で即座に切り上げ。不要な固定待機（1,200ms）を排除。
- **共有 Chromium プロセスの自動ローテーション**:
  - 累積 200 回のブラウザレンダリング実行後、かつアクティブセッションが 0 のアイドル時に共有ブラウザを自動でクリーン再起動。長時間稼働に伴う Chromium のメモリリークやタブゾンビを根絶。

### 5. 🛑 グレースフルシャットダウン (Graceful Shutdown)
- **安全なリソース解放**:
  - `SIGTERM` / `SIGINT` シグナル受信時に、新規リクエストの受付停止、対話型ブラウザセッション（`closeAllBrowserSessions`）、共有 Chromium（`closeSharedBrowser`）、SQLite コネクション（`closeDatabase`）を安全にクローズしてクリーン終了。

### 6. 🏗️ REST ルーターのドメイン別モジュール分割
- **Fat Router の完全解消**:
  - `src/index.ts`（1,620 行）に集中していた 50 以上のエンドポイントを、Hono 標準の `app.route()` を用いて **9 つのドメイン別サブルーター**（`src/routes/`）へ分割・再構築：
    - `system.ts`: ヘルスチェック・メトリクス・OpenAPI・Docs・キャッシュクリア
    - `mcp_route.ts`: MCP Streamable HTTP / SSE プロトコル
    - `scrape.ts`: 単一・一括・ストリーミング・サイトマップ・クロール
    - `search.ts`: Web検索・リアルタイム速報・画像/動画/ニュース/知恵袋・乗換案内・音楽
    - `browser.ts`: ステルスブラウザ自動操作
    - `trade.ts`: 米国貿易コンプライアンス（HTS/FDA/CPSC/eFiling）
    - `public_data.ts`: 気象庁天気・警報・地震・道路交通・フライト・法令・国会会議録・標高
    - `watch.ts`: Web 差分監視
    - `media.ts`: マルチモーダル画像視覚入力
  - `src/index.ts` は 150 行のエントリポイントへと約 91% スリム化。

---

## 🧪 テスト・検証実績 (Testing & Verification)

- **自動テストスイート**: **全 209 テスト 100% PASS**（2,347 件の expect アサーション）
- **外部 API 互換性**: 既存の全 REST エンドポイント・MCP ツール仕様と 100% 完全互換
- **コンテナ**: v2.9.0 のイメージで稼働確認済み

---

## 📦 アップグレード方法

### Docker / Podman
```bash
podman pull ghcr.io/ikenokazuki/sora:latest
# またはバージョン固定
podman pull ghcr.io/ikenokazuki/sora:2.9.0
```

### Claude Desktop / Cursor 設定 (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "sora": {
      "url": "http://localhost:3016/mcp"
    }
  }
}
```

- v2.37.0 と v2.37.1 は公開前の検査で止まり、イメージもリリースも公開されていません。v2.37.0 は実 API 検査（楽天トラベルのホテル検索）、v2.37.1 は全件テスト（CI が使う新しい Bun で、環境変数を書き換えたテストの後始末が不十分だったため、後続テストの通信が架空のプロキシへ向かった）で止まりました。v2.37.2 は公開されましたが、本番へ入れる前の検証で固有名詞判定の改善点が見つかったため、本番には入れていません。v2.37.3 はこれらの変更をすべて含み、固有名詞判定を直したものです。
- 実験的なホテル検索（MCP の `search_hotel_availability`、REST の `POST /hotels/availability`、有効化フラグ `SORA_RAKUTEN_TRAVEL_ENABLED`）を廃止しました。楽天トラベルの公開検索に依存し、外部の応答次第で公開前の検査が止まっていたためです。既定では公開されていなかった機能なので、既定のツール数（47）は変わりません。公開前の実 API 検査からホテルのレーンも外しました。
- `search_deep` の通常応答に `schedule` を追加しました。上位ページの `events`（公式サイト・TimeTree・まとめサイトなど）から、開始日（JST）と名称が同じ予定を 1 件にまとめた一覧で、`results` の前に置きます。各予定に載せていたページの URL を `sources` で示し、開催中・今後の予定は近い順、過去の予定はその後ろに並べます（予定は削除しません）。名称が違えば同日・同会場でも別の予定として残します。**応答の形が変わります**: 通常応答ではページごとの `results[].events` は `schedule` に移ります（重複を避けるため）。`verbose: true` では従来どおり `results[].events` に入り、`schedule` は付きません。`maxTotalChars` の対象外です。
- Markdown 冒頭の「📅 イベント情報」が、先頭 1 件だけから、開催中・今後の予定を近い順に（過去の予定はその後ろに）最大 10 件を 1 件 1 行で並べる形になりました。超えた分は「ほか N 件」と件数で示します。以前は TimeTree のように過去の予定が先頭にあると、それだけが出ていました。`events` は従来どおり抽出順で全件を返します。
- `maxTotalChars` で本文を切り詰めるとき、本文の塊を先に残し、短いラベル（16 字以下）のリンクだけの塊（グローバルナビなど）を先に落とすようにしました。ページの先頭にナビがあると、取り分の小さい結果がナビだけになり本文が消えていました（equal-love.jp の例: 4,624 字中 218 字がフロントマターとナビだけ）。本文だけでは空同然にしかならない場合は、従来どおり先頭側を残して切ります。ラベルの長いリンク一覧（ニュース・予定）は本文として扱います。
- X 検索の固有名詞（anchor）の判定を見直しました。語彙は追加していません。サイト名の枠（タイトル末尾）に出る語を重く数え、得点がほぼ同点（最高得点の 85% 以上）の語の中に X の総ヒット数が 3 分の 1 以下の語があればそちらを選びます（クエリに含まれる一般語はタイトルにも出やすいため。本番前の検証で「ライブ 予定 =LOVE」がライブと =LOVE のほぼ同点になり、旧版も含めて別名検索に進めなかったのを直しました）。それ以外で**確信が持てないときは決めません**（従来の緩和検索に任せます）: 最高得点が同点のとき、および X の総ヒット数が全候補分あり、最高得点の語が他のクエリ語より明らかにありふれている（少ない側の半分にも、最少の語の 1.25 倍以内にも入らない）ときです。「Web API デジタル庁」で API を、「アイドルフェス 持ち物 注意点」で持ち物を固有名詞と取り違えていた誤りがなくなりました。評価セット（dev と held の 53 クエリ。上の実データを dev に追加）は 正解 50・決めない 3・誤り 0 です（旧版は 52 クエリで 正解 48・誤り 4。決めない 3 件は固有名詞のないクエリ）。方式を決めた後に、正解を先に決めて集めた検証セット held2（16 クエリ）は、正解 9・決めない 5・誤り 2 でした。誤りは固有名詞なしと決めていた「前方エリア 一般エリア 違い フェス」で「前方エリア」を選んだものです。固有名詞を含むクエリで誤った語を選んだ例はありません。`SORA_REALTIME_ANCHOR=off` で従来の動作に戻せます。
- `search_deep`（`POST /search`）に `includeMedia` を追加しました。`false` で、画像・動画の URL（X 投稿の `media`、各ページの `ogImage` と `media`、本文中の画像記法。alt があれば「[画像: alt]」に置き換え）を応答から省きます。既定は `true`（従来どおり含める）です。`formats` で明示した `images` と `highlights` は省きません。
- `twitterHandle` を、メタタグ（`twitter:site` / `twitter:creator`）で宣言されたアカウントだけにしました。以前は、メタタグが無いと本文中で最初に見つかった x.com のリンクを使っていたため、まとめサイトのフッターにある開発者のアカウントが「公式」の候補になっていました。本文中のリンクは `socialLinks` にだけ残ります。**影響**: メタタグを持たない公式サイトでは、ページ由来の公式 X が決まらなくなります。その場合の `search_deep` の公式枠は、`officialAccountId` の指定か、クエリの固有名詞から Web 検索結果で見つけたアカウントで決まります。
- GitHub Actions の Live tool health の定期実行（毎日）が、2026-10-02 の追加以降ずっと失敗していた問題を直しました。定期実行・手動実行では候補イメージのタグが空になり、実行が始まる前に終了していました。公開時の検査には影響していませんでした。
- MCP の instructions と `POST /search` の API 説明に、`schedule` と `includeMedia` の使い方を追記しました。README の `scrape` 応答例を実際の出力形式（「📍 階層」「📅 イベント情報」の行）に合わせました。
- スクレイプと深層検索のキャッシュ名前空間を更新しました。デプロイ後に旧版の応答が返り続けないためです。

# Sora v2.36.1 — X 検索の誤りの修正と、応答の削減

- X のプロフィールページ（`x.com/アカウント名`）の本文が、別人の投稿にすり替わる不具合を修正しました。タイトルの整形が「＝LOVE_official」を「＝LOVE_off」に切り、無関係な投稿（「LOVE off vocal」）を本文に採用していました。アカウント名が分かれば、そのアカウント本人の投稿（`id:`）だけを使います。
- `search_realtime` と `search_deep` で、1件だけ全語に一致する投稿があると「網羅できた」と判断して検索を終える問題を直しました。全角の「＝LOVE」と書いた1件が全語に一致し、残り19件が記号を無視された別物でも、別名での再検索に進んでいませんでした。全語を含む投稿が半数未満（6件以上のとき）は、固有名詞が壊れていないか確かめます。語が1つだけのクエリ（`=LOVE`）でも別名で検索します。
- 誰の投稿を優先するかを選べるようにしました（`search_realtime` の `focus`、`search_deep` の `realtimeFocus`。`official`＝本人・公式、`public`＝本人以外）。省略時はクエリの語（評判・口コミ・感想・反応・炎上・批判など）から判定し、無ければ従来どおり公式優先です。`public` では評判系の語を必須にせず、投稿にほぼ書かれない語（評判・口コミ）は検索語から外し（「内山優花 評判」は0件、「内山優花」は250件でした）、`search_deep` の公式枠は後ろに最大2件へ下げます。応答の `focus` に適用した方が入ります。`search_deep` の `realtime.intent`（事実系・評判系・どちらとも言えない。結果の並びには使っていませんでした）は、`focus` に置き換えて応答から外しました（`intent` を読んでいるクライアントは `focus` を参照してください）。使われていなかった古い並べ替えのコードも削除しています。
- `search_deep` の公式枠で、自動で見つけたアカウントは、表示名か最近の投稿（3割以上）にクエリの語がある場合だけ公式として扱うようにしました（クエリと無関係なページの X 欄、例えば TimeTree のページの TimeTree 自身のアカウントを使わないため）。`officialAccountId` を指定したときは確認しません。
- 返す X 投稿の上限を `search_realtime` の `limit`（既定20）と `search_deep` の `realtimeLimit`（既定20、公式の枠は別）にそろえました。以前は複数の検索をまとめた結果が上限を超えていました。上限は返す件数にだけ効き、上限内のどの投稿にも無いクエリ語を含む投稿は、上限を超えて最大5件まで残します。省いた件数は `omittedCount` で返します。
- 応答を小さくしました。MCP の `search_deep` と `search_realtime` を整形なしの JSON にし（`verbose: true` のみ整形。同じ内容で約10%少ないトークン）、X 投稿の 0 の反応数と `isOfficial: false` を省き、別のページと同じハイライト（PC版とスマホ版など）の2つ目以降を `highlightsSameAs`（先の結果の URL）に置き換えます。「=LOVE ライブ 予定」の深層検索の一例では 30,084 → 18,869 トークンでした（Web 結果は検索のたびに変わります）。
- 固有名詞の判定で使う X の総ヒット数の取得を、既定の件数に直しました（1件だけ取ると「内山優花」が 250 件のところ 6 件と過少に返っていました）。
- `search_deep` のキャッシュ名前空間を更新しました。デプロイ後に旧版の応答が返り続けないためです。

# Sora v2.36.0 — X 検索のノイズ削減（固有名詞を守る緩和と別名検索）

- `search_realtime` と `search_deep` の X 検索で、原式で全語の揃う投稿が無いときの再検索を見直しました。従来は語を1つずつ落として再検索する際に固有名詞まで落とし、「ライブ 予定」のような無関係な投稿を大量に返していました。Web 検索上位のタイトルと X の総ヒット数から固有名詞を判定し、固有名詞を落とす再検索をしないようにしました（語順は問いません）。最後の再検索は、不足語の単独検索の代わりに固有名詞だけで行います。
- Yahoo が記号を無視して別物を返す固有名詞（`=LOVE` が「LOVE」一般の投稿になる等）は、公式 X アカウントの投稿のハッシュタグから別名（`イコラブ`）を見つけて検索し、固有名詞も別名も含まない投稿を除きます。`search_deep` の公式枠も固有名詞の公式にそろえます（「ライブ 予定 =LOVE」でラブライブ!の公式アカウントを公式枠にしていた不具合の修正）。
- 評価セットの12クエリの実測で、固有名詞か別名を含む投稿の割合が 24% → 100%、X への検索回数が 38 → 30 回になりました。判定に Web 検索を1回使うため、緩和が必要なクエリでは所要時間が約 0.4〜1.3 秒増えます（原式で揃うクエリは変わりません）。`SORA_REALTIME_ANCHOR=off` で従来の動作に戻せます。
- `missingTerms`（1件の投稿に揃わなかったクエリ語。空なら省略）と `aliasTerms`（検索に使った別名）を通常応答にも含めました。OpenAPI と MCP のツール説明にも反映しています。判定した固有名詞（`anchorTerm`）と除外件数（`anchorFiltered`）は `verbose: true` のときだけ返します。
- X 検索の網羅判定を NFKC で行うようにしました（全角の「＝ＬＯＶＥ」も =LOVE として扱います）。
- コンテナで共有 Chromium を閉じた後に、補助プロセスがゾンビとして残り続ける不具合を修正しました（v2.35.0 の無操作時の解放で発生）。イメージに tini を入れて PID 1 にし、孤児になったプロセスを回収します。起動コマンドと公開ポートは変わりません。
- `includeDomains` / `excludeDomains` に空文字列（API ドキュメントの入力フォームが送る `[""]`）があると Web 検索が0件になる不具合を修正しました。
- テストの各ファイルの終了時に共有 Chromium を閉じるようにしました。テスト実行後に Chromium が残ってメモリを圧迫していたためで、本番の動作は変わりません。
- 固有名詞判定の評価セット（`eval/realtime_anchor_cases.json`。設計に使った dev 28 クエリと、設計後に集めた held 24 クエリ）と評価スクリプト（`scripts/eval-realtime-anchor.ts`）を追加しました。判定精度は dev 24/28・held 24/24 です。
- `search_deep` のキャッシュ名前空間を更新しました。デプロイ後に旧版の応答が返り続けないためです。

# Sora v2.35.0 — 検索の待ち時間とコンテキスト量の削減、Chromium のメモリ解放

- MCP の `tools/list` から `outputSchema` を既定で除外しました（全47ツールで約245KB → 約82KB）。stdio も同様です。`tools/call` の構造化出力と検証は変わりません。従来どおり含めたい場合は `SORA_TOOL_OUTPUT_SCHEMA=true` を指定してください。
- `search_deep`（`POST /search`）に、本文合計の上限 `maxTotalChars` と、遅いページの打ち切り `scrapeDeadlineMs` を追加しました。どちらも明示した場合だけ働きます（`scrapeDeadlineMs` の既定は無効）。切り詰めた結果には `markdownTruncated`、打ち切った結果には `deadlineExceeded` が付き、`highlights` は削りません。
- 応答に `contextSufficiency`（根拠が足りているかの信号）を追加しました。応答内容は変わりません。`partial` / `insufficient` の `reasons`（`unmentioned:語` / `unanswered:語` / `few-success`）は不足の根拠になりますが、`no_gap_detected` は十分の保証ではありません。MCP の instructions と OpenAPI にも反映しています。
- ブラウザ描画の待機を改善しました。`networkidle` が来ないページは `load` 後5秒で打ち切り、DOM 静止の判定は DOM の変化ではなく見えている本文の変化で行います。属性だけを書き換え続けるページ（多言語化ウィジェットなど）で上限まで待たなくなり、実サイトの例で約9秒 → 約4秒になりました。取得した本文は変更前と一致しています。
- 共有 Chromium を、無操作5分（`BROWSER_IDLE_TTL_MS`、`0` で無効）で自動的に閉じるようにしました。実測で、描画中の約950MBが解放後は約200MBに戻ります。ブラウザセッションなどが開いている間は閉じません。
- `MAX_CONCURRENT_BROWSERS` の既定を、利用可能メモリ（cgroup の上限、無ければ搭載メモリ）から1〜5で自動算出するようにしました。明示した正の整数が優先されます。数値でない値を指定するとブラウザ描画が永久に待つ不具合を修正しました。
- 回答値の判定で、見出し文（「■チケット料金」）の後ろ2文までの値も回答とみなすようにしました（`DEFAULT_VALUE_LOOKAHEAD`）。保存済みの100ページでハイライトの選抜は98件が不変で、変わった2件は改善でした。
- 深層検索とスクレイプのキャッシュ名前空間を更新しました。デプロイ後に旧版の応答が返り続けないためです。
- README を実測値と実装に合わせて整理しました（起動時間・メモリの記載、比較表、ツール数、章立て）。`docs/search-scrape-mechanics.md` と agent 向け SKILL.md も更新しています。

# Sora v2.34.8 — 旧ハイライト選択アルゴリズム rho-bm25 の廃止

- `highlightAlgorithm` の選択肢から `rho-bm25` を削除しました。指定できる値は `rho-select-v2`（既定）、`rho-select`、`legacy` です。`rho-bm25` を指定したリクエストは入力検証エラーになります。
- 後方互換用の `rho_bm25` モジュールと `RhoBm25*` 型の別名を削除しました。MCP・REST のスキーマ説明（OpenAPI）と README からも記載を削除しています。

# Sora v2.34.7 — 検索・描画待機の高速化と公開カレンダー取得の改善

- deep検索で、Web検索が完了した時点から各ページの本文取得を開始し、独立したXリアルタイム検索と並行して処理します。最終結果には両方の取得結果を統合します。
- ブラウザ描画後に本文が空の場合、同じページで残りの期限内に描画を待つようにしました。再ナビゲーションを減らし、Loadingや読み込み中の表示だけで取得を完了する判定も改善しています。
- 非表示要素の除去をDOMのコピー上で行い、元ページのJavaScriptによる更新を維持します。Shadow DOMの再取得ではコピーを更新し、表やgrid内の主要な本文を保持する抽出も改善しました。
- 日本のWebをAIエージェントから利用するSelf-hosted MCP / REST統合サーバーとして、TimeTree公開カレンダーの接続処理を追加しました。公開ページ自身が受信した予定レスポンスから、予定名・日付・説明・会場・URL・画像を既存のscrapeとsearch_deepで取得できます。追加のAPI通信・APIキー・LLM呼び出しは不要です。
- TimeTree固有処理は対象の公開カレンダーと同じカレンダーのレスポンスに限定します。予定データがない場合は通常のDOM抽出を使用します。取得範囲はページが読み込んだ公開予定で、全月巡回や非公開予定の取得には対応していません。ページ内APIの形式変更への追従が必要です。
- MCPの説明文を、モデルが利用できるツールの直接呼び出しとホスト側のツール検索を優先する内容へ修正しました。配送・国地域ツールでも不要なsearch_tools呼び出しを要求しません。
- 旧キャッシュの再利用を防ぐためscrapeとdeep検索のキャッシュ名前空間を更新しました。responseModeの既定値は引き続きfullです。特定モデルへの依存や新しい公開ツール・引数は追加していません。

# Sora v2.34.6 — APIドキュメントの表示とテスト初期値の統一

- APIドキュメントの列挙値を、型・enum・DefaultとValues枠内のチップで表示する形式に統一しました。表示ライブラリのバージョンを固定し、外部更新による表示の変化を防ぎます。
- GETとPOSTの入力定義を共通化し、型・範囲・既定値・選択肢・説明を揃えました。荷物追跡GETには、実装が受け付ける自動判別指定のautoも記載します。
- POI検索のテスト入力に、有効な「カフェ・原宿」のサンプルを設定しました。半径5000メートル、最大10件、キャッシュ利用から試せます。地名と座標を同時に含む無効な自動生成サンプルを避けます。
- キャッシュ回避の既定値falseを明示し、APIドキュメントとOpenAPI定義を更新時に再検証するようにしました。
- GET/POSTの定義一致とテスト初期値を確認する回帰テストを追加しました。APIの検索処理や入力省略時の動作は変更していません。

# Sora v2.34.5 — API仕様と位置情報検索の改善

- MCPとREST/OpenAPIの入力・出力仕様を整合させました。整数の範囲、列挙値、既定値を明示し、画像・動画・候補語・週間天気・地震などのレスポンス定義を実際の返却内容に合わせています。
- Yahoo!路線情報で指定した日付・時刻を検索に反映し、省略時は日本時間を使用します。経路検索のキャッシュキーにもすべての検索条件を含めました。Yahoo! Web検索とサイトマップ取得では、指定したキャッシュ回避・日付条件を反映します。
- スクレイピングの`fullPage`指定とバッチ入力を処理に渡すよう修正しました。イベントの説明・終了時刻・公開日時の抽出を改善し、カレンダーの操作部分だけを本文として扱う誤判定を防ぎます。統合検索では同じ投稿の重複も除去します。
- 地名からの座標取得をNominatim（OpenStreetMap）へ切り替え、見つからない住所は国土地理院の住所検索で補完します。駅名・ランドマーク・番地を含む住所の検索に対応し、候補が複数の都道府県にまたがる場合は確認が必要な結果として返します。
- `search_poi`と`get_elevation`の結果に、使用した位置情報サービスの出典情報を追加しました。OpenPOIの施設情報にも出典を付け、クライアントが結果とともに帰属表示を提示できるようにしています。
- APIの表記検査と、駅名・住所・位置情報の出典表示を確認する回帰テストを追加しました。

## クライアント側の確認事項

監視チェックのREST応答は、単件を`{ result }`、複数件を`{ results }`で返します。監視結果を直接参照していたクライアントは、ラッパー内の結果を参照してください。

# Sora v2.34.4

- 公開gateをsoft hold化。`fail`/`unavailable`（破損シグナル）は公開停止を維持し、`unverified`/`blocked`のみ残存時は記録付きで公開進行（runner exit 3）。資格情報・test dataなし運用に対応。

# Sora v2.34.3

- live改善: 公開SNS投稿の既定test data（4 platform＋X、秘密上書き可）、運航の国際fallback、外部tool caseのunverified再試行。機能変更なし。

# Sora v2.34.2

- CI安定化: 追跡テストのChromium有無・WAF変動・60秒上限に対応（旧unknown固定期待の更新、browser取得の時間上限）。機能変更なし。

# Sora v2.34.1

- CI修正: 国際追跡のブラウザ取得をCIの60秒上限内に収める（ups/fedex分割・描画上限30秒・遷移待ち上限20秒）。機能変更なし。

# Sora v2.34.0

- 新規MCPツール `search_poi`（OpenPOI直結・全国施設POI検索、座標付き）と REST `POST/GET /geo/poi` を追加。OpenAPIに登録し、README・件数表記を全47ツール（hotel有効時48）へ同期。
- 国際3社（UPS・FedEx・DHL）の追跡をキーなし動作化。資格情報があれば公式API優先、なし時はステルスブラウザ取得、それも不可なら公式URL案内へフォールバック。DHL追跡URLを現行化。
- MCPのHost/Origin検証（不正は403）、本文抽出の情報欠落修正（aside置換・表列重複・lazy画像）、国地域SNS入力の保持、SNS失敗の誤キャッシュ防止、監視selector不在のbaseline保護。
- 全ツール live CI harness（`scripts/tool-health`）：本体検査＋候補コンテナ実取得＋provider別確認＋JSON/Markdown/JUnit報告。公開は同一image検査通過が条件。
- 検証: 全test 1204 pass / 0 fail、typecheck成功。live通常lane 82 pass・0 fail（資格情報・test data不足分はunverified/blockedとして記録）。

# Sora v2.33.1

- MCPの遅延ツール有効化状態をセッションごとに分離。同じAPIキーや匿名接続でも、別セッションと再接続は初期公開14ツールから開始します。
- セッションIDを付けない単発呼び出しは、指定ツールをその要求内だけで有効化。正式名・`default.`互換名を利用でき、他の要求や接続へ状態を持ち越しません。
- MCPセッションは作成時と同じテナントからのみ利用可能。別APIキーや認証を外した要求ではセッションを使用できません。
- 接続間の分離・再接続・単発呼び出しの回帰テストを公開イメージのCI検証に追加。版数検証の古い固定値を除去し、READMEの接続手順を更新しました。
- CIでHTTP403になるe-Gov実通信の4テストを、既存の`SORA_LIVE_TESTS=1`ライブ試験へ分離。入力不正の400応答は通常テストで検証します。e-Gov上流の403自体はこの修正の対象外です。

# Sora v2.33.0

- X個別投稿の全文取得: MCP `fetch_x_post`（遅延ツール）と REST `POST /realtime/post` を追加し、OpenAPIに登録。ステータスIDまたは投稿URLからFxTwitter経由の検証済み全文を取得。`search_realtime` で見つけた投稿の深掘り用。
- X全文補完の検査窓を上位5件から10件に拡大（外部取得は2件のまま）。切詰め疑いの見逃しを減らす。
- 実験的楽天トラベル宿泊検索を `SORA_RAKUTEN_TRAVEL_ENABLED=true` 背後に追加（東京駅・京都駅・草津温泉のみ、施設名は未対応のため null）。既定の公開範囲・ツール数に影響なし。
- ツール数は46（コア14不変）。

# Sora v2.32.0

- 証拠スコアリング: 回答値検出・entity関連・表/定義構造・時間関連・明示日付の年照合・相対日解決。言及/回答カバレッジ診断と 12-24-48 段階候補投入。
- 辞書分離: intent語・stopwords・時間語を retrieval lexicons に集約し、スコア倍率を EVIDENCE_WEIGHTS 一表化。dead RRF削除、enrichment循環import解消。
- 評価: live 10件収集＋機械的事前ラベル、5件にAI一次ラベル（要人手確認）。
- API: `adaptiveScrape` と `scrapeBudget` を REST・MCP・OpenAPI 共通スキーマに接続。型・範囲を検証し、指定値を内部検索へ渡します。既定は引き続き追加取得なしです。
- ドキュメント: README・API説明・検索処理の説明を更新。日付の基準と年省略時の仮定、`updated` と開催日の違い、検索精度評価の未完了範囲を明記。OpenAPI は整数制約を `integer` として出力します。
- CI: Google News fixtureの経時失敗、MCP有効化状態・環境変数のテスト間漏れ、バージョン不整合を修正。配送会社の実応答テストを `SORA_LIVE_TESTS=1` に分離し、佐川の未登録・HTTPエラー・通信失敗は固定応答で検証。失敗ログとJUnitを保存します。
# Sora v2.31.0

- 検索 v2: Yahoo プロバイダー圧力制御（AIMD・サーキット・予算）、構造化 429 と Retry-After 対応、stale キャッシュ、検索 singleflight、回答カバレッジ停止、抽出エスカレーション＋遅延ブラウザスキップ。
- API: `GET /metrics` にセキュリティ・検索カウンタを JSON と Prometheus の両形式で公開。OpenAPI の表記を日本語化。`search_deep` の適応パラメータを README に文書化し、検索・スクレイプの仕組みを `docs/search-scrape-mechanics.md` に整理。
- 品質: strict typecheck 修復、JMA 週間予報テストの提供日数変動への対応。フルスイート 1073 pass / 4 skip / 0 fail、Hermetic gate 207 pass。

# 監査対応パッチ (unreleased)

- Yahoo 路線情報フライト一覧の Next.js 化（__NEXT_DATA__）に対応。旧 table 解析はフォールバックとして維持。
- 詳細ヘルスが SORA_VERSION を返すよう修正。L2 キャッシュの作成時刻を永続化値から復元。古い API 使用量・監視履歴の定期 purge を追加。
- 外部依存のライブテストを SORA_LIVE_TESTS=1 背後に分離し、CI に bun test ワークフローを追加。
- README のツール数・モジュール・環境変数表を実態に更新。GET / 一覧に tracking/social を追加。未使用の Dockerfile・ベンチ・ゴミファイルを削除。

# 公開SNS取得（Weibo/Threads/Instagram/Facebook）(unreleased)

- MCPに `search_social_posts`（Weibo新着検索・Meta公開投稿の発見＋本文取得）と `fetch_social_post`（既知投稿の本文・日時・反応）を追加。追加費用・ログイン不要。Xは対象外のため `search_realtime` を使う。
- RESTに POST /social/search・POST /social/fetch を追加し、OpenAPIへ登録。
- 国地域インテリジェンスに `social_posts` プロバイダーを追加。`includeSocial: true`＋`social` 指定で実行し、締め切りは55秒。単独SNS結果はDB保存しない。

# Global Intelligence v2 — live evidence without Yahoo realtime (unreleased)

Country Intelligence restores event content instead of counts: GDACS real-shape parsing (url objects, affected countries, severity), GDELT Events export ingestion with region filtering and honest period gaps, USGS/EONET/global feeds, 6 World Bank indicators with full series, holiday scope details, and article-body extraction.

- Report v2 (schemaVersion 2, additive): domainContext facts per domain, provider limitations, refreshState, actualWindows with gaps, persisted evidence details with cursor paging and change diffs.
- MCP intel: research_country_context now returns text JSON plus validated structuredContent; new get_country_context, get_country_context_evidence, get_country_context_updates. REST adds the matching evidence and updates endpoints. Yahoo realtime is never used on this path.
- Collection durability: evidence details, source cursors, and change history persist (migration v3); single-owner collector lease; stale/unknown/clock-anomaly freshness instead of silent success.

# 🧭 Sora Release v2.27.0

## Xリアルタイム検索の直接JSON移行 (unreleased)
- `search_realtime` / `POST /search/realtime` / `POST /realtime` / `search_deep` 内のX取得・X投稿URL解決が、Yahoo MCPバイナリ経由からYahooのJSON取得の直接呼び出しに切り替わりました。Yahoo HTMLのトップ枠 (`bestTweet`) にだけ存在した投稿の取りこぼしを解消します。
- Yahoo公式の検索演算子 (`id:` / `@` / `#` / `-` / `(A B)` / `URL:` / URL直接入力) と複数語・アカウント指定の併用に対応し、OR・URL条件を含む式の意味を変える自動relaxは行いません。
- 構造化 `url` は `URL:` 演算子として送信するよう修正しました (従来は通常語として追加)。
- `page` は公開1始まり・Yahoo側40件固定幅、`limit` は1〜40・デフォルト20。provider障害はHTTP 502 / MCPエラーとして返し、一部失敗時は `partial` 付きで成功分を返します。
- Web・画像・動画・ニュース・知恵袋の取得は従来どおりMCPバイナリを使用し、バイナリ配置も維持します。
- Country Intelligence 側は geo 正規化・provenance・検証済み two-pass・metric/signal 基盤・domain view・default runtime を追加しました (詳細は intel 実装メモ)。

### Realtime compact default + Country Intelligence v1

- `search_realtime` / `search_web` / `search_deep` return compact responses by default (answer-required fields only); pass `verbose: true` for retrieval diagnostics (`retrievalQueries` / `contributingQueries` / `resultsMerged` etc.). REST `/search/realtime` and `/search/web` behave the same with cache keys separated by verbosity.
- `search_realtime` description shortened to stay within the 400-char initial tools/list budget (33 contract tests pass).

### Country Intelligence v1 — evidence-backed country context

- New `POST /intelligence/country` + `GET /intelligence/context/:contextId`, and deferred MCP tool `research_country_context` (`intel` module, `search_tools` keyword `国地域`).
- Deterministic pipeline: conservative region resolution, isolated providers with timeout/retry/cache, normalized evidence, conservative event clustering, factual temporal/relation context, SQLite persistence.
- Report counts keep articles, event clusters, and independent sources separate; publisher country never leaks into event country; ambiguous regions stay low-confidence.
- Partial-report semantics: a single provider 429/timeout degrades coverage instead of failing the report.
- Explicitly no sentiment, hostility, anti-Japan, safety, or risk classifiers or scores.
- Persistence requires `SORA_DB_PATH=/data/sora.db` on a mounted `/data` volume (`VOLUME ["/data"]` declared in Dockerfile/Containerfile). Opt-in smoke: `bun run test:intel:live`.

# 🌤️ Sora Release v2.25.0

### MCP 遅延ツールの LibreChat 互換修正

- 再接続時の有効化状態保持に加え、有効化した遅延ツールの `default.` 付き互換名を公開。LibreChat が `default.search_trend` 等を完全一致で検索する場合も、再初期化後に定義取得・呼び出しできるよう対応。
- 初期公開は12ツールを維持。遅延ツール1件の有効化で正式名と互換名の2定義を追加（同じ引数検証・処理を使用）。無効モジュールは公開しない。
- キーワード検索のランキングを維持しつつ、明示的なカテゴリ検索では3件制限を適用せず、カテゴリ内の全ツールを有効化。
- 有効化状態の保持は同一プロセス内。プロセス再起動・別レプリカへの接続では再度 `search_tools` が必要。

伝票番号の形式衝突と投機競合（first-response-wins）を排除し、決定論的かつ高信頼な配送追跡を実現する **Tracking v2 アーキテクチャ** を導入したメジャー・マイナー機能リリースです。

> **原則: Detect locally. Verify narrowly. Never guess.**
> （推測するな。観測せよ。最速応答は勝者ではない。確実な配送エビデンスのみを採用する。）

### 🌟 主な機能と改善 (Highlights)

1. **Carrier Adapter & Registry 刷新 (8キャリア対応)**
   - 運送会社ごとの追跡・検証責任をアダプタへ完全分離。
   - 国内 5 大キャリア（ヤマト運輸、佐川急便、日本郵便、西濃運輸、福山通運）に加えて、国際配送（UPS、FedEx、DHL Express）の計 8 社へ正式対応。

2. **Ranked Local Detection (非推測・完全ローカル判定)**
   - ネットワーク通信を一切行わず、全キャリアアダプタの形式ルール・チェックディジット・正規表現に基づきスコアと強度を判定・順位付け。
   - **UPS 1Z Exclusive**: UPS 固有の `^1Z[0-9A-Z]{16}$` は他社候補を一切呼び出さず単一照会。
   - **UPU S10 国際郵便**: 公式重みベクトル `[8, 6, 4, 2, 3, 5, 9, 7]` によるチェックディジット検証と `postal` メタデータ付与。外国発行（US 等）の EMS 番号も日本郵便国際追跡へ安全にルーティング。

3. **Bounded Wave Verification (最大 4 回制限・段階的並行照会)**
   - 候補上位から最大 2 社ずつ並列照会（Wave 1: Top 2、Wave 2: Next 2）。
   - Wave 1 で確実なエビデンス（`strong`）が確認された時点で後続 Wave を即時中止（Short-circuit）。
   - ネットワーク照会は最大 4 回に厳格制限し、外部サービスへの不要な高負荷やレイテンシ遅延を防止。

4. **Verified Carrier Adoption (Fastest Is Not Winner)**
   - 最速で返ってきたこと自体を勝者決定の理由とせず、配送イベント履歴や詳細情報が存在する `verification.level === 'strong'` の結果のみを勝者として採用。
   - API クレデンシャル未設定時の Web URL 案内（URL-only）が auto winner になることを厳格に防止。

5. **Multiple Strong Conflict 判定**
   - 同一伝票番号で複数社が有効な配送実績を返した場合、単一キャリアを推測・偽装せず `ambiguous: true` / `status: 'unknown'` として安全に競合をユーザーへ通知。

6. **REST / MCP / OpenAPI 契約同期**
   - MCP `track_package` および REST `/tracking` において 8 社キャリアコード（`fedex`, `dhl` を含む）と `preferredCarriers`, `originCountry`, `destinationCountry` ヒントパラメータを完全サポート。
   - 初期 12 コアツール構成（Two-Tier Tool Architecture）とコンテキストトークン効率を維持。

---

# 🌤️ Sora Release v2.24.3

コアツール枠（厳格な初期 12 ツール構成）の復元と、遅延ツール動的有効化（Two-Tier Tool Architecture）の LLM 誘導プロンプトを強化した Hotfix リリースです。

- **初期コアツール枠の復元（12 ツール制限の厳格な遵守）**: `track_package` を初期 CORE ツールから元の遅延読み込み（`defaultEnabled: deferredDefault`）へ戻し、初期 `tools/list` のツール数を 12 ツール（11 コア + `search_tools`）に復元。コンテキストトークン効率を最優先とする設計原則を徹底。
- **動的有効化誘導プロンプトの強化**: `buildSoraMcpInstructions` 内の Tier 1 指示において、`track_package` が初期非表示の遅延ツール（DEFERRED）であることを明記し、利用前に必ず `search_tools(query: '荷物追跡')` を呼び出して動的有効化してから使用することを LLM に一意に指示・誘導。
- **コントラクトテストの整合性担保**: 初期 12 ツール構成および `track_package` の動的有効化フローに対するテストアサーションを同期（29 tests 全件 PASS）。

---

# 🌤️ Sora Release v2.24.1

v2.24.0 で導入した X long-form enrichment に対する Hotfix リリースです。

- **post-merge X long-form detail selection**: Yahoo official/public マージ後に全文取得候補を選定
- **Yahoo truncation gate**: Yahoo 本文が切断疑い（`text.length >= 240`）の投稿のみを Gate 通過
- **max two Fx detail calls**: 上位 5 件をローカル評価し、FxTwitter HTTP 呼び出しは最大 2 件に制限
- **query relevance selection**: original semantic query relevance に基づき Fx detail 候補を選択
- **canonical X text response**: `text` を唯一の canonical 本文に一本化
- **canonical author_name/author_handle response**: `author_name` + `author_handle` を canonical author 表現とし、`@` を除去
- **removal of redundant long-form response fields**: 通常レスポンスから `snippet`, `markdown`, `originalText`, `author`, `author_url`, `siteName` を完全に除外し、レスポンスサイズを大幅に削減（`verbose: true` のみ `detailDiagnostics` を付与）
- **URL normalization**: host-facing X URL から Yahoo トラッキングパラメータ（`utm_source`, `utm_medium`, `utm_campaign`）を自動除去
- **Yahoo/Fx fail-soft挙動の維持**: 外部 API エラーやタイムアウト時もエラーを発生させず安定フォールバック

---

# 🌤️ Sora Release v2.24.0

荷物追跡の信頼性・レイテンシを飛躍的に高める **Fail-fast Package Tracking** と、X (旧 Twitter) の長文投稿（Note Tweet 等）を正確かつ安全に補完する **Bounded X Long-form Enrichment** を統合したメジャー・マイナー機能リリースです。

各種 MCP ツールと REST API の全レイヤー（`search_deep` / `/search/deep`, `search_realtime` / `/realtime`, `scrape` / `/scrape`, `track_package` / `/tracking`）においてマルチサーフェスな動作整合性を完全担保しました。

---

## 🌟 v2.24.0 主なハイライト (Highlights)

### 1. 📦 荷物追跡の信頼性・レイテンシ改善 (Track B)
- **並行投機照会の Fail-fast 化**: 複数キャリアの並行探索において、確実な配送結果（`delivered`, `in_transit`, `registered`, `returned`）が確定した瞬間に即座に早期 return。遅延キャリアやタイムアウト待ちによるレイテンシを大幅に削減。
- **UPS フォールバックの適正化**: API 認証情報（`UPS_CLIENT_ID` / `UPS_CLIENT_SECRET`）が未設定の場合に従来の `status: 'registered'`（虚偽の追跡完了リスク）を廃止し、安全な `status: 'unknown'` と公式追跡 Web リンク案内へ是正。
- **伝票番号の候補推定適正化**: 汎用的な未知伝票番号から UPS を除外し、UPS 固有の形式（`^1Z[0-9A-Z]{16}$`）のみ候補として自動判定。

### 2. 𝕏 X 長文投稿 (Note Tweet) の適応的全文補完
- **Yahoo Realtime Discovery の維持**: 広範な即時検索・トレンド把握は Yahoo! リアルタイム検索の高速性を維持し、不要な外部 API コールを排除。
- **語彙観測に基づく Bounded Enrichment**: クエリ要求とスニペットの語彙照合（`tokenizeAndSelectTerms`）および省略記号（`…` や `...`）による切り捨て検知を行い、情報欠落の兆候がある上位候補のみ FxTwitter v2 API（最大 2 件、通常 0〜1 件）で全文補完。
- **Direct X Status URL への直結**: X ポスト URL（`/status/:id`）が指定された場合、Yahoo 検索を待たずに直接 FxTwitter detail を試行し、Note Tweet の完全な長文本文・正確な著者名・投稿日時を 1 回で抽出。
- **100% Fail-soft & プライバシー保護**: 外部 API のタイムアウト（1,500ms）・レート制限・HTTP エラー時もエラー落ちせず Yahoo スニペットを維持。FxTwitter へは numeric statusId のみ送信し、ユーザーの生クエリやセッション情報は一切非送信。5分 TTL キャッシュと single-flight 重複排除を内蔵。

### 3. 🔁 MCP & REST Multi-surface Parity
- **REST `/realtime` エイリアス**: クライアント互換性のため、`POST /search/realtime` に加えて `POST /realtime` も同一ハンドラでマウント。
- **Deep 統合検索・単一スクレイプ連携**: `search_deep`（MCP）および `/search/deep`（REST）の速報枠や Web 記事スクレイプ、`scrape`（MCP）および `/scrape`（REST）のすべてで X ポストの全文抽出がシームレスに機能。
- **包括的統合テストスイート**: REST と MCP の全サーフェスを検証する `src/services/mcp_rest_deep_realtime.test.ts` を追加し、全件グリーンを恒久保証。

---

# 🌤️ Sora Release v2.23.1

v2.23.0 で導入された各種機能と runtime 挙動を、MCP スキーマ・ツール説明・指示文（`SORA_MCP_INSTRUCTIONS`）・REST・OpenAPI・ドキュメント間で 100% 整合させる **LLM-facing Contract Synchronization & Discovery Refinement** リリースです。

検索・retrieval・ranking・ρSelect v2 の精度経路は変更せず、LLM が迷わず正確にツールを選択・発見・活用できるプロトコル契約を強化しました。

---

## 🌟 v2.23.1 主なハイライト (Highlights)

### 1. 🔁 `search_deep` スキーマの Single-Source 化 & 完全パリティ
- `src/mcp.ts` 内の手動インラインスキーマ定義を撤廃し、共有スキーマ `INTEGRATED_SEARCH_INPUT_SHAPE` に一本化。
- OpenAPI 生成における Zod 3.24+ の enum 欠落バグを修正し、REST / MCP / OpenAPI 間の全 enum・default・境界値の一致をテストで恒久保証。
- `search_web` の `limit` 説明文言をランタイム挙動（最大: 20。formats指定時: 5。未指定時: provider 既定件数維持）と完全同期。

### 2. 🧩 Module-Aware な MCP ガイダンス & 厳格な分離
- `buildSoraMcpInstructions(activeModules)` を導入し、有効なモジュールのみ Tier 1 ディレクティブおよびツールガイダンスを動的生成。
- `life` モジュールと `disaster` モジュールの instructions 定義を完全に分離し、片方のみ有効な構成でも他方のツール名が漏出しないよう適正化。
- `search_tools` の候補なしメッセージに表示される「利用可能なカテゴリ」も現在アクティブなモジュールのみ動的反映。

### 3. 🔍 段階的ツール発見 (Progressive Discovery) の品質向上
- `search_tools` の自然言語判定における逆包含処理を 2 文字以上（`[...kLower].length >= 2`）に限定。「歌手」で「歌」を含む `search_song` が誤活性化される 1 文字誤マッチを排除。
- `search_tools` の description から固定ツール名（`search_deep 等`）を削除し、モジュール無効構成でも矛盾しない client-neutral な案内に統一。
- 初期 12 コアツールの定義文字数を 19,963 文字、instructions を 6,102 文字に最適化（初期コンテキスト消費を全登録比約 70% 削減）。

### 4. ⚡ MCP Standard Streamable HTTP 通知の E2E 実証
- MCP SDK 標準の Streamable HTTP（GET SSE ストリーム）経由で、`search_tools` 実行時に `notifications/tools/list_changed` が確実にクライアントへ届き、同一セッション内で `tools/list` が動的リフレッシュされる E2E 通信を実証。

---

# 🌤️ Sora Release v2.23.0

MCP / REST の検索レスポンス整合性を保ちながら、必要なクライアントだけ返却量を大幅に削減できる **Evidence Response Mode**、`search_web` の共通 format 契約、Host-facing highlights 正規化、および検索診断の安全な拡張を統合したリリースです。

既存互換性を優先し、`search_deep` の `responseMode` は引き続き **`full` がデフォルト**です。`evidence` は明示 opt-in であり、取得・ρSelect v2・Deep Evidence Rerank の精度経路は変更しません。

---

## 🌟 v2.23.0 主なハイライト (Highlights)

### 1. 📦 `search_deep` Evidence Response Mode（明示 opt-in）
- `responseMode: "full" | "evidence"` を MCP / REST の双方で利用可能。
- `full` は従来互換のデフォルト。
- `evidence` は query-selected `highlights` を保持し、安全条件を満たす結果だけ重複する全文 `markdown` を省略。
- `markdown` を highlights で上書きせず、`highlights` も削除しません。
- `formats:["markdown"]` の明示指定、`extractHighlights:false`、highlights 不在、scrape fallback/error、X ソースでは全文 Markdown を保持します。
- 決定論的な real MCP + REST E2E fixture では、対象情報を保持したまま返却文字数を約 91% 削減しました（fixture 実測値であり、一般ワークロードの保証値ではありません）。

### 2. 🔁 MCP / REST の検索契約整合性
- `search_deep` の full / evidence で stable semantic surface の MCP / REST parity を実 E2E で検証。
- `search_web` に共通 `formats` 契約を導入し、MCP / REST の双方で `markdown`, `tables`, `links`, `jsonLd` 等を同一方針で取得可能。
- `formats` 未指定時の `search_web` は従来の軽量検索パスを維持し、追加スクレイプを行いません。
- requested format 以外の payload を漏らさない Host projection を追加。

### 3. 🎯 Host-facing highlights の正規化
- 外部向けの標準 surface を `highlights` に統一。
- 内部用 `highlightItems` は Deep Evidence Rerank まで保持し、通常レスポンスでは露出させません。
- `verbose` 時のみ診断用内部情報を維持します。

### 4. 🔎 安全な検索診断と実験機能
- verbose-only の query lineage / evidence diagnostics を追加。通常レスポンス・順位決定には影響しません。
- Web Query Union と X Source Isolation は引き続き **明示 opt-in / デフォルトOFF**。
- Study 2B の実験実装は production candidate から除外済みで、本リリースには含めません。

### 5. 🧪 回帰安全性
- ρSelect v2 canonical tests: 23 tests / 422 assertions。
- ρSelect v2 1,000-seed stress: 5 tests / 4,588 assertions。
- ソライロ / 季節外れのリナリア / SPARK の precision fixtures を release gate に固定。
- real MCP + REST Evidence E2E、real MCP + REST `search_web formats` E2E、build、version contract をリリース前に実行。
- main と release candidate の full test suite を同一隔離環境で比較し、candidate-only failure がないことを確認してからリリースします。

---

# 🌤️ Sora Release v2.22.0

気象庁公式オープンデータによる週間天気予報（最大7日先＝計8日間）の統合、および不要な個人ボランティアAPI（tsukumijima）フォールバックの完全撤廃アップデート（v2.22.0）です。

---

## 🌟 v2.22.0 主なハイライト (Highlights)

### 1. 🌦️ 気象庁公式 週間天気予報（7日先＝計8日分）の統合
- **日別マージエンジンの新設**:
  - 気象庁 API の短期予報（今日・明日・明後日）と週間予報（3日後〜7日後）を自動統合し、指定地域（例: 「山中湖」190020）において最大 8 日分（今日〜7日後）の日別予報（天気コード・日本語テロップ・降水確率・予想最高/最低気温・予報信頼度 A/B/C）をシームレスに取得可能になりました。
- **`days` パラメータ拡張**:
  - `days: 1〜8`（デフォルト: 7）へ拡張し、MCP ツール `get_weather` および `/weather` エンドポイントで週間予報をワンショット取得可能にしました。

### 2. 🛡️ OSS開発倫理・健全性の向上（個人APIフォールバックの完全撤廃）
- **一次ソース（気象庁公式 CDN）への一本化**:
  - 個人開発者がボランティア運用している外部サーバーへの自動フォールバック処理を完全削除しました。
  - 共倒れリスクと外部への不要な負荷集中を根絶し、Akamai CDN 等で高可用配信される気象庁公式データのみを直接参照する堅牢で倫理的なアーキテクチャに整理しました（オッカムの剃刀）。

---

# 🌤️ Sora Release v2.19.0

最新の数理最適化研究に基づく証拠選択エンジン **「ρSelect v2 (Canonical Engine)」** の完全導入および深層エビデンス駆動リランキング機能の搭載アップデート（v2.19.0）です。連続スコア $r_{it} \in [0, 1]$ に対する Graded Max-Evidence 則と座標単調効用関数 $\Phi(y)$、Safe Dominance 剪定、および Exact Observed-Rank DP / Adaptive Refinement 二段階ハイブリッドソルバーを実装しました。全クエリに対して数学的オプティマイザ証明書（`certificate`: $LB \le \rho^* \le UB$）を発行し、外部監査レポート（v0.35）の全指摘事項を是正するとともに、実クエリでの偽陽性を根絶する深層エビデンス駆動リランキングおよび Markdown リスト構造保護パースを導入しました。

---

## 🌟 v2.19.0 主なハイライト (Highlights)

### 1. 🎯 ρSelect v2: 数学的オプティマイザ証明書付き証拠選択エンジン
- **連続スコア評価と Graded Max-Evidence**:
  - 連続値 $r_{it} \in [0, 1]$ の適合スコアを直接扱う数理モデルへ刷新。
- **Canonical Unconstrained Mode（自律的疎性最適化）**:
  - ハード上限 $K$ を前提とせず、State-Witness Sparsity 定理（$|S^*| \le m$）と分数目的関数に基づき、必要最小限かつ情報密度の高い証拠集合を自律選出。
- **Safe Dominance 剪定による状態空間 22.7倍（95.59%）削減**:
  - パレート劣位候補を探索前に安全にパージ。実測において状態数を 1,678 → 74 へ劇的削減（レイテンシ約 52 倍 高速化）。
- **二段階ハイブリッド・ソルバー & 数学的証明書 (`certificate`)**:
  - Exact DP と Adaptive Refinement により大域的最適性を数学的に証明。各レスポンスに `certificate`（$LB \le \rho^* \le UB$）を添付。
- **1,000 Seeds ストレス回帰テストスイートの完走**:
  - 1,000 決定論的シード（4,588 assertions）による厳格な数学的性質（Exact vs Brute-force、AR Bounds、$\epsilon=0$ 収束、Dominance不変性、Ties、Fail-closed）を 100% 検証。

### 2. 🔍 深層エビデンス駆動リランキング (`rerankByDeepEvidence`)
- **スニペット段階での偽陽性の根絶**:
  - 検索エンジンの合成スニペットに別文脈の単語が含まれていた場合の誤1位判定を解消。
- **多層エビデンス順位補正**:
  - 深層スクレイピング完了後、本文およびハイライトのクエリ単語カバレッジ、意図キーフレーズ（末尾語・特異語）充足、および ρSelect v2 ハイライトスコアを総合評価し、真に回答根拠を含むページを 1 位へ自動浮上。

### 3. 📝 Markdown 空行区切りリスト構造保護パース
- **クレジット・定義リストの泣き別れ防止**:
  - `- 作詞者\n\n 内山優花` のような空行区切りインデントリストが空行で別セクションに分断されるのを防ぎ、同一セクションブロックに結合保持。

### 4. 📚 監査・仕様ドキュメントの最新化
- 理論解説: [`docs/rho_select.md`](docs/rho_select.md)
- LLM向けハンドオーバー仕様書: [`docs/rho_select_v2_llm_handover.md`](docs/rho_select_v2_llm_handover.md)
- 監査指摘是正・新機能実装報告書: [`docs/rho_select_v2_audit_response.md`](docs/rho_select_v2_audit_response.md)

---

# 🌤️ Sora Release v2.18.0

日本の主要運送会社および国際便の横断追跡機能（`/tracking`、`track_package` MCP ツール）の新規搭載、およびトークン効率的証拠選択エンジン「ρSelect」におけるボイラープレート・メタデータ自動排除とリスト内見出し階層認識の機能強化を含む大型アップデート（v2.18.0）です。

---

## 🌟 v2.18.0 主なハイライト (Highlights)

### 1. 📦 日本主要5社＋UPS 荷物追跡 API & MCP ツール (`POST /tracking`, `track_package`)
- **対応キャリア**:
  - ヤマト運輸（クロネコヤマト）
  - 佐川急便
  - 日本郵便（ゆうパック・書留）
  - 西濃運輸（カンガルー便）
  - 福山通運
  - UPS（United Parcel Service / 国際便）
- **高精度キャリア自動判別**:
  - 伝票番号の桁数（10/11/12/13/18桁等）やハイフン位置、Modulus 7 および Luhn チェックサムによる自動キャリア識別。
  - キャリア指定なし（`"carrier": "auto"`、または `GET /tracking/:number`）でも即座に対象キャリアを判定して追跡。
- **5分間インメモリ LRU キャッシュ**:
  - 同一伝票番号への重複問い合わせを防止し、外部サーバーへの負荷を抑制（キャッシュヒット時レイテンシ <0.5ms）。
- **REST & MCP 両対応**:
  - REST API: `POST /tracking`, `GET /tracking/:carrier/:number`, `GET /tracking/:number`
  - MCP ツール: `track_package`（Module 4: Japan Daily Life & Transit に統合）

### 2. ⚡ ρSelect: ボイラープレート・メタデータ自動排除 & リスト内見出し認識
- **Frontmatter & パンくずメタデータの自動排除**:
  - Markdown 先頭の YAML frontmatter（`--- publishedTime: ... ---`）やサイト共通ナビゲーション（`> 📍 **階層**: ...`）が候補セクションに混入してハイライト選択を歪める問題を根本解決。
- **リスト内見出し階層認識 (`- ### [記事見出し]`)**:
  - 朝日新聞トピックスや Yahoo!ニュース等のポータルサイトで頻出する、箇条書きリスト要素内に埋め込まれた Markdown 見出し記号を正確に境界認識。一覧記事の各トピックを独立した候補セクションとして精密に分離・スコアリング。
- **スニペットの Frontmatter クレンジング**:
  - 検索結果レスポンスの `snippet` および `description` に混入した YAML frontmatter やパンくず文字列を事前サニタイズ。

---

# 🌤️ Sora Release v2.16.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」の最新機能アップデート（v2.16.0）です。

本バージョンでは、現代の情報検索（Information Retrieval: IR）理論と最新 RAG 研究に基づく **3大 IR アルゴリズム（Lost in the Middle 対策 U字型リオーダリング、MMR 多様性選択、インメモリ PRF 適合性フィードバック）**、時間軸ハルシネーションを防止する **Temporal Context Anchor（相対日時の絶対タイムスタンプ自動解決）**、および大規模な表構造をインテリジェントに要約・圧縮する **Smart Table Minimizer** を新規実装しました。

すべてのアルゴリズムは **ゼロ・ミドルウェア（外部 LLM・外部ベクトル DB 不要、完全インメモリ <0.05ms）** で動作し、LLM コンテキスト窓の劇的な節約とエージェントの推論精度向上を両立します。

---

## 🌟 v2.16.0 主なハイライト (Highlights)

### 1. 🧠 情報検索 (IR) 理論に基づく 3 大アルゴリズム (Zero-Middleware IR Engine)

外部の重厚なベクトル検索エンジンや Re-ranking LLM を一切導入せず、スクレイピング・検索結果の本文チャンクに対して純粋な数理的インメモリ処理（純粋 TypeScript / Bun）で最高水準の検索精度を実現しました。

- **① Lost in the Middle 対策: U字型リオーダリング (`reorderUshaped: true`)**
  - **背景**: 大規模言語モデル（LLM）は、プロンプトの先頭（Primacy Bias）と末尾（Recency Bias）にある情報を強くアテンションし、中央部の情報を忘却・見落としやすい特性（Lost in the Middle 現象）を持ちます。
  - **解決策**: BM25 や検索スコア順に上位から並べる従来の直線的配置を刷新。最重要チャンク（Rank 1, 2）を先頭と末尾に配置し、中央部に向かってスコアが緩やかに低下する **U 字型順序（$R_1, R_3, \dots, R_4, R_2$）** へ自動再配置。LLM による中央部情報の見落としを数理的に防止します。
- **② Carbonell & Goldstein (1998) 準拠: MMR 多様性選択 (`useMmr: true`)**
  - **背景**: 単純な類似度・BM25 スコアのみで上位チャンクを抽出すると、ほぼ同一内容の文章（ヘッダー、重複した免責事項、定型句など）が連続して選択され、限られたコンテキスト窓を浪費します。
  - **解決策**: クエリとの関連性（$\text{Sim}_1$）と、すでに選択されたチャンク群との最大類似度（$\text{Sim}_2$）のトレードオフを数式 $\text{MMR} = \operatorname{argmax} \left[ \lambda \cdot \text{Sim}_1(d_i, q) - (1 - \lambda) \max_{d_j \in S} \text{Sim}_2(d_i, d_j) \right]$ に基づいて動的評価。$\lambda = 0.7$（デフォルト）により、関連性を維持しながら重複情報を強力に排除し、多様な情報源からチャンクを網羅採択します。
- **③ Rocchio 適合性フィードバック: インメモリ PRF (`usePrf: true`)**
  - **背景**: ユーザーの検索キーワードと Web ページの記述表現の揺らぎ（Vocabulary Mismatch）により、重要な本文が従来の単語一致検索から漏れる問題があります。
  - **解決策**: 一次検索で高スコアを獲得した上位チャンク（Top-K）のテキストから、TF-IDF + サブワード境界スコアリングによって特異的キーワードをインメモリで自動抽出。クエリ重みベクトルを $q_{\text{new}} = \alpha \cdot q + \beta \cdot \text{keywords}$ で自動拡張して再スコアリング。重い Embedding モデル不要で検索適合率を大幅に向上させます。

### 2. ⏳ Temporal Context Anchor（相対日時の絶対タイムスタンプ自動解決）
- **背景**: Web 記事やプレスリリース、ブログ、SNS では「明日」「来週」「3日前」「今週末」といった相対日時表現が多用されます。LLM はスクレイピング日時や記事執筆日時を知らないため、時間軸のハルシネーション（過去のイベントを未来と誤認するなど）を頻発させます。
- **解決策**:
  - 記事の公開日時（HTML メタタグ `article:published_time`、Schema.org JSON-LD `datePublished` 等）またはスクレイピング実行日時を「基準アンカー日時（Anchor Time）」として自動設定。
  - 本文中の相対日時表現を正規表現とカレンダー演算により動的検知し、インラインで絶対日時を付与（例: `来週水曜日 [2026-09-16 (水)] に開催予定`）。LLM が一切の推測なしに確定日時を認識できます。

### 3. 📊 Smart Table Minimizer（表トークンのインテリジェント圧縮）
- **背景**: 仕様表、比較表、運行スケジュール等の Markdown テーブルは、空セル（`-`, `N/A`, `なし`）や定型ヘッダー、重複列が多く、LLM のコンテキスト窓を極度に浪費します。
- **解決策**:
  - 表全体の空セル率が 50% を超えるスパースな表や、低情報密度の列・行を自動検出。
  - 重要なデータ行を維持しながら、コンパクトなキー・バリュー形式や省略フォーマットへ自動圧縮。表データの可読性と意味的完全性を保ちながら、トークン消費量を **最大 60% 削減** します。

### 4. ♿ Evidence-Preserving Accessibility Hints（根拠データプレーン）
- 画像リンク、アイコンボタン、装飾的ナビゲーションなど、テキストが少なくアクセシビリティ属性（`aria-label`, `alt`, `title`）にのみ意味情報が含まれる HTML 要素から、根拠テキストを自動抽出し Markdown 出力に統合。視覚情報・補助テキストの欠落を防ぎます。

### 5. ⚡ 圧倒的なパフォーマンス・ベンチマーク (Zero-Middleware)
- すべての処理を外部サービスや重厚なミドルウェアに依存せず、純粋な TypeScript / Bun インメモリ環境で完結。
- 実測レイテンシ：
  - **U-shaped Reordering**: **1.2 µs**
  - **MMR 多様性選択 (10チャンク)**: **28.4 µs**
  - **インメモリ PRF 適合性フィードバック**: **42.1 µs**
  - **Temporal Anchor (相対日時解決)**: **15.6 µs**
  - **Smart Table Minimizer**: **8.3 µs**
  - 合計オーバーヘッドは 0.1ms 未満であり、既存のスクレイピング・検索速度に一切影響を与えません。

### 6. 🧪 テスト・検証実績 (Testing & Verification)
- **自動テストスイート**: **全 292 テスト 100% PASS**（2,843 件の expect アサーション）
  - 新規 IR アルゴリズム、Temporal Anchor、Table Minimizer の単体・統合テストを完全網羅。
  - 既存の全 REST エンドポイント・MCP ツール仕様と 100% 完全互換。
- **コンテナ**: v2.16.0 のイメージで稼働確認済み（`curl http://127.0.0.1:3016/health` → `200 OK`）。

---

# 🌤️ Sora Release v2.13.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」の最新機能アップデート（v2.13.0）です。

本バージョンでは、商用 LLM（Claude / ChatGPT 等）やローカル LLM（Llama / Qwen / Ollama 等）における**回答拒絶（Over-Specialization による過剰拒否）の完全根絶（Zero-Refusal Policy）**、**2層構造ツール決定フレームワーク (Two-Tier Tool Decision Framework)**、および Google（Passage Chunking）や Firecrawl のベストプラクティスに基づく**本文精読（Search → Scrape ループ）の義務化** を実装しました。

---

## 🌟 v2.13.0 主なハイライト (Highlights)

### 1. 🛡️ 回答拒絶の完全防止ポリシー (Zero-Refusal Policy)
- **過剰適合による回答拒絶の根本解決**:
  - LLM に多数の専門ツールを提供した際、「ライブ日程専用ツール」「営業時間専用ツール」「発売日専用ツール」等が存在しないことを理由に、LLM が「ツールがないためお答えできません」と勝手に決めつけて回答を拒絶する問題（Over-Specialization Bias）を根絶。
  - MCP 初期化ハンドシェイク（`initialize`）時に配布される `instructions` において、「専用ツールの不在を理由とした回答拒絶・推測放棄」を全面的に禁止。

### 2. 🗺️ 2層構造ツール決定フレームワーク (Two-Tier Tool Decision Framework)
- **Tier 1 (公式専門データ直結ツール・強制呼び出し)**:
  - 以下の 6 大ドメインについては、モデル自前の知識推測や一般 Web 検索を禁止し、必ず Sora の専用公式ツールを実行：
    1. **米国貿易・通関・規制判定**: `predict_hts_code`, `verify_hts_code`, `check_cpsc_certificate`, `check_fda_regulated`, `check_product_compliance`
    2. **日本法令・国会審議録**: `search_laws`, `get_law_text`, `search_diet_minutes`
    3. **気象庁防災・地震・道路交通**: `get_weather`, `search_disaster_warnings`, `search_earthquake`, `search_road_traffic`
    4. **国内路線乗換・フライト・標高**: `search_route`, `get_flight_status`, `get_elevation`
    5. **SNS速報・知恵袋・トレンド**: `search_realtime`, `search_trend`, `search_chiebukuro`, `suggest_keywords`
    6. **音楽メタデータ**: `search_song`, `search_artist`, `search_music`
- **Tier 2 (万能深層Web検索ツール・全実世界データ調査)**:
  - 上記以外のあらゆる最新事実・スケジュール・実世界データ（ライブ・公演・イベント日程、新製品・発売日、店舗営業時間、人物・企業動向、時事ニュース、技術ドキュメント等）は、**`search_deep`（推奨一次ツール）** を呼び出し、Clean Markdown 本文まで深く読み込んで包括的かつ根拠ある回答を構築。

### 3. 🔍 Google & Firecrawl 式の本文精読（Search → Scrape ループ）ルール
- **スニペットによる中途半端な推測の防止**:
  - 検索スニペット（1〜2行の抜粋）はメタ情報に過ぎず、開場時間やチケット発売日、詳細規約は本文（Main Content）にしか存在しません。
  - `search_web`（URL・概要スニペット探索）を使用した場合でも、スニペットだけで詳細が不確定な場合は推測で終わらせず、必ずヒットした公式 URL を `scrape` ツールで精読して本文を確認することを規約化。

### 4. 🏷️ 万能ツールの検索キーワード & Description 強化
- **動的ツール発見（`search_tools`）の精度向上**:
  - `search_deep`: 「【万能深層Web検索・最新事実/スケジュール/イベント調査】」を明記し、`['スケジュール', 'イベント', 'ライブ日程', '発売日', '営業時間', '最新情報']` をキーワードに追加。
  - `search_web`: 「【万能Web検索・候補探索】」を明記し、`['イベント検索', '告知検索', 'スケジュール']` をキーワードに追加。
  - `search_artist`: 「ライブ・公演日程や最新の出演スケジュール・最新活動情報は search_deep または search_realtime を使用してください」との相互誘導を明記。
  - `search_realtime`: アイドルのライブ出演・物販タイテ・緊急告知・イベント現地の生の声への最適性を明記。

### 5. ⚡ 次世代スクレイピング＆抽出エンジン（8大機能強化）
- **BrowserContext 軽量セッション分離**: 常駐 Chromium インスタンスに対し軽量な一時コンテキストをオンデマンド生成・即時破棄。プロセスの起動・終了待機ゼロとセッションごとの完全な Cookie / キャッシュ隔離を両立。
- **インテリジェント・アセット遮断**: 不要な画像バイナリ、メディア、Webフォント、3Dモデル、広告・解析トラッカーをネットワーク層（Request Interception）で即座に abort。CSS・JS を維持して正確な DOM レイアウトと不可視要素判定を保持しつつ、転送量 99% 削減とロード時間半減を達成。
- **DOM Quiescence（静止検知）SPA待機**: 固定スリープを廃止し、`MutationObserver` により 200ms の DOM 静止を動的検知して即座に完了。テスト実行時間を 106s から 90s へ大幅短縮。
- **イベント・スケジュール構造化抽出**: Schema.org `Event` / `MusicEvent` を自動解析し、構造化データ（JSON）および Markdown 冒頭コールアウトとして出力。
- **パンくずリスト（階層コンテキスト）抽出**: サイトの階層ナビゲーションを抽出し、ページの文脈パス（Breadcrumb）を Markdown に自動付加。
- **テーブル結合セル正規化**: `colspan` / `rowspan` を 2D マトリクスで自動補完・展開し、複雑な表構造の崩れを防止。
- **重要画像スコアリング**: フライヤー・タイテ・図表等の画像メタデータを検出し、不要アイコンと区別して優先抽出。
- **Clean Content Sanitizer & DNS Pinning**: プロンプトインジェクション用制御トークンや不可視ゼロ幅文字のサニタイズ、末尾ドット FQDN 表記による SSRF 回避の厳格な防御。

---

# 🌤️ Sora Release v2.12.0

### 1. 📋 MCP Instructions ＆ 専門ツール強制ディレクティブの導入
- MCP 初期化ハンドシェイク時に配布されるクライアント向けシステム指示書（`SORA_MCP_INSTRUCTIONS`）を整備。
- 各ツールの説明文に「【必須・推測回答厳禁】」「【公式直結】」等の強制ディレクティブを付与し、モデル自身の不確実な学習知識によるハルシネーションを防止。

### 2. 🪶 入力・出力の分離と軽量返却キー注記 (Return Annotations)
- 巨大な JSON 出力スキーマによるトークン爆発やローカル LLM の KV キャッシュ枯渇を防ぎつつ、各ツール説明文末尾に `返却: { status, overallStatus, ... }` の軽量アノテーションを付与してエージェントの戻り値認識性を最適化。

---

# 🌤️ Sora Release v2.11.0

### 1. 🛡️ 米国貿易コンプライアンスにおける多層防御（Dynamic Clarifying Questions）
- `check_product_compliance` や `predict_hts_code` において、主素材や対象年齢、飲食接触の有無などの重要パラメータが不足している場合、モデルが勝手に推測せず、AI エージェントがユーザーにヒアリングするための動的質問リスト（`clarifyingQuestions`）と `inputCompleteness: "partial"` を返却する多層防御機構を実装。

---

# 🌤️ Sora Release v2.10.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」の機能拡張アップデート（v2.10.0）です。

本バージョンでは、米国輸出通関・越境 EC 支援において極めて重要な**「商品情報からの HTS/HS コード推測エンジン（`predict_hts_code` / `POST /trade/hts-predict`）」**の新設、**2026 HTS Revision 18 & Chapter 99 特別追加関税リスク対応**、**2026年7月 CPSC 完全義務化 & ACE Disclaimer（免責申告コード）の反映**、および **FDA 実務 PGA フラグ（FD1〜FD4）判定ロジックの刷新** を実施しました。

---

## 🌟 v2.10.0 主なハイライト (Highlights)

### 1. 🎯 商品情報からの HTS/HS コード推測エンジン (`predict_hts_code` / `POST /trade/hts-predict`)
- **2段階ハイブリッド推測アルゴリズム**:
  - 米国通関申告に必須となる 10 桁統計細分コードを特定するため、商品名・説明文・素材・用途・対象年齢からセマンティックスコアリングでサブヘディング（6 桁）を高速に特定。
  - 米国国際貿易委員会（USITC）公式現行関税率表 API（`hts.usitc.gov`）とリアルタイム連携し、該当サブヘディング配下の全 10 桁統計細分コード、品目名、一般関税率を展開してセマンティック照合を実施。
- **実測精度**:
  - 玩具、陶磁器食器、化粧品、綿衣料、ヘルメット、食品（緑茶）、電子機器（急速充電器）等の代表品目において、**6 桁 HS コード特定率 100%、10 桁 HTS 完全一致 71%、上位 2 位以内特定率 100%** の高精度を実証。
- **PGA 規制判定とのシームレス連動**:
  - 推測された最有力 HTS コードに基づき、連動する CPSC 適合証明書要件（CCC/GCC・eFiling）および FDA 規制要件（FD1〜FD4 フラグ・Prior Notice・MoCRA）を自動で並行評価。

### 2. 📜 2026 HTS Revision 18 & Chapter 99 特別追加関税リスクのガイダンス追加
- **大統領布告・通商条約への即応**:
  - 2026年9月公開の 2026 HTS Revision 18（大統領布告 PP 11059/11055）や通商法 301 条（中国原産品追加関税等）に基づく **Chapter 99 特別追加関税** の適用リスクと通関士確認手順を判定レポートに追加。

### 3. 🛡️ CPSC 2026年7月8日 eFiling 完全義務化 & ACE Disclaimer（免責コード）対応
- **完全義務化ステータスの反映**:
  - 2026年7月8日より施行された米国税関（CBP）ACE システムへの電子申告（eFiling: フル PGA メッセージセット送信、または CPSC Product Registry 事前登録による参照送信）完全義務化（De Minimis 適用除外なし）を明記。
- **ACE 免責申告（Disclaimer）の案内**:
  - 規制対象外品目や類似コード品目に対して、通関保留エラー（P00/PU2）を防止するための **ACE Disclaimer コード（A: 非規制品、B: 適用規格免除等）** の申告ガイダンスを追加。

### 4. 🏥 FDA 実務 PGA フラグ（FD1〜FD4）判定ロジックの刷新
- **通関実務仕様への完全移行**:
  - 従来の粗い Chapter 2 桁判定から、CBP/FDA 実務で機械的に使用される PGA フラグ体系（FD1〜FD4）へ全面刷新：
    - **FD4**（食品必須）: 米国到着前の FDA 事前通知（Prior Notice / PNC 確認番号取得）絶対必須。
    - **FD2**（食品以外必須）: 化粧品（MoCRA / Cosmetics Direct 施設登録・製品リスティング）、医療機器（510(k) / Listing）、医薬品（NDC コード取得）。
    - **FD1**（用途により該当）: 食器・調理器具等の食品接触物質（FCS）。`foodContact` パラメータと連動し、食品接触用途なら FDA 安全基準適合要件、装飾用等の非接触用途なら ACE 免責（Disclaimer）申告を自動案内。

### 5. 🛠️ 全 38 MCP ツールへの拡張 & Gemini 100% 互換性維持
- 新規 MCP ツール `predict_hts_code` を含め、全 38 ツールの inputSchema が Gemini の Tool Calling 仕様（`exclusiveMinimum`、`const`、`array` 型禁止）に 100% 適合（1,412 項目検査パス）。

---

# 🌤️ Sora Release v2.9.0

日本の Web 空間と日常・行政・防災インフラを AI エージェントから自由かつ安全に利用するための Self-hosted MCP / REST 統合サーバー「Sora (空)」のメジャーアップデート（v2.9.0）です。

本バージョンでは、LLM エージェント連携における**トークン消費量の大幅削減（Compact Response Mode & Base64 画像パージ）**、**SSRF 難読化 IP の数学的正規化によるセキュリティ完全防御**、**SPA 描画の適応型待機最適化**、**共有ブラウザ自動ローテーション & グレースフルシャットダウン**、および **REST ルーターのドメイン別モジュール分割（コードベース 91% スリム化）** を実施しました。

---

## 🌟 主なハイライト (Highlights)

### 1. 🪶 Compact Response Mode（LLM トークン消費量を 50% 以上削減）
- **デフォルト出力の軽量化**:
  - スクレイピング API (`/scrape`, `/scrape/stream`, `/search` 等) において、AI エージェントのコンテキスト窓を圧迫していた内部品質評価データ（`quality`, `completeness`, `qualityReasons`, `missingFields`, `evidence`, `renderedWithBrowser` 等）をデフォルトで自動除外。
  - レスポンスのペイロードサイズと LLM のトークン消費量を **50% 以上削減** し、高速かつ低コストなエージェント運用を実現。
- **オンデマンド詳細出力 (`verbose: true`)**:
  - 品質デバッグやハルシネーション検証で内部評価データが必要な場合は、リクエストに `"verbose": true`（または `/search?verbose=true`）を指定することで、完全な出処根拠（Provenance）やスコアを常時取得可能。

### 2. 🧹 Base64 インライン画像の自動パージ & 置換
- **コンテキスト窓の浪費防止**:
  - Web サイト内に埋め込まれた長大なインライン画像（`data:image/png;base64,...`）を自動検知し、Markdown 変換時に `![画像: alt属性]` へ自動置換してパージ。
- **画像保持オプション (`keepDataImages: true`)**:
  - Base64 データをそのまま保持したい場合は、`"keepDataImages": true` を指定することで置換をバイパス可能。

### 3. 🔒 SSRF 難読化 IP の 32bit 整数正規化 & IPv6 埋め込み完全遮断
- **バイパス攻撃の完全無力化**:
  - 8進数（`0177.0.0.1`）、16進数（`0x7f000001`）、32bit整数（`2130706433`）、省略記法（`127.1`）、および IPv4-mapped IPv6（`::ffff:127.0.0.1`）などの難読化されたプライベート IP 表現をすべて 32bit 符号なし整数へと数学的に正規化。
  - DNS 解決および HTTP リクエスト送信前に内部プライベート空間（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, CGNAT `100.64.0.0/10`）へのアクセスを確実に遮断。

### 4. ⚡ SPA 描画待機最適化 & Chromium 自動クリーンローテーション
- **動的適応待機（最大 850ms 短縮）**:
  - TimeTree や React/Next.js 等の SPA 描画時、本文要素の出現とローディングスピナーの消失をリアルタイム監視し、描画完了の瞬間に 350ms で即座に切り上げ。不要な固定待機（1,200ms）を排除。
- **共有 Chromium プロセスの自動ローテーション**:
  - 累積 200 回のブラウザレンダリング実行後、かつアクティブセッションが 0 のアイドル時に共有ブラウザを自動でクリーン再起動。長時間稼働に伴う Chromium のメモリリークやタブゾンビを根絶。

### 5. 🛑 グレースフルシャットダウン (Graceful Shutdown)
- **安全なリソース解放**:
  - `SIGTERM` / `SIGINT` シグナル受信時に、新規リクエストの受付停止、対話型ブラウザセッション（`closeAllBrowserSessions`）、共有 Chromium（`closeSharedBrowser`）、SQLite コネクション（`closeDatabase`）を安全にクローズしてクリーン終了。

### 6. 🏗️ REST ルーターのドメイン別モジュール分割
- **Fat Router の完全解消**:
  - `src/index.ts`（1,620 行）に集中していた 50 以上のエンドポイントを、Hono 標準の `app.route()` を用いて **9 つのドメイン別サブルーター**（`src/routes/`）へ分割・再構築：
    - `system.ts`: ヘルスチェック・メトリクス・OpenAPI・Docs・キャッシュクリア
    - `mcp_route.ts`: MCP Streamable HTTP / SSE プロトコル
    - `scrape.ts`: 単一・一括・ストリーミング・サイトマップ・クロール
    - `search.ts`: Web検索・リアルタイム速報・画像/動画/ニュース/知恵袋・乗換案内・音楽
    - `browser.ts`: ステルスブラウザ自動操作
    - `trade.ts`: 米国貿易コンプライアンス（HTS/FDA/CPSC/eFiling）
    - `public_data.ts`: 気象庁天気・警報・地震・道路交通・フライト・法令・国会会議録・標高
    - `watch.ts`: Web 差分監視
    - `media.ts`: マルチモーダル画像視覚入力
  - `src/index.ts` は 150 行のエントリポイントへと約 91% スリム化。

---

## 🧪 テスト・検証実績 (Testing & Verification)

- **自動テストスイート**: **全 209 テスト 100% PASS**（2,347 件の expect アサーション）
- **外部 API 互換性**: 既存の全 REST エンドポイント・MCP ツール仕様と 100% 完全互換
- **コンテナ**: v2.9.0 のイメージで稼働確認済み

---

## 📦 アップグレード方法

### Docker / Podman
```bash
podman pull ghcr.io/ikenokazuki/sora:latest
# またはバージョン固定
podman pull ghcr.io/ikenokazuki/sora:2.9.0
```

### Claude Desktop / Cursor 設定 (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "sora": {
      "url": "http://localhost:3016/mcp"
    }
  }
}
```
