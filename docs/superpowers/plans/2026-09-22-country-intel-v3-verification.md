# Country Intelligence v3 Verification (2026-09-22)

## Unit
- `bun test src/services/country_intel`: 190 pass / 0 fail (baseline 175 + 15 new).
- `bun test` full: pass +14 vs baseline; failures identical to baseline (65 pre-existing network-dependent live tests).
- Fixed during work: `z.custom` in report schema broke MCP Gemini-compat test; replaced with `EvidenceDetailSchema`.

## Fixture perf (South Korea, stubbed fetch, 10 runs)
- p50 59ms, min 52ms, max 283ms, 28,376 bytes. All 11 providers success (incl. gdelt_export via yauzl, official_web empty success).

## Live (verify container on :13017, new-code bundle, noCache, 30d)
| region | secs | bytes | evidence | keyEvents | direct/related/candidate/unrelated/unknown |
|---|---|---|---|---|
| China | 10.2-10.5 | ~855-867KB | 415 | 6 | 35/0/89/41/250 |
| France | 10.1 | 769KB | 393 | 1 | 12/0/89/42/250 |
| Tuvalu | 10.1 | 717KB | 381 | 0 | 0/0/89/42/250 |
| parallel x3 | 9.3 total | 865/765/712KB | - | - | all HTTP 200 |

- China keyEvents: DOLPHIN-26, SAUDEL-26, Earthquake in China, BAVI-26, Flood x2 (distinct GDACS ids 1104081:19 / 1104123:4, full indicators).
- France: one multi-country drought incl. France. Tuvalu: 0 events + factors_missing (honest).
- gdelt_export success live (53 items, 16 CN direct). GDELT DOC still PROVIDER_TIMEOUT (unresolved upstream).
- Enrichment unavailable in container (no scraper wired); explicit limitation. Yahoo web search returns dict spam for bare country names; contained as candidates.

## Open issues
- GDELT DOC timeout root cause unknown (staged diagnostics added: connect/headers/body/parse).
- Production wiring of article scraper (budget exists, default unwired).

## Article bodies (wired 2026-09-22)
- Default runtime now scrapes via built-in fast-mode scraper (`SORA_INTEL_SCRAPE=off` disables; tests stay hermetic).
- GDELT export rows carry `title_only` details pointing at `SOURCEURL`, so headline-less rows gain bodies.
- Live China re-run: 16.4s, enrichment 11/12 upgraded 1 failed, `extracted_text` 11, body chars 39K -> 86K, fact max 1000 chars (16 truncated+flagged). `article_enrichment_unavailable` gone.
- intel suite: 192 pass / 0 fail.

## Follow-up improvements (2026-09-22, live cn7)
- Candidates limited to region-query prose; unattributed global records are evidence-only (cn: candidates 340 -> 89).
- GDELT DOC: 8s first attempt + one 7d retry, 16s cap; still PROVIDER_TIMEOUT live (endpoint hangs, unresolved upstream). Request time 28.2s -> 18.7s.
- Enrichment ranking: region link, article count, recency. GDELT export rows carry numArticles.
- Scraped headlines resolve into `resolvedTitle` and lead factor text (live: De Beers, Pinglu Canal readable).
- GDACS: API 8s + RSS fallback incl. timeouts, 18s cap (live: recovered, 6 China events).
- intel suite: 197 pass / 0 fail.

## Acquisition strengthening (2026-09-22, live cn8 + social)
- Official seeds (15 domains, 8 countries): China run hits 20 seed-domain evidence items; 66 official-source items; refresh complete; 6.9s.
- GDELT DOC removed from defaults (code + tests kept). Typical response back to ~7s.
- Bluesky request search implemented + unit tested; live public searchPosts returns 403 from server networks (searchActors 200, UA-independent) -> honest provider error + limitation. Authenticated access is future work.
- intel suite: 203 pass / 0 fail.

## Keyless acquisition expansion (2026-09-22, no container, code+unit only)
- Regional RSS: catalog 3 globals + 10 regional feeds (Al Jazeera/DW/France24/CBC/ABC-AU/NDTV/Yonhap/SCMP/Straits-Times/Nikkei-Asia). URLs from prior live probe session (counts 20-103 items); NHK/Kyodo/Xinhua/CNA guesses 404, excluded. Selection is globals + countryCode match, max 6 per request; unknown countries keep globals. Unit tests cover CN selection, unknown-country fallback, 6-cap.
- Official seeds: 15 domains/8 countries -> 37 domains/20 countries (+IT/ES/CA/AU/IN/BR/MX/TH/VN/ID/PH/SG gov + statistics portals). Region attribution unchanged (query+evidence, never domain).
- intel suite: 205 pass / 0 fail (+2 new selection tests). Typecheck via bunx unavailable offline (registry refused); bun test compiles touched modules clean.
- Live re-verify pending (container access down this session): CN/FR/TV re-run + feed fetch confirmation before main merge.


## SNS posting inputs (2026-09-22, code+unit, no live yet)
- New providers: google_news (country-edition RSS, region-derived gl/hl/ceid, max 15), wiki_current (Current Events bullets mentioning region, max 10), gtrends (daily per geo, failure-tolerant). GDELT export adds AvgTone parse + gdelt_media_tone metric (no new fetch).
- Fixed real regression found by tests: pass1 cap 12 dropped wikidata when providers grew 10->13. Cap raised to 16 (code + test expectation).
- intel suite: 213 pass / 0 fail (+8 new). Live verify pending (container down): new hosts + tone metric + 13-provider route before main merge.


## Live check via browser (2026-09-22, container still down)
- Wiki Current Events live: portal day pages need year (Portal:Current events/2026 September 22). Initial year-less title 404s and falls back to search page. Fixed currentEventsPageFor + test. Extractor verified against live-format bullets (CN/FR matched, JP/TV correctly empty).
- Google News RSS + Trends API: not openable via browser tool (reader rejects XML/XSSI-JSON). Endpoint formats are long-standing documented; provider-level run tests added (stub fetch, all three emit items). Live fetch still pending container recovery.
- GDELT AvgTone index 34 confirmed against export 2.1 column spec (GLOBALEVENTID 0 ... NumArticles 33, AvgTone 34).
- intel suite: 216 pass / 0 fail (+3 run-level tests).


## China voice (2026-09-22)
- Collection runs from JP servers, so GFW does not block us. Per-provider CN: GDELT rows+tone, SCMP/Nikkei/Yonhap RSS (SCMP live-verified 50 items), GDACS/USGS/EONET, Wiki bullets, Yahoo site: seeds, WorldBank/Nager all fine.
- Google News gl=CN reachable from JP in principle, live fetch pending. Trends geo=CN exists but mainland data is thin, expect sparse results, tolerant by design.
- New: baidu_hot provider (CN-only). Baidu realtime board live-verified readable without auth: 40+ ranked topics with hot index, includes mourning-grade and scandal topics. Weibo hot search is login/JS-walled, deprioritized.
- intel suite: 219 pass / 0 fail.


## Unconfirmed items follow-up (2026-09-22)
- Baidu JSON API (top.baidu.com/api/board?tab=realtime) live-verified without auth: errno/data.cards[].content[] with query/desc/hotScore/url/hotTag. Provider now JSON-first, HTML fallback. Test uses live-shape fixture.
- Google News RSS search URL scheme confirmed current via 2024-2026 docs and active templates (rss/search?q=&hl=&gl=&ceid=). Item links are Google-internal redirects, so a best-effort publisher-URL decoder was added (single-URL payloads only, ambiguity keeps original; real-payload hit rate pending container).
- Trends dailytrends endpoint format stands; live fetch still pending container recovery (browser tool cannot read XSSI-JSON, sandbox has no egress, podman socket unreachable).
- intel suite: 221 pass / 0 fail.


## Full live verification (2026-09-22, network open, 14 providers)
- China+social: 15.6s, keyEvents 6, evidence 608, details 608, enrichment 10/12. Japan+social: 8.7s, keyEvents 10 (all Japan-attributed quakes/typhoons), evidence 537, enrichment 12/12. Schema v3.
- Provider outcomes live: 12-13 success per run. baidu_hot honest timeout from JP host (API+HTML both time out; works from alternate egress). bluesky honest PROVIDER_HTTP_4XX when social requested. wikidata/worldbank/nager metrics+calendar fine. Tone metric present (CN -2.34 falling, JP +0.16 stable).
- Root cause found and fixed: Yahoo MCP binary returns 429 from this egress, so official_web went 0 items. Added direct-fetch fallback (server-rendered result list, direct publisher URLs). Live: official_web 27-30 items. Google News links are opaque /rss/articles IDs (not decodable protobuf), so evidence now prefers per-item source publisher URLs (live: reuters.com etc.).
- Removed gtrends: dailytrends endpoint retired (404 for all geos incl. US baseline; deprecation confirmed Nov 2024). Deletion only, no replacement; attention coverage stays via news RSS + tone.
- Remaining thin areas (both countries): politics/security/health/polls/social/foreignRelations missing, finance economy/trade and businessActivity zero. Disaster+calendar+attention+tone carry posting judgment; politics surfaces only as unevaluated evidence/candidates.
- intel suite: 218 pass / 0 fail with live network (bun default 5s timeout too short for live-fetch tests; use --timeout 60000).



## Query-targeted Google News + TopHub fallback (2026-09-22, new code, live network)
- google_news now uses the planned pass-1 query (region + request query) with region-name fallback; gl/hl/ceid derivation unchanged, no country tables. Repro tests added first (planned-query URL, TopHub decode/dedupe, mirror fallback, 20s cap).
- 3-country live (30d, includeSocial false, noCache, direct bun run of the new code):
  | run | elapsed | details | google-news | official_web | baidu_hot | keyEvents |
  |---|---|---|---|---|---|---|
  | CN + query 经济 | 17.2s | 601 | 10 (economist.com, merics.org, bloomberg.com) | 27 | error PROVIDER_HTTP_4XX (honest) | 6 disaster-only |
  | FR + query economie | 8.2s | 435 | 13 (tresor.economie.gouv.fr, banque-france.fr, semafor, mediapart) | 27 | n/a (non-CN, empty success) | 1 |
  | TV, no query | 6.1s | 370 | 15 via region-name fallback | 9 | n/a | 0 |
- Query synthesis is generic: FR economy sources prove the benefit is not China-only. Region-matched feeds also fired generically (dw-top + france24-en for FR).
- TopHub mirror (tophub.today/n/Jb0vmloB1G) returned HTTP 200 with ~50 Baidu topics earlier in the session, then flipped to 403 安全验证 (bot challenge for datacenter IPs, same class as Baidu direct captcha/SYN-drop). Stages are API 5s -> HTML 5s -> TopHub 8s with a 20s provider cap so the outer 10s default can no longer cut the chain; the first live run exposed exactly that cut (baidu_hot unavailable at 10.0s) and the cap fixed it. Live mirror rescue is fixture-proven but currently unverifiable from the JP verification network; failures stay honest errors, never fake data.
- Unrelated transient: gdelt_export 4xx on the FR run while the CN run 1 minute earlier succeeded with the same code (58 items). Upstream flakiness, not this change.
- intel suite: 221 pass / 0 fail (218 baseline + 3 new: planned-query URL, TopHub decode/dedupe, mirror fallback incl. 20s cap). Scratch live scripts removed before commit.


## so360 query search for CN (2026-09-22, live-verified)
- Sogou serves a JS antispider page even cookied (SUV/SNUID signing needs JS) -> rejected. s.weibo.com and m.weibo.cn both 302 to passport visitor walls (login cookie needed, against the keyless rule). TopHub Weibo node shares the 403 gating. Weibo routes parked.
- 360 Search works keyless: first 302 sets a cookie, following it with the cookie returns HTTP 200 with SSR results; data-mdurl carries publisher-direct URLs. New CN-only provider so360_search (planned query first, 1 page, max 10, per-fetch 6s, 14s cap). Repro tests first (parse/mdurl-only, planned query URL, cookie redirect, non-CN skip).
- Live CN + query 经济: 16.1s, details 615, so360_search success 7 items in 2.5s (china-cer.com.cn, finance.china.com.cn, sdchina.com with dates/numbers). domestic finance layer restored. baidu_hot still honest 4xx.
- intel suite: 225 pass / 0 fail (221 + 4 new).


## so.com経由のsite:weibo.com (2026-09-23, 不採用)
- 取得自体は成功 (HTTP 200, 228KB, 投稿URL 8件)。だが日付検証で最新が2026年8月20日、他は2022-2024年。遅延は数十分ではなく数週間〜年単位。site:演算も緩く無関係ヒットとプロフィール頁が混入。追跡調査には使えるが投稿判断の材料にならないため不採用。直のso360検索は維持。


## wreq-js native restoration (2026-09-23, intelとは別件)
- 症状: bun実行で毎回 `[http_fetcher] wreq-js native module unavailable` → native fetch退行。原因はlibstdc++.so.6欠落 (cause: ERR_DLOPEN_FAILED)。binding実体は正常でnodeでは読める。
- 復旧: devは~/.bashrcにLD_LIBRARY_PATH追加 (nix-ld lib、fresh login shellで133 profiles確認、http_fetcher経路でexample.com 200確認、指紋chrome_149)。prodはDockerfileにlibstdc++6明示 (chromium依存で実質含有のはずが保証化)。
- テスト: src/wreq_availability.test.ts追加 (profiles>0)。指紋安定テスト既存通過。なおBaidu/Weiboの壁種別には効かないことを確認済み。


## Structured situation fill + mention detection (2026-09-23)
- 原因: situationはクラスタ由来のみで単独証拠が入らず、言及走査自体が不在 (mentionedCountriesは構造化providerのみ設定) のためクエリ検索系295件がcandidate凍結。enrichment後も再判定なし。
- 実装 (非LLM・抽出のみ、スキーマ変更なし): (1) promoteSingleObservations - クラスタ皆無の分野にdirect/related単独を最大5件、eventIdsは作らず単独明示・公式一次優先・新着順。(2) classifyActionTypeをクラスタと共有 (見出しのみ型付け、11の高信号型のみ昇格)。経済語 (economy/经济/経済/貿易/関税/景気/GDP/CPI等) をbusiness_actionに追加 (statementより前)。(3) ICU汎用多言語言及検出 (国別表記ハードコードなし、証拠言語+地域言語+en) を取得時とenrichment後の本文確認に適用。candidateからrelatedへの昇格は本文言及時のみ。
- Live CN+经济 16.1s: economy 12件 (3源泉: global_feeds/so360/official_web、関税協議・入境経済・統計局等)、security・social各1件。FR+economie 12.2s: economy 5件 (仏財務省・仏銀・Insee等背景資料)。単独クラスタは件数欄が正直 (evi:1/indep:1) のためLLM側で重み付け可能。DDG liteは空フォーム、Xinhua ENはRSSなしで不採用。
- intel suite: 237 pass / 0 fail。health/humanitarianは該当型がなく空のまま (正直)。

## weibo_hot provider live-verified
- hotSearch keyless OK with browser UA plus Referer, no-UA bun fetch gets 403. CN-only max30 8s cap fail-open.
- Live CN 30 items in 275ms. Trending only, no keyword search. xianbao timeout parked, m.weibo.cn UID 302 parked.
- intel suite 241 pass 0 fail with timeout 60000.
- intel suite 241 pass 0 fail with timeout 60000.
- 2026-09-23 realtime follow-up: Weibo ranks from realpos with ads dropped and stable topic ids; Google News keeps article links with publisherUrl recorded; GDELT tone direction is unknown without a baseline; pass1 cap 24 with region-applicable selection and explicit omitted providers; new keyless CN providers zhihu_hot/toutiao_hot/wallstreet_live/cctv_news/thepaper_hot plus NewsNow fallback in weibo_hot (defaults 15 to 20 providers); scheduled hot collection with 30-day history, backoff, and report recentContext (topics/reports/sources/limitations). Full suite: 869 pass, 3 pre-existing environmental failures (2 Yahoo live, 1 slow seed test passing with --timeout 60000).
