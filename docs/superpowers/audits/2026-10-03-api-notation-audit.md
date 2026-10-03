# API表記・契約監査（2026-10-03）

対象: `/home/ikeno/Sora` main `56fe1f3`（v2.34.4）＋作業ツリーの未コミット修正。
範囲: MCP入力スキーマ、REST/OpenAPI入出力、MCPツール説明の「返却」注記、README。全48ツール（ホテル有効時）。

## 0. 今回の作業ツリーで修正済み（未コミット）

| 項目 | 内容 |
| --- | --- |
| OpenAPI変換器 | 手書きの `zodToOpenApiSchema` を `z.toJSONSchema(..., { target: 'openapi-3.0', io: 'input' })` へ置換。`z.literal` が `type: "undefined"` になる不具合（76箇所）、`nullable` の必須判定、`z.any` が `string` になる問題、`record` の値型、URL・正規表現・文字数・配列長の制約欠落を解消 |
| Compact Scrape応答 | 通常応答で省略する `isTruncated`・`contentType`・`source` を任意項目へ変更 |
| 統合検索応答 | `results` の実際の項目（`markdown`、`snippet`、`directFetch` など）、`realtime` のオブジェクト形状、`prf`、`responseMode` を定義 |
| 本文取得判定 | `contentStatus`（`body` / `structured_data` / `metadata_only` / `unavailable`）を追加。曜日・数字だけの本文を成功扱いしない。JSON-LDのイベント説明・終了日時を本文へ反映 |
| 重複統合 | 同一URL・同一X投稿IDをモードに関係なく統合し、`retrievalSources` と公式フラグを保持。`dedup` は別投稿の類似内容の間引き用として残す |

検証: `bun run typecheck` 成功、全テスト 1245成功・17スキップ・0失敗。

## 1. 実害あり（入力が無視される・結果が変わる）

| # | 内容 | 根拠 | 最小修正 |
| --- | --- | --- | --- |
| A1 | MCP `search_route` の `date`・`time` が無視され、常に現在時刻で検索する | MCP定義 [mcp.ts:1336](../../../src/mcp.ts#L1336)。サービスは `year/month/day/hour/minute` だけを参照 [life.ts:29](../../../src/services/life.ts#L29) | `date`/`time` を `year/month/day/hour/minute` に変換して渡す。現在時刻は `Asia/Tokyo` で算出する（コンテナがUTCの場合ずれる） |
| A2 | 乗換のキャッシュキーに `ticket`・`sortBy`・`seatPreference`・`walkSpeed`・`use*` が含まれず、条件を変えても前回結果が返る | [life.ts:169](../../../src/services/life.ts#L169) | キーに全条件を含める |
| A3 | REST `/transit/route` のOpenAPIに日時・`timeType`・`ticket`・`use*` がない（ルート実装は `year` などを受け付ける） | [types.ts:618](../../../src/types.ts#L618) | MCPと同じ入力定義を共有する |
| A4 | MCP `scrape` の `fullPage` が `scrapeUrl` へ渡らない | [mcp.ts:593](../../../src/mcp.ts#L593) | 引数に `fullPage` を追加 |
| A5 | REST `/scrape/batch` が13項目（`clipSelector`、`headers`、`removeSelectors`、`extractSummary`、`extractCitations`、`chunkMarkdown`、`chunkSize`、`validateLinks`、`formatAsPrompt`、`highlightMatches`、`maskPii`、`webhookUrl`、`retries`）をエラーなしで削除する | `BatchScrapeRequestSchema` [types.ts:473](../../../src/types.ts#L473) が未定義キーを除去 | MCPと同じ入力定義を共有する |
| A6 | REST `/scrape/batch` の `urls` に上限がない（説明は「最大20件」）。`concurrency` は最大20と定義されているが、実装は5で打ち切る | [types.ts:474-475](../../../src/types.ts#L474)、[scraper.ts:934](../../../src/scraper.ts#L934) | `urls.max(20)`、`concurrency.max(5)` |
| A7 | REST `/map` の `until`・`noCache` が定義されているが未実装・未転送 | [types.ts:567-568](../../../src/types.ts#L567)、[scrape.ts:118](../../../src/routes/scrape.ts#L118)、`mapSiteUrl` に `until` なし [scraper.ts:1039](../../../src/scraper.ts#L1039) | `noCache` を転送。`until` は実装するか定義から削除 |
| A8 | `noCache: true` でもWeb検索・深層検索がYahoo検索の下層キャッシュを使う | [yahoo.ts:465](../../../src/services/yahoo.ts#L465) | `searchYahooWeb` に `noCache` を渡し、下層キャッシュも迂回 |

## 2. 応答スキーマと実応答の不一致

| # | 対象 | 実応答 | 定義 | 根拠 |
| --- | --- | --- | --- | --- |
| B1 | 画像検索 | `source_url`、`original.url`、`thumbnail{}`、`cached{}`、`source_site` など | `url`、`imageUrl`、`thumbnailUrl`、`width`、`height` | 2026-10-03に実取得で確認。[types.ts:1397](../../../src/types.ts#L1397) |
| B2 | 動画検索 | `item.source` が上流の値（`"YouTube"`）で上書きされる。`uploader`・`upload_date`・`summary` | `source: "video"`、`publisher`、`publishedAt` | 展開順 `{ source: 'video', ...item }` [yahoo.ts:2091](../../../src/services/yahoo.ts#L2091) |
| B3 | サジェスト | `suggestions: [{ keyword, search_url }]` | `string[]` | 実取得で確認。[types.ts:1469](../../../src/types.ts#L1469) |
| B4 | 天気（3日目以降） | `detail` なし、`reliability`・`chanceOfRain.allDay` あり | `detail` 必須 | [life.ts:350](../../../src/services/life.ts#L350)、[types.ts:1509](../../../src/types.ts#L1509) |
| B5 | 地震 | `{ count, earthquakes }` | `{ count, items, source }` | [disaster.ts:186](../../../src/services/disaster.ts#L186)、[types.ts:1577](../../../src/types.ts#L1577) |
| B6 | 監視 `POST /watch/check`（`id` 省略） | 配列 | 単一の `WatchCheckResult` | [watch.ts:70-72](../../../src/routes/watch.ts#L70) |
| B7 | 監視ターゲット | 未設定値はDB由来の `null` | `optional` の文字列（`null` 不可） | [db.ts:99](../../../src/db.ts#L99)、[types.ts:1738](../../../src/types.ts#L1738) |

B1〜B3は上流のYahoo MCP応答をそのまま返している。スキーマを実応答に合わせるか、Sora側で定義どおりの形に正規化するかを決める必要がある。既存利用者への影響が小さいのはスキーマ側の修正。B2の `source` 上書きは、展開順を `{ ...item, source: 'video' }` に変える。

## 3. 説明文・ドキュメントの食い違い

| # | 内容 | 根拠 |
| --- | --- | --- |
| C1 | MCPの「返却」注記が実際のフィールド名と異なる。`search_route`（`departure`/`arrival`/`duration`/`transferCount`/`steps` → 実際は `totalTime`/`transfers`/`sections`）、`get_weather`（`areaName`/`weather`/`pop`/`tempMin` → 実際は `title`/`telop`/`chanceOfRain`/`temperature`）、`search_earthquake`（`epicenter`/`maxIntensity` → 実際は `hypocenter`/`maxScale`、外側は `earthquakes`） | `src/mcp.ts` の「返却:」注記（全31件、上記以外は未精査） |
| C2 | 説明文に「デフォルト: …」と書いてあるが、スキーマに `default` がなく、OpenAPIに既定値が出ない | `types.ts` 110件、`mcp.ts` 50件（`.optional()` で `.default()`/`.meta()` なし） |
| C3 | `suggest_keywords.limit` の上限がMCPは30、RESTは20 | [mcp.ts:1137](../../../src/mcp.ts#L1137)、[types.ts:689](../../../src/types.ts#L689) |
| C4 | `maxChars` の上限がMCPは100000（`scrape`）・50000（`scrape_batch`、`crawl_site`）、RESTは上限なし | `scrape`・`scrape_batch`・`crawl_site` |
| C5 | 根拠ID指定がMCPは `evidenceIds`（配列）、RESTはクエリ `ids`（カンマ区切り）。MCPの `limit` は1〜100、RESTは制約なし | [mcp.ts:2296](../../../src/mcp.ts#L2296)、[intelligence.ts:54](../../../src/routes/intelligence.ts#L54) |
| C6 | README性能表の荷物追跡が「主要6社」のまま（現在は8社） | [README.md:209](../../../README.md#L209) |

## 4. 意図的な差（修正不要）

- `noCache` はRESTだけにある（MCPは各ツールの既定キャッシュ方針に従う）。ただし、定義している以上はA7・A8のように実装で効くこと。
- `page` はRESTの画像・動画・ニュース・知恵袋検索だけにある。
- `search_tools` はMCPのツール探索専用で、RESTはない。
- `watch_delete` の `id` は、RESTではパス変数 `/watch/:id`。
- `search_realtime.verbose` はMCPだけ、`track_package.verbose` はRESTだけ。統一するかは任意。

## 5. 推奨順序

1. A1〜A8（入力が無視される・キャッシュで誤った結果を返す）。各項目に回帰テストを付ける。
2. B2（`source` 上書き）、B5〜B7（Sora自身が作る応答の形）。
3. B1・B3（上流応答の扱いを決めてから）。
4. C1〜C6（説明・README）。C2は既定値を `.meta({ default })` または `.default()` で宣言し、説明文の重複を削る。

再発防止として、MCP入力とREST入力を同じZod定義から作る方式に寄せると、A3・A5・C3〜C5は構造的に防げる。

## 未検証

- MCP「返却」注記31件のうち、精査したのは上記3件だけ。
- 外部取得を伴う実応答の確認は、画像・動画・サジェストの3件だけ（2026-10-03実施）。

## 対応状況（2026-10-03〜04、ブランチ fix/api-schema-notation）

判断事項はすべて既定案で実施（2026-10-03 ユーザー承認）。

| 監査項目 | 対応コミット | 備考 |
| --- | --- | --- |
| A1 乗換 `date`/`time` 無視 | `fd2ff37` | `date`/`time` を `year..minute` に解決。省略分は Asia/Tokyo の現在時刻。既存の `year..minute` 直接指定は互換のため維持 |
| A2 乗換キャッシュキー不足 | `fd2ff37` | 全条件をキー化。`TRANSIT_ROUTE_INPUT_SHAPE` を MCP・REST で共有 |
| A3 REST乗換の入力不足 | `fd2ff37` | 同上 |
| A4 MCP `scrape` の `fullPage` 未転送 | `765043d` | ハンドラーの分割代入と `scrapeUrl` 呼び出しに追加 |
| A5 REST batch の13項目欠落 | `765043d` | `SCRAPE_BATCH_INPUT_SHAPE` を MCP・REST で共有（REST は `verbose`・`noCache` を追加） |
| A6 batch の `urls` 上限・`concurrency` 上限不一致 | `765043d`・`37c2fd7` | `urls.max(20)`・`concurrency.max(5)`。判断事項4の URL 形式チェックも適用（`z.string().url()`） |
| A7 `/map` の `until`・`noCache` 未実装 | `11d43a3` | `filterSitemapEntriesByDate` を切り出し。MCP `map_site` にも `until` を追加 |
| A8 Web検索の `noCache` が下層キャッシュを迂回しない | `11d43a3` | `searchYahooWeb` に `noCache` を追加し、fresh キャッシュを迂回（single-flight の合流は維持） |
| B1 画像・B2 動画・B3 サジェスト | `5e6043a` | 上流の実際の形にスキーマを合わせた。動画 `source` は `"video"` に固定し、上流値は `platform` へ |
| B4 天気（週間予報に `detail` なし） | `5e6043a` | `detail` を任意化、`reliability`・`chanceOfRain.allDay` を追加 |
| B5 地震（`items`→`earthquakes`） | `5e6043a` | 実装の `{ count, earthquakes }` に合わせた |
| B6 監視check（単一/配列の混在） | `5e6043a` | `{ result }`・`{ results }` の包み形式に変更し、OpenAPI の top-level object を維持 |
| B7 監視ターゲットの `null` | `5e6043a` | 未設定項目を `.nullable().optional()` に変更 |
| C1 「返却」注記 | `7a4c4a8` | 13件の不一致を修正。検出器 `scanReturnNotes` と契約テストで固定。realtime・天気は説明文の文字数予算のため内側キーを省略形に |
| C2 既定値の未宣言（338件） | `97d66bc` | `.meta({ default })` で宣言。説明と実装が違った6件は実装に合わせた（REST scrape の `maxChars` 30000・`timeoutMs` 15000、batch の `maxChars` 30000、browser の `screenshotFullPage` true、ニュース `limit` 20、知恵袋 `limit` 10）。`includeDiagnostics`・`includeDiscrepancies` は動作上の既定がないため「省略時: …」表記に変更 |
| C3 suggest 上限・C4 `maxChars` 上限・C5 根拠ID表記・範囲6件 | `37c2fd7`・`f110050` | 上限・enum を宣言。`minIntensity` は数値enum化（震度6弱55を追加） |
| C6 README 荷物追跡6社 | `7a4c4a8` | 8社に更新 |
| MCP/REST の同名パラメータ不一致11件 | `5a2e7ad` | suggest 上限20、ホテル既定値、scrape/batch/crawl の既定値を両面に宣言。`search_road_traffic.pref` のみ許可リスト（MCPは名称限定が意図的） |

検証: `bun run typecheck` 成功。`bun run schema:notation` は `TOTAL 0`。全テストは6件の失敗が残るが、いずれも clean HEAD で再現する既存の失敗（プロキシ環境変数・UA・auth-strip・テナント分離2件・`/scrape` formats 1件）で、本変更によるものではない。
