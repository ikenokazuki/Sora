# 環境変数の整理（v5.0.0）

## 目的

環境変数の名前の付け方がばらばらです（`SORA_` の有る無し、昔の名前の `WEB_FETCHER_API_KEY`、汎用名の `API_KEY`・`ENABLED_MODULES`・`LOG_FORMAT` など）。別名が重なり、README に載らない設定が 18 個あり、不正な値は黙って既定値に戻ります。これを整理します。破壊的変更を許す前提です（ユーザーの決定）。

2026-11-11 の調べ: コードが読む名前は 86 個で、README §4.3 に載っているのは 49 個。整理後は 74 個（Sora 固有の設定は 65 個から 53 個）。

## 決定（ユーザー承認、2026-11-11）

1. **認証の Fail-Open（キー未設定でも使える）は保つ**（README の Quickstart の 1 行起動を保つため）。そのうえで、旧い名前の鍵（`WEB_FETCHER_API_KEY`・`API_KEY`）だけが設定されていて、新しい名前（`SORA_API_KEY`）が無いときは、**起動を拒否する**。名前を変えたときに、黙って認証が外れるのを防ぐ。
2. 名前の変更は、下の表の案（25 個の改名）。本番の運用者が設定している 8 個のうち、変わるのは `ENABLED_MODULES`→`SORA_MODULES` と `SORA_DEFER_TOOLS`→`SORA_MCP_DEFER_TOOLS` の 2 個。
3. **旧名を別名として読まない。** 旧名だけが設定されているときは、下の表の「旧名だけのとき」のとおり、起動を拒否する（無視すると動きが黙って変わるもの）か、警告する（置き換え先を示す）。ツール統合の「旧名の別名は残さない」と同じ。
4. 結果が確定した旗は、動きを固定して消す（`SORA_WEB_NATIVE_RANKING`・`SORA_RRF_ENABLED`・`SORA_REALTIME_ANCHOR`・`SORA_YAHOO_THROTTLE`・`SORA_WEB_RETRY_WAIT_MS`）。採用の評価が無いまま opt-in になっている実験（`SORA_WEB_QUERY_UNION`・`SORA_X_SOURCE_ISOLATION`。後者は `x_source_isolation.ts` の約 330 行）は、コードごと消す。**ただし、`x_source_isolation.ts` には、実験でない部分（X の URL のホストの一覧 `X_HOSTS` と `parseXDiscoverySeed` など、`fetch_social_post` の X の取得が使うもの）がある。実験の分岐だけを消し、使われている部分は残す**（実装時に、`grep` で、そのファイルの export の使われ方を確かめる）。
5. Containerfile に `SORA_DB_PATH=/data/sora.db` を足す（いまは DB がボリュームの外にできて揮発する）。
6. 時期: ツールの統合（`docs/superpowers/specs/2026-11-11-tool-consolidation-design.md`）をマージしたあとの別の PR。同じ v5.0.0 に入れる。テストの環境変数の書き換えが約 460 か所（67 ファイル）あり、統合と大きく重なるため。
7. **不正な値は、起動時に、変数名と正しい形を示して止める**（`PORT=abc`・`5m`・`1e3` のように、いまは黙って通る値）。
8. サーバーの認証キーは `SORA_API_KEY`（生成クライアント `client/runtime.ts` がすでに使っている名前）。

## 命名の決まり

- Sora 固有の設定は `SORA_<領域>_<名前>`。領域は次のとおり: AUTH・LOG・ALERT・MCP・BROWSER・FETCH・PROXY・SEARCH・YAHOO・X・OPENPOI・ADDRESS・HTS・GCC・TRACKING・INTEL。
- ほぼ全員が設定する、全機能にまたがる 7 個だけは、領域名を付けない: `SORA_API_KEY`・`SORA_ALLOW_ANONYMOUS`・`SORA_MODULES`・`SORA_DB_PATH`・`SORA_PUBLIC_URL`・`SORA_ALLOWED_HOSTS`・`SORA_ALLOWED_ORIGINS`。
- 同梱の実行ファイルの場所は `SORA_<実行ファイル名>_PATH`（例 `SORA_YAHOO_MCP_PATH`・`SORA_RS_TRAFILATURA_PATH`）。
- 業界の標準の名前は変えない: `PORT`・`NODE_ENV`・`HTTP_PROXY`・`HTTPS_PROXY`・`ALL_PROXY`・`NO_PROXY`（大文字・小文字）・`CHROME_PATH`・`CHROME_BIN`・`PUPPETEER_EXECUTABLE_PATH`。
- 単位は名前の末尾に付ける（`_MS`・`_MB`）。0 の意味（無効・無制限）は、変数ごとに登録簿に書く。
- `SORA_` が付いていて意味の通る名前は、改名しても得るものが小さいので変えない。変えるのは、`SORA_` の次が領域名でないもの（例 `SORA_DEFER_TOOLS`→`SORA_MCP_DEFER_TOOLS`）と、汎用の名前（ほかのプログラムの設定とぶつかるもの）。

## 値の読み方（統一）

いまの実装は、場所ごとにばらばらです。真偽値は 4 通り（`=== 'true'` 8 個、`!== 'false'` 3 個、`'off'` の比較 6 個、空でなければ真 1 個）、数は 5 通り（`parseInt` で緩く、`/^\d+$/` で厳密に、`Number()`、範囲の検査つき）で、不正な値は黙って既定値に戻ります。次にそろえます。

- **共通:** 空や空白だけの値は、未設定とみなす。
- **真偽値:** 大文字小文字を区別せず、`true`・`false`・`1`・`0`・`on`・`off`・`yes`・`no`。それ以外は不正。
- **整数:** 前後の空白を除いて `^\d+$`。最小・最大は変数ごとに決める。
- **列挙:** 前後の空白を除いて小文字にし、許された値のどれかと一致すること。
- **カンマ区切りの列:** 要素ごとに空白を除き、空の要素を捨て、重複を除き、要素の型で検査する。`all` は、許した変数（`SORA_MODULES`）だけ。
- **URL:** `new URL()` で読める値。scheme は変数ごとに（`http`/`https`。プロキシは `socks5` も、判例の索引は `file` も）。末尾の `/` は外す。
- **パス:** 前後の空白を除く。同梱の実行ファイルの場所が設定されていて、そのファイルが無ければ、起動時に警告して、探索を続ける。
- **JSON:** 起動時に読んで、形を検査する。
- **不正な値:** 起動時は、変数名と正しい形を示して exit 1 で止める。秘密の値は表示しない（「設定済み、長さ N」とだけ出す）。呼び出しのたびの読み取りでは、既定値を返し、例外は投げない（テストが不正な値を入れて既定値を確かめる形は、そのまま通る）。

## 設定を 1 か所に集める

`src/config.ts`（150 行前後の見込み）に、変数の登録簿を置く。

```ts
const S = {
  SORA_API_KEY: { area: 'core', kind: 'string', secret: true, legacy: ['WEB_FETCHER_API_KEY', 'API_KEY'], legacyOnly: 'error', doc: '…' },
  SORA_BROWSER_IDLE_TTL_MS: { area: 'browser', kind: 'int', min: 0, default: 300_000, legacy: ['BROWSER_IDLE_TTL_MS'], doc: '… 0 で無効' },
  // …
} satisfies Record<string, Setting>;
export function bool(name: BoolName, env = process.env): boolean; // int・str・list・url・json も同じ形
export function checkEnv(env = process.env): { errors: string[]; warnings: string[] };
export function renderEnvTable(): string;
```

- **読み取りは、呼び出しのたびに `process.env` を読む。** 覚えておかない。テストが実行中に環境変数を書き換える性質を保つため。いまモジュールの読み込み時に読んでいる 6 か所（`PORT`・`MAX_CONCURRENT_BROWSERS`・`YAHOO_MCP_PATH`・FxTwitter のシングルトン・MCP のセッション管理・Origin の中間層）は、同じ時機のまま、getter を通すだけにする。
- `checkEnv` は、環境を引数に取る純粋な関数にして、テストしやすくする。
- 文書: README §4.3 の表は、`renderEnvTable()` から作る。登録簿と README の表が一致すること、`src/` の中の `process.env` の読み取りが `config.ts`（とテスト・`test_preload.ts`・`scripts/`）の外に無いことを、テストで確かめる。`docs/configuration.md` と `.env.example` は作らない（二重になって古くなる。Bun は `.env.example` を自動では読まない）。

## 起動時の検査

`index.ts` の `if (import.meta.main)` の中と、`stdio.ts` の `main()` の中だけで `checkEnv` を呼ぶ（テストが `index.js` を import しても影響しない）。

- (a) 未知の `SORA_*` は警告する（綴り間違いの検出。クライアント用の `SORA_URL`、テスト用の `SORA_LIVE_TESTS` などは、既知に入れる）。
- (b) 廃止した名前が設定されていたら警告し、置き換え先を示す。旧名は別名として読まない（新名があれば新名を使い、旧名は無視する）。
- (c) **旧名だけがあって新名が無いとき、「拒否」の 10 個は、起動を拒否する**: `WEB_FETCHER_API_KEY`・`API_KEY`・`ENABLED_MODULES`・`DAILY_REQUEST_LIMIT`・`SORA_DEFER_TOOLS`・`SORA_DEFAULT_REFERER`・`FXTWITTER_API_BASE`・`SORA_ADDRESS`・`SORA_CROSS_INDEX_URL`・`SORA_CROSS_INDEX_SHA256`。認証の 2 個（`WEB_FETCHER_API_KEY`・`API_KEY`）と、無視すると、絞った設定が開く・外への通信が変わる・ツールの一覧が変わるもの。`API_KEY` がほかのプログラムのものなら、エラー文で「unset するか `SORA_API_KEY` を設定」と案内する。
- (d) 不正な値は止める。
- `SORA_MODULES` の未知のモジュール名は、いまは黙って無視される（綴りを間違えると全ツールが消える）。起動時に、使えるモジュール名を示してエラーにする。

## 対応表

### 名前を変えるもの（RENAME）（25 個）

| 旧名 | 新名 | 領域 | 既定 | 型 | 旧名だけのとき | 備考 |
|---|---|---|---|---|---|---|
| `ENABLED_MODULES` | `SORA_MODULES` | CORE | all（lyrics・shazam は名前を挙げたときだけ） | list<enum> | **拒否** | registry.ts isModuleActive。小文字化のみ、未知の名前は黙って無視（綴り違いで全ツールが消える）。旧名を無視すると lyrics/shazam が消え、絞ったモジュールが開く |
| `ALLOW_LOCAL_NO_AUTH` | `SORA_AUTH_LOOPBACK_NO_KEY` | AUTH | false | bool | 警告 | auth.ts。=== 'true'。旧名を無視すると閉じる側（401）なので警告で足りる。smithery.yaml の設定は stdio では効かない（認証の中間層を通らない） |
| `TRUST_PROXY` | `SORA_AUTH_TRUST_PROXY` | AUTH | false | bool | 警告 | auth.ts resolvePeerLocal だけが読む。無視すると閉じる側 |
| `DAILY_REQUEST_LIMIT` | `SORA_AUTH_DAILY_LIMIT` | AUTH | unset（無制限） | int>=1 | **拒否** | auth.ts。parseInt なので '100abc' は 100、不正・0 以下は黙って無制限。無視すると利用上限が外れる |
| `LOG_FORMAT` | `SORA_LOG_FORMAT` | SERVER | text | enum text\|json | 警告 | index.ts。=== 'json' |
| `ADMIN_ALERT_WEBHOOK_URL` | `SORA_ALERT_WEBHOOK_URL` | SERVER | unset | url | 警告 | health.ts。外への送信。私的な宛先は isSafeWebhookUrl が拒否し、その警告ログに URL 全体を出す（秘密が漏れる） |
| `SORA_DEFER_TOOLS` | `SORA_MCP_DEFER_TOOLS` | MCP | true | bool | **拒否** | mcp.ts。!== 'false'（'0'・'off' は有効のまま）。stdio は常に false で無関係。無視するとツールの一覧が変わる |
| `SORA_TOOL_OUTPUT_SCHEMA` | `SORA_MCP_OUTPUT_SCHEMA` | MCP | false | bool | 警告 | mcp.ts slimListedTool。=== 'true'。v2.36 で既定を false にした、反対側も要る（厳密な MCP クライアント） |
| `MAX_CONCURRENT_BROWSERS` | `SORA_BROWSER_MAX_CONCURRENCY` | BROWSER | メモリから 1〜5 | int 1-50 | 警告 | browser_engine.ts（モジュール読み込み時）。/^\d+$/、50 で頭打ち、不正は自動 |
| `BROWSER_IDLE_TTL_MS` | `SORA_BROWSER_IDLE_TTL_MS` | BROWSER | 300000 | int>=0 (0=無効) | 警告 | browser_engine.ts。Number()。'abc' は黙って 0（無効）になる |
| `ALLOW_BROWSER_EVALUATE` | `SORA_BROWSER_ALLOW_EVALUATE` | BROWSER | false | bool | 警告 | browser_session.ts 2 か所。任意 JS 実行。無視すると閉じる側。types.ts の引数の説明にも名前がある |
| `ALLOW_LOCAL_FETCH` | `SORA_FETCH_ALLOW_PRIVATE_NETWORK` | FETCH | false | bool | 警告 | SSRF の全防御（DNS 検査・ブラウザの要求・遷移・Webhook）を外す。テスト専用。=== 'true'。テストで 164 回・24 ファイル、run_test.sh |
| `SORA_DEFAULT_REFERER` | `SORA_FETCH_DEFAULT_REFERER` | FETCH | true | bool（off で無効） | **拒否** | http_fetcher.ts。trim+小文字で === 'off'。無視すると運用者が止めた Referer の偽装が戻る |
| `RS_TRAFILATURA_PATH` | `SORA_RS_TRAFILATURA_PATH` | FETCH | unset（イメージは Containerfile で設定） | path | 警告 | extractor/rs_trafilatura.ts の引数の既定値。存在しなければ Readability に黙って戻る |
| `YAHOO_MCP_PATH` | `SORA_YAHOO_MCP_PATH` | SEARCH | /usr/local/bin → bin/ → PATH | path | 警告 | yahoo.ts（モジュール読み込み時の const）。Containerfile が /app/yahoo-search-mcp を設定。既定の探索に /app は無い |
| `SORA_SCRAPE_DEADLINE_MS` | `SORA_SEARCH_SCRAPE_DEADLINE_MS` | SEARCH | 0 | int>=0 (0=無し) | 警告 | scraper.ts（search_deep だけ。scrape ツールには効かない）。Number()、負の値も通る（0 以下は打ち切り無し） |
| `FXTWITTER_API_BASE` | `SORA_X_DETAIL_BASE_URL` | SEARCH | https://api.fxtwitter.com | url | **拒否** | x_detail.ts（構築時）。無視すると自前の FxEmbed でなく公開の FxTwitter へ送る |
| `FXTWITTER_TIMEOUT_MS` | `SORA_X_DETAIL_TIMEOUT_MS` | SEARCH | 1500 | int>=1 | 警告 | x_detail.ts。parseInt \|\| 既定（0 も既定） |
| `SORA_ADDRESS` | `SORA_ADDRESS_MODE` | ADDRESS | lazy | enum lazy\|eager\|off | **拒否** | address_config.ts。不明な値は黙って lazy。無視すると off にした運用者で取得（外への通信）が始まる |
| `CROSS_SOURCE` | `SORA_HTS_CROSS_SOURCE` | HTS | local | enum local\|api | 警告 | cbp_cross.ts。=== 'api'。api は今 403 だが、テストの固定応答（test_fixtures/external_apis.ts）と eval-hts-predict が使う |
| `SORA_CROSS_INDEX_URL` | `SORA_HTS_CROSS_INDEX_URL` | HTS | Sora の GitHub リリース | url(https\|file) | **拒否** | cross_index.ts。無視すると運用者の索引でなく GitHub から取る |
| `SORA_CROSS_INDEX_SHA256` | `SORA_HTS_CROSS_INDEX_SHA256` | HTS | 組み込み | hex64 | **拒否** | URL と対。検査は初回の利用時に throw（起動時に前倒し） |
| `UPS_CLIENT_ID` | `SORA_TRACKING_UPS_CLIENT_ID` | TRACKING | unset | string | 警告 | carriers/ups.ts。無いとブラウザでの取得に戻る（安全側） |
| `UPS_CLIENT_SECRET` | `SORA_TRACKING_UPS_CLIENT_SECRET` | TRACKING | unset | string | 警告 | 同上 |
| `SORA_BLUESKY_DIDS` | `SORA_INTEL_BLUESKY_DIDS` | INTEL | unset（全員） | list<did> | 警告 | providers/bluesky.ts。設定すると、その DID の投稿だけを残す。README に無い |

### 統合するもの（MERGE）（8 個）

| 旧名 | 新名 | 領域 | 既定 | 型 | 旧名だけのとき | 備考 |
|---|---|---|---|---|---|---|
| `WEB_FETCHER_API_KEY` | `SORA_API_KEY` | CORE | unset (=Fail-Open) | string | **拒否** | auth.ts createAuthMiddleware。最優先。旧名だけなら起動拒否 |
| `API_KEY` | `SORA_API_KEY` | CORE | unset | string | **拒否** | README の Quickstart が案内している名前（外部の利用者が最も設定していそう）。旧名だけなら起動拒否 |
| `FEDEX_API_KEY` | `SORA_TRACKING_FEDEX_CLIENT_ID` | TRACKING | unset | string | 警告 | carriers/fedex.ts。FEDEX_API_KEY \|\| FEDEX_CLIENT_ID（別の組の ID と secret が混ざりうる） |
| `FEDEX_CLIENT_ID` | `SORA_TRACKING_FEDEX_CLIENT_ID` | TRACKING | unset | string | 警告 | 同上 |
| `FEDEX_API_SECRET` | `SORA_TRACKING_FEDEX_CLIENT_SECRET` | TRACKING | unset | string | 警告 | 同上 |
| `FEDEX_CLIENT_SECRET` | `SORA_TRACKING_FEDEX_CLIENT_SECRET` | TRACKING | unset | string | 警告 | 同上 |
| `DHL_EXPRESS_API_KEY` | `SORA_TRACKING_DHL_API_KEY` | TRACKING | unset | string | 警告 | carriers/dhl.ts。DHL_EXPRESS_API_KEY \|\| DHL_API_KEY。呼ぶのは統合の追跡 API（Express 専用ではない） |
| `DHL_API_KEY` | `SORA_TRACKING_DHL_API_KEY` | TRACKING | unset | string | 警告 | 同上 |

### 廃止するもの（REMOVE）（7 個）

| 旧名 | 新名 | 領域 | 既定 | 型 | 旧名だけのとき | 備考 |
|---|---|---|---|---|---|---|
| `SORA_YAHOO_THROTTLE` | （廃止） | SEARCH | on | bool(off) | 警告 | README が『テスト用途のみ』。テストも delete するだけで off にしない。消す |
| `SORA_WEB_RETRY_WAIT_MS` | （廃止） | SEARCH | (deprecated) | int | 警告 | provider_pressure.ts（モジュール読み込み時）。Number(unset ?? '') が 0 になり、未設定でも初期間隔が 400 でなく 0 になっている（潜在の不具合）。旗を消して 400 に固定 |
| `SORA_WEB_NATIVE_RANKING` | （廃止） | SEARCH | true | bool | 警告 | Retrieval v2 の戻し旗（2026-09-27）。docs/retrieval-v2-dod.md で完了。true に固定し BM25 の全体並べ替えの分岐を消す |
| `SORA_RRF_ENABLED` | （廃止） | SEARCH | true | bool | 警告 | 同上の戻し旗。true に固定 |
| `SORA_WEB_QUERY_UNION` | （廃止） | SEARCH | false | bool | 警告 | 2026-09-16 の opt-in の実験。採用の評価が無く本番も未設定。分岐ごと消す案（要判断）。scripts/eval-live-ab.ts も |
| `SORA_X_SOURCE_ISOLATION` | （廃止） | SEARCH | false | bool | 警告 | 2026-09-16 の opt-in の実験（x_source_isolation.ts 327 行）。同上（要判断） |
| `SORA_REALTIME_ANCHOR` | （廃止） | SEARCH | on | bool(off) | 警告 | v2.36.0 の戻し旗。評価で 24%→100%（RELEASE_NOTES）。on に固定 |

### そのまま（KEEP、25 個）

`SORA_API_KEY`・`SORA_ALLOW_ANONYMOUS`・`SORA_DB_PATH`・`SORA_PUBLIC_URL`・`SORA_ALLOWED_HOSTS`・`SORA_ALLOWED_ORIGINS`・`SORA_MCP_MAX_SESSIONS`・`SORA_PROXY_URL`・`SORA_PROXY_LIST`・`SORA_YAHOO_MIN_INTERVAL_MS`・`SORA_YAHOO_BREAKER_COOLDOWN_MS`・`SORA_X_DETAIL_PROVIDER`・`SORA_OPENPOI_BASE_URL`・`SORA_ADDRESS_DIR`・`SORA_ADDRESS_MAX_MB`・`SORA_ADDRESS_WAIT_MS`・`SORA_ADDRESS_BUILD_CONCURRENCY`・`SORA_ADDRESS_PRELOAD`・`SORA_HTS_DIR`・`SORA_GCC_CERTIFIER`・`SORA_GCC_CUSTODIAN`・`SORA_TRACKING_PAGE_SECRET`・`SORA_INTEL_DISABLED`・`SORA_INTEL_SCRAPE`・`SORA_INTEL_WEB_SEARCH`

README に載っていない Sora の設定（18 個）は、登録簿から表を作るので、0 個になる。`SORA_PROXY_URL` はブラウザと静的取得の両方に、`SORA_PROXY_LIST` は静的取得だけに効く（この違いを README に書く）。

### 標準の名前（EXTERNAL、13 個）

`PORT`・`NODE_ENV`・`CHROME_PATH`・`CHROME_BIN`・`PUPPETEER_EXECUTABLE_PATH`・`HTTPS_PROXY`・`https_proxy`・`HTTP_PROXY`・`http_proxy`・`ALL_PROXY`・`all_proxy`・`NO_PROXY`・`no_proxy`

### 設定でないもの

`SORA_VERSION`・`SORA_MCP_INSTRUCTIONS`（定数）、`SORA_GCC_`（動的に組み立てる名前の接頭辞）、`PATH`・`LOCALAPPDATA`（OS）。テスト・スクリプト用: `SORA_LIVE_TESTS`・`SORA_TOOL_HEALTH_CASES_JSON`・`SORA_URL`（クライアント）。

## 本番の運用者への影響と手順

本番の運用者が設定している Sora の変数は 8 個。

| 変数 | 変化 |
|---|---|
| `ENABLED_MODULES` | `SORA_MODULES` に変わる（旧名だけなら起動を拒否） |
| `SORA_DEFER_TOOLS` | `SORA_MCP_DEFER_TOOLS` に変わる（旧名だけなら起動を拒否） |
| `SORA_DB_PATH`・`SORA_ALLOWED_HOSTS`・`SORA_ALLOWED_ORIGINS`・`SORA_ALLOW_ANONYMOUS`・`SORA_PUBLIC_URL`・`SORA_TRACKING_PAGE_SECRET` | 変わらない |

- 変わる 2 個は、直し忘れると v5 が起動を拒否するので、黙って壊れることはない。キーを設定しない運用（`SORA_ALLOW_ANONYMOUS=true`）は、(c) の認証の拒否に当たらない。
- **切り替えは 1 回で行う。旧名と新名の併記はしない**（併記すると、宣言が二重になって読みにくく、旧名を消す作業も増える。ユーザーの決定）。宣言（とコンテナの設定の上書き）を新名に直して、v5 を入れる。直し忘れた旧名は、v5 が起動を拒否または警告して知らせる。
- v4 に戻すときは、宣言ごと戻す（宣言は git の履歴にあるので、コミットを戻せばよい）。v4 は新しい名前を読まないので、新名の宣言のまま v4 に戻すと、`SORA_MODULES` が読まれず（lyrics・shazam が無効になる）、`SORA_MCP_DEFER_TOOLS` が読まれず（遅延読み込みが有効になる）、動くが設定が違う。
- 実際に効くのは、宣言のほかに、コンテナの設定の上書き（drop-in）なので、両方を直す。
- 値を書き換える必要があるものは無い（`off`・`on` も真偽値として受け付けるので、`SORA_FETCH_DEFAULT_REFERER=off` はそのまま使える）。挙動が変わるのは 3 つだけ: `'1'`・`'yes'` が真になる、`SORA_MCP_DEFER_TOOLS` が `'0'`・`'off'` で無効になる、不正な値が起動時のエラーになる。

## 直す不具合（整理の中で）

1. `SORA_ALLOW_ANONYMOUS=true` の README の説明が誤っている。キーを設定していても、キー無しの要求も誤ったキーの要求も、匿名として通る（`src/auth.ts` の分岐と `auth.test.ts` がこの動きを固定している）。説明を直す。
2. `SORA_WEB_RETRY_WAIT_MS` が未設定のとき、初期の間隔が 400 ではなく 0（`Number(undefined ?? '')` が 0）。変数を消し、400 に固定する。
3. `PORT=abc` だと、Bun が任意のポートで待ち受ける。不正な値として止める。
4. `BROWSER_IDLE_TTL_MS=abc` が、黙って 0（閉じない）になる。不正な値として止める。
5. `ENABLED_MODULES` の未知の名前が黙って無視される（上の起動時の検査）。
6. `smithery.yaml` の `ALLOW_LOCAL_NO_AUTH` は効いていない（stdio は認証の中間層を通らない）。行を消す。
7. Containerfile が `SORA_DB_PATH` を設定していない。足す。README の「本番コンテナでは `/data/address`」は、`SORA_DB_PATH` を設定したときだけ正しい。
8. Webhook の SSRF を止めたときの警告ログに、URL 全体が出る（管理者のアラートの Webhook URL が漏れる）。URL を出さない。
9. FedEx の鍵が `||` で読まれ、別の組の ID と秘密が混ざりうる。ID と秘密を組で読む。
10. Chromium が `env: {...process.env}` で起動し、API キーなどの秘密を受け継ぐ。登録簿の `secret` を使って外す（`yahoo-search-mcp` と `rs-trafilatura` が環境変数を受け継ぐかは、実装時に確かめる）。

## 書き換える場所

- `src/`: 環境変数を読むテスト以外の 31 ファイルと、文言に変数名が入っている所（`auth.ts` の警告、`browser_session.ts` のエラー文、`address_errors.ts`、`cross_index.ts` のエラー、`types.ts` の `browser_action` の引数の説明）。
- テスト: 環境変数を書き換えるのは 67 ファイル、約 460 か所（`ALLOW_LOCAL_FETCH` が 24 ファイル 164 か所、`ENABLED_MODULES` が 47 か所）。名前を置き換えるだけで済む。
- ビルドと実行の設定: `Containerfile`、`smithery.yaml`、`run_test.sh`、`.github/workflows/live-tools.yml`（運送会社の鍵の環境変数名。secret の名前は変えなくてよい）。
- `scripts/`: `tool-health/run.ts`（`PASS_THROUGH_ENV`・`-e ENABLED_MODULES`）、`measure-context.ts`、`schema-notation/readme_examples.ts`、`eval-live-ab.ts`、`eval-hts-predict.ts`、`eval-wcxb.ts`、`tool-health` の `catalog.test.ts`・`geo.test.ts`。
- `client/`: 作り直す（`browser_action` の説明が変わる）。
- README: §1.1（`-e API_KEY` と `ENABLED_MODULES`）、§2 のモジュールの見出し 14 個とそのリンク（変数名が入っている）、docker の例、§4.3。
- `docs/`: `engines/` の 9 本、`operations/address-data.md`、`search-scrape-mechanics.md`、`retrieval-v2-rollout.md`、`retrieval-v2-dod.md`、`testing/tool-health.md`。`docs/superpowers/` と `docs/evaluations/` は、過去の記録なので書き換えない。
- `RELEASE_NOTES.md`: v5.0.0 に、旧名→新名の表を足す。

## 範囲外

- `SORA_` が付いて意味の通る名前の改名（得るものが小さい）。
- 設定ファイル（YAML・TOML）の導入。環境変数だけを整理する。

## テスト

- `config.test.ts`: 型ごとの読み方（真偽値・整数・列挙・列・URL・JSON）、不正な値、空の値、`checkEnv` の (a)〜(d)（拒否の 10 個ぜんぶ、旧名と新名の両方、未知の `SORA_*`）。
- 登録簿と README §4.3 の一致、`src/` の `process.env` の読み取りが `config.ts` の外に無いことの検査。
- 既存のテストは、変数名の置き換えだけで通る（動きは変えない）。
- 起動の検査: `index.ts` の起動時と `stdio.ts` で、拒否・警告・正常が、期待どおりの出力と終了コードになること。

## 段階

各段階の終わりに、main が整合した状態になるようにする。

1. 登録簿と読み取りの関数（`src/config.ts`）、`checkEnv`、その `config.test.ts`。まだ誰も使わない。
2. 領域ごとに、読み取りを `config.ts` 経由に直し、名前を変える（CORE・AUTH・LOG・ALERT・MCP → BROWSER・FETCH・PROXY → SEARCH・YAHOO・X・OPENPOI → ADDRESS・HTS・GCC・TRACKING・INTEL）。テストの名前の置き換えを同時に。
3. 旗の廃止（5 個の固定と、2 個の実験のコードごとの削除）。
4. 起動時の検査の組み込み（`index.ts`・`stdio.ts`）、Containerfile・`smithery.yaml`・`run_test.sh`・workflow、不具合の修正（上の一覧）。
5. README §4.3 の生成、`docs/` の更新、`RELEASE_NOTES.md` の移行の表、登録簿と README の一致の検査。
