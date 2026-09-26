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
- [ ] Fail-closed production auth: per-request 401 exists; startup throw
  deliberately not adopted (would break imports/tests). OPEN by decision.
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
- Full suite: 710/714; all 4 failures reproduce on pristine base (live Yahoo/JMA drift, zero branch-caused).
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
