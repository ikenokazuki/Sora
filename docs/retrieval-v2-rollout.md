# Retrieval v2 / Security rollout

## Rollback flags (default: v2 behavior)

| Flag | Default | Legacy when `false` |
|---|---|---|
| `SORA_WEB_NATIVE_RANKING` | true | Single-SERP BM25 global reorder (providerRank still recorded for shadow compare) |
| `SORA_RRF_ENABLED` | true | First-wins dedup without RRF ordering |
| `SORA_WEB_QUERY_UNION` | false (opt-in) | Sequential first-nonempty fallback |
| `SORA_X_SOURCE_ISOLATION` | false (opt-in) | Direct discovery text |
| `SORA_ALLOW_ANONYMOUS` | false (closed) | Anonymous requests rejected on keyed deployments |
| `TRUST_PROXY` | unset | X-Forwarded-For ignored for local checks |

Adaptive scrape and PRF retrieval are per-request options
(`adaptiveScrape`, `scrapeBudget`, `enablePrf`), default off.

## Suggested stages

1. Ship with flags at defaults; watch `sora_*` counters and latency.
2. Compare shadow fields (`providerRank` vs reranked order) on live traffic.
3. Expand the golden set (`eval/search_retrieval_cases.json`) toward 100 with human labels.
4. Flip adaptive/PRF defaults only after A/B evidence (arms A-E in `scripts/eval-search-retrieval.ts`).

## Live evidence (2026-09-27 sample, eval/results/live-sample-20260927.json)

- 4/4 live queries reorder under legacy BM25; native order kept the
  provider top in each case (official site, official X, organizer
  timetable, digital.go.jp).
- Legacy top-1 twice preferred third-party pages, once a lookalike
  blog over the `.go.jp` official source.
- Adaptive confidence stayed quiet on all healthy first pages,
  so the extra query fires only on weak retrieval.

## Upstream rate discipline (2026-09-27 observation)

- Bulk live evaluation (12 sequential queries plus earlier probes)
  tripped Yahoo upstream HTTP 429 for this IP; single queries had
  succeeded minutes earlier at ~500ms with 8-10 results.
- Raw MCP payload in that state is a 127-char 429 notice, parsed as
  zero items. Empty results under throttle correctly read as weak
  retrieval (adaptive would fire), not as "no evidence".
- Consequences kept: no always-on query union, single adaptive
  rescue at most, PRF retrieval opt-in, per-request budgets.
- Live eval runs must be spaced out; do not re-probe while throttled.
- Re-checked later: single-query probe still 429-empty. Ban persists; live suite stays out of rotation.

## Gate proof (2026-09-27, local replay of CI)

- Workflow YAML parses; `bun install --frozen-lockfile` clean.
- `bun run typecheck` clean; gate command green: 198 pass / 0 fail
  across the exact 20 files listed in the workflow.

## Open decisions

- MCP tenant scoping relies on Authorization/X-API-Key; unauthenticated use shares `legacy` scope.
- `tsc --noEmit` is CI-gated; no startup auth throw (per-request fail-closed instead).
- Weak-evidence cases (`event-timetable-01/03`) correctly report missing evidence instead of fabricating it.
