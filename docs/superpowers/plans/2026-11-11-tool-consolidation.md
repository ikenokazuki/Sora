# ツールの統合（v5.0.0）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP のツール 53 個を、用途ごとに 33 個にまとめる（REST は変えない）。設計は `docs/superpowers/specs/2026-11-11-tool-consolidation-design.md`（承認済み）。

**Architecture:** 各統合ツールは、元のツールが使っていたサービス関数をそのまま呼ぶ。ツール登録（`src/mcp/tools_*.ts`）だけを作り替え、サービスと REST は触らない。モードは入力（`type`・`action`・`include`・URL の種類など）で選び、引数の組み合わせの誤りは、ハンドラの先頭で検査して、正しい使い方を示すエラー（`isError`）にする（`mcpServer.tool` は引数の素の形を受けるので、スキーマ全体の `refine` は使えない）。

**Tech Stack:** Bun、TypeScript、zod、`@modelcontextprotocol/sdk`。テストは `bun test`。

## Global Constraints

- REST（URL・リクエスト・レスポンス）は変えない。MCP のツールだけを統合する。REST のルートは、統合したツールが複数持つ。
- 引数は**平らな**オブジェクト（任意の引数を並べる）。`oneOf`・`anyOf` は使わない（Gemini の関数宣言が受けない）。数の enum は使わない。
- `include` の既定は、いまの応答のまま。応答を膨らませない。
- 旧名の別名は残さない。旧名は、新しいツールの `registerTool` の `keywords` に入れる（`search_tools` で旧名を検索しても新しいツールが見つかるように）。
- コア（`defaultEnabled: true`）14 ツールの `description` の合計は 3500 字未満（`src/llm_contract_sync.test.ts`。この計画の開始時点で 3499 字）。初期の tools/list の合計は 30000 字未満（開始時点で 22,957 字）。コアのツールの説明を長くするときは、同じ作業の中で、意味を変えずに他のコアの説明を縮める。説明の決まりのテスト（先頭が「【」、「必須・公式・直結・速報」のどれかを含む）は保つ。新しいツールは遅延読み込み（コアにしない）。ただし、旧ツールがコアだった統合先は、コアのまま。
- `src/mcp/instructions.ts` の本文は 9000 字以内（`src/llm_contract_sync.test.ts`。Task 2 の終わりで 8972 字で、余白は 28 字）。名前を書き換えるときに、字数を増やさない（増えるなら、同じ作業の中で他を縮める）。
- **`onlyForMode` に、引数の既定値の一覧（`defaults`）を渡す**（Task 2b で足す）。モード専用の引数を、**既定値と同じ値**で指定した呼び出し（LLM が、JSON Schema の `default` をそのまま入れる場合）は、「指定された」と数えず、断らない。既定値と違う値だけを、モード違いとして断る。
- 統合したツールは、元のツールが属していたモジュールに置く（`registerTool` の第 5 引数）。モジュールが無効なら、そのツールは出ない。
- 遅延読み込みのツールは `default.<名前>` の別名（`registerTool` が自動で作る）を持つ。新しい名前でも同じ。
- **型つきクライアント（`client/`）の関数名は変えない。** 統合したツールの `REST_MAP` の各ルートに、そのルートに当たる**旧いツール**の名前（camelCase。例: `scrapeBatch`・`mapSite`・`fetchXPost`・`searchSong`・`watchRegister`・`searchImage`）を `fn` として持たせる（`RestRoute.fn`。Task 1b で追加済み）。新しいツール名が旧いツールの名前と同じで、1 つ目のルートがその旧ツールのものなら、`fn` は省略できる（1 つ目のルートは、camelCase のツール名になる）。1 つ目のルートが別の旧ツールのもの（例: `watch` の 1 つ目は `watchRegister`、`search_media` の 1 つ目は `searchImage`）なら、`fn` を付ける。
- **モード専用の引数の検査は `onlyForMode`**（Task 1b で足す。モードは、ハンドラが入力から決めた文字列を渡す）。引数の値を読む `onlyWith` は、モードが引数の値で決まる場合だけに使う。
- **モード専用の引数に、zod の `.default()` を付けない。** ハンドラは、既定値が入った引数を「指定された」と見てしまい、他のモードで常にエラーになる。既存の決まりのとおり、`.meta({ default: … })` で説明にだけ既定を出し、ハンドラの中で既定を補う（例: `scrape` の `fullPage`（`.optional().default(true)`）、`fetch_social_post` の `commentLimit`（`.optional().default(10)`））。
- 統合前の応答の中身は、モードごとに保つ（欄の名前・値）。モードを示す `mode` 欄を足してよい。複数の種類を返す統合（`get_disaster_info`）は、種類ごとの節にする。
- Sora は OSS。個人のサービス名（oshiframe・LibreChat・n8n・idol-radar・hts-tiny・ikeno など）をコード・文書・コミットに書かない。例の値は架空のものを使う。
- コミットは `git -c user.name=ikenokazuki -c user.email=51224867+ikenokazuki@users.noreply.github.com commit` で、Co-Authored-By や Generated-with の行を付けない。コミットの本文に「skip ci」と書かない。`git stash`（引数なし）・`git checkout .`・`git clean` を使わない。`rm` は `"${VAR:?}"` の形で、確かめてから。
- 手元でテストを回す条件は、`env -u HTTPS_PROXY -u HTTP_PROXY bun test --timeout 60000`。全件（約 3,000 件・約 6 分）は、前景で回さず、`run_in_background` で。Chromium は nix のもの（`CHROME_PATH`）。
- 各作業の終わりに、次が全部通ること: `bun run typecheck`、`bun run lint`、`bun run schema:notation`、`bun run gen:client`（実行後に `client/` の差分がコミット済みと同じ）、全体テスト。旧い名前が、統合した作業の範囲の `src/`・`scripts/`・README・`docs/engines/`・`glama.json`・`client/` に残らない（`RELEASE_NOTES.md`・`docs/superpowers/`・評価の基準線 `docs/evaluations/tool-selection/baseline-v4.json`・`prompts.json` は除く）。

## 各作業の共通の手順

どの統合の作業も、次の順で進める（各作業の本文は、統合の中身だけを書く）。

- [ ] **A. 洗い出し:** 旧いツール名の全参照を `grep -rn` で一覧にする（`src/`・`scripts/`・README・`docs/engines/`・`glama.json`。テスト・`CANONICAL_TOOLS`・`REST_MAP`・`scripts/tool-health/catalog.ts` の検査・`src/mcp/instructions.ts`・`src/llm_contract_sync.test.ts` の名前の検査を含む）。
- [ ] **B. 新しいツールの検査（テスト）を先に書く:** モードごとの正しい呼び出し、誤った組み合わせ（両方指定・どちらも無し・そのモードに無い引数）が、正しい使い方のエラーになること。旧ツールのテストは、新しいツール名で呼ぶ形に直す（応答の中身の検査は残す）。
- [ ] **C. 実装:** `tools_*.ts` に新しいツールを登録し（元のサービス関数を呼ぶ）、旧ツールの登録を消す。`keywords` に旧名を入れる。
- [ ] **D. 周辺の更新:** `CANONICAL_TOOLS`・`REST_MAP`（複数のルート）・`scripts/tool-health/catalog.ts` の検査・`src/mcp/instructions.ts`・README の表と節・`docs/engines/` の記事・`glama.json`・`schema:notation` の許可リスト（`scripts/schema-notation/allowlist.ts`）。README のツール数の記述（`grep -n '全 [0-9]* ツール\|遅延' README.md` で全箇所。取りこぼしやすい）を、新しい数にする。
- [ ] **E. 検査:** 上の「各作業の終わりに」のとおり。`bun run gen:client` で `client/` を作り直す。さらに、**作業の前後で、`grep -h '^export function' client/servers/sora/*.ts | sort` を比べ、関数が 1 つも消えていないこと**を確かめる（`gen:client` の差分の検査は、関数名の変更に気づけない。旧いツールの関数名は、`fn` で保つ）。
- [ ] **F. コミット:** 作業ごとに、意味のまとまりでコミット（コミットの題は日本語、`feat(mcp)!:` の形。本文に、統合した旧ツールと新ツールの対応を書く）。

---

### Task 1: 土台（REST_MAP の複数経路・引数の検査の共通部分）

**Files:**
- Modify: `scripts/tool-health/catalog.ts`（`REST_MAP` の型と読み手）、`scripts/gen-client/index.ts`、`scripts/schema-notation/scan.ts`、`src/tool_contracts.test.ts`、`scripts/tool-health/run.ts`（`REST_MAP` を読む箇所があれば）
- Create: `src/mcp/args.ts`、`src/mcp/args.test.ts`
- Modify（説明の余白）: コアのツールの説明（`src/mcp/tools_*.ts`）

**Interfaces:**
- Produces: `REST_MAP: Record<string, RestRoute | RestRoute[] | null>`。配列は、そのツールが複数の REST ルートを持つこと（モードごと）。`restRoutesOf(tool): RestRoute[]`（`null` は `[]`、1 つは 1 要素の配列）を `scripts/tool-health/catalog.ts` から export。
- Produces（`src/mcp/args.ts`）: 
  - `exactlyOne(args: Record<string, unknown>, keys: string[], usage: string): string | undefined` — キーのうち、値が空でない（`undefined`・`null`・空文字・空配列でない）ものが、ちょうど 1 つでなければ、`usage` を添えたエラーの文を返す。
  - `onlyWith(args, key: string, allowedWhen: string, keys: string[]): string | undefined` — `keys` のどれかが指定されているのに `allowedWhen` の条件に当たらないときの、エラーの文。
  - `usageError(message: string): { isError: true; content: [{ type: 'text'; text: string }] }` — MCP のエラー応答。文面は「入力の誤り: …」の形。
- Consumes: なし。

`schema:notation` の対の検査（`pair_mismatch`）は、MCP の 1 つの引数を、そのツールのルートのうち同じ名前の引数を持つ最初のルートの引数と比べる。どのルートにも無い MCP の引数は、比べない（モードにだけ効く引数）。許可リストの書式（`'pair_mismatch <tool> <param>'`）は変えない。

- [ ] **Step 1: `args.ts` のテストを書く**（上の 3 つの関数。空・未指定・複数指定・どれも無し）。落ちることを確かめる。
- [ ] **Step 2: `args.ts` を実装し、通す。**
- [ ] **Step 3: `REST_MAP` の型を配列を許す形に直し、読み手（`gen-client`・`schema-notation/scan.ts`・`tool_contracts.test.ts`・`run.ts`）を `restRoutesOf` 経由にする。** この時点では、どのツールも 1 つのルートのままで、全体の挙動が変わらないこと（`gen:client` の差分が出ない）を確かめる。`scan.ts` と `scan.test.ts` に、複数ルートの対のテストを足す。
- [ ] **Step 4: コアのツールの説明に余白を作る。** 開始時点で合計 3499 字のため、後の作業でコアの説明を足せない。意味を変えずに、冗長な言い回しを縮めて、合計を **3300 字以下**にする（対象は、`search_social_posts`（397）・`search_deep`（341）・`check_product_compliance`（342）・`scrape`（250）など、長いもの）。縮めた説明が、説明の決まりのテスト・`src/llm_contract_sync.test.ts`・`client/` の生成に通ること。
- [ ] **Step 5: 全体の検査と、コミット（`refactor(mcp):` と `docs(mcp):`）。**

### Task 2: scrape・crawl_site

**Files:**
- Modify: `src/mcp/tools_web.ts`、`scripts/tool-health/catalog.ts`、README、`docs/engines/`（該当があれば）、テスト（`src/mcp_tool_params.test.ts`・`src/llm_contract_sync.test.ts`・`src/crawl_map_params.test.ts`・`src/scrape_input_paths.test.ts`・`src/index.test.ts` ほか、洗い出しで見つかったもの）

**Interfaces:**
- `scrape`（コア。`scrape_batch` を統合）: `url`（string）と `urls`（string の配列。上限は旧 `scrape_batch` と同じ）の**どちらか 1 つ**。`concurrency`・`webhookUrl` は `urls` のときだけ。`fullPage`・`keepDataImages` は `url` のときだけ。ほかの引数は、旧 `scrape` と旧 `scrape_batch` に共通のものと、それぞれにだけあるものの和。`url` のときの応答は旧 `scrape`、`urls` のときの応答は旧 `scrape_batch` と同じ。REST: `POST /scrape`・`POST /scrape/batch`。`REST_MAP` は `scrape: [{ method: 'POST', path: '/scrape' }, { method: 'POST', path: '/scrape/batch', fn: 'scrapeBatch' }]`（1 つ目が主。`client/` の関数名は `scrape`・`scrapeBatch` のまま）。モードは `urls` の有無（`onlyForMode` に `'batch'`/`'single'` を渡す）。`fullPage` は `.default(true)` を外し、`.meta({ default: true })` + ハンドラで補う。
- `crawl_site`（`map_site` を統合）: `listOnly: true` のとき URL の一覧だけ（`limit`・`since`・`until` が効き、`maxPages`・`maxChars`・`includePatterns` など巡回の引数は指定できない）。省略か false のとき旧 `crawl_site` と同じ（`limit`・`since`・`until` は指定できない）。応答は、それぞれ旧 `map_site`・旧 `crawl_site`。REST: `POST /crawl`・`POST /map`（`/crawl/stream` は MCP に無いのでそのまま）。`REST_MAP` は `crawl_site: [{ method: 'POST', path: '/crawl' }, { method: 'POST', path: '/map', fn: 'mapSite' }]`。モードは `listOnly`（真偽値。`onlyForMode` に `'list'`/`'crawl'` を渡す）。
- 旧 `scrape_batch` の `webhookUrl` の検査（URL の形、1 回だけ・整形後の結果を送る）は、`urls` のときに保つ。

- [ ] 共通の手順（A〜F）。特に、`src/crawl_map_params.test.ts` の `scrape_batch`・`map_site` の検査は、新しい名前と引数で保つ。`src/mcp_tool_params.test.ts` の引数の一覧を、新しい和の一覧に直す。

### Task 3: fetch_social_post・search_media・search_keywords

**Files:**
- Modify: `src/mcp/tools_web.ts`（`fetch_social_post`）、`src/mcp/tools_yahoo.ts`（`search_image`・`search_video`・`search_news`・`suggest_keywords`・`search_trend`・`fetch_x_post`）、`scripts/tool-health/catalog.ts`、README、`docs/`、テスト

**Interfaces:**
- `fetch_social_post`（コア。`fetch_x_post` を統合）: `url`（X・Weibo・Threads・Instagram・Facebook）、`statusId`（X だけ）、`commentLimit`。URL か `statusId` が X のものなら、旧 `fetch_x_post` の経路（`xDetailProvider` のテスト用の差し替えは保つ）、それ以外は旧 `fetch_social_post` の経路。`url` か `statusId` のどちらかは必須。`commentLimit` は X 以外のときだけ。応答は、それぞれ旧ツールと同じ。REST: `POST /social/fetch`・`POST /realtime/post`。
- `search_media`（`search_image`・`search_video`・`search_news` を統合。モジュール `yahoo`）: `type`（`image` `video` `news`、必須）、`query`、`limit`、`page`（news には無い）。動画だけの `transcripts`・`transcriptChars`・`updated`・`platform` は `type: video` のときだけ。応答は、それぞれ旧ツールと同じ。REST: `POST /search/image`・`/search/video`・`/search/news`。
- `search_keywords`（`suggest_keywords`・`search_trend` を統合）: `query` あり＝サジェスト（`limit` が効く）、なし＝急上昇トレンド（`limit` が効く）。応答は、それぞれ旧ツールと同じ。REST: `POST /search/suggest`・`/search/trend`。
- **作業の最初に（Task 2b の持ち越し）:** `onlyForMode` の `defaults` の比較で、配列の既定値（例: `crawl_site` の `formats: ["markdown"]`）は、`JSON.stringify` で比べる（いまは `===` だけで、`listOnly: true` と `formats: ["markdown"]` が断られる）。`args.test.ts` に、配列の既定値と同じ値は通り、違う配列は断るテストを足す（比べるのは、`defaults` にそのキーがあるときだけ。`crawl_site` の `defaults` に `formats: ['markdown']` を足し、`mcp_tool_params.test.ts` の「既定値がスキーマと食い違わない」検査の一覧にも足す。「対象外」の注記は消す）。**エラー文の「とき だけ」の空白を直す:** `src/mcp/args.ts` の定型文を `${set.join(', ')} は ${allowedModes.join(' か ')}だけ指定できます（いま: ${mode}）。${usage}` にし、期待の文（`args.test.ts`・`mcp_tool_params.test.ts` の約 12 か所）を合わせる。既定値を `.meta({ default })` と `defaults` の 2 か所に書く重複は、スキーマの形（shape）の定数から `defaults` を作れるなら、そうして減らしてよい（無理にはしない）。
- `search_media` の説明は、旧 3 ツールの検索語（画像・動画・ニュース・YouTube・TikTok・Yahoo）を残す。
- `fetch_social_post` の `commentLimit` は `.optional().default(10)` を外し、`.meta({ default: 10 })` + ハンドラで補う（非 X のときだけ指定できる引数のため。`onlyForMode` に `'x'`/`'social'` を渡す）。`REST_MAP`: `fetch_social_post: [{ POST /social/fetch }, { POST /realtime/post, fn: 'fetchXPost' }]`、`search_media: [{ POST /search/image, fn: 'searchImage' }, { POST /search/video, fn: 'searchVideo' }, { POST /search/news, fn: 'searchNews' }]`、`search_keywords: [{ POST /search/suggest, fn: 'suggestKeywords' }, { POST /search/trend, fn: 'searchTrend' }]`。

- [ ] 共通の手順（A〜F）。

### Task 4: lookup_address

**Files:**
- Modify: `src/mcp/tools_disaster.ts`、`src/services/address_*.ts`（呼び出しだけ。サービスの挙動は変えない）、`docs/engines/address-normalization.md`・`postal-code.md`・`reverse-geocoding.md`、`scripts/tool-health/catalog.ts`、テスト

**Interfaces:**
- `lookup_address`（`search_postal_code`・`normalize_address`・`reverse_geocode` を統合。モジュール `disaster`）: 引数は旧 3 ツールの和（`address` `zipcode` `lat` `lon` `level` `compareAddress` `maxDistanceMeters` ほか）。モードは入力で選ぶ。
  - `lat` と `lon` の両方がある → 逆引き（旧 `reverse_geocode`。`maxDistanceMeters` が効く）。`address` や `zipcode` と同時には指定できない。
  - `address` がある → 正規化（旧 `normalize_address`。`zipcode`・`level`・`compareAddress`・`lat`/`lon`（座標近傍の判定用）は旧 `normalize_address` のとおり）。旧 `search_postal_code` の「住所から郵便番号」は、正規化の応答の郵便番号で足りる。
  - `zipcode` だけ → 郵便番号の候補（旧 `search_postal_code`）。
  - どれも無ければエラー。
  応答は、それぞれ旧ツールと同じ。`mode` 欄（`reverse` `normalize` `postal`）を足す。REST: `POST /geo/reverse`・`POST /geo/address/normalize`（GET も）・`POST /geo/postal-code`（GET も）。
- 旧 `normalize_address` が、`lat`・`lon` を「座標近傍の判定」に使う（`address` とともに）ことに注意。`lat`＋`lon` だけなら逆引き、`address`＋`lat`＋`lon` なら正規化＋近傍判定。

- **作業の最初に（Task 3 の持ち越し。小さな整理。別コミット `test(mcp):`）:** (a) `src/mcp_tool_params.test.ts` の、ツールごとの引数の一覧を固定する検査（`scrape`・`crawl_site`・`search_deep` がある）に、`fetch_social_post`・`search_media`・`search_keywords` を足す（引数の和を守る）。(b) `search_media` の `type: news` で `page: 1` を指定しても断らない（`page` に既定値は無いが、`news` には `page` が無いので、`1` は何も指定していないのと同じ。`onlyForMode` の `defaults` に `page: 1` を、`news` のときだけ渡す）。違う値（`page: 2`）は断る。(c) `tools_web.ts`・`tools_yahoo.ts` の、同じ数の繰り返し（`commentLimit` の 10、サジェストの上限 20）を、名前付きの定数 1 つにする。
- [ ] 共通の手順（A〜F）。旧 3 ツールのテスト（正規化の level 8・地番・ローマ字の町名・郵便番号の事業所・逆引きの距離）は、新しい名前で保つ。

### Task 5: get_place_info（標高）

**Files:**
- Modify: `src/mcp/tools_disaster.ts`、`docs/engines/coordinate-resolution.md`、`docs/superpowers/specs/2026-11-11-area-safety-design.md`（名前を `get_place_info` に直す。防災の設計の中身は変えない）、README、テスト

**Interfaces:**
- `get_place_info`（`get_elevation` を置き換える。モジュール `disaster`）: `address` か `lat`＋`lon`、`noCache`、`include`（配列。値は今は `elevation` だけ。既定 `['elevation']`。後の作業で `hazards` `shelters` `seismic` を足す）。
- 応答（MCP だけ。REST の `/geo/elevation` は変えない）: `{ location: { query?, address?, matchedTitle?, lat, lon, geocodingSource?, geocodingAttribution?, needsVerification? }, elevation: { elevationMeters, dataAccuracy?, formatted, source }, include: ['elevation'] }`。旧 `get_elevation` の欄を、`location` と `elevation` に分ける。
- `include` に未対応の値が来たら、使える値を示すエラー。

- [ ] 共通の手順（A〜F）。

### Task 6: get_disaster_info

**Files:**
- Modify: `src/mcp/tools_disaster.ts`、`src/mcp/tools_life.ts`（必要なら）、`docs/engines/weather-place-names.md`、`scripts/tool-health/catalog.ts`、README、テスト（`src/services/disaster.test.ts`・`src/schema_enums.test.ts`・`src/llm_contract_sync.test.ts`・`src/index.test.ts` ほか）

**Interfaces:**
- `get_disaster_info`（コア。`search_disaster_warnings`・`search_earthquake` を統合。モジュール `disaster`）: `city`・`areaCode`（旧 `search_disaster_warnings`）、`limit`・`minIntensity`（旧 `search_earthquake`。`minIntensity` は MCP では 10〜70 の範囲だけを出し、値は refine で確かめる既存の決まりを保つ）、`include`（配列。値は `warnings` `earthquake`。後の作業で足す）。
- `include` の既定: `city` か `areaCode` があれば `['warnings']`、なければ `['earthquake']`。両方の種類を頼むときは `include: ['warnings','earthquake']`。`city` と `areaCode` の両方は旧 `search_disaster_warnings` のとおり。`limit`・`minIntensity` は `earthquake` を返すときだけ。`warnings` には `city` か `areaCode` が必須（無ければ使い方を示すエラー）。
- 応答: `{ include: [...], warnings?: <旧 search_disaster_warnings の応答>, earthquakes?: <旧 search_earthquake の応答: { count, earthquakes: [...] }> }`。
- 説明は、旧 2 ツールの合計より短くして、コアの説明の合計を減らす（警報・地震・津波・特別警報・震度を語に残す）。
- REST: `POST /disaster/warnings`・`POST /disaster/earthquake`。

- [ ] 共通の手順（A〜F）。

### Task 7: search_laws・search_music・watch

**Files:**
- Modify: `src/mcp/tools_gov.ts`、`src/mcp/tools_music.ts`、`src/mcp/tools_watch.ts`、`scripts/tool-health/catalog.ts`、README、`docs/`、テスト

**Interfaces:**
- `search_laws`（コア。`get_law_text` を統合）: `keyword`（検索）か `lawId`（条文の全文）の**どちらか 1 つ**。`limit` は `keyword` のときだけ。応答は旧ツールと同じ。REST: `POST /gov/laws`・`POST /gov/law-text`（`REST_MAP` は 2 経路）。
- `search_music`（`search_song`・`search_artist` を統合）: 旧 `search_music` の引数のまま（`entity`: `song` `album` `musicArtist`）。旧 `search_song`・`search_artist` を消し、説明の「search_song / search_artist を推奨」の文を直す。REST: `POST /search/music`・`POST /search/song`・`POST /search/artist`（REST は残す）。`REST_MAP`: `search_music: [{ POST /search/music }, { POST /search/song, fn: 'searchSong' }, { POST /search/artist, fn: 'searchArtist' }]`。
- `watch`（`watch_register`・`watch_check`・`watch_list`・`watch_delete` を統合）: `action`（`register` `check` `list` `delete`、必須）。`register`: `url`（必須）・`title`・`selector`・`webhookUrl`。`check`: `id`（省略で全件）。`list`: 引数なし。`delete`: `id`（必須）。モードに無い引数はエラー。応答は、それぞれ旧ツールと同じ。REST: `POST /watch/register`・`POST /watch/check`・`GET /watch/list`・`DELETE /watch/:id`（`REST_MAP` は 4 経路）。

- [ ] 共通の手順（A〜F）。

### Task 8: lookup_hts・check_regulations

**Files:**
- Modify: `src/mcp/tools_trade.ts`、`docs/engines/hts-prediction.md`・`cpsc-certificate.md`・`fda-regulated.md`・`product-compliance.md`・`gcc-certificate.md`、`scripts/tool-health/catalog.ts`、README、テスト（`src/services/trade*.test.ts` ほか）

**Interfaces:**
- `lookup_hts`（`predict_hts_code`・`verify_hts_code` を統合。モジュール `trade`）: `htsCode` があれば照合（旧 `verify_hts_code`。`description` を旧 `productDescription` の代わりに使う）、なければ商品の説明から推測（旧 `predict_hts_code`: `productName`・`description`・`material`・`productCategory`・`targetAge`・`foodContact`・`hasBattery`）。推測のときだけの引数を、`htsCode` と同時に指定したらエラー。応答は、それぞれ旧ツールと同じ。`mode`（`verify` `predict`）を足す。REST: `POST /trade/hts-verify`・`POST /trade/hts-predict`。
- `check_regulations`（`check_cpsc_certificate`・`check_fda_regulated` を統合）: `htsCode`（必須）、`agencies`（`cpsc` `fda` の配列。既定は両方）、CPSC の引数（`targetAge`・`material`・`hasBattery`・`batteryType`・`fabricSurface`・`fabricWeightOzPerSqYd`）、FDA の引数（`foodContact`）。`agencies` に含まれない機関にだけ効く引数（例: `agencies: ['fda']` のときの `batteryType`）は、無視せず、使い方を示すエラーにする。応答: `{ agencies: [...], cpsc?: <旧 check_cpsc_certificate の応答>, fda?: <旧 check_fda_regulated の応答> }`。REST: `POST /trade/cpsc-check`・`POST /trade/fda-check`。
- `check_product_compliance`（コア）・`generate_gcc_certificate` は変えない。

- [ ] 共通の手順（A〜F）。

### Task 9: get_country_context・get_youtube

**Files:**
- Modify: `src/mcp/tools_intel.ts`、`src/mcp/tools_youtube.ts`、`scripts/tool-health/catalog.ts`、README、`docs/engines/country-intelligence.md`・`youtube-transcript-selection.md`、テスト

**Interfaces:**
- `get_country_context`（`get_country_context_evidence`・`get_country_context_updates` を統合）: `contextId`（必須）、`part`（`report`（既定）`evidence` `updates`）。`evidence` のときだけ `evidenceIds`・`cursor`・`limit`、`updates` のときだけ `cursor`。応答は、それぞれ旧ツールと同じ。`research_country_context` は変えない。REST: `GET /intelligence/context/:contextId`（と `/evidence`・`/updates`。`REST_MAP` は 3 経路）。
- `get_youtube`（`get_youtube_transcript`・`get_youtube_channel` を統合）: `url`（動画の URL・動画 ID か、チャンネルの URL・`@ハンドル`・`UC…`）。動画かチャンネルかは、入力の形で判別する（旧 2 ツールの URL の解釈を共通にする）。動画のときだけ `lang`・`fromSec`・`maxChars`、チャンネルのときだけ `limit`。判別できない入力は、使い方を示すエラー。応答は、それぞれ旧ツールと同じ。`mode`（`video` `channel`）を足す。REST: `POST /youtube/transcript`・`POST /youtube/channel`（`REST_MAP` は 2 経路）。

- [ ] 共通の手順（A〜F）。

### Task 10: 仕上げ（説明・文書・版 5.0.0・評価）

**Files:**
- Modify: `src/mcp/instructions.ts`、README（ツールの一覧・節・移行の表）、`docs/engines/README.md`、`glama.json`、`package.json` と版の定数（`SORA_VERSION`）、`RELEASE_NOTES.md`、`docs/evaluations/tool-selection/`（統合後の結果）、`client/`

- [ ] **Step 1: ツールの名前の残りを確かめる。** `grep` で、旧い名前が、README・`docs/engines/`・`glama.json`・`src/mcp/instructions.ts`・`client/` に残っていないこと（`RELEASE_NOTES.md`・設計メモ・計画・基準線は除く）。`src/mcp/instructions.ts` の本文を、新しいツール名で書き直す（初期の tools/list と合わせて 30000 字未満）。
- [ ] **Step 2: README に、移行の表（旧名 → 新名と引数）を足す。** `RELEASE_NOTES.md` に、v5.0.0 の節（破壊的変更: ツールの統合、`search_road_traffic` の `source`（PR #70 が先にマージされていれば）、旧名の `search_tools` での検索）を書く。
- [ ] **Step 3: 版を 5.0.0 にする。** `package.json`・`SORA_VERSION`（grep で全箇所）・OpenAPI の version・`client/` の版。
- [ ] **Step 4: ツール選びの評価を、統合後で測る。** `bun docs/evaluations/tool-selection/snapshot.ts` で新しい定義を書き出し、`run.ts --surface new` を、`claude-haiku-5-5` と `claude-haiku-4-5` で回す（鍵は `~/.config/sora-hl/anthropic_key`。費用は数十円）。結果の要約を `docs/evaluations/tool-selection/results-v5.json` に保存し、README に、基準線との比較の表を足す。合格の目安（同じモデルで基準線より 1 問を超えて下がらない・モードを選ぶ引数の正答率 90% 以上）に届かなければ、原因のツールの説明を直して回し直す。直しきれないものは、その統合を戻すか、報告に残す。
- [ ] **Step 5: 全体の検査と、コミット。** 全体テスト（bun 1.3.3 と、CI と同じ 1.4.2 の両方。手順は記憶の `sora-test-env` のとおり、`npm install --no-save --prefix <scratch>/bunX bun@1.4.2`）。

### Task 11（任意。Task 10 のあと）: LLM に見せるスキーマの飾りを削る

統合では、引数は減らない（282 個の引数の和が残る）ため、ツール定義の大きさは、数ほど減らない（2026-11-11 の実測: 53 ツールで約 6.4 万字。説明 21%、引数の説明 25%、スキーマの構造 54%）。そこで、検証はサーバー側のまま、LLM に見せる `tools/list` の入力スキーマから、飾りを外す。

**Files:**
- Modify: `tools/list` の入力スキーマを作る場所（`src/schema_sanitizer.ts` の `sanitizeJsonSchemaForGemini` と、`tools/list` の応答を作る箇所。調べて決める）、`src/mcp/tool_search.ts`（`search_tools` の `detail=schema` と揃える）、テスト、`docs/evaluations/tool-selection/`（結果）、`client/`（作り直し）

**Interfaces:**
- 外すもの（実測で、全部で約 11% 減）: `default`（約 2.8%）、数や文字数の範囲（`minimum`・`maximum`・`minLength`・`maxLength`・`exclusiveMinimum`・`exclusiveMaximum`・`minItems`・`maxItems`。約 3.7%）、`$schema` と `additionalProperties`（約 4.4%）。
- 残すもの: 型、`enum`、`required`、`description`。既定値や範囲が、引数の説明に書かれていなければ使い方が分からないもの（例: 範囲が説明にしか無い引数）は、**説明に 1 句で書き足してから**外す（説明の字数が、外した字数より少ないものだけ）。
- サーバー側の検証（zod）は、変えない。範囲外の値は、これまでどおりエラーになる。

- [ ] **Step 1: 現状の大きさを測る**（`docs/evaluations/tool-selection/snapshot.ts` の字数。Task 10 の終わりの値）。
- [ ] **Step 2: 飾りを外す層を実装する**（テスト: 外したあとのスキーマに、`default`・範囲・`$schema`・`additionalProperties` が無く、`type`・`enum`・`required`・`description` が残ること。`search_tools` の `detail=schema` と同じ形になること）。
- [ ] **Step 3: ツール選びの評価を回す**（`claude-haiku-5-5` と `claude-haiku-4-5`。Task 10 の結果と比べる）。合格の目安: 正答率が、同じモデルで、1 問を超えて下がらない。モードを選ぶ引数の正答率が 90% 以上。**悪化したら、外すものを減らす（範囲だけ残す、など）か、この作業を取りやめる。**
- [ ] **Step 4: 全体の検査と、コミット**（`feat(mcp):`）。大きさの変化（字数）を、コミットの本文と `RELEASE_NOTES.md` に書く。
