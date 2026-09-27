# Retrieval v2 Definition of Done audit

Branch: `feat/search-retrieval-p0-p2`. Evidence dated 2026-09-27.
Legend: DONE (code + test), PARTIAL (code, gap noted), OPEN (needs decision/labor).

## Security DoD (§61)

- [x] Authenticated requests bypass public cache (read/write/in-flight).
  Proof: `src/security/scrape_cache_isolation.test.ts`.
- [x] Cookie/session tenant separation with legacy default.
  Anonymous shares the legacy scope (no identity to isolate;
  preserves single-user persisted state).
  Proof: `src/security/tenant_isolation.test.ts` (incl. live jar E2E).
- [x] Cross-origin credentials stripped (auth set per RFC list).
  Proof: `src/http_fetcher_redirect.test.ts`, `src/net/safe_transport.test.ts`.
- [x] Redirect targets revalidated (per-hop validation in legacy path;
  stub-validated redirect tests in safe transport).
- [x] Streaming response cap wired into scrape/image paths.
- [x] Production no-key policy: deliberate fail-open (v2.30.2 integrates
  retrieval-v2 auth: NODE_ENV gating removed because bun build inlines it;
  per-request 401 applies when a key IS configured).
- [x] Browser session ownership + tenant binding + close-path check.
  Proof: `src/browser_session_access.test.ts`.
- [x] MCP activation per-tenant; legacy scope preserved unauthenticated.
  Proof: J/J2 contract tests.
- [x] Failing tests block container publish (hermetic gate + frozen lockfile).

## Retrieval DoD (§62)

- [x] providerRank preserved; single SERP not BM25-reordered (flag-gated).
- [x] X generic reranker removed (deprecated alias only).
- [x] Multi-query RRF with canonical module + formula-consistency test.
- [x] Scrape refill on usable-content basis.
- [x] Provenance visible in verbose diagnostics.

## Deep Search DoD (§63)

- [x] Candidate pool larger than limit; requirements extracted.
- [x] Adaptive waves behind explicit opt-in (default flip pending A/B).
- [x] Sufficiency evaluated; missing requirements drive selection.
- [x] Attempts bounded (budget cap); Web/X policies separated.
- [x] Final rerank uses acquired evidence (weighted coverage, dual anchor).

## Dependency audit (2026-09-27, `bun audit --audit-level=high`)

- fast-uri SSRF/host-confusion chain (via MCP SDK > ajv): FIXED by
  `overrides: { "fast-uri": "^3.1.6" }` (resolved 3.1.8, audit clean).
- extract-zip symlink traversal (via @puppeteer/browsers toolchain):
  ACCEPTED RISK. No fixed 2.x release exists and the package is not
  imported anywhere in `src/` (browser comes from system Chromium);
  the vulnerable extract path is unreachable at runtime.

## Single-flight audit

- `scrapeUrl`: credential-scoped requests bypass in-flight coalescing.
- `x-detail` FxTwitter fetch uses static headers only (no user
  credentials); shared public cache and coalescing by status ID
  are correct there.

## Open labor

- Golden set: 50 deterministic web + 10 inline X + 30 live-unlabeled (target 100; remaining labels are human labor). Offline eval: arms B-E official recall 1.0, A (legacy) 0.96.
- Full suite (post v2.30.4 integration): 1044 pass / 4 skip / 0 fail across 112 files.

## Live throttle re-check (2026-09-27 09:16 JST)

- Yahoo upstream 429 ban lifted. Single-query probe healthy:
  `live-factual-01`, 8 items, 592ms, adaptive quiet.
  Follow-up `--limit 4` all healthy (8/9/10/9, adaptive quiet).
- Hermetic throttle discipline green: `src/services/yahoo_throttle.test.ts` 7 pass.
- `bun run typecheck` clean on branch `feat/search-retrieval-p0-p2` (HEAD `5b2fe51`).
- Live suite returns to spaced rotation only (`--limit 1-4`, no bulk 12);
  adaptive/PRF default flip still waits for A/B evidence.

## v2.30.4 integration (2026-09-28)

- Merged onto `origin/main` (`ddc79b2`, v2.30.4). Conflicts resolved:
  `src/auth.ts` (fail-open kept, NODE_ENV 401 dropped per v2.30.2),
  `src/http_fetcher.ts` (tenantId + parentSignal kept; social callers updated),
  `src/mcp.ts` (sessionState + intelResearch kept; stray sessionActivated
  dropped from structured call, added to social calls),
  `src/services/yahoo.ts` (throttle markers + providerErrors/direct-fetch kept),
  `Dockerfile` removed upstream (frozen-only rule lives in `Containerfile`).
- Discipline fixes from integration: breaker short-circuits direct fetch;
  `finish` exempts `throttled` stop from total-failure throw.
- OpenAPI operation count literal updated 63 to 67 (origin endpoint growth,
  all 67 satisfy rich-schema assertions; verified no duplicate operations).
- `tsc --noEmit` carries pre-existing `country_intel` errors identical to
  pristine `origin/main`; the merge adds zero new type errors.
- `registerStructuredTool` unified with per-session activation (J2 extended:
  structured `get_country_context` isolation incl. reconnect and late-joiner).

## Yahoo Provider Pressure (spec sections 3-17)

- [x] Provider controller
  - implementation: `src/retrieval/provider_pressure.ts`, wired in `src/services/yahoo.ts` (`yahooWebPressure`, web-only)
  - tests: `src/retrieval/provider_pressure.test.ts` (8 pass: AIMD, circuit, half-open, sliding window, levels, budget)
  - commit: `3b12141`
- [x] AIMD
  - implementation: success `-50ms` to floor 150, 429 `x2` to ceiling 5000, initial 400
  - tests: spacing floor/ceiling cases in `provider_pressure.test.ts`
- [x] Retry-After
  - implementation: `YahooProviderError(status, retryAfterMs)`, `parseRetryAfterMs` (seconds + HTTP date)
  - tests: parser cases + structured-429 cooldown in `yahoo_throttle.test.ts`
- [x] Circuit breaker
  - implementation: sliding 30s window, threshold 3, 15s cooldown, half-open single probe
  - tests: open/half-open/close transitions in `provider_pressure.test.ts`
- [x] Pressure-aware budget
  - implementation: `getYahooQueryBudget` (low 3 / medium 2 / high 1), union capped at 2, rescue gated at budget >= 2
  - tests: budget mapping + union bound assertion in `yahoo_query_union.test.ts`
- [x] Partial success
  - implementation: throttled web results carry `partial: true` + `stopReason: 'provider_rate_limited'`; Q0 results kept
  - tests: Q0-success/Q1-429 partial case in `yahoo_search_failure.test.ts`
- [x] No long sleeps
  - implementation: `paceForYahooPressure` capped at 250ms; `canRequest` gates follow-up queries
  - tests: fan-out-stop cases in `yahoo_search_failure.test.ts`

## Ranking (spec sections 22-28, pre-existing implementation)

- [x] Provider rank preservation
  - implementation: `src/services/yahoo.ts` (native ranking default, `SORA_WEB_NATIVE_RANKING` rollback)
  - tests: union/providerRank cases in `src/services/yahoo_query_union.test.ts`
- [x] RRF only for multi-query
  - implementation: `src/retrieval/rrf.ts`, weighted original 1.0 / fallback 0.6
  - tests: `src/services/yahoo_weighted_rrf.test.ts`, `reciprocalRankFusion prefers multi-hit docs`
- [x] Duplicate provenance
  - implementation: `mergeYahooWebQueryBatches` appends `providerRanks` per occurrence
  - tests: `duplicate URL keeps richest snippet` asserts two occurrences

## Completion audit notes (spec sections 19, 48, 55, 69)

- Section 19 variance: web retrieval coverage lives as `assessRetrievalConfidence`
  in `src/services/yahoo.ts`, not a separate `src/retrieval/web_coverage.ts`.
  Behavior (count/coverage/domain-diversity gating of Q1) is proven by
  `adaptive confidence detects weak retrieval` and live evidence (adaptive quiet).
- Section 48: continuous score matrix realized as weighted coverage + dual anchor
  in `rerankByDeepEvidence` (entity 3 / intent 3 / temporal-location 2 / support 1).
- Section 55 gauges (pressure level, spacing, budget as time series) deferred:
  counters are cumulative-only; level and budget ride verbose diagnostics.
- Section 69: buried-answer expansion proven (`expands beyond 12 when answer is buried`,
  stages 12-24-48 in adapter); recall-escalation tie behavior pinned in escalation tests.
- Open for Done: 100-query golden A/B with human labels, section-80 outcome
  measurement, and push.

## Fresh / Stale / SingleFlight (spec sections 30-32, 58-60)

- [x] Execution order fresh cache, singleflight, controller, provider, stale fallback
  - implementation: `searchYahooWeb` wrapper + `src/retrieval/yahoo_cache.ts` (fresh 5m / stale 30m)
  - tests: fresh-hit, stale-fallback, 10-concurrent-coalescing in `yahoo_search_failure.test.ts`
  - commit: `8a32a8a`
- [x] Stale served only on cooldown, open circuit, 429, or upstream errors
  - implementation: stale lookup gated on throttled branches and error-bearing empty results
  - tests: throttled-plus-stale case; genuine-empty stays empty
- [x] Rejected singleflight evicted, retryable
  - tests: `src/cache_singleflight.test.ts` (3 pass)
- [x] Metrics
  - implementation: `yahoo_request_total`, `yahoo_429_total`, `yahoo_circuit_open_total`,
    `yahoo_cache_hit_total`, `yahoo_stale_hit_total`, `yahoo_singleflight_join_total`
  - deferred: level/spacing gauges (cumulative counters only; level visible in verbose diagnostics)
- [x] Performance gates hold after pressure work
  - benchmark: 200 blocks adaptive p95 8.34ms (< 15ms); 800 blocks adaptive p95 11.94ms (< 40ms)
  - bench: `scripts/bench-evidence-extraction.ts` (2026-09-28)
- [x] Live spot check post-change
  - evidence: `eval/results/live-sample-20260928.json` (4/4 healthy, 8/9/10/9 items, 0 throttled, adaptive quiet)
- [x] Live A/B pilot for completion criteria (section 80)
  - evidence: `eval/results/live-ab-20260928.json` (2 queries, arms A/B/C; native keeps official tops, legacy prefers third-party; adaptive quiet, 0 throttled)
  - pending: full 100-query golden A/B with human labels before flipping adaptive/PRF defaults

## Query Scrape (spec sections 40-46)

- [x] Requirement normalization
  - implementation: `src/retrieval/requirements.ts` (entity/intent/support terms + temporal intent, LLM-free)
  - tests: `src/retrieval/requirements.test.ts`
- [x] Answer-bearing
  - implementation: `src/retrieval/answerability.ts` (price/weight/date/time/version value patterns)
  - tests: answer-bearing cases in `src/retrieval/answerability.test.ts`
- [x] Mention/Answer split
  - implementation: `FacetEvidence` mentioned/answered/answeredWithEntity + `EvidenceCoverage`
  - tests: sections 52-53, 78-80 cases in `answerability.test.ts`
- [x] Entity relation
  - implementation: `associationMultiplier` (entity + value proximity), wrong-entity blocks lose
  - tests: section 80 case
- [x] Temporal relevance
  - implementation: `detectCurrentIntent` + `temporalMultiplier` (boost current, penalize old, no exclusion)
  - tests: section 81 case
- [x] AnswerCoverage stop (section 43)
  - implementation: `assessEvidenceSufficiency` requires answerCoverage >= 0.5 for answer-seeking queries
  - tests: mention-only insufficient / priced sufficient in `scraper_selector.test.ts`

## Deep Search (spec sections 35-38)

- [x] Candidate pool larger than output limit
  - implementation: `candidatePoolSize` in `src/scraper.ts` (adaptive: max(budget, limit*2, 10))
- [x] Adaptive scrape
  - implementation: sufficiency-gated spare waves, budget cap, `sora_deep_search_wave_total`
- [x] Failed scrape refill
  - implementation: usable-evidence basis, `selectionReason: 'scrape_refill'`, `sora_scrape_refill_total`
  - tests: gate suite (`scraper_selector.test.ts`, 205-file gate green)
- [x] Extraction escalation / recall path (sections 51-53)
  - implementation: `extractWithEscalation` in `src/rho_select_v2_adapter.ts` (precision first, relaxed recall on weak answers, ties keep precision)
  - tests: `src/rho_select_v2_escalation.test.ts` (5 pass: paths, empty, limits, time-box)
- [x] Browser late escalation (section 52)
  - implementation: `shouldEscalateToBrowser` in `src/scraper.ts`; browser skipped only on demonstrated static answers
  - tests: skip/escalate decision cases in `scraper_selector.test.ts`
  - metrics: `sora_browser_launch_total`, `sora_browser_recall_saved_total`
- [x] Resource guards (section 53)
  - implementation: `ExtractionLimits` (maxBlocks/maxExtractionMs/maxHtmlBytes enforced in adapter; tables/DOM covered upstream by transport cap and table minimization)
  - tests: truncation + time-box cases

## Evidence quality DoD (query-aware scrape RFC)

- [x] Single SERP preserves Yahoo rank; providerRank and retrieval provenance survive the pipeline.
- [x] Multi-query union uses weighted RRF (original 1.0, fallback/rescue 0.6); fallback-only tops cannot drift past original mid-ranks.
  Proof: src/services/yahoo_weighted_rrf.test.ts.
- [x] Requirement normalization input; rho-select-v2 remains the canonical optimizer (unmodified core).
- [x] Mention vs answer split with price/weight/date/time/version/wifi value patterns.
  Proof: src/retrieval/answerability.test.ts (RFC sections 78-79 cases).
- [x] Entity association (same-sentence entity + facet + value); wrong-entity blocks lose to correct ones.
  Proof: src/retrieval/answerability.test.ts (section 80 case).
- [x] Table-row (1.8x) and definition key-value (1.4x) structural scoring.
  Proof: src/retrieval/answerability.test.ts (section 83 case).
- [x] Temporal relevance: current-intent boost, old-year/old-marker penalty (no exclusion).
  Proof: src/retrieval/answerability.test.ts (section 81 case, years relative to current year).
- [x] Mention/answer coverage diagnostics (mentionCoverage, answerCoverage, answered/missing requirements) on selected evidence.
  Proof: src/retrieval/answerability.test.ts (sections 52-53 case).
- [x] Adaptive candidate expansion 12-24-48 with full-set fallback, opt-out, and expansion reporting.
  Proof: src/retrieval/answerability.test.ts.
- [x] CPU-only, no models; performance gates measured on dev box (bun, 20 runs after warmup, total extraction incl. optimizer):
  200 blocks adaptive p95 10.60ms (gate under 15ms); 800 blocks adaptive p95 13.80ms (gate under 40ms).
  Bench: scripts/bench-evidence-extraction.ts.
- [x] Upstream rate discipline: shared call gate, process-local breaker with cooldown, no fan-out after 429, throttled markers.
  Proof: src/services/yahoo_throttle.test.ts.
