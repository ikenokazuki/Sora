# 楽天トラベル内部APIの調査・条件付き実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本書は計画であり、未確認のAPIの存在や採用を確約するものではない。調査結果を根拠に、下記の判定ゲートを順に通過する。

**Goal:** 外部APIキーの登録を不要とし、楽天トラベルの公開検索画面が利用する構造化データを使って、日本の宿泊施設・指定日の空室・料金を正しく取得できるか検証する。採用条件を満たした場合に、Soraへ最小限の検索機能を追加する。

**Architecture:** まず独立した調査スクリプトでブラウザ通信を観測し、匿名HTTPでの再現性を確認する。採用後は楽天固有の通信・解析を小さなサービスに閉じ込め、RESTとMCPから同じ入力スキーマと処理を呼ぶ。Google固有のRPC形式やPython実装は移植しない。

**Tech Stack:** 既存のBun、TypeScript、Puppeteer、Hono、Zod、`bun:test`。初期調査で追加ランタイム・依存パッケージを導入しない。

**Spec:** 本書の「設計仕様」「判定ゲート」を、会話で示されたキー不要・国内宿泊検索・保守負担低減という要件を具体化した仕様とする。未観測の楽天エンドポイント・パラメーターはタスク1・2の成果物で確定する。

## 現状と調査範囲

- 基準コミットは `44336c4`、Soraのバージョンは `2.32.0`。実行開始時に差分と更新を再確認する。
- PCトップと東京都の日付未指定検索ページは、通常のHTTP GETで200とHTMLを取得済み。
- 日付未指定ページでは `/ds/undated/search` へのフォーム送信を確認した。これは独立したJSON空室APIを発見したという意味ではない。
- PC・モバイル版の実ブラウザ通信、日付指定検索、施設別プランの内部APIは未調査。匿名HTTPでの料金取得も未検証。
- `google-hotels-mcp` は、観測した通信仕様の文書化、リクエスト生成と解析の分離、実応答を使うテストを参考にする。Google向けのリクエスト頻度やTLS設定を楽天へ流用しない。
- 内部APIの更新頻度がHTMLより少ないという実証はない。まず削減を狙うのは、DOM構造・CSS・表示文言への依存である。

## Global Constraints

- 計画作成時の依頼範囲は計画書のみ。その後の実装依頼を受け、調査スクリプトと実通信を実行する。製品コード変更はG1/G2通過後に限る。
- 調査対象は、ログインなしで通常利用できる国内宿泊検索とプラン表示の通信。個人アカウントのCookieや共有ブラウザのログイン状態を使わない。
- 外部APIキー、有料中継サービス、追加の常駐MCPサーバー、内部LLMを必須にしない。
- 内部APIのURL・必須ヘッダー・フィールド・列挙値は、実際の通信を観測してから定義する。
- 日付意図や地名を独自辞書で推測しない。検索条件を黙って変更・削除・緩和しない。
- CAPTCHA・403・429が出た場合は記録して調査を停止し、IP切り替えやセッション再発行の連打で継続しない。
- 既存検索の順位・日付処理・Yahoo取得・本番コンテナは、この変更に含めない。
- 実サイト試験は `SORA_LIVE_TESTS=1` で明示的に実行する。通常CIには楽天への外部通信を追加しない。
- 計画書・仕様書・コメントは通常の日本語で記述する。

## 設計仕様

### 初期リリースの範囲

最初の公開機能は `search_hotel_availability` と REST `POST /hotels/availability` の1処理に絞る。地域・日付・大人人数から施設と取得できたプランを返す。施設紹介専用ツール、予約・決済、日付未定検索、複数事業者の比較は別段階とする。

初期入力案は次の通り。上流の制約と矛盾する場合は、ゲートG2で本書を更新してから公開する。

| フィールド | 契約 |
|---|---|
| `location` | 空でない地域・駅・温泉地の文字列。楽天の公開検索に備わる場所解決を利用する。曖昧な場合は選択候補を返し、勝手に決めない |
| `checkIn` / `checkOut` | 実在する `YYYY-MM-DD`。両方必須。`checkOut > checkIn`。過去日判定はAsia/Tokyo。年を自動補完しない |
| `adults` | 1以上の整数、1室あたりの大人人数。必須。観測した上流の上限も検証する |
| `rooms` | 初期版は1のみ、省略時1。複数室は入力エラーとする |
| `limit` | 1〜10、既定5。Sora側の取得量上限であり、楽天の公式上限を意味しない |

入力スキーマは未知の項目を拒否する。子供、複数室、食事などの絞り込みを未対応のまま受け付けて無視しない。子供の食事・布団区分と複数室は調査時に通信を確認するが、正確な対応が確認できたものだけ次段階で契約に追加する。

### 出力と失敗の契約

- `source: "rakuten_travel"`、`status`、`query`、`retrievedAt`、`hotels`、`warnings`、`failures` を返す。`retrievedAt` はUTCのISO日時、宿泊日は日本の暦日として保持する。
- `status` は `ok | partial | empty | unavailable`。`empty` は上流が検索成功・該当なしを明示した場合だけ使用する。
- 各施設は、観測できた施設ID、名称、所在地、出典URL、プラン一覧を持つ。プランID・部屋IDは上流にある場合だけ保持する。
- 料金は `amount`、`currency`、`basis`、`taxStatus` を組にする。`basis` は `stay_total | room_night | person_night | unknown`、`taxStatus` は `included | excluded | unknown`。
- 日付未指定の参考最安値は指定日の料金に使わない。1泊料金に泊数を掛けて全泊総額を捏造しない。比較不能な料金を一緒に最安順に並べない。
- 食事・喫煙・キャンセル条件は確認できた内容だけ返す。値がない場合は不明として扱う。
- 部分取得は `partial` とし、取れた施設と失敗理由を両方残す。API応答形式の不一致は `SCHEMA_CHANGED`、条件不一致は `CONDITION_MISMATCH` として、空室なしに変換しない。
- `failures[].code` は `AMBIGUOUS_LOCATION | UNSUPPORTED_CONDITION | CONDITION_MISMATCH | SCHEMA_CHANGED | SESSION_REQUIRED | RATE_LIMITED | ACCESS_DENIED | TIMEOUT | UPSTREAM_ERROR`。曖昧な場所は `failures[].details.candidates` に実際の候補を返す。
- 実験段階では `SORA_RAKUTEN_TRAVEL_ENABLED=true` の場合だけRESTとMCPを有効にする。MCPは既存の `life` カテゴリに遅延公開する。

### 実装を複雑にしないための境界

- ネットワーク応答のJSON解析・フィールド対応だけを楽天固有コードに閉じ込める。複数プロバイダー用のレジストリや汎用クローラーは作らない。
- HTTPの第一候補は標準 `fetch`。送信先は観測済みの固定HTTPSオリジンに限定し、任意URL入力は公開しない。リダイレクトは自動追従せず、観測した必要経路だけを扱う。
- 既存 `src/http_fetcher.ts` の `fetchWithSafeRedirects()` はGET専用、HTTPセッション生成は保存Cookieを復元する。匿名POSTの要件にそのまま流用できるとは扱わない。まず楽天専用の小さな取得処理で成立させ、共通HTTP層の拡張は必要性が実証された場合に限る。
- 初期版は結果キャッシュなし。同条件の実行中リクエストだけをまとめる。これにより、初期検証ではキャッシュの速さと上流取得の速さを混同しない。
- セッション不要ならセッション管理を作らない。必要な場合は、この機能専用の匿名セッションをメモリ内に保持し、個人セッション・既存Cookie DBと混ぜない。条件ごとの履歴やトークンを出力しない。
- 低頻度の失効復旧以外にChromiumが必要なら、HTTP中心の採用条件を満たさない。毎検索ブラウザを起動する構成には自動で切り替えない。

### 設計上の優先順位

Well-Architectedの観点は、今回必要な次の範囲に絞って適用する。

| 観点 | 今回の対応 |
|---|---|
| 運用上の優秀性 | 通信仕様と再現ケースを残し、形式変更と取得失敗を検知する |
| セキュリティ | 匿名セッションの分離、固定送信先、資格情報を保存しない記録 |
| 信頼性 | 条件・料金の照合、期限付き取得、障害を空室なしに変換しない |
| パフォーマンス効率 | ブラウザ初期化と検索を分けて実測し、毎回の描画を不要にする |
| コスト最適化 | 外部API契約と追加常駐サービスを必須にせず、要求数を制限する |
| 持続可能性 | 定期巡回を追加せず、必要な件数だけ取得し、不要なブラウザを終了する |

## Review Focus

1. 日付・人数が送信されても上流で無視されるケース：条件を変えた実通信と画面照合で確認し、不一致を成功にしない（タスク2・3）。
2. HTTP 200で空配列・HTML・変更後JSONが返るケース：正常な該当なしと解析失敗を分離する（タスク3・4）。
3. 地域名の曖昧さ、同一施設の別名、同施設の異なるプラン：場所を確認し、施設IDでまとめ、プランを落とさない（タスク2・3）。
4. 連泊、税・サービス料、人数変更で料金単位が変わるケース：画面上の内訳と照合し、不明を計算で埋めない（タスク2・3）。
5. 同時実行中の中断、429、セッション失効：余分な初期化・リトライを起こさず、別の呼び出しの結果や条件を混ぜない（タスク4・5）。

## 判定ゲート

| ゲート | 通過条件 | 通過しない場合 |
|---|---|---|
| G1：通信の発見 | 匿名の公開画面が、施設または日付付きプランの構造化応答を取得する経路を特定できる | API方式は未成立として調査結果を提出。HTMLスクレイピングを自動実装しない |
| G2：HTTP再現と意味確認 | 東京・京都・草津の3地域で、場所・日付・人数の反映と同条件の画面との一致を確認。新しい匿名セッションでも再現できる | 施設情報のみ取得可能、セッション依存、地域解決不能など、成立範囲を報告。公開機能は実装しない |
| G3：Soraでの受入 | 固定応答テスト、REST/MCP/OpenAPI整合、実環境の少量試験、処理終了・資源解放の確認が通る | 実験フラグを既定offのまま維持し、リリース対象に含めない |

G2の運用目標は、結果キャッシュなしで異なる条件5回の検索時間中央値10秒以下・各回20秒以内。初期化時間、待ち行列、場所解決、検索、必要な詳細取得を含む。初期化後に5回連続してブラウザを再起動せず取得できることも確認する。この数値は採用目標であり、現在の実測値や楽天の制限値ではない。

少数の試験から長期安定性、規制されないこと、全施設・全プランの網羅性は主張しない。サイト側で該当なしの条件は取得失敗と分ける。時間差による在庫変動は再照合1回で切り分け、説明できない不一致はG2未通過とする。

## 対象ファイル

以下は実行段階の予定。タスク1・2では製品コードを追加しない。

| 段階 | パス | 責務 |
|---|---|---|
| 調査 | `scripts/probe-rakuten-travel.ts`（新規） | 通信記録、HTTP再現、条件別計測。通常起動やCIから呼ばない |
| 調査 | `docs/evaluations/rakuten-travel/feasibility.md`（新規） | 発見経路、実測、採否、未確認事項、条件対応表 |
| 調査 | `docs/evaluations/rakuten-travel/protocol.md`（G1後に新規） | メソッド、送信先、必要なパラメーター、レスポンスの意味、匿名初期化 |
| 実装 | `src/services/hotels/types.ts`（新規） | 共通Zod入出力、推論したTypeScript型 |
| 実装 | `src/services/hotels/rakuten.ts`（新規） | 観測済み条件のエンコードと応答解析。ネットワークから分離 |
| 実装 | `src/services/hotels/index.ts`（新規） | HTTP取得、条件確認、上限・中断・失敗分類 |
| 実装 | `src/services/hotels/fixtures/`（新規） | 秘密値を除去した実応答の最小標本 |
| 実装 | `src/services/hotels/rakuten.test.ts`、`index.test.ts`（新規） | 解析と取得制御の回帰試験 |
| 公開 | `src/routes/hotels.ts`（新規）、`src/index.ts`（変更） | REST検証とルート登録 |
| 公開 | `src/mcp.ts`、`src/types.ts`（変更） | 遅延公開、ツール説明、共通スキーマによるOpenAPI |
| 検証 | `src/hotels_contract.test.ts`、`src/services/hotels/live.test.ts`（新規） | 公開契約と任意の実サイト試験 |
| 文書 | `README.md`（変更） | 有効化方法、入力例、対応範囲、失敗の意味、ツール数 |

## タスク1：公開画面の通信を観測する

**Files:** `scripts/probe-rakuten-travel.ts`、`docs/evaluations/rakuten-travel/feasibility.md`、G1成立時のみ `protocol.md`。

**Interfaces:** プローブCLIは `capture | replay | verify` のモードを持つ。最初に実装するのは `capture`。出力先は必須の `--out-dir`、各操作の記録は `caseId`、条件、UTC取得日時、所要時間、HTTP状態、内容種別、応答構造の要約とする。

- [ ] 既存差分、依存関係、Chromiumの利用可能場所を確認する。既存サービスとは別プロセス・新しい匿名BrowserContextを使い、終了時は生成したページとブラウザだけを閉じる。
- [ ] Puppeteerのrequest/responseイベントを使い、公開画面のDocument・XHR・Fetchを記録する。REST `/browser/action` は通信本文を取得する専用インターフェースではないため、無理に変更しない。
- [ ] PC版で「地域選択→日付と人数指定→検索→施設プラン表示」を1経路確認する。構造化応答がない場合だけ、同じ公開操作をモバイル版で確認する。端末間でデータ形式が違う場合は別経路として記録する。
- [ ] API応答、HTMLに埋め込まれた状態JSON、完成したHTMLを区別する。広告・解析・おすすめ施設のAPIを、条件付き空室APIと取り違えない。
- [ ] 保存前にCookie、Authorization、CSRF・セッショントークン、識別子を除去する。再現に必要な一時値は実行メモリだけに保持し、採用した取得手順を文書化する。
- [ ] G1を判定し、見つからない場合も確認した画面・操作・応答形式を記録して完了する。

実行例：`SORA_LIVE_TESTS=1 SORA_DB_PATH=:memory: bun run scripts/probe-rakuten-travel.ts capture --out-dir /tmp/sora-rakuten-probe`

確認結果：独立した構造化経路の有無と、空室・料金がどの応答に入っているか説明できる。URIを推測して探索するスクリプトや自動全件巡回は作らない。

## タスク2：匿名HTTPで再現し、画面と照合する

**Files:** タスク1のプローブと2文書。`replay` と `verify` を追加する。

**Interfaces:** タスク1で記録したケースとプロトコルを入力とし、HTTP再現の可否、条件ごとの比較表、G2判定を出力する。HTTP再現に使うパラメーター名・本文は観測結果から確定する。

- [ ] 観測した検索を標準fetchで再送し、不要なヘッダーを一つずつ除いて最小要求を特定する。匿名初期化が必要な場合は、その有無と再利用の可否を測る。
- [ ] 初期化済みCookieを持たない新しいプロセスでも再現する。ブラウザの実行ごとに取得して固定したトークンを恒久設定にしない。
- [ ] 地名から楽天の場所識別子への解決方法を記録する。検索語が単なる施設名フィルターになっていないか、草津温泉などで範囲を確認する。
- [ ] 下表のケースを画面とHTTPで比較する。基準日Dは実行日のAsia/Tokyoで14日以上先の火曜日とし、実際の年月日を保存する。
- [ ] 調査CLIが明示的に再送するHTTP通信は同時1件、検索・候補解決・詳細の開始間隔は最低3秒。ブラウザによる公開画面の受動観測は、サイト自身のXHR・Fetchの並行性と間隔を変更せず記録する。1回の検証実行で楽天のDocument・XHR・Fetchは合計24要求までとし、画像・CSS・スクリプト等は別集計とする。上限に到達したら停止し、未実施を記録する。この区別は2026-10-01の調査時に裁定したもので、ブラウザ取得の通信抑制やG2性能合格を意味しない。
- [ ] 結果キャッシュなしで異なる条件5回を計測する。ブラウザ初期化、待機、場所解決、検索、詳細、解析を分け、API要求数・ブラウザ起動数・試験前後のメモリも記録する。
- [ ] 必須フィールド・料金単位・匿名初期化手順を `protocol.md` に確定し、G2判定を書く。同時にタスク3の場所識別子・送信要求の型を実応答に基づき確定し、本計画へ追記する。未知の状態は成功扱いにせず、実装可否を説明できるところで調査を区切る。

| ケース | 検索条件 | 確認する差分 |
|---|---|---|
| 基準3件 | 東京駅周辺・京都駅周辺・草津温泉、Dから1泊、大人2人1室 | 正しい地域、施設・プランID、条件付き料金。画面で確認できる最大3施設を照合 |
| 日付変更 | 東京、D+7から1泊、大人2人1室 | 送信条件と有効条件が変わる。料金が同額でも直ちに失敗とはしない |
| 人数変更 | 東京、Dから1泊、大人1人1室 | 人数・料金単位・対象プランの反映 |
| 連泊 | 京都、Dから2泊、大人2人1室 | 日別額・総額・税の扱い。1泊料金の単純倍で判断しない |
| 日本語・英語 | 草津温泉の日本語／英語表記 | 同じ場所に解決されるか。曖昧なら候補を保持 |
| 子供・複数室 | 画面が提供する代表条件を各1件 | 将来の対応可否のみ確認。初期公開契約には自動追加しない |

空室なしが自然に観測された場合は標本を保存する。HTTP障害・429は意図的に発生させず、後続の固定応答テストで確認する。

## タスク3：条件と料金の解析を実装する（G2通過後）

**Files:** `src/services/hotels/types.ts`、`rakuten.ts`、`rakuten.test.ts`、`fixtures/`。

**Interfaces:** `HotelSearchInputSchema` / `HotelSearchResultSchema` と推論型 `HotelSearchInput` / `HotelSearchResult` を公開する。`rakuten.ts` は `encodeRakutenSearch(input: HotelSearchInput, resolvedLocation: unknown)` と `parseRakutenResponse(raw: unknown, input: HotelSearchInput, retrievedAt: string): HotelSearchResult` を公開する。場所識別子の実型とエンコードの返却型は、タスク2の観測仕様をもとにこの節へ追記し、`unknown` のまま製品実装へ持ち込まない。
**Interfaces:** `HotelSearchInputSchema` / `HotelSearchResultSchema` と推論型 `HotelSearchInput` / `HotelSearchResult` を公開する。`rakuten.ts` は `encodeRakutenSearch(input: HotelSearchInput, resolved: ResolvedRakutenLocation): URL` と `parseRakutenResponse(raw: unknown, input: HotelSearchInput, retrievedAt: string): HotelSearchResult` を公開する。`ResolvedRakutenLocation = { id: 'tokyo' | 'kyoto' | 'kusatsu'; label: string; templateUrl: string }` とし、観測済み3地点の完全一致のみ解決する。施設名・住所は構造化経路が未確立のため `name: string | null` / `address: string | null` で `null` を返す。料金は税込優先・税区分不明保持・連泊 `basis: unknown` とする。

- [ ] 実応答を必要な施設・プランだけに縮小し、資格情報を含まないfixtureを作る。正常・該当なし・条件不一致・形式変更・一部欠落を用意する。
- [ ] 先に失敗するテストを書く。必須確認は、架空日付の拒否、年またぎと日本時間の日付境界、未知入力の拒否、異なる条件のエンコード、同施設別プランの保持、料金単位・税不明の保持、200のHTML・不正JSONを `empty` にしないこと。
- [ ] `bun test src/services/hotels/rakuten.test.ts` で未実装による失敗を確認する。
- [ ] 仕様に必要なフィールドだけをエンコード・解析する。観測済みAPIの列挙値対応は1か所に置く。自然言語の意図判定辞書は追加しない。
- [ ] 同じテストを再実行し、fixtureの期待値を実応答の意味と照合する。キー順変更・無関係な項目追加では壊れず、必須項目欠落では明示的に失敗することを確認する。

## タスク4：取得制御を実装する（G2通過後）

**Files:** `src/services/hotels/index.ts`、`index.test.ts`。セッションが必要と確認された場合に限り、その小さな管理処理をここへ追加する。

**Interfaces:** `searchHotelAvailability(input: HotelSearchInput, context: { signal: AbortSignal; deadlineAt: number }): Promise<HotelSearchResult>` を公開する。テストではHTTPと時計を注入できる `createHotelService({ fetch, now })` を使い、`searchHotelAvailability` は共有の本番インスタンスへ委譲する。

- [ ] 先にHTTPの固定応答テストを書く。429、403、5xx、タイムアウト、途中中断、同条件の同時実行、別条件の並行要求、上限待機を対象にする。
- [ ] `bun test src/services/hotels/index.test.ts` で失敗を確認する。
- [ ] 初期運用値を、楽天全体で同時1件・開始間隔3秒・待機含む1呼び出し20秒以内・上流要求最大6件にする。観測した正常経路がこの予算に収まらない場合は、実装前にG2を再評価する。
- [ ] 429はその呼び出しを即終了し、`Retry-After` を優先して同プロセスの以後の要求を抑制する。値なしなら60秒。これはSoraの初期運用設定。5xx・ネットワーク失敗も初期版は自動再試行せず、呼び出し側へ理由を返す。
- [ ] 必要な匿名セッション初期化は同時に1回だけ行う。実測で識別できる失効のみ、要求予算内で再初期化を1回許す。403・429・CAPTCHAを失効扱いにしない。
- [ ] 実行中要求の集約キーには場所・日付・人数・部屋数・取得上限を含める。呼び出しの中断はその待機者だけを外し、全待機者が離れた場合に上流通信を中断する。共有処理の締め切りを後着要求で延長しない。
- [ ] 実験フラグoff、無効入力、待機期限切れの場合は外部通信0件とする。固定応答テストを再実行して確認する。

## タスク5：REST・MCP・OpenAPIを同じ契約へ接続する

**Files:** `src/routes/hotels.ts`、`src/index.ts`、`src/mcp.ts`、`src/types.ts`、`src/hotels_contract.test.ts`、`README.md`。

**Interfaces:** `createHotelRoutes({ service? })` によりテスト用サービスを注入可能にする。RESTとMCPはタスク3の同一スキーマで検証し、タスク4の同一サービスを呼ぶ。

- [ ] 契約テストを先に書く。日付・人数・limitが両経路で保持されること、無効入力で取得しないこと、フラグoffでREST/MCPに公開されないこと、遅延ツール検索から発見できることを確認する。
- [ ] RESTは不正JSON・入力不正を400、処理結果は共通の `status` を持つJSONで返す。MCPは同じ結果を返し、`unavailable` は `isError: true` を併記する。
- [ ] `src/types.ts` の `generateOpenApiDocument()` に入力・出力・400応答を登録する。未知パラメーター拒否がOpenAPIにも反映されるかテストし、必要な場合だけ共通変換器を最小修正する。
- [ ] `life` の遅延ツールとして登録し、READMEに実験フラグ・対応範囲・具体例・料金の単位・空室なしと取得失敗の違いを記載する。ツール数はフラグoff/onを区別する。
- [ ] `bun test src/hotels_contract.test.ts` を実行し、REST/MCP/OpenAPIの意味が一致することを確認する。

## タスク6：受入試験と導入判断

**Files:** `src/services/hotels/live.test.ts`、調査レポート、必要に応じてREADME。

- [ ] `SORA_LIVE_TESTS=1` のときだけ動く少量試験を追加する。将来日を計算して使い、ホテル名・料金・件数を固定値でassertしない。入力条件、構造、取得時刻、料金単位、成功・失敗状態を検証する。
- [ ] 固定応答・契約テスト、型検査、ビルドを実行する。`bun test src/services/hotels/rakuten.test.ts src/services/hotels/index.test.ts src/hotels_contract.test.ts`、`bun run typecheck`、`bun run build`。
- [ ] 既存CI相当の `NODE_ENV=test SORA_DB_PATH=:memory: bun test --timeout 60000` を実行する。既存失敗がある場合は変更前との差を記録し、未解決のまま合格としない。
- [ ] 実際のデプロイ環境と同条件の隔離プロセスで `SORA_LIVE_TESTS=1 SORA_RAKUTEN_TRAVEL_ENABLED=true SORA_DB_PATH=:memory: bun test src/services/hotels/live.test.ts --timeout 60000` を実行する。本番サービスの再起動は行わない。
- [ ] 東京・京都・草津を再照合し、G3を判定する。初回／再利用時／別条件の時間とメモリを分け、未確認の長期安定性も明記する。
- [ ] 採用の場合は差分・検証結果・有効化方法・フラグoffで戻せる手順を提示する。未採用の場合は調査成果だけを残す。どちらの場合も、この計画の作成だけを根拠にpush・リリース・本番有効化しない。

## 完了の定義

調査完了と機能完成を分けて報告する。

- **調査完了:** G1/G2の結果、再現手順、画面比較、時間内訳、取得できない条件、採否が文書化されている。内部APIが存在しない・再利用できないという結論でも、証拠があれば調査完了とする。
- **機能完成:** G1〜G3を通過し、共通契約のREST/MCP機能とドキュメントがそろっている。実通信未確認のまま完成・高速化成功・高精度とは報告しない。
- **本番導入完了:** 別途指示された公開・配備と、その環境での検証まで完了している。調査やローカル実装の完了に含めない。

## 参考資料

- [google-hotels-mcp プロトコル資料](https://github.com/alexechoi/google-hotels-mcp/blob/main/docs/PROTOCOL.md)：通信観測、二重エンコード、フィルターが黙って無効になる事例、実応答fixtureの扱い。
- [楽天トラベル 国内検索ページ](https://search.travel.rakuten.co.jp/ds/yado/tokyo/low-p1)：予備確認した公開画面。日付未指定の価格を空室料金に流用しない。
- [楽天トラベル公式空室API仕様](https://webservice.rakuten.co.jp/documentation/vacant-hotel-search)：宿泊条件や料金の意味を確認する補助資料。非公開APIと同じパラメーター・返却形式だとは仮定しない。

## 2026-10-01 実行結果

- タスク1：指定日の構造化料金をHTML内の `ds` JSONで発見。G1通過。独立した空室JSON APIの採用とは区別する。
- タスク2：東京駅・京都駅・草津温泉の匿名HTTP取得と新しい匿名ブラウザ内JSONの一致、日付変更・人数変更・連泊の有効条件を確認。施設メタデータの取得契約、汎用のHTTP場所解決、全ケースの画面照合が未達のためG2未通過。
- タスク3〜6：採用条件未達により実施しない。ホテル検索機能の完成・本番導入として報告しない。
## 2026-10-01 実装結果（ユーザー指示による条件付き実施）

- タスク3：条件・料金の解析を実装。観測済み3地点の完全一致解決、条件不一致・形式変更の失敗分離、税込優先・税不明保持・連泊単位不明を実装（`src/services/hotels/`、テスト23件）。
- タスク4：取得制御を実装。同時1件・開始間隔3秒・20秒予算・上流最大6件・429抑制・同条件集約・中断分離を実装。セッション管理は不要と確認したため作らない。
- タスク5：REST `POST /hotels/availability`・MCP `search_hotel_availability`（`life`遅延）・OpenAPIを同一契約で接続。すべて `SORA_RAKUTEN_TRAVEL_ENABLED=true` でのみ公開。既定の45ツール/14コアは不変。
- タスク6：固定応答・契約テスト、型検査、ビルド、実サイト少量試験（3地域 ok・条件一致・各20秒以内）が通過。全テストは1118成功・10スキップ・4失敗で、失敗は基準コミットと同一の既存e-Gov 4件。G3通過と判定するが、本番導入は別途指示があるまで行わない。
- 詳細・実測・未確認事項：[調査結果](../../evaluations/rakuten-travel/feasibility.md)、[観測プロトコル](../../evaluations/rakuten-travel/protocol.md)。

調査時の裁定：受動観測でサイト自身の通信順序・並行性を変更すると、観測した経路が通常の公開画面と異なるため、3秒間隔・同時1件は明示的HTTP再送に適用する。ブラウザ側には要求上限と403/429時の停止を適用する。Soraの製品サービスを採用する場合の同時1件・3秒間隔は、タスク4のまま維持する。
