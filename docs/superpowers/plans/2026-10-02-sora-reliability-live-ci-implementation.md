# Sora信頼性修正・全ツールCI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 現行版で確認した7件を修正し、有効な全ツールの本体処理と実際の外部取得を、検査漏れや失敗の隠蔽なしでCI判定できるようにする。

**Architecture:** 既存Bun testとfixtureによる全本体検査、同じcommitの配布候補コンテナを使うlive検査を分ける。登録集合と検査台帳を照合し、liveは実データの意味的assertionと取得先別レポートで判定する。既存SDK、サービス、DB、コンテナ、GitHub Actionsを再利用する。

**Tech Stack:** Bun、TypeScript、Zod、Hono、MCP SDK、Cheerio/Readability/Turndown、既存SQLite、Chromium、Docker、GitHub Actions。

**Spec:** [修正計画・設計](../specs/2026-10-02-sora-reliability-live-ci-design.md)

作成日: 2026-10-02。対象repo: `/home/ikeno/Sora`。調査基準: v2.33.1、`69eedcf`。これは実装指示書であり、記載した新規ファイルやコマンドは実装後に使用可能になります。

## Global Constraints

- このrepoの現行コードを使用する。旧`/home/ikeno/work/sora`や`/home/ikeno/app/web-fetcher`を修正対象にしない。
- 実装前にHEAD・差分・既存テストを確認する。ユーザーの変更を上書きしない。スコープ外の整理や新機能を混ぜない。
- 各修正は失敗する回帰テストを先に実行し、最小実装後に同じテストを通す。外部サービスの予想に基づいてparserを変更しない。
- 入力・取得器などの境界だけmockする。ハンドラ、実parser、取得状態の集約、DB更新は本物を使う。
- テストは`NODE_ENV=test SORA_DB_PATH=:memory:`、`.env`無効で実行する。liveも隔離DB、webhookなし、低件数、明示起動に限定する。
- 現行の認証、tenant/cache分離、SSRF対策、MCPセッション分離、遅延ツール有効化を維持する。
- 本体の合格と外部取得の合格を分ける。active対象の欠測・blocked・unavailableをskip成功にしない。
- CI公開時は検査した候補イメージをそのままpushする。外部確認を終える前に公開しない。
- 新規runtimeサービス、DB表、queue、parser frameworkを追加しない。本文選択や画像判定は決定的なルールにする。
- 変更は対象ごとの小さな単位に分ける。commit・push・releaseは実行時のユーザー指示に従い、この文書だけを根拠に実行しない。

## Review Focus

| 失敗分類 | 担当task / 必須の検出試験 |
|---|---|
| 1. 攻撃者指定のHost/Origin、OPTIONSでの迂回 | Task 1: 3経路×POST/GET/DELETE/OPTIONS、不正Host＋同一Originも403 |
| 2. 本文・表列・実画像の情報欠落 | Tasks 2–4: 本文anchor保持、全列値保持、画像一覧とMarkdown一致 |
| 3. schemaで入力が脱落、SNS全失敗が成功になる | Tasks 5–6: MCP/REST parity、503/429、正常0件、復旧時の再呼び出し |
| 4. 失敗取得で監視baselineや履歴を破壊 | Task 7: selector不在時DB不変・通知0回、一括処理継続 |
| 5. CIがモック・空配列・skip・古いimageで偽陽性 | Tasks 8–11: 動的集合照合、実parserに壊れた外部応答、worker停止、候補image ID一致 |

---

## Task 0: 現状確認と再現条件の固定

**Files:** 参照のみ: `package.json`、`src/mcp.ts`、`.github/workflows/test.yml`、`.github/workflows/docker-publish.yml`、設計文書。

- [ ] `pwd`、`git rev-parse --short HEAD`、`git status --short`で対象と既存変更を確認する。
- [ ] 次を実行して基準値を記録する。テスト結果のskip一覧も保存する。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test --timeout 60000
bun --no-env-file run typecheck --tsBuildInfoFile /tmp/sora-plan-baseline.tsbuildinfo
bun --no-env-file build ./src/index.ts --target=bun --outfile /tmp/sora-plan-baseline-server.js
```

- [ ] 調査基準は1137 pass / 16 skip / 0 fail。差分があれば現行HEADの結果を優先し、既に直った問題には重複修正しない。
- [ ] SDKのInMemoryTransport＋`createMcpServer({deferTools:false})`で通常のcanonical集合を取得する。ホテル有効設定は別プロセスで取得する。`default.*`を件数に含めない。

## Task 1: F1 — MCP Origin/Host検証

**Files:** 新規`src/security/mcp_origin.ts`、新規`src/security/mcp_origin.test.ts`、変更`src/index.ts`、`src/routes/mcp_route.ts`、`src/mcp_session_isolation.test.ts`、`README.md`。

**Interface:** `createMcpOriginMiddleware(options?: { allowedHosts?: readonly string[]; allowedOrigins?: readonly string[]; port?: number }): MiddlewareHandler`。設定正規化と照合を同じmoduleに置く。環境設定の読み取りは生成時に行い、設定不備を起動時に発見する。

- [ ] RED: 実際のHono appにmiddlewareを組み込むテストを作る。evil Origin、任意Host＋同じOrigin、scheme/port違い、`null`、複数origin、不正URL、Host欠落を403とassertする。現行では任意Origin受理で失敗することを確認する。
- [ ] RED: `/mcp`、`/sse`、`/message`のPOST/GET/DELETE/OPTIONSすべてを対象にし、OPTIONSが既存CORSを迂回しないことをassertする。
- [ ] GREEN: 設計F1のallowlistを実装し、`src/index.ts`でCORSより前に登録する。MCP経路のCORSのみ許可originを返す。ホスト照合をOriginとの単純比較で済ませない。
- [ ] GREEN: Originなし＋信頼Host、許可済みTLS公開Host/Origin、既存認証・SDK通信は通す。不正な環境設定は例外にし、空設定を全許可として扱わない。
- [ ] `README.md`にコンテナport差、proxy/TLSの設定例と移行手順を追加する。実運用の許可Host/Originを確認して設定する。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/security/mcp_origin.test.ts src/auth.test.ts src/mcp_session_isolation.test.ts --timeout 60000
```

**Acceptance:** 不正要求はMCPセッションを作成せず403。正常な認証・session isolationに退行なし。実HTTPでの最終確認はTask 8。

## Task 2: F2 — 本文を保持する構造救済

**Files:** 変更`src/html_parser.ts`、`src/html_parser.test.ts`。

- [ ] RED: `main`に813文字相当の識別可能な説明、`aside > article`に593文字相当の別表を置くfixtureを作る。Markdownに本文の全主要段落が残ることをassertする。現行では表側だけに置換されることを確認する。
- [ ] RED: 主本文に表があるケース、主領域なしのcalendar div、Readabilityがすでに表を保持するケース、`onlyMainContent=false`の期待値を追加する。
- [ ] GREEN: `selectMainContent`で候補の親領域を検査し、aside/nav/complementaryを除外する。実質的なReadabilityブロックの正規化テキストを全て保持する候補だけを採用する。
- [ ] GREEN: 意味的主領域が存在するが表はasideだけの場合、候補なしを理由にbody全体へ戻さない。意味的主領域のないcalendar救済は、aside等の外にある構造に限定して維持する。
- [ ] 長さ比やcompletenessだけを変更してテストを通さない。正規化helperはこのファイル内のprivate関数で足りる。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/html_parser.test.ts --timeout 60000
```

**Acceptance:** 説明文の識別anchorが全て残り、必要な主表・calendarも保持される。

## Task 3: F3 — 表ヘッダーの一意化

**Files:** 変更`src/html_parser.ts`、`src/html_parser.test.ts`。

- [ ] RED: colspan=2の同名`Revenue`列に100/200を置き、構造化JSONに両値が残ることをassertする。現行は200への上書きで失敗する。
- [ ] RED: 空ヘッダー、3列同名、既存`Revenue_2`との衝突、rowspan/colspanの期待値を追加する。
- [ ] GREEN: `extractTables`のヘッダー確定時に、既存名を予約し左から一意化する。仕様例`Revenue, Revenue, Revenue_2`→`Revenue, Revenue_3, Revenue_2`を固定する。
- [ ] 全列の順序と値を保持し、Markdownの100/200とJSONの100/200が一致することを検証する。既存row表現は維持する。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/html_parser.test.ts --timeout 60000
```

## Task 4: F4 — lazy画像のURL解決を統一

**Files:** 変更`src/html_parser.ts`、`src/html_parser.test.ts`。

**Interface:** private `resolveImageUrl(element, baseUrl): string | undefined`。画像一覧とTurndownに渡すDOMの`src`正規化に使用する。公開APIを増やさない。

- [ ] RED: HTTP placeholder＋`data-src`、data URI＋`data-src`、srcset-only、data-srcset-only、相対URLを追加し、実画像URLがimagesとMarkdownの両方に現れることをassertする。
- [ ] RED: 実HTTP(S) src＋data-srcは既存srcを保持する。既知placeholder basename、w/x候補選択、危険scheme、`keepDataImages`の既存動作も固定する。
- [ ] GREEN: 設計F4の優先順位でURL解決する。Readability/Markdown変換より前にDOMを正規化し、metadata抽出にも同じ結果を使う。新しい画像処理依存は追加しない。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/html_parser.test.ts --timeout 60000
```

## Task 5: F5 — 国地域MCPのSNS入力を保持

**Files:** 変更`src/mcp.ts`、`src/services/country_intel/mcp_parity.test.ts`、`src/mcp_social.test.ts`。参照`src/services/country_intel/types.ts`の`IntelSocialInputSchema`。

- [ ] RED: SDK InMemoryTransportで`search_tools`を使って国地域toolを有効化し、`research_country_context`へ`social.platforms=['weibo']`、query=`およよう！`、urls、lookbackHours=24を渡す。注入した`intelResearch`に全値が届くことをassertする。
- [ ] RED: RESTでも同じ入力が届き、canonical/`default.*`aliasでも一致することを確認する。不正platformと範囲外lookbackHoursは上流呼び出し0回で拒否されることをassertする。
- [ ] GREEN: MCP input shapeに`social: IntelSocialInputSchema.optional()`を追加する。既存region/topics等の契約を不用意に厳格化しない。SNS schemaを別の手書き定義へ複製しない。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/services/country_intel/mcp_parity.test.ts src/mcp_social.test.ts src/mcp_session_isolation.test.ts --timeout 60000
```

## Task 6: F6 — SNS失敗を伝播し、誤キャッシュを防止

**Files:** 変更`src/services/social/discovery.ts`、`src/services/social/index.ts`、`src/services/social/index.test.ts`、`src/services/country_intel/providers/social_posts.ts`、`src/services/country_intel/providers/social_posts.test.ts`、`src/services/country_intel/provider_cache.test.ts`。必要な場合のみ変更`provider_registry.ts`。

**Interface:** discovery内部の`DiscoveryResult = { status: 'ok' | 'empty' | 'unavailable'; urls: string[]; failures: string[] }`。country側は既存`ProviderResult.status/errorCode/gaps`を利用する。

- [ ] RED: discovery HTTP 503→SocialSearchResult.unavailable、正常検索0件→empty、login HTML→本文取得成功にならないことをassertする。
- [ ] RED: 全Weibo 429と全Meta 503ではprovider runがsuccessにならない。2回目の実行で検索を再呼び出すことをassertする。現行ではsuccess/キャッシュで失敗する。
- [ ] RED: 一部投稿を取得できた後の取得失敗・deadline・abortはデータを保持してpartial/gapsを返す。結果limit到達は正常終了、未処理の別queryは未実行として区別する。
- [ ] GREEN: discovery状態を直接扱い、文字列regexでemptyを推定する分岐を除去する。予定query・URLと実行済み数を管理し、失敗・未実行を既存gapsに反映する。
- [ ] GREEN: `social_posts`が常にstatusを明示し、全失敗のcoverageを成功として宣言しない。失敗statusがキャッシュされない既存registryの仕組みをまず利用する。
- [ ] 正常0件は本体テストでsuccessとして扱い、liveの非空期待とは混同しない。レポートのcoverage/取得状態まで反映されることもassertする。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/services/social/index.test.ts src/services/country_intel/providers/social_posts.test.ts src/services/country_intel/provider_cache.test.ts src/services/country_intel/report_v3.test.ts --timeout 60000
```

## Task 7: F7 — selector不在でbaselineを書き換えない

**Files:** 変更`src/services/watch.ts`、`src/routes/watch.ts`、`src/types.ts`、watch用exportが必要な場合`src/scraper.ts`。新規`src/services/watch.test.ts`、新規`src/routes/watch.test.ts`。

**Interface:** `WatchSelectorNotFoundError`は`code='WATCH_SELECTOR_NOT_FOUND'`を持つ。`WatchCheckResult.errorCode?: string`、登録結果に`initialError?: {code:string; message:string}`を追加し、対応Zod schemaも一致させる。

- [ ] RED: baseline取得→selector不在→同じ内容でselector復旧の順に呼ぶ。不在時は拒否、last_hash/content/last_checked_at/履歴が不変、webhook0回、復旧時changed=falseをassertする。
- [ ] RED: マッチ要素の空文字列は有効な空内容、selectorなしは従来どおり本文全体。新規登録の初回selector不在はinitialErrorあり、initialResult/baselineなしをassertする。
- [ ] RED: 一括チェックで失敗対象のerrorCodeがあり、他対象は処理される。単体RESTは502/code/retryable=false、MCPはisError=trueをassertする。
- [ ] GREEN: hash計算とDB変更より前に、selector指定＋extracted.contentのstring判定を行う。truthy判定を使わない。
- [ ] GREEN: 初回取得のcatchと一括checkのcatchで機械可読エラーを返す。DB migrationや全ページfallbackは追加しない。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test src/services/watch.test.ts src/routes/watch.test.ts src/scraper_selector.test.ts --timeout 60000
```

## Task 8: 全ツールの本体台帳・公開経路の検査

**Files:** 新規`scripts/tool-health/catalog.ts`、新規`scripts/tool-health/catalog.test.ts`、新規`src/tool_contracts.test.ts`、新規`src/tool_transport_smoke.test.ts`、新規`test/fixtures/tool-health/`配下。既存domain testは再利用する。

**Interface:** catalogはデータ・意味的assertion・case定義をexportする。`HealthCase`は`id`、`toolNames`、`dependencyIds`、`externalRequired`、`timeoutMs`、fixture/live入力生成、期待値検査を持つ。個別adapter実装を台帳側に複製しない。認証値をcase IDや入力概要へ埋め込まない。

- [ ] RED: SDKの実登録canonical集合とcatalog対象集合が一致することをassertする。catalogから1名を削ると、その名前を示して失敗するテストを作る。通常/ホテル有効は別プロセスで比較する。
- [ ] RED: 配送8社、SNS4種、国地域24 provider、feed13、fediverse4、World Bank6指標の現行登録集合とdependency台帳を一致させる。`getAllCarrierAdapters()`、`SocialPlatformSchema`、`defaultCountryIntelProviderIds`、`GLOBAL_FEED_CATALOG`、`FEDIVERSE_TAG_SOURCES`、`WORLD_BANK_INDICATORS`を参照する。固定件数だけで済ませない。
- [ ] GREEN: 設計の47行をすべて本体ケースへ関連付ける。ハンドラ/サービスそのものではなくHTTP、helper、browser取得境界へfixtureを注入し、実parserを通す。既存依存注入を優先する。
- [ ] GREEN: 対応RESTのpath・method・入力をcatalogに明示する。alias、`/scrape/stream`、`/crawl/stream`も既存の実在経路を検査する。存在しない`/search/stream`を前提にしない。
- [ ] GREEN: watch lifecycle、country contextの保存/証拠ページング/updates、inspect_imageのImageContent、search_toolsのsession isolationを本体で確認する。
- [ ] GREEN: buildしたBunサーバーを別プロセスで起動するtransport testを追加する。SDK HTTP initialize→tools/list→activation→call→session delete、SSE alias、Task 1の悪意Origin/Host/OPTIONSを確認する。実接続元による認証も維持されることを確認する。
- [ ] server終了、DB/browser cleanup、port衝突回避を実装し、固定portの常駐サービスへ接続しない。既存の依存注入で足りない場合のみ、取得境界の引数を最小限追加する。Bunのmodule mockを使うケースは別プロセスに隔離し、全suiteへmockを残さない。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test scripts/tool-health/catalog.test.ts src/tool_contracts.test.ts src/tool_transport_smoke.test.ts --timeout 60000
```

**Acceptance:** 全canonicalに意味的assertionがあり、実公開経路も動く。fixtureが成功を返すだけのテストは不可。

## Task 9: 実取得worker・判定・レポート

**Files:** 新規`scripts/tool-health/run.ts`、新規`scripts/tool-health/worker.ts`、新規`scripts/tool-health/report.ts`、新規`scripts/tool-health/run.test.ts`、変更`catalog.ts`、`package.json`、`src/services/country_intel/providers/fediverse.ts`、`fediverse.test.ts`。参照`src/services/country_intel/source_catalog.ts`、`providers/feeds.ts`、`providers/worldbank.ts`。必要な取得証拠は実adapterの既存diagnosticsを優先する。

**CLI（実装後）:** `bun --no-env-file run scripts/tool-health/run.ts --live --image IMAGE --out DIRECTORY [--enable-hotel]`。image省略や`--live`省略ではlive開始せず非zero終了する。通常とホテル有効を別実行する。

**Report contract:** `HealthStatus`は設計の7状態。`CaseResult`に`caseId/toolNames/dependencyIds/status/reason/startedAt/durationMs/attempts/recovered/observedSources`を持たせる。`observedSources`は取得先、cache、件数、観測可能なら上流status/形式、欠落フィールドを含む。外部取得と本体の判定を別のfieldにする。

**Test data contract:** `SORA_TOOL_HEALTH_CASES_JSON`は`{ version: 1, cases: Record<string, { trackingNumber?: string; url?: string; query?: string; expectedText?: string }> }`とする。unknown case ID・unknown keyは設定エラー。caseに必要なfield欠落はunverified。case IDは`tracking.yamato.positive`などの秘密を含まない固定値で、catalogから一覧を生成する。実資格情報は既存のcarrier環境変数を使う。

- [ ] RED: worker起動失敗、途中終了、期限超過、結果JSONなし、不正JSON、必須case欠落がexit 1になることをassertする。
- [ ] RED: 実parserにHTTP 200ログインHTML、必須キーなしJSON、503、429を与え、それぞれblocked/fail/unavailableとして終了1になることをassertする。HTTP 200と空配列を与えるだけの成功テストは禁止する。
- [ ] RED: 資格情報不足・配送番号なし・fallbackだけ成功は、必要取得先がunverifiedとなることをassertする。警報なしの正常文書はpass_empty、単なる[]はunverifiedとする。
- [ ] GREEN: runnerが同じcommitのworker bundleを作り、`docker run`で候補imageの`/app/tool-health-worker.js`へ読み取り専用mountする。`--entrypoint /usr/local/bin/bun`でworkerを起動し、native依存は候補の`/app/node_modules`、Yahoo helperは`/app/yahoo-search-mcp`を使用する。image ID/SHA/worker SHAを記録し、候補内`/app/server.js`を起動して公開toolを呼ぶ。runnerはAPI結果を返すreadinessを待ち、その後に意味的なtool検査を実行する。
- [ ] GREEN: 逐次シナリオ、ケース上限、signal、SDK timeout、期限時のcontainer強制削除、job終了時の全作成container cleanupを実装する。停止要求でChrome/serverが残らないことを検証する。
- [ ] GREEN: 秘密値は環境経由で渡し、CLI引数、docker commandログ、reportに出さない。`SORA_TOOL_HEALTH_CASES_JSON`のcase IDをschemaで検証し、Secret値を含むvalidation errorも伏字にする。
- [ ] GREEN: 既存Provider.runと取得器で台帳のprovider・carrier・SNS・feedケースを実行する。MCPが内部providerを全部起動したと推定しない。地域限定やincludeSocialの条件も明示する。
- [ ] GREEN: feedは`createGlobalFeedsProvider(fetchFn, [entry])`、World Bankは`createWorldBankProvider(fetchFn, [indicator])`で1供給元/指標ずつ確認する。fediverse factoryにoptional `sources`引数を追加し、既存parserと本番の既定4供給先を維持する。上限到達で未実行の供給先を成功扱いしない。
- [ ] GREEN: JSON、Markdown、JUnitを出力し、各case完了時に途中reportも更新する。missing/blocked/unavailableを含む集計はexit 1。再試行は最大追加1回、bounded Retry-After、復旧履歴を保持する。
- [ ] 元APIとfallbackを別行で記録する。観測できない上流statusを200と記入しない。正の外部取得に関係しないハードコード規則はnot_applicableと記録する。worker/serverのstdout/stderrも既知の秘密値と機密headerを伏字にし、未加工ログをartifactへ保存しない。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test scripts/tool-health/catalog.test.ts scripts/tool-health/run.test.ts --timeout 60000
bun --no-env-file build scripts/tool-health/worker.ts --target=bun --outfile /tmp/sora-tool-health-worker.js
```

**Acceptance:** 壊れた本体、壊れた外部応答、検査漏れ、worker自体の異常を合否に反映する。新規常駐APIを作らずCIスクリプト内で完結する。

## Task 10: liveの実測と旧スキップの整理

**Files:** 変更`catalog.ts`、必要な実parser/adapter、`test/fixtures/tool-health/`、`src/services/country_intel/live_smoke.ts`、`package.json`、該当する既存live test。

- [ ] 必要な公開投稿、配送番号、配送資格情報を安全に設定する。まだ用意できないケースはunverifiedで記録する。ダミー番号や空結果への期待変更で通さない。
- [ ] 候補imageをbuildし、通常全liveを実行する。その後ホテル有効laneを実行する。ホテルflagは正確に`SORA_RAKUTEN_TRAVEL_ENABLED=true`を使う。

```bash
docker build -f Containerfile -t sora-tool-health:candidate .
bun --no-env-file run scripts/tool-health/run.ts --live --image sora-tool-health:candidate --out /tmp/sora-tool-health-standard
bun --no-env-file run scripts/tool-health/run.ts --live --image sora-tool-health:candidate --enable-hotel --out /tmp/sora-tool-health-hotel
```

- [ ] HTML/JSON変更を検出した場合は、失敗応答の形式とparser条件を観測してから修正する。必要最小限の伏字fixtureを追加し、本体回帰テストを通してからliveを再実行する。
- [ ] 運航・ニュース・ホテル・SNSの変動データは複数のbounded候補を許すが、時間無制限検索をしない。国地域イベント0件は設計の解析証拠を取得できる場合だけpass_emptyとする。
- [ ] legacyの`test:intel:live`は限定範囲のadvisoryと明記し、明示的`--live`起動と既存fixture検査を維持する。live失敗を終了コード1へ反映する。`package.json`に`test:tools:live`として新runnerを追加し、全機能の合否にはこちらを使う。
- [ ] 既存16 skipを本体fixtureケースとlive台帳に一対一で紐付ける。ダミー配送not_foundなどの負例は残す。PRでliveをskipする理由は表示し、live jobでactive caseをskipする分岐は作らない。
- [ ] CPSC/FDAの内蔵規則が最新法規に正しいことは、この機能検査だけでは証明しない。既存規則を変更する場合は別途公式資料を確認する。

**Acceptance:** 同じ候補imageで観測した証拠付きreportがあり、未観測対象を把握できる。全ケースのデータが揃わない場合は「全live成功」「完了」と報告しない。

## Task 11: workflow接続・公開ゲート・運用手順

**Files:** 変更`.github/workflows/test.yml`、`.github/workflows/docker-publish.yml`、新規`.github/workflows/live-tools.yml`、新規`docs/testing/tool-health.md`、変更`README.md`。

- [ ] `test.yml`に`workflow_call`を追加し、既存PR/main triggerを維持する。型検査、全Bun test、台帳整合、transport testを必須にする。Secret不要の本体検査がfork PRでも動くようにする。
- [ ] `live-tools.yml`を`workflow_call`、schedule、workflow_dispatchから実行可能にする。予定時刻はUTC `23 19 * * *`。通常laneとホテル有効laneの結果を別artifactへ出す。失敗時も他の結果・diagnosticsを保存する。
- [ ] mainの全liveはpublish workflowの候補検査へ接続し、同じcommitで重複した全外部取得jobを並行起動しない。定期・手動は対象commitの候補imageをbuildして検査する。
- [ ] publish workflowはreusable本体検査→candidate build/load→全通常live＋候補smoke→同じimageのpush→必要なrelease作成の順にする。main/tagの従来の公開条件を維持し、別workflow成功を待ったつもりの実装にしない。
- [ ] reusable live jobへ候補imageを渡す場合はローカルimageのOCI/Docker archiveをartifactとして引き渡し、load後のimage IDを照合する。検査後はそのarchive内のimageをpushし、別buildで置換しない。公開manifestのconfig digestと候補image IDの対応を確認し、manifest digestとimage ID自体が同じだとは扱わない。
- [ ] `if: always()`でJSON/Markdown/JUnitを7日保存し、exit codeを保持する。`continue-on-error`や`|| true`は使わない。Secret不足をunverified/失敗として表示する。
- [ ] Secretsは信頼されたmain/tag/手動・定期だけで使う。PR由来コードをSecret付き`pull_request_target`で実行しない。最小permissionsを指定する。
- [ ] 運用手順にcase追加、登録集合照合、テストデータ更新、失敗分類、通信環境比較、再試行上限、Secret/番号の伏字、artifact読解、公開保留時の診断を記載する。
- [ ] 新toolを台帳未追加で登録、壊れたHTML/JSON、Secret不足、worker強制停止を与えて、workflowが失敗しpublish段階へ進まない受入試験を実行する。ローカルの模擬workflow確認と実GitHub実行を区別する。
- [ ] 通常全live成功、ホテルlaneの状態、公開imageとの一致を確認する。外部障害やテストデータ不足のまま完了扱いしない。

## 最終検証と引継ぎ

- [ ] 最後のコード変更後に次を実行し、結果を記録する。同じ変更に対する意味のない全suite反復は避ける。

```bash
NODE_ENV=test SORA_DB_PATH=:memory: bun --no-env-file test --timeout 60000
bun --no-env-file run typecheck --tsBuildInfoFile /tmp/sora-plan-final.tsbuildinfo
bun --no-env-file build ./src/index.ts --target=bun --outfile /tmp/sora-plan-final-server.js
git diff --check
```

- [ ] Task 10/11の実取得とCI受入結果を併記し、本体成功、外部成功、未検証、experimental無効を分けて報告する。
- [ ] 修正内容、使用したfixture、実取得証拠、残る制約、移行設定を引き継ぐ。文書作成だけ、ローカル4経路だけ、部分providerだけの成功を全機能完成と呼ばない。
