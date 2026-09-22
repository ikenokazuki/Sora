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

