# Sora 修正計画と全ツール取得確認の設計

作成日: 2026-10-02。対象: `/home/ikeno/Sora`、v2.33.1、調査時コミット `69eedcf`。
状態: 設計文書。ここに記載した修正・検査器・CIは未実装です。
実装手順: [実装指示書](../plans/2026-10-02-sora-reliability-live-ci-implementation.md)。

## 1. 達成すること

確認済みの不具合7件を修正し、全ツールについて次の二つを別々に自動判定します。

1. **本体の機能**: 実際のハンドラ、入力検証、解析、結果整形、永続化、MCP/RESTの経路が正しく動作すること。
2. **外部取得の機能**: 現在の外部応答を実際の取得器・解析器で処理し、利用可能な本文・レコード・画像などを取得できること。

モックの成功、HTTP 200、ツール呼び出しの完了、空配列、`status: success`だけでは外部取得成功としません。新しいツールや取得先が登録されたのに検査が追加されていない場合も失敗にします。

「全ツール機能」の範囲は、有効な全ツールと、登録された供給元・主要な取得方式の代表ケースです。あらゆるURL、検索語、国、時刻での動作を保証するものではありません。live結果には検査時刻、コミット、コンテナイメージID、実行環境を残します。

## 2. 調査結果と現CIの不足

### 2.1 現行版で確認した基準値

| 検査 | 2026-10-02の結果 |
|---|---|
| 全テスト、隔離メモリDB、`.env`無効 | 1137 pass / 16 skip / 0 fail、127ファイル |
| TypeScript型検査 | 成功 |
| Bunサーバーバンドル | 成功 |
| SDK経由の非遅延canonical一覧 | 通常47、ホテル有効時48。`default.*`は互換alias。search_poi 追加後 |
| 実登録の取得先 | 配送8社、公開SNS4種、国地域24 provider |

旧チェックアウトで見つかった型エラーとGoogle Newsの日付fixture失敗は現行版では解消済みです。現在のBunサーバーは実接続元を認証ミドルウェアへ渡しています。これらを新規不具合として扱いません。

今回、現行の実サービス関数を使い、キャッシュを避けて読み取りのみの外部確認を実施しました。

| 実取得経路 | 入力 | 観測結果 |
|---|---|---|
| `scrapeUrl` | W3C Web Annotation Data Model、fast、noCache、maxChars=3000 | 題名一致、本文3000文字、Annotationの本文あり |
| `fetchWeatherForecast` | 東京、2日 | 予報2件、cached=false |
| `searchLaws` | 民法、limit=2、noCache | 法令2件 |
| `searchTransitRoute` | 東京→新宿 | 経路6件 |

これは作業環境での4経路の観測です。全ツール、GitHub Actionsの通信環境、配布コンテナの取得成功はまだ確認していません。

### 2.2 既存CIでは確認できないこと

- `.github/workflows/test.yml`は全テストを実行しますが、live用の16件は通常スキップされ、型検査は同workflowにありません。
- `.github/workflows/docker-publish.yml`は型検査と一部のテストだけを公開条件にしています。別workflowの全テスト失敗がコンテナ公開を止める構成ではありません。
- スキップ内訳はX詳細1、e-Gov4、国会会議録1、標高1、運航1、関連RESTのまとめ1、配送6、ホテル1です。
- `SORA_LIVE_TESTS=1`で既存テストを有効化しても、配送のダミー番号に対する`not_found`や、ホテルの空配列を許す検査は正の取得証拠になりません。
- `src/services/country_intel/live_smoke.ts`は一部providerだけを対象とし、live取得失敗でも終了コード0を返します。そのまま合否ゲートには使えません。
- healthの疎通検査と、サービス関数が実データを返す検査は別です。外部エラーを空配列に変換する経路も、意味的な検査で検出する必要があります。

## 3. 修正対象と仕様

| ID / 優先度 | 現象・原因 | 主な対象 | 修正後の条件 |
|---|---|---|---|
| F1 / P0 | MCPで任意Originを受理。Hostも検証せず、CORSが`*` | `src/index.ts`、`src/routes/mcp_route.ts`、新規`src/security/mcp_origin.ts` | 信頼Hostと許可Originを独立検証。違反は403 |
| F2 / P1 | 本文813文字がaside内の表付きarticle593文字に置換される | `src/html_parser.ts`の`selectMainContent` | 本文を保持し、主領域の表・カレンダーを補完 |
| F3 / P1 | colspan由来の同名ヘッダーが同じJSONキーに書き込まれる | `src/html_parser.ts`の表抽出 | 全列を一意なキーで保持 |
| F4 / P1 | placeholderの`src`を優先し、`data-src`・srcsetの実画像を失う | `src/html_parser.ts`の画像抽出・Markdown変換 | 実URLを共通の処理で解決 |
| F5 / P1 | MCPの国地域入力に`social`がなく、ネストしたSNS条件が脱落 | `src/mcp.ts`、国地域入力schema | RESTと同じSNS条件をサービスへ渡す |
| F6 / P1 | SNS discoveryの503を`empty`扱い。providerがstatus未指定で成功・キャッシュ化 | `src/services/social/`、`country_intel/providers/social_posts.ts` | 正常0件と取得不能を区別し、失敗を成功キャッシュにしない |
| F7 / P1 | 監視selector不在で全ページを代用し、誤ったhash・履歴を保存 | `src/services/watch.ts`、watch REST/schema | 対象不在を明示し、正常なbaselineを維持 |

### F1: MCPの信頼境界

MCP transportはOrigin検証を要求し、不正OriginにはHTTP 403を返す仕様です。[MCP transport仕様](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

- 対象は`/mcp`、`/sse`、`/message`の全メソッドです。OPTIONSも、グローバルCORSが応答する**前**に検証します。
- 新規設定`SORA_ALLOWED_HOSTS`はカンマ区切りのauthorityです。hostnameを小文字化してport込みで照合し、ワイルドカードを認めません。既定は`localhost`、`127.0.0.1`、`[::1]`のportなしと、実際の`PORT`付きです。
- 新規設定`SORA_ALLOWED_ORIGINS`はカンマ区切りの完全なHTTP(S) originです。scheme・host・portを含むURLのoriginとして照合します。既定はlocalhost系のHTTP origin、portなしと`PORT`付きです。
- Origin省略は非ブラウザクライアントとして許可しますが、Host検証は省略しません。`Origin: null`、複数origin、不正形式、許可外originは拒否します。
- 攻撃者指定のHostとOriginが一致しても許可しません。`X-Forwarded-Host`は信頼判断に使いません。Hostの欠落・不正形式も拒否します。
- MCPのCORSは許可済みoriginだけを返します。認証、接続元判定、テナント分離、セッション単位のツール有効化は維持します。
- 公開URL、TLS終端、コンテナのhost側portが異なる構成では、外部Host・Originを明示設定します。不正な設定は起動時に失敗させます。既存の配備設定を確認してから適用します。

### F2–F4: 抽出時の情報欠落

本文救済候補から`aside`、`nav`、`role=navigation/complementary`内を除外します。長さ比だけで本文を置換しません。Readability側の実質的な段落・リスト・引用の正規化テキストが候補にも含まれる場合だけ、構造付き候補を採用します。正規化は空白の統一で、意味を推測しません。80文字以上の本文ブロックがない場合は、Readabilityの正規化全文の保持を条件にします。

主領域に構造がなく、asideだけに表がある場合はReadabilityを維持します。意味的主領域がなく、本文側に表やカレンダーがあるページの救済は維持します。`onlyMainContent=false`も維持します。completenessを上げるだけの修正は禁止します。

表のキーは左から確定します。同名の2列目以降に`_2`、`_3`を付け、既存の文字通りのヘッダー名も予約して衝突を避けます。例: `Revenue, Revenue, Revenue_2`は`Revenue, Revenue_3, Revenue_2`です。空ヘッダーには従来の補完名を使い、その後同じ一意化を適用します。Markdownと構造化JSONの値が一致することを検査します。

画像は実HTTP(S)の`src`を保持し、未設定・data URI・既知のplaceholder名の場合に有効な`data-src`を優先します。次に`srcset`/`data-srcset`のHTTP(S)候補を使い、同じdescriptor種別内で最大のw/x候補を選びます。混在・descriptorなしは先頭の有効候補とします。placeholder判定は拡張子を除くbasenameが`placeholder`、`spacer`、`blank`、`transparent`、`1x1`に一致する場合に限定します。相対URLはURL APIで解決し、危険なschemeは除外します。画像一覧とMarkdown生成に同じ解決結果を使い、`keepDataImages`の既存契約は維持します。

### F5–F6: SNS条件と取得状態

MCP入力に既存`IntelSocialInputSchema`を再利用して`social`を追加します。`platforms`、`queries[].platform/query`、`urls`、`lookbackHours`を渡し、既存schemaのtrim以外でクエリを書き換えません。deferred activation、`default.*`alias、REST、サービスの対応を検査します。

discoveryは内部的に`ok | empty | unavailable`を返します。正常検索0件は`empty`、HTTP 503など取得失敗は`unavailable`です。失敗文字列の正規表現で成功状態を決めません。

国地域SNS providerは、実行予定・実行済み・成功・失敗を集計し、既存`ProviderRunStatus`を明示します。全経路失敗は`unavailable`または`rate_limited`、データを取得できても一部失敗・予算切れ・未実行があれば`partial`です。正常な0件検索と全失敗0件を区別します。結果上限での正常終了と、deadlineで処理できなかった経路も区別します。既存gapsに取得不能・未実行理由を残し、coverageを実行結果に合わせます。

全失敗結果はキャッシュしません。成功・partialの既存キャッシュ方針を維持しますが、partialのgapsを消しません。失敗後の2回目で上流を再呼び出し、復旧データが返ることを検査します。

### F7: 監視対象不在

selector指定時に`extracted.content`がstringでなければ、`WATCH_SELECTOR_NOT_FOUND`を返します。要素は存在するが文字列が空の場合は、空内容の正常な取得として区別します。selector不在時に全ページ内容を代用しません。

不在時はbaseline、content、履歴、`last_checked_at`を更新せず、webhookも送信しません。単体RESTはHTTP 502、code=`WATCH_SELECTOR_NOT_FOUND`、retryable=false、MCPは`isError=true`です。一括チェックは他の対象を継続し、失敗対象の結果にoptional `errorCode`を追加します。`changed=false`だけで「変更なし成功」と判定しません。

登録時の初回取得が失敗した場合は、登録済みtargetを返しつつoptional `initialError: {code, message}`を追加します。`initialResult`やbaselineを作ったように見せません。既存DBに新しい表は追加しません。

## 4. CI構成

### 4.1 本体検査: PRと公開ゲート

既存Bun test、TypeScript、SDKを使います。外部HTTPなどの境界だけfixtureに置き換え、ハンドラや解析器の結果はモックしません。

- canonical全ツールについて、MCP呼び出し→実ハンドラ→実サービス→fixture応答の解析→意味的assertionを通します。
- 対応REST、deferred activation、互換aliasも同じ入力・結果の主要値で照合します。RESTのない`search_tools`はMCPのみを検査します。
- ブラウザ、PDF、watch、国地域保存・ページング・更新差分などは独立した代表ケースを持ちます。
- 実Bun HTTPサーバーを起動するtransport検査を別途用意します。`app.request`だけで本番のHost・接続元・SSE・セッション処理が動いたとは判定しません。
- `tools/list`を`deferTools:false`で取得してcanonical集合を比較します。通常・ホテル有効の2設定を検査し、検査台帳に未登録のツールを失敗にします。
- 同様に配送registry、SNS enum、国地域default provider、複数feed、fediverse、World Bank指標の登録集合と台帳を照合します。46などの固定件数だけの検査は行いません。

### 4.2 外部取得検査: main、定期、手動、公開前

新規live runnerは明示的な`--live`がなければネットワーク検査を開始しません。対象コミットから作った配布候補コンテナを使い、本番のBun、Chromium、wreq、Yahoo helperを含めて確認します。

runnerはホスト側のBunスクリプトです。各シナリオを、候補イメージ内のworkerで順番に実行します。workerは同じコミットからbundleして読み取り専用mountします。公開ツールはworkerが起動した`/app/server.js`へSDK/HTTPで呼び出します。MCPに直接公開されないprovider単位の確認だけ、同じコミットの実provider関数をworkerで呼びます。出所の異なる古いserverや配備済みlatestを代用しません。

- シナリオ単位で新しいコンテナ・メモリDBを使い、公開ポート・webhookを設定しません。watchの登録→確認→一覧→削除、国地域の作成→詳細→証拠→更新は同じシナリオ内で実行します。
- 外部検索・本文取得をモックしません。`noCache`がある入力には指定し、他も新規プロセスで古い結果を避けます。
- 最初は同時実行1、外部呼び出し間隔1秒、通常シナリオの上限90秒、国地域・SNSは120秒、job上限45分とします。必要な呼び出しを台帳に列挙し、無制限crawl・検索・browser retryを禁止します。
- SDKのtimeout/signalに加え、親runnerが期限でコンテナを停止・削除します。`Promise.race`だけでは実際の通信・ブラウザ停止を保証しません。
- transient network/5xxのみ追加1回、429は判明したRetry-Afterを最大30秒まで尊重します。解析失敗、401/403、資格情報不足は自動再試行しません。サービス自身の再試行も含めた回数を記録します。
- GitHub runnerだけ403になる場合は`blocked`です。解析変更とは分けて記録し、必要時に同じ候補イメージを通常実行環境で比較します。取得不能を成功へ変換しません。

GitHub Actionsのscheduleは既定ブランチで実行され、遅延・実行欠落があり得ます。外部取得の結果には時刻を必ず付け、手動実行も用意します。例はUTC `23 19 * * *`、日本時間翌日04:23です。[GitHub Actionsの起動条件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

### 4.3 合否と外部変更の検出

| 判定 | 条件 | 全体ゲート |
|---|---|---|
| `pass` | 意味的assertion成立、必要な取得先の実データあり | 合格 |
| `pass_empty` | 正常0件が許され、上流文書の解析と対象地域・時刻などを証明 | 合格。ただし単なる空配列は禁止 |
| `fail` | 入出力・構造・内容の契約違反、処理例外、解析不能 | 失敗 |
| `unavailable` | network/5xx/timeout/429などで必要な取得ができない | 失敗 |
| `blocked` | 403、ログイン・challenge画面など | 失敗 |
| `unverified` | 資格情報・有効テストデータ・取得証拠が不足 | 失敗 |
| `not_applicable` | 外部処理のないツール、または明示的に無効の機能 | 外部取得分母から除外。理由を表示 |

警報なし・交通規制なしは、正しい地域の最新文書を解析した証拠があれば`pass_empty`です。地域イベント0件は、同じ実解析経路が供給元文書を処理した証拠と地域フィルタの本体検査がある場合だけ許可します。現行の結果から証拠を取得できなければ`unverified`とし、空配列を推測で正常扱いしません。ニュース・法令・画像・実配送などの正のケースには非空の実情報を要求します。

JSONのキー型・必須値、HTML本文の既知特徴、URL/ID対応、時刻形式、画像magic bytes、ZIP/TSVの解析結果などを、サービス別に検査します。本文長だけ、HTTP statusだけ、JSON.parse成功だけの条件は禁止します。数値は型と定義域で検査し、日々変わる予報・株価・順位の値は固定しません。期間判定は未来時刻や秒/millisecond混同も検出します。

fallbackが成功しても元の取得先は成功扱いにしません。元API、mirror、browserなどの必要経路は別の台帳行にし、未観測は`unverified`です。通常のツール利用としての成功と、全取得先が検査済みであることを分けて表示します。

### 4.4 レポート

既存のartifact運用を利用し、JSON、Markdown summary、JUnitを`always()`で7日保存します。JSONには次を残します。

- 実行時刻、commit SHA、イメージID、worker SHA、runner環境、機能設定、全体合否。
- canonical別の本体判定・外部判定、case ID、期待する取得先、実行できた取得先、取得件数、cache利用有無。
- failure分類、必須キーや本文特徴の不足、response形式、観測できた上流status、試行回数、所要時間。
- 未検査ツール・provider・carrier・platform・feed、無効機能と理由。

上流statusを観測できない場合はunknownです。MCP/REST側の200を上流の200として記録しません。ログやartifactには認証、Cookie、追跡番号、個人情報を出さず、失敗応答も伏字済みの短い抜粋またはhashに限定します。画像Base64や配送全文は保存しません。

最終exit codeは、fail/unavailableまたは未登録が1件でもあれば1（hard fail、公開停止）、それらがなくblocked/unverifiedのみ残れば3（soft hold、記録付きで公開進行）です。全greenは0です。機能していない検査器・workerの途中終了も失敗です。各case終了時に途中reportを更新し、job中断前までの結果も残します。再試行で復旧したものは`pass`でも試行履歴と`recovered=true`を表示します。

## 5. 全ツールの検査台帳

各行は本体正常ケースを必須とします。下表は意味的な期待値であり、実装時の入力は現行schemaから組み立てます。公開ページP、画像I、公開投稿S、配送番号N、監視ID W、context ID Cはcase内で指定・取得するテストデータです。

| canonical | 本体で確認する結果 | liveの供給元・正の取得証拠 |
|---|---|---|
| `scrape` | 既知本文・表・画像、HTML/PDF、fast/browser | 公開HTMLの本文、公開PDFの実テキスト、Chromium描画 |
| `scrape_batch` | 複数URLと本文の対応、一部失敗 | 2ページそれぞれの本文 |
| `search_deep` | Web・本文・realtime統合、重複排除 | Yahoo Web、検索先の実本文、Yahoo経由Xを別確認 |
| `map_site` | 同一サイトURL、上限 | 実sitemapとページリンクfallback |
| `crawl_site` | 2ページ本文、重複・上限 | 同一サイト2ページの実本文 |
| `search_web` | 検索項目、markdown要求時の本文 | Yahoo検索と検索先本文。snippet代用を除外 |
| `search_social_posts` | 本文・期間・取得状態、4 platform | 期間内公開投稿。検索と本文取得の両方 |
| `fetch_social_post` | 投稿ID・本文・長文・コメント | 全4 platformの公開投稿、Weibo長文/コメント別ケース |
| `browser_action` | click後の本文、browser終了 | Chromiumで外部ページ取得・DOM操作 |
| `search_image` | 画像項目・元ページ | Yahooの実画像URLと元ページ |
| `search_video` | 動画項目 | Yahooの実動画URL・題名 |
| `search_news` | 記事項目・日付 | Yahooの実記事URL・題名 |
| `search_chiebukuro` | 質問項目 | Yahooの実質問情報 |
| `suggest_keywords` | サジェスト候補 | Yahooの非空候補 |
| `search_realtime` | 投稿ID・URL・本文・時刻 | Yahooリアルタイムの実投稿 |
| `search_trend` | keyword・rank | Yahooリアルタイムの実ランキング |
| `fetch_x_post` | found・ID一致・全文 | FxTwitterの既知公開投稿。provider offは成功にしない |
| `search_route` | 経路・時刻・運賃 | 東京→新宿などの実構造化経路。rawTextだけは不可 |
| `get_weather` | 場所・日付・予報 | 気象庁forecast/overviewの対象地域 |
| `get_flight_status` | 便名・予定時刻・状態 | Yahoo空港情報の実運航レコード |
| `track_package` | 指定番号・carrier・strong検証 | 全8社の実配送履歴。autoも別確認 |
| `search_hotel_availability` | プラン・部屋・価格・指定日 | 楽天トラベル、将来21日付近、東京駅/京都駅/草津温泉 |
| `search_road_traffic` | 道路/都道府県・更新・規制 | Yahoo道路交通の実文書。正常0件の証拠を別確認 |
| `search_disaster_warnings` | 地域・発表日時・分類 | 気象庁対象地域文書。警報なしでも解析証拠必須 |
| `search_earthquake` | 地震ID・時刻・座標 | P2P地震情報の非空実記録 |
| `get_elevation` | 住所→座標→数値標高、座標直指定 | 国土地理院の住所検索と標高API |
| `search_poi` | クエリ/緯紐度/半径/bbox→施設・住所・緯紐度 | OpenPOI全国施設検索、保存時licenses/attributions保持 |
| `watch_register` | W・初期hash、initialError | 公開ページの初期本文とbaseline |
| `watch_check` | 同一・変更・selector不在、全件処理 | 公開ページ再取得。変更判定自体は制御fixture |
| `watch_list` | 隔離DBの登録一覧 | 外部処理なし |
| `watch_delete` | 削除、一覧から消失 | 外部処理なし |
| `search_song` | 曲情報 | iTunesの実楽曲 |
| `search_artist` | アーティスト関連情報 | iTunesの実情報 |
| `search_music` | 種別別の音楽項目 | iTunesの実情報 |
| `search_laws` | 法令ID・題名 | e-Gov v2の民法など |
| `get_law_text` | 条文Markdown・articleCount>0 | e-Govの実条文。代替文字列だけは不可 |
| `search_diet_minutes` | 発言・話者・日付 | 国会会議録APIの実発言 |
| `check_cpsc_certificate` | 年齢・HTS条件に対応した証明書判定 | 外部処理なし。内蔵規則の正確性は別途更新管理 |
| `check_fda_regulated` | 条件に対応したFDA/PGA判定 | 外部処理なし。内蔵規則の正確性は別途更新管理 |
| `verify_hts_code` | exactなコード確認 | USITCの実10桁コード・説明・税率 |
| `predict_hts_code` | 候補・bestMatch | USITCの実候補。既定値だけは不可 |
| `check_product_compliance` | HTS/FDA/CPSC/actionPlan、情報不足 | USITC照合。商品URL指定時の実本文も確認 |
| `inspect_image` | MCP ImageContent・Base64・形式 | 実画像bytes、復号後magic bytesとサイズ |
| `research_country_context` | C・証拠・provider結果・SNS条件 | 以下24 providerと内部供給元 |
| `get_country_context` | 同じCの保存レポート | 外部処理なし |
| `get_country_context_evidence` | 証拠・ページング・所属制約 | 外部処理なし |
| `get_country_context_updates` | 追加・訂正・削除差分・cursor | 外部処理なし |
| `search_tools` | 有効化、alias、別セッション非波及 | 外部処理なし |

通常46名を必須とし、`SORA_RAKUTEN_TRAVEL_ENABLED=true`かつlife module有効のlaneで47名を必須とします。ホテル無効laneでは明示的にdisabled表示します。ホテルの未実装フィールドである住所・施設名などのnullを新規失敗条件にはしません。

### 5.1 配送・SNSの必要データ

| carrier | 実取得に必要なもの |
|---|---|
| `yamato` | 利用許可のある、取得期間内の実追跡番号 |
| `sagawa` | 同上 |
| `japanpost` | 同上。国内番号と国際S10を別ケース |
| `seino` | 同上 |
| `fukutsu` | 同上 |
| `ups` | 実番号。ブラウザ取得（資格情報があれば公式API優先） |
| `fedex` | 実番号。ブラウザ取得（資格情報があれば公式API優先） |
| `dhl` | 実番号。ブラウザ取得（資格情報があれば公式API優先） |

新規テスト設定`SORA_TOOL_HEALTH_CASES_JSON`をGitHub Secretに置き、case IDごとの番号・公開投稿URL・検索語・期待する公開本文特徴を渡します。値のschemaは実装指示書Task 9で定義します。配送の宛名・住所は期待値にもログにも使いません。番号に配送履歴がなくなった場合はテストデータを更新し、それまで`unverified`です。ダミー番号の`not_found`は本体の負例として残します。

SNS対象は`weibo`、`threads`、`instagram`、`facebook`です。Weiboは匿名セッション・検索・status・長文・コメント、Meta系はYahoo索引・公開HTTP・browserを確認します。Metaコメントは現行仕様のunsupportedであり、取得成功の必須条件にしません。検索の期間内投稿と既知URLの本文取得は別ケースです。

### 5.2 国地域providerの台帳

JP・CN・USだけの一括レポート成功では全provider検査済みとしません。地域限定・SNS有効条件を満たす入力をprovider別に用意し、実providerの結果と取得証拠を評価します。

| provider ID | 必須の供給元・解析証拠 |
|---|---|
| `gdelt_export` | lastupdate→ZIP解凍→TSV、地域に対応するイベント |
| `gdacs` | GDACS APIの実災害、RSS fallbackを別判定 |
| `usgs` | GeoJSONの地震ID・座標・時刻、地域フィルタ |
| `eonet` | NASA EONETのID・geometry、地域フィルタ |
| `global_feeds` | RSS/Atomの記事URL・題名、以下13 feed |
| `google_news` | Google News RSSの地域/query対応記事 |
| `bing_news` | Bing News RSSの地域/query対応記事 |
| `wiki_current` | Wikipedia Current eventsの地域言及本文 |
| `baidu_hot` | 百度board/API、Tophub fallbackを別判定 |
| `so360_search` | CNのso.com検索結果 |
| `weibo_hot` | Weibo hotSearch/hot、NewsNow fallbackを別判定 |
| `zhihu_hot` | Zhihu hot-list |
| `toutiao_hot` | 今日頭条hot-board |
| `wallstreet_live` | WallstreetCN global-channel記事 |
| `cctv_news` | CCTVカテゴリJSONP |
| `thepaper_hot` | 澎湃新聞rightSidebar |
| `official_web` | Yahoo候補探索と公式ページ本文。domain候補だけは不可 |
| `bluesky` | searchPostsのDID・URL・本文 |
| `yahoo_realtime` | JP、Yahoo pagination APIのX投稿 |
| `fediverse` | 以下4サーバーの実投稿 |
| `social_posts` | 公開SNS4種の本文、Weiboコメント補完 |
| `worldbank` | 国コード、指標ID、年、実数値。以下6指標 |
| `nager` | 当年の祝日の日付・名称 |
| `wikidata` | 検索応答の実候補とsource生成。未取得entityを取得済み扱いしない |

feed IDは`bbc-world`、`un-news`、`ecb-press`、`aljazeera-all`、`dw-top`、`france24-en`、`cbc-top`、`abc-au-top`、`ndtv-latest`、`yonhap-en`、`scmp-hk`、`st-asia`、`nikkei-asia`です。fediverseは`misskey.io`、`mstdn.jp`、`fedibird.com`、`mastodon.xyz`です。World BankはGDP、成長率、CPI、失業率、人口、貿易比率を確認します。

登録済みでも機能フラグで無効化したproviderはdisabledと表示します。ただし「全機能」laneで`SORA_INTEL_DISABLED`などにより必須providerを外した場合は設定不備として失敗させます。既定登録外のlegacy `gdelt`/`gdelt_events`は現時点の分母に入れません。再登録時は集合比較で検査の追加を要求します。

feedは`GLOBAL_FEED_CATALOG`を1件ずつ既存`createGlobalFeedsProvider`へ渡し、地域選択上限に隠れた未実行を避けます。World Bankは`WORLD_BANK_INDICATORS`の各指標を既存factoryに渡して検査します。fediverseは既存parser・取得処理を共有したまま供給先を選べる内部factory引数を追加し、4供給先を個別実行します。こうした内部選択は検査用のscopeであり、本番の既定登録を無効化した成功として数えません。

## 6. 実行条件・運用・公開

| 起動条件 | 必須検査 | 秘密情報 |
|---|---|---|
| PR、forkを含む | 型、全本体テスト、台帳整合、transport | 不要 |
| main push | 上記＋候補イメージの全live | 信頼された実行のみSecret利用 |
| 毎日、workflow_dispatch | 同じ候補イメージの全live、ホテル有効lane | 同上 |
| container公開前 | 同じcommitの全本体＋通常全live＋候補image smoke | 未検証があれば公開保留 |

live jobのSecret不足は導入時にもgreenへ隠しません。全取得成功に必要な追跡番号・資格情報・投稿caseが揃うまで、全機能の証明とその公開ゲートは未成立です。ホテルはexperimentalとして通常公開の分母には入れませんが、ホテル有効laneの失敗は明示して記録します。

fork PRに配送資格情報などを渡しません。`pull_request_target`で未信頼のPRコードをcheckoutして実行する構成は禁止します。[GitHubのイベントと実行権限](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)、[Secret利用](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

既存Test workflowを`workflow_call`でも呼べるようにし、publish workflowから同じ全本体検査を必須依存にします。コンテナは先にローカル候補としてbuild/loadし、検査した同じイメージをpushします。検査後の別build、以前のイメージに対する成功結果、`continue-on-error`、`|| true`での代用は禁止します。候補イメージIDと公開digestの対応を記録します。

外部障害で公開が止まることと、本体コードの退行を分けてレポートします。まず取得先・テストデータ・通信環境を診断し、契約を弱めて通さない運用とします。GitHub summary/artifactで可視化し、Slack/メールなどの追加通知サービスは導入しません。

Well-Architectedの6観点は、運用=JSON/JUnitと再実行手順、セキュリティ=Origin/Host・Secret・隔離、信頼性=失敗伝播と公開ゲート、性能=期限と逐次実行、コスト=低件数・再試行上限、持続可能性=既存Bun/コンテナ/CIの再利用として扱います。専用DB、queue、常駐監視サービス、新しいテストframeworkは追加しません。

## 7. 実装順・完了条件

1. F1を回帰テスト付きで修正します。
2. F2–F4の抽出欠落を修正します。
3. F5–F6のSNS契約・状態・キャッシュを修正します。
4. F7の監視baseline保護を修正します。
5. 全ツール本体の台帳・契約・transport検査を整えます。
6. live runner、意味的assertion、失敗分類、レポートを作り、実取得で検証します。
7. workflowを接続し、Secret不足・外部解析変更・正常0件・worker停止を含む受入試験を行います。

完了条件は、7件の回帰テスト、全本体検査、型検査、buildが成功し、台帳に未登録の有効対象がなく、必要データを設定した候補イメージのliveで実取得が確認できることです。HTTP 200のログインHTML、必須キーを失ったJSON、503、429、資格情報不足を故意に与えた試験では、正しく非zero終了する必要があります。

## 8. 追加ツールの扱い

`inspect_pdf`、`verify_citations`、`get_source_status`は別の機能候補です。今回の不具合修正・全ツールCIの必須範囲には追加しません。PDF画像レンダリングのBun動作、引用原文の位置対応、取得状態データの再利用を先に実測し、具体的な利用要件があるものだけ別計画にします。
