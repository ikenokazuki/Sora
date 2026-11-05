# v4.1.0（引数の調べで見つかった不具合・効かない引数・説明の直し）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** v4.0.0 の全ツールの引数を、値を変えて呼ぶ・コードを追うことで判定した結果（324 項目）のうち、効かない引数、間違った答えを返す処理、範囲外の入力を通す REST のルート、説明と実際の違いを直す。あわせて、MCP の search_image・search_video・search_chiebukuro に page を足す。

**Architecture:** 直す場所ごとに Task を分け、1 つのブランチに順に積む。効かない引数は消す（zod の既定で、送られても無視されるだけでエラーにはならない）。説明（describe・ツールの説明・instructions・README）は、各 Task が直すツールの分を一緒に直す。最後の Task で、生成するクライアント・版・全体の確認を行う。

**Tech Stack:** Bun（CI は 1.4.2）・TypeScript・zod 4・cheerio・bun:test

## Global Constraints

- 公開リポジトリなので、特定の利用者のサービスの名前を、コード・コメント・docs・コミット・PR に書かない。
- 依存を足さない。Containerfile とイメージは変えない。
- 既定の値は変えない（この計画に書いたものを除く）。REST の応答の形は変えない（項目を足すのは可）。
- 引数を消すときは、MCP の inputSchema・ハンドラー・内部の options・REST のスキーマ・ルート・README・instructions・docs から消す。スキーマを `.strict()` にしない（送られても無視されるだけにする）。生成するクライアント（`client/`）は Task 9 でまとめて作り直す。
- 同じキャッシュのキーで応答の中身が変わる修正では、そのキャッシュの版を上げる（今は `scrape:v9`・`search:integrated:v12`。ほかのキーも同じ考え）。
- 説明文は今の文体（日本語、短く）に合わせ、MCP の定義を必要以上に長くしない。
- 振る舞いを変える項目は、先に失敗するテストを書き、直して通す（TDD）。外のサービスはテストでは偽物（`src/test_fixtures/` の型や、送り先の差し替え）を使う。
- 外のサービスへの実際の要求は、各 Task に書いた回数まで。Yahoo への要求は、間を 15 秒以上あけ、429 が返ったら止める。
- コミットのメッセージは英語の Conventional Commits（例: `fix(weather): ...`）。本文に「skip ci」と書かない（否定の文でも CI が止まる）。

---

### Task 1: 天気・警報・地震・標高

対象のファイル: `src/services/life.ts`（天気の部分）、`src/services/disaster.ts`、`src/city_map.ts`、新しい生成データのファイル、`src/mcp/tools_life.ts`（get_weather）、`src/mcp/tools_disaster.ts`、`src/types.ts`、`src/routes/public_data.ts`、README。

**データ:** 気象庁の `https://www.jma.go.jp/bosai/common/const/area.json` を 1 回取得し、次を生成して同梱する。新しいファイル（例 `src/jma_areas.ts`）の先頭に、元の URL と取得日を書く（`city_map.ts` と同じ書き方）。生成に使ったコマンドは report に書く（スクリプトのファイルは足さなくてよい）。
- 予報区（class10、142 件）: 番号 → `{ name, office }`。`office` は class10s[code].parent。
- 気象台（offices、58 件）: 番号 → name。
- 市町村（class20、1,805 件）: 名前 → `[{ code(7 桁), class10 }]`。同じ名前（23 件、例: 森町・池田町・府中市など）は候補を複数持つ。class10 は class20s[code].parent（class15）の class15s[...].parent。

`city_map.ts`（地名 3,490 件 → 予報区）はそのまま使う。

1. **気象台の番号:** 天気（life.ts:291 の `cityId.substring(0, 2) + '0000'`）と警報（disaster.ts:108）で、気象台の番号を予報区の表の `office` から引く。今の作り方は北海道・鹿児島・沖縄の 27 予報区で無い番号（010000・460000・470000）を作り、404 になる。
2. **get_weather の地名:** 今の `resolveCityId`（完全一致 → 都・府・県・市・区・町・村を除いて → 部分一致）で見つからなければ、市町村の表から予報区を引く。それでも見つからなければ、東京にせずエラー（例: `地名「X」が見つかりません`）にする。city を省いたときの既定がある場合はそのまま残す。6 桁の数字はそのまま予報区の番号として使う。
3. **get_weather の気温:** 今は常に `timeSeries[2].areas[0]`（気象台の最初の地点）の気温を使う。`timeSeries[0].areas` の中での予報区の位置と同じ位置の `timeSeries[2].areas` の地点の気温を使い（無ければ今のとおり最初の地点）、応答にその地点の名前を足す（例 `temperatureArea`）。週間予報は地点が 1 つなので今のまま。福岡（400000）と沖縄本島（471000）の JSON で、地域と地点の並びが一致することを確かめてある。
4. **search_disaster_warnings の地名:** 今は県の予報区を全部合わせて返す（disaster.ts の `targetAreaCode.startsWith(a.code.slice(0, 4))`。新宿区に小笠原・伊豆諸島の警報が混ざる）。次の順に解決し、その範囲の警報だけを返す。
   - 市町村の表に当たれば、その市町村の警報（警報の JSON の `areaTypes[1]` の同じ番号の欄）。同じ名前が複数あるときは、入力に含まれる都道府県名（または市名）で絞り、絞れなければ候補（都道府県と名前）を挙げたエラーにする。政令指定都市の区（例「横浜市中区」「札幌市中央区」）は市（「横浜市」「札幌市」）に当てる。東京の特別区は区のまま。
   - 市町村で無ければ `city_map.ts` の予報区の警報（`areaTypes[0]` の同じ番号の欄）。
   - どちらでも無ければ、東京にせずエラー。city も areaCode も無いときの既定（東京）は残す。
   - 応答の `areaCode` は解決した番号、`areaName` は解決した市町村・予報区の名前にする。
5. **search_disaster_warnings の areaCode:** 7 桁（市町村）・6 桁（予報区または気象台）・2 桁（都道府県）を受ける。今は 2 桁を `.../warning/27.json` のまま引いて 404 になる。2 桁は `XX0000` に補う。ただし気象台が複数ある北海道（01）・鹿児島（46）・沖縄（47）は、その県の気象台の 6 桁の番号と名前を挙げたエラーにする。気象台の番号なら、その気象台の範囲の警報を合わせて返す（今の動き）。city が無いときのラベルは、表から areaCode の名前を引いて作る（今は「東京」になる）。
6. **天気・警報のキャッシュ:** 今はキャッシュのキーが解決後の番号だけなので、応答の地名に最初に引いたときの入力が残る。キャッシュには入力に依らない中身だけを入れ、返すときに今の入力と解決結果からラベルを付ける（キーは今のまま）。
7. **search_earthquake の minIntensity:** 今は P2P 地震情報から最新の `limit×2` 件（40 件まで）を取ってから震度で絞る（disaster.ts:188-197）ので、limit が小さいと、ある地震が 0 件になる。minIntensity が既定（震度 1 以上）より大きいときは 100 件取り、絞ってから limit 件に切る。
8. **search_earthquake の失敗:** 今は取得に失敗すると 0 件の結果を返す（disaster.ts:263-269、「地震が無い」と区別できない）。エラーにする（MCP はエラーの応答、REST は今のルートのエラーの形）。失敗はキャッシュしない。
9. **get_elevation:** lat は -90〜90、lon は -180〜180 を MCP と REST のスキーマで確かめる（今は (999, 999) にも 0m を返す）。
10. **REST の `POST /weather`:** MCP と同じ範囲で検証する（今は days=0 が 7、100 が 8、'abc' が空になる）。範囲外は 400。
11. **説明:** get_weather の city、search_disaster_warnings の city（市区町村単位。予報区の名前も可。同じ名前の町は都道府県名を付ける）と areaCode（7 桁・6 桁・2 桁の意味）、REST の describe、README の該当の行を、上の動きに合わせる。

テスト: 那覇 → 気象台 471000、札幌 → 市町村 0110000 と気象台 016000、新宿区 → 1310400 の欄だけ、森町 → 候補のエラー、北海道森町 → 解決、横浜市中区 → 横浜市、知らない地名 → エラー、2 桁 27 → 270000、01 → 気象台の一覧のエラー、気温の地点の位置、キャッシュのラベル、地震の絞り込みと失敗、標高の範囲、REST の検証。

外への要求: 気象庁の area.json 1 回、予報・警報の JSON は確かめに 6 回まで。Yahoo は使わない。

### Task 2: 乗換・飛行機・道路

対象のファイル: `src/services/life.ts`（乗換の部分）、`src/services/traffic.ts`、`src/mcp/tools_life.ts`、`src/mcp/tools_disaster.ts`（search_road_traffic）、`src/types.ts`、`src/routes/search.ts`（`/transit/route`）、`src/routes/public_data.ts`、README。

1. **search_route の sortBy:** Yahoo の乗換の並び順は `s=0` 到着が早い順・`s=1` 料金が安い順・`s=2` 乗り換え回数順（Yahoo の乗換の検索フォームの select で確かめてある）。今の対応（life.ts:92-93 の transfer→1・fare→2）は逆なので、transfer→2・fare→1 にする。
2. **search_route の seatPreference:** 今は座席の値を `shin` に入れ、後の `useShinkansen` が同じ `shin` を上書きするので、座席は Yahoo に送られていない（life.ts:84-85・97）。座席は `expkind` に送る（non_reserved→1 自由席優先・reserved→2 指定席優先・green→3 グリーン車優先。同じフォームで確かめてある）。`shin` は useShinkansen だけに使う。
3. **get_flight_status の行き先・出発地:** Yahoo の JSON は名前が逆向きで、到着の一覧では `depatureName` が自分の空港、`arrivalName` が相手の空港になっている（羽田の internationalArrival で確かめてある）。traffic.ts:418 の式を、到着の一覧は `arrivalName`、出発の一覧は `depatureName` にする。keyword の行き先での絞り込みもこれで当たるようになる。
4. **get_flight_status の airport:** Yahoo の運航情報は羽田・成田・伊丹・関西・中部の 5 空港（ID 1〜5）だけで、6 番以降は 404。今は表に無い空港（新千歳・福岡・那覇など）を何も言わずに羽田として答える（traffic.ts:339-343）。空でない入力が表に無ければ、対応する 5 空港を挙げたエラーにする。省いたときの既定（羽田）は残す。説明（MCP・REST・README）も 5 空港に直す。
5. **search_road_traffic:**
   - 道路名で絞った結果が 0 件のとき、今は「規制情報はなく順調です」と返す（traffic.ts:255-259。表に無い道路名でもこうなる）。0 件のときは「この道路の情報は見つかりませんでした」の旨を返し、順調とは言わない。都道府県のページから 1 件も読めなかったときも同じにする。
   - pref と road を両方指定したら、その都道府県のページを道路名で絞る（今は road が表に当たると pref を無視する）。
   - 空でない pref が解決できなければ、東京都にせずエラーにする（traffic.ts:200）。省いたときの既定は残す。
   - 説明の road の例を、表（ROAD_CODE_MAP）にある名前にする。
6. **REST の `POST /transit/route`:** 今は検証せずに本文を直に読む（routes/search.ts:410-440）。`TransitRouteRequestSchema` で検証する。REST だけが受けている year・month・day・hour・minute は、日時の解決に使われているなら、REST のスキーマに足して残す（消さない）。via の上限は MCP と同じにし、超えたら 400 にする。

テスト: `buildTransitUrl` の s と expkind と shin、到着・出発の一覧の行き先、表に無い空港のエラー、道路の 0 件・pref と road の両方・不明な pref、REST の検証。

外への要求: Yahoo の乗換 2 回・運航情報 1 回・道路 2 回まで（間を 15 秒以上）。

### Task 3: Yahoo の検索

対象のファイル: `src/services/yahoo.ts`、`src/services/yahoo_realtime_api.ts`、`src/mcp/tools_yahoo.ts`、`src/mcp/tools_web.ts`（search_deep）、`src/scraper.ts`（統合検索の部分）、`src/mcp/tools_search.ts`、`src/mcp/instructions.ts`、`src/routes/search.ts`、`src/types.ts`、README。

1. **search_deep の noCache:** 統合検索と Web 検索のキャッシュは迂回するが、ページ本文を取る `scrapeUrl` の 4 か所（scraper.ts:1778・1962・2063・2140）に `noCache` が渡っていない。渡す。
2. **MCP の Yahoo の 6 ツールのキャッシュ:** REST の image・video・news・chiebukuro・suggest・realtime は短い時間キャッシュするが（routes/search.ts:95・308・333・355・376・397）、MCP のハンドラー（tools_yahoo.ts:29・61・93 ほか）は毎回 Yahoo に当たる。MCP にも REST と同じキー・同じ時間（リアルタイムは `CACHE_TTL_TREND`、ほかは `searchCacheTtl`）のキャッシュをかける。処理は両方から呼べる 1 か所にまとめ、REST の動き（キー・時間・noCache）は変えない。MCP に noCache は足さない。
3. **search_realtime の missingTerms:** 今は `( )` と `URL:` を修飾子として扱わないので、`(ハロウィン`・`色違い)`・`URL:example.com` のような断片が `missingTerms` に入る（yahoo.ts:1374 の `splitRealtimeQueryParts`）。括弧と `URL:` を修飾子として除く。
4. **MCP の page:** search_image・search_video・search_chiebukuro に page を足す（REST のスキーマの `page` をそのまま使う。中の関数は page に対応済み。キャッシュのキーに page を入れる）。search_news はバイナリに page が無いので足さない。limit の説明を「最大 20 件（知恵袋は 10 件）。大きい値を指定しても 20 件（10 件）」にする（スキーマの上限は今のままで、エラーにしない）。README も同じ。
5. **search_realtime の page:** 今は `start=(page-1)*40` で limit と関係しない（yahoo_realtime_api.ts:55）。limit 20（既定）で 2 ページ目を取ると 21〜40 件目が抜ける。`start=(page-1)*limit` にする。実装の前に、Yahoo が 40 の倍数でない start を受けるかを、実際に 2 回まで呼んで確かめる（例: limit 20・start 20 の結果が、limit 40・start 0 の 21〜40 件目と一致するか）。受けないなら start は今のままにし、MCP の説明に「page は 40 件ずつ進む。続きは limit 40 で」と書く。README と REST の説明（今は「40 件固定幅」）も結果に合わせる。
6. **REST の `/search/news` の page:** `NewsSearchRequestSchema` にあるが、ルートは読まず（routes/search.ts:351）、バイナリにも page が無い。スキーマ・README から消す。
7. **REST の `POST /search/deep`:** 今は検証がゆるい（routes/search.ts:197-208。`limit:-3`・`highlightMaxCount:99`・`formats:["bogus"]`・`updated:"month"`・`maxChars:999999` が通る）。`IntegratedSearchRequestSchema` で検証して 400 にする。REST だけが受ける項目があれば、消さずにスキーマに足す。
8. **REST の `POST /search/trend`:** limit を検証せずに 1〜50 に丸めている。1〜50 の整数で検証して 400 にする。
9. **説明:**
   - instructions.ts:154 の realtimeFocus の `"official" (default)` から「(default)」を外し、省くと検索語から決まることがわかる文にする。
   - search_trend の limit: 「最大 50」とあるが、返るのはページに載っている件数まで（2026-11 は 31 件）。
   - search_deep の maxChars: 効くのは markdown とハイライトの字数（html には効かない）。
   - search_deep の realtimeLimit: 1 回の取得は 40 件まで（scraper.ts:1821）。
   - search_tools の detail: `activate:false` を付けないと、調べたツールを有効にもする。
   - README: search_news の既定は 10 ではなく 20、suggest_keywords の最大は 30 ではなく 20。

テスト: 偽の Yahoo（送り先の差し替え）で、noCache が本文の取得まで届くこと、MCP の 2 回目がキャッシュから返ること、missingTerms、MCP の page、start の計算、REST の検証。

外への要求: Yahoo は 4 回まで（5 の確かめに 2 回、ほかの確かめに 2 回）。

### Task 4: scrape・scrape_batch

対象のファイル: `src/scraper.ts`（scrape の部分）、`src/browser_stealth.ts`、`src/mcp/tools_web.ts`、`src/routes/scrape.ts`、`src/types.ts`、`src/extractor/temporal_anchor.ts`（説明だけ）、README。

1. **maskPii:** 今は content とハイライトだけをマスクし（scraper.ts:319-332）、html・rawHtml は元のまま返す。html・rawHtml・title・description・tables・extracted の文字列にも同じマスクをかける。
2. **formats の screenshot:** 既定の auto で静的取得が通ると、画像が付かず、警告も出ない（scraper.ts:719・905。`needScreenshot` はブラウザの経路の中でだけ読まれる）。formats に screenshot があれば、ブラウザで取る。mode に fast を明示したときは切り替えず、画像を取れない旨の警告を付ける。scrape_batch も同じ。
3. **headers:** 静的取得では届くが、ブラウザの経路（mode browser・SPA への切り替え・REST の renderJs）では `fetchWithStealthBrowser` に渡らず捨てられる（scraper.ts:910-929）。ブラウザにも渡す（例 `page.setExtraHTTPHeaders`）。cookies は今も届いているので、同じ経路で渡す。
4. **verbose（MCP）:** MCP のハンドラーは verbose を `formatCompactScrapeResult` にだけ渡し、`scrapeUrl` に渡さないので、`highlightDiagnostics` が REST にだけ付く（tools_web.ts:89-90・120-122）。`scrapeUrl` にも渡す。
5. **入力の誤り:** scrape で renderJs と fastOnly を同時に指定したとき、removeSelectors が壊れているときは、今は 500 と `retryable:true` を返す。400 と `retryable:false` にする（入力の誤りの扱いが既にあれば、それに合わせる）。
6. **説明:**
   - annotateTemporal: 「明日、来週等」とあるが、「来週」だけでは注記しない（来週＋曜日・来月・N 日後などは注記する。extractor/temporal_anchor.ts:75-125）。公開日時が無いときは今日が基準。
   - scrape_batch の mode の auto: 「静的フェッチ失敗時に自動ブラウザ昇格」とあるが、接続できないときは切り替えない（types.ts:336）。scrape と同じ説明にする。
   - REST の clipSelector: renderJs（または mode browser）と formats の screenshot があるときだけ要素の画像を返す。
   - scrape_batch の結果は入力の順ではなく、終わった順に並ぶ（scraper.ts:1069）。

キャッシュ: maskPii の結果がキャッシュに入っているなら、`scrape:v9` を `scrape:v10` に上げる。

テスト: 手元の検証用のページ（既存のテストの型に合わせる）で、html のマスク、静的で通るページの screenshot、ブラウザの経路の headers、MCP の verbose、400 の応答。

外への要求: なし（手元のページだけ）。

### Task 5: crawl_site・map_site・webhook

対象のファイル: `src/scraper.ts`（crawl・map の部分）、`src/mcp/tools_web.ts`、`src/routes/scrape.ts`、`src/types.ts`、`src/enrichment.ts`（webhook の送り先の確かめ）、README。

1. **map_site の limit:** 今は日付で絞る前に件数で切る（scraper.ts:1242-1244。limit 2 と since を一緒に指定すると、先頭の古い 2 件が落ちて 0 件になる）。日付で絞ってから件数で切る。
2. **crawl_site の返却:** pages の各項目に scrape と同じ整形をかけていないので、formats が既定（markdown）でも links が付き、quality・evidence・qualityReasons・missingFields などの内部の項目も残る（scraper.ts:1382）。scrape と同じ整形（`formatCompactScrapeResult`）を通し、links は formats で求められたときだけにする。説明の返却の形と合わせる。
3. **`/crawl/stream` の webhookUrl:** 受けるが渡していない（routes/scrape.ts:194 は `/crawl` だけ）。渡して、完了したら送る。
4. **scrape_batch の webhookUrl:** URL でない文字列（`not a url`）もスキーマを通り、黙って送られない。MCP と REST のスキーマで URL の形を確かめる（`z.string().url()` など、ほかの URL の引数に合わせる）。
5. **REST の `POST /crawl`:** `CrawlRequestSchema` を通さず本文を直に読む（routes/scrape.ts:165-197）ので、maxDepth の上限 5、maxChars の 50000、timeoutMs の 120000 を確かめていない（maxDepth 100 で 9 段のページを全部たどった）。スキーマで検証して 400 にする。
6. **説明:**
   - map_site の since・until: サイトマップの lastmod のある URL だけで効き、lastmod の無い URL は常に残る。リンクをたどる切り替えのときは効かない。
   - REST の map の includeSubdomains・timeoutMs: リンクをたどる切り替えのときだけ効く（サイトマップ・robots.txt の取得は固定の 10 秒・5 秒）。

テスト: 手元の検証用のページとサイトマップで、日付と件数の順、crawl_site の整形、`/crawl/stream` の webhook（手元の受け口。ローカル宛ての許可は既存のテストの書き方に合わせる）、URL でない webhookUrl の 400、`/crawl` の範囲外の 400。

外への要求: なし。

### Task 6: browser_action・inspect_image

対象のファイル: `src/browser_session.ts`、`src/mcp/tools_browser.ts`、`src/routes/browser.ts`、`src/services/image_inspect.ts`、`src/mcp/tools_media.ts`、`src/types.ts`、README。

1. **extract.clipSelector:** `screenshot:true` を付けないと、画像と Web フォントを読み込まない設定でページを開くので、撮った要素の画像が空白になる（browser_session.ts:446-449・484 の `needScreenshot` は `extract.screenshot` と actions の screenshot だけを見る）。`extract.clipSelector` があるときも `needScreenshot` を真にする（scrape 側の browser_stealth.ts:386 は `!needScreenshot && !clipSelector`）。
2. **REST の本文の ownerToken:** REST は本文の ownerToken を読まず、Authorization ヘッダーで持ち主を確かめる（routes/browser.ts:34）。REST のスキーマ・説明から本文の ownerToken を消す。MCP は今のまま。
3. **inspect_image:** 画像でない応答（HTML など）も `image/jpeg` として返す（services/image_inspect.ts:36-38）。Content-Type が画像でなければエラーにする。
4. **説明:**
   - timeout: 全体の制限時間ではなく、ページ遷移（goto・navigate）の待ちだけに効く（browser_session.ts:318・363・518）。
   - actions の evaluate: 環境変数 `ALLOW_BROWSER_EVALUATE=true` のときだけ動く（browser_session.ts:296・387）。
   - actions の delay: click は操作の後の待ち、fill・type は 1 文字ごとの間隔で、press・scroll・wait などでは読まれない。
   - actions の screenshot: 単独では画像を返さない（browser_session.ts:323-328）。画像は extract.screenshot で取ると書く。
   - README の環境変数の表（README.md:2325）は `ALLOW_BROWSER_EVALUATE` の既定を `true` と書いているが、実際の既定は止める側なので直す。README.md:2284 の `SAFE_BROWSER_MODE` はコードに無いので消す。

テスト: 手元のページで、clipSelector だけの画像が空白でないこと、REST の ownerToken、inspect_image の HTML のエラー。

外への要求: なし。

### Task 7: 貿易・荷物・監視・音楽・国会

対象のファイル: `src/services/trade.ts`、`src/mcp/tools_trade.ts`、`src/routes/trade.ts`、`src/services/tracking/index.ts`、`src/mcp/tools_life.ts`（track_package）、`src/routes/tracking.ts`、`src/services/watch.ts`、`src/mcp/tools_watch.ts`、`src/routes/watch.ts`、`src/enrichment.ts`（webhook）、`src/services/gov.ts`、`src/mcp/tools_gov.ts`、`src/mcp/tools_music.ts`、`src/types.ts`、README。

1. **verify_hts_code の productDescription:** 必須だが、判定には使わず応答に写すだけ（trade.ts:572-637）。必須のまま残し、説明に「判定には使わず、根拠の記録として応答に返す」と書く。
2. **check_cpsc_certificate の productCategory・description:** どこからも読まれていない。消す。未掲載のときの案内の「productCategory（製品カテゴリ）を補足するか」「productCategory を追加して再判定するか」と `missingInputs: ['productCategory']`（trade.ts:223-230）も消す（足しても結果は変わらない）。
3. **check_fda_regulated の productDescription:** どこからも読まれていない。消す。
4. **track_package の originCountry・destinationCountry:** キャッシュのキーにだけ入り、自動判別に使われていない（tracking/index.ts:239-240・268-269）。消す。
5. **REST の `POST /tracking` の verbose:** 受けるだけで読まれていない。消す。
6. **watch_register の intervalSeconds:** 保存して返すだけで、自動で巡回する処理は無い（watch.ts:58、db.ts:310）。入力から消す（DB の列と、応答の interval_seconds はそのまま）。README の「定期差分検知」（README.md:517・1347 付近）を「watch_check を呼んだときに前回と比べる」の旨に直す。ツールの説明の返却の欄からも interval_seconds の説明を外す。
7. **watch_register の webhookSent:** 送れなかったときも true を返す（watch.ts:129-138、enrichment.ts:227-257 は待たずに送る）。送った結果を待ち、2xx のときだけ true にする。
8. **search_diet_minutes:** keyword・speaker・nameOfMeeting のどれか 1 つが要るのに、スキーマではすべて任意で、REST は 500 になる（gov.ts:435-437）。MCP と REST のスキーマで「どれか 1 つ」を確かめ、400（MCP はエラーの応答）にする。
9. **search_music の attribute:** スキーマが `enum(...).or(z.string())`（types.ts:636、tools_music.ts:82）なので、任意の文字列が通り、iTunes の 400 がそのまま返る。3 つの値の enum だけにする。
10. **説明:**
    - foodContact（check_product_compliance・predict_hts_code・check_fda_regulated）: 効くのは、HTS の 4 桁が FCS の表の品目（3924・4419・6911・6912・7013・7323）のときだけ。
    - hasBattery（check_product_compliance・predict_hts_code）: true のときに検索語へ battery を足すだけ（check_product_compliance は注意書きも 1 行足す）。false では何もしない。
    - check_product_compliance・predict_hts_code の productCategory: 推測の検索語には入るが、CPSC の判定は読まない。
    - check_cpsc_certificate の targetAge: 証明書の種類を決めるのは、リストの 10 桁と完全に一致したときだけ。material: 確認の質問を出すか消すかだけで、判定は変えない。
    - track_package の preferredCarriers: 自動判別（carrier を省く・auto）のときだけ効く。

テスト: 消した引数を送っても無視されること（エラーにならない）、CPSC の案内文、webhookSent（つながらない先で false）、国会の 400、attribute の enum。

外への要求: なし（webhook は手元の受け口）。

### Task 8: 国の情報・search_poi

対象のファイル: `src/services/country_intel/`（region.ts・social_posts.ts・report.ts など）、`src/mcp/tools_intel.ts`、`src/routes/` の国の情報のルート、`src/mcp/tools_disaster.ts`（search_poi の説明だけ）、`src/types.ts`、README。research_country_context・get_country_context の定義（outputSchema）はすでに非常に長いので、説明を足すときは最小限にする。

1. **research_country_context の region:** 英語名と ISO コードだけを解決し、例の「台湾」も「日本」「韓国」も解決できない（country_intel/region.ts:61-83）。`new Intl.DisplayNames(['ja'], { type: 'region' })` で ISO コードから日本語の国名を作って引く（国名の表を持たない）。「アメリカ」のように正式名（アメリカ合衆国）の先頭だけの入力の扱いは、誤って別の国に当たらない範囲で決める。Bun で TW・JP・KR・US が「台湾」「日本」「韓国」「アメリカ合衆国」になることを確かめてある。
2. **social.platforms:** queries に書いたほかの SNS も検索する（social_posts.ts:28-38）。platforms を指定したら、queries の SNS も platforms で絞る。
3. **social:** `includeSocial=true` が無いと失敗する（report.ts:304）。social を渡したら includeSocial を true とみなす。
4. **get_country_context_evidence の evidenceIds:** その報告に無い ID を黙って落とし、limit を超えた分は nextCursor 無しで切り、cursor を読まない。見つからない ID を応答で返し（例 `missingIds`）、limit を超えたら nextCursor を付け、cursor で続きを返す。
5. **説明:**
   - research_country_context の topics: ニュース検索の分野語（5 分野）にだけ効き、証拠・節は絞らない。period: イベントの時間の範囲にだけ効く（ニュース検索は 7 日で固定）。social: 上の 3 のとおり。
   - get_country_context_evidence: REST は `ids`（カンマ区切り）、MCP は `evidenceIds`（配列）と名前が違うことを書く。
   - search_poi: REST の説明にある「bbox は center/radius より優先」「radiusMeters は bbox 指定時は無視」を MCP の説明にも書く（tools_disaster.ts:108-112、types.ts:811-813）。

テスト: 日本語の国名、platforms の絞り込み、social だけの指定、evidenceIds の missingIds・nextCursor・cursor。外の取得は既存のテストの差し替えを使う。

外への要求: なし。

### Task 9: 全体の確認と版

1. `bun run gen:client` で `client/` を作り直し、差分を確かめてコミットする。
2. 消した引数（check_cpsc_certificate の productCategory・description、check_fda_regulated の productDescription、track_package の originCountry・destinationCountry、watch_register の intervalSeconds、REST の news の page・tracking の verbose・browser の本文の ownerToken）が、README・instructions・docs・client に残っていないかを grep で確かめ、残りを直す。
3. `bun run typecheck`・`bun run lint`・`bun run schema:notation` を通す。
4. 版を 4.1.0 にする（package.json と、版を持つほかの場所。`4.0.0` を grep して確かめる）。
5. 全件のテストを、手元の Bun と CI と同じ Bun 1.4.2 の両方で通す。
6. MCP の定義の大きさ（全ツールの定義の合計の字数、最初から見えるツールの字数、instructions の字数）を、origin/main と比べて report に書く。

外への要求: なし。

### Task 10: 警報を気象庁の新しいデータ（r8）に移す

Task 1 の作業中に見つかった。気象庁は 2026 年 5 月下旬に新しい防災気象情報に移り、今のコードが読む `https://www.jma.go.jp/bosai/warning/data/warning/{気象台}.json` は、その頃の発表のまま止まっている（2026-11-06 に 130000 が 2026-05-28、270000 が 2026-05-26 であることを確かめた）。search_disaster_warnings は、数か月前の警報を今の警報として返している。気象庁の警報のページは `https://www.jma.go.jp/bosai/warning/data/r8/{気象台}.json` を読み、こちらは今の発表になっている。

対象のファイル: `src/services/disaster.ts`（警報の部分）、`src/test_fixtures/external_apis.ts`（警報の偽物）、ほかに旧い URL を使う所（`src/services/health.ts` など、grep で確かめる）、`src/mcp/tools_disaster.ts`・`src/types.ts`・README（説明）。Task 1 の地名・番号の解決（市町村・予報区・気象台）はそのまま使う。

**新しい形:** 応答は報の配列で、報ごとに `dataTypeCode`（VPWW55・56・58・59・61 など、種類ごとに分かれている）・`reportDatetime`・`headlineText`・`warning.class10Items`・`warning.class20Items` を持つ。各 item は `areaCode` と `kinds`（`code`・`status`・`additions` など）を持つ。status には「発表」「継続」「解除」「発表警報・注意報はなし」などがある。

**名前と段階:** 気象庁の警報のページ（`https://www.jma.go.jp/bosai/warning/`）のスクリプトは、種類（大雨・土砂災害・氾濫・高潮・暴風・暴風雪・大雪・波浪・雷・融雪・濃霧・乾燥・なだれ・低温・霜・着氷・着雪など）と段階（レベル２ 注意報・レベル３ 警報・レベル４ 危険警報・レベル５ 特別警報。段階が付くのは大雨・土砂災害・氾濫・高潮）を組み合わせて名前を作っている。`code` と種類・段階の対応は、推測せず、このページのスクリプトから取る（取った所を report に書く）。

1. 解決した市町村（class20Items）または予報区（class10Items）の、すべての報の kinds を合わせる。「解除」と「発表警報・注意報はなし」は除き、今出ているもの（発表・継続など）だけを返す。気象台の番号を渡したときは、今の動きと同じく、その気象台の範囲を合わせる。
2. 応答の形は変えない（`specialWarnings`・`warnings`・`advisories`）。レベル５と特別警報は specialWarnings、警報と危険警報は warnings、注意報は advisories に入れる。各項目に、段階のあるものは数字の段階（例 `alertLevel: 4`）を足す。名前は気象庁のページと同じ組み立て（例「大雨危険警報」）にする。
3. `reportTime` は、使った報のうち最も新しい `reportDatetime` にする。
4. 旧い番号の表（`WARNING_CODE_MAP`）は、使われなくなるなら消す。
5. 旧い URL を使う所を、すべて新しい URL に替える。
6. 説明・README に、新しい段階（危険警報・レベル）を書く。

テスト: 実際の r8 の JSON から削った偽物で、市町村・予報区・気象台の 3 つの解決、解除となしの除外、段階の振り分け、reportTime。

外への要求: 気象庁に 10 回まで。
