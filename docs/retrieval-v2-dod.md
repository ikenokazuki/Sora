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

## Open labor

- Golden set: 18 web + 3 X deterministic, 12 live-unlabeled (target 100).
- Full suite: 710/714; all 4 failures reproduce on pristine base (live Yahoo/JMA drift, zero branch-caused).
