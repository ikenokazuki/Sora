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

- Golden set: 24 web + 8 X deterministic, 30 live-unlabeled (target 100; labeling is human labor).
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
