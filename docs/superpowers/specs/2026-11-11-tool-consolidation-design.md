# ツールの統合（v5.0.0）

## 目的

ツールが多いと、LLM が似た名前のツールの中から選び間違える。MCP のツールを、**用途ごとに 1 つ**にまとめて、53 個を 33 個にします。新しく足す `search_archives`（国立公文書館）を入れても 34 個です（数は 2026-11-11 時点の既定のモジュール。`lyrics`・`shazam`・`hts-archive` は名前を挙げたときだけなので除く）。

破壊的変更を許す前提です（ユーザーの決定）。REST は変えません（下の「REST と client」）。

## 原則

1. **1 ツール = 1 つの意図。** 種類の違いは引数（`type`・`include`・`action` など）で選ぶ。
2. **検索と取得は 1 ツール。** `query` か `id`・`url` のどちらかを渡す。
3. **入力から判別できるものは、判別する。** URL の種類、住所か郵便番号か座標か、など。
4. **平らな引数にする。** 任意の引数を並べ、「どれか 1 つ必須」は refine で確かめる。`oneOf`・`anyOf` は使わない（Gemini の関数宣言が受けないため）。数の enum も使わない（既存の決まり）。
5. **`include` の既定は、いまの応答のまま。** 応答を膨らませない。新しい種類は、頼まれたときだけ返す。
6. **名前を付け替えるものは、旧名の別名を残さない。** ただし、旧名を `search_tools` のキーワードに入れて、旧名で探しても新しいツールが見つかるようにする。
7. **予算を守る。** コア 14 ツールの `description` の合計は 3500 字未満（今 3499 字）、初期の tools/list は 30000 字未満（今 22,957 字）。種類ごとの説明は引数の説明に置く。

## 新旧の対応

| 新しいツール | 統合する旧ツール | 判別・入力の決まり |
|---|---|---|
| `scrape`（コア） | `scrape_batch` | `url` か `urls` のどちらか。`concurrency`・`webhookUrl` は `urls` のときだけ |
| `crawl_site` | `map_site` | `listOnly: true` で URL 一覧だけ（`limit`・`since`・`until`）。省略は今の巡回 |
| `fetch_social_post`（コア） | `fetch_x_post` | `url`（X・Weibo・Threads・Instagram・Facebook）。X は `statusId` でも可 |
| `search_media` | `search_image` `search_video` `search_news` | `type`: `image` `video` `news`。動画だけの引数（`transcripts` など）は `type: video` のときだけ |
| `search_keywords` | `suggest_keywords` `search_trend` | `query` あり＝サジェスト、なし＝急上昇トレンド |
| `get_disaster_info`（コア） | `search_disaster_warnings` `search_earthquake` | `city`／`areaCode`＝その場所の警報、なし＝全国の地震。`include` で台風・火山・洪水予報・津波などを足す（気象庁の追加と同時に設計） |
| `lookup_address` | `search_postal_code` `normalize_address` `reverse_geocode` | `lat`＋`lon`＝逆引き、`address`＝正規化（`level`・`compareAddress`・`zipcode` も）、`zipcode` だけ＝郵便番号の候補 |
| `get_place_info` | `get_elevation`（と新しい防災） | `address` か `lat`＋`lon`。`include`: `elevation`（既定）`hazards` `shelters` `seismic`。防災の設計メモ（`get_area_safety`）をここに入れる |
| `search_laws`（コア） | `get_law_text` | `keyword` か `lawId` のどちらか |
| `watch` | `watch_register` `watch_check` `watch_list` `watch_delete` | `action`: `register` `check` `list` `delete` |
| `search_music` | `search_song` `search_artist` | `entity`（曲・アルバム・アーティスト）で選ぶ（今の `search_music` の引数のまま） |
| `lookup_hts` | `predict_hts_code` `verify_hts_code` | `htsCode` あり＝照合、なし＝商品の説明から推測 |
| `check_regulations` | `check_cpsc_certificate` `check_fda_regulated` | `htsCode`＋`agencies`（`cpsc` `fda`。既定は両方） |
| `get_country_context` | `get_country_context_evidence` `get_country_context_updates` | `contextId`＋`part`: `report`（既定）`evidence` `updates` |
| `get_youtube` | `get_youtube_transcript` `get_youtube_channel` | `url` が動画か、チャンネルかで判別 |

そのまま残すもの: `search_web` `search_deep` `search_realtime` `search_social_posts` `search_chiebukuro`（検索の本流。意図が違う）、`browser_action` `inspect_image` `search_tools`、`get_weather` `search_route` `search_road_traffic` `get_flight_status` `track_package`、`search_poi` `search_diet_minutes`、`check_product_compliance` `generate_gcc_certificate`、`research_country_context`。

新しく足すもの: 新ツールは `search_archives`（国立公文書館。ジャパンサーチの単一 DB 検索 `najda-default`。検索と id の取得を 1 ツールに）だけ。ほかは、統合後の既存ツールの `include` や欄として足します（各機能の設計メモは別）。

| 新機能 | 置き場（統合後の名前） |
|---|---|
| 防災（ハザードの想定区域・避難場所・地震の確率） | `get_place_info` の `include`: `hazards` `shelters` `seismic`（承認済みの設計メモ `get_area_safety` を、この形に直す） |
| 気象庁: 地域時系列予報・アメダス現在値・季節予報と 2 週間気温・ナウキャスト | `get_weather` の `include`: `hourly` `observation` `outlook` `nowcast` |
| 気象庁: 早期注意情報・気象解説情報・津波・長周期地震動・南海トラフ・海上警報・キキクル | `get_disaster_info` の `include`: `outlook` `bulletins` `tsunami` `longPeriod` `nankai` `sea` `risk` |
| 空港の天気 | `get_flight_status` の欄 `airportWeather`（既存の天気・警報の関数を空港の所在市で流用） |
| 道路の交通量（国土交通省の交通量 API） | `search_road_traffic` に `lat`・`lon` と `include: ['volume']` |
| 国立公文書館 | `search_archives`（新ツール） |
| OpenPOI の住所・施設の補完 | `search_poi` の応答（調査中） |

結果: 53 → 33（`search_archives` を足して 34）。コアは 14 → 13（警報と地震が 1 つになる）。

## 統合の決まり（各ツール共通）

- 応答は、統合前の応答をそのまま使う（モードごと）。複数の種類を返すときは、種類ごとの節にする（例: `get_disaster_info` の `warnings`・`earthquakes`・`typhoons`）。どのモードで答えたかを `mode` 欄で返す。
- 引数の検査: 「どれか 1 つ必須」「同時に指定できない」は refine で確かめ、エラーの文面で正しい使い方を示す。
- 説明文: 先頭に「何をするか」、続けて「どう使い分けるか」。旧名の語（「標高」「郵便番号」「逆ジオコーディング」など）を説明に残し、`registerTool` の `keywords` に旧名（`get_elevation` など）を入れる。
- 遅延読み込みのツールは、今までどおり `default.<名前>` の別名（`default.` を付けた名前で呼ぶ MCP クライアント用）を持つ。新しい名前でも同じ。
- モジュール: 統合したツールは、元のツールが属していたモジュールに置く（例: `lookup_address`・`get_place_info` は `disaster`、`lookup_hts`・`check_regulations` は `trade`）。モジュールが無効なら、そのツールは出ない。

## REST と client

- **REST は変えません。** URL・リクエスト・レスポンスはそのまま。REST の利用側（資源ごとの URL を呼ぶ）には、LLM の選び間違いの問題が無く、変えると利用側を直す費用だけが増えるためです。
- ただし MCP の統合ツールと REST の対応は 1 対多になります。`scripts/tool-health/catalog.ts` の `REST_MAP`（ツール → REST の 1 経路）を、複数の経路を持てる形にします。`CANONICAL_TOOLS`・`gen-client`・`schema:notation` の対（`pair_mismatch`）・`src/tool_contracts.test.ts` はこの表を読んでいるので、モードごとの経路を比べる形に直します。
- `client/`（型つきクライアント）は `bun run gen:client` で作り直します。

## 移行

- 版は **v5.0.0**。`RELEASE_NOTES.md` と README に、旧名 → 新名と引数の対応の表を載せる。
- ツール名を設定に書いている利用側（エージェントの許可リスト・除外リストなど）は、本番に出すときに合わせて直す。Sora のリポジトリには、利用側の個別の名前は書かない。
- 旧名を呼ぶと、MCP は「そのツールはありません」。`search_tools` で旧名を検索すれば、新しいツールが見つかる。

## 検証

- 統合の目的は「選び間違いを減らす」ことなので、**ツール選びの正答率を前後で測る**。日本語の依頼 60 問（各ツールの用途をまんべんなく）に、期待するツールと主な引数を付け、旧の 53 ツールと新の 34 ツール（`search_archives` を含む）を、それぞれ丸ごと渡して選ばせる（実行はしない）。モデルは Haiku 5.5。ツールの定義はキャッシュに載せるので、費用は数ドル以内の見込み。**実行の前にユーザーの承認をもらう。**
- 正答率が下がる統合があれば、その統合は戻すか、説明を直す。
- 契約テスト（応答の形・OpenAPI・MCP の入力）、`schema:notation`、説明文の予算のテスト、`tool-health` の検査（ツール名の対応）を新しい名前に直す。

## 段階

各段階の終わりに、main が整合した状態（旧名と新名が混ざらない）になるようにする。リリース（v5.0.0）は最後にまとめて。

1. 土台: `REST_MAP` を複数の経路を持てる形に直す。モード付きの引数の検査の共通部分。
2. 検索・取得: `scrape`・`crawl_site`・`fetch_social_post`・`search_media`・`search_keywords`。
3. 住所・地点: `lookup_address`、`get_place_info`（標高だけ。防災は別の設計メモで足す）。
4. 災害・気象: `get_disaster_info`（警報と地震。気象庁の追加は別の設計メモで足す）。
5. 法令・音楽・監視・貿易・国の情報・YouTube: `search_laws`・`search_music`・`watch`・`lookup_hts`・`check_regulations`・`get_country_context`・`get_youtube`。
6. ツール選びの評価、README・docs・`RELEASE_NOTES.md`、版を 5.0.0 に。

そのあとに、統合後の名前で新機能（防災・気象庁・公文書館・交通・POI の補完）を足します。

## 範囲外

- REST の統合。
- 検索の本流（`search_web` ほか）の統合。意図が違い、統合すると引数が膨らむ。
- ツールの中身（取得元・判定）の変更。統合は入口の整理だけ。
