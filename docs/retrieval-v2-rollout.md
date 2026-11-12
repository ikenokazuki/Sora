# Retrieval v2 / Security rollout

## Rollback flags (removed in v5.0.0)

The rollout shipped with two rollback flags and two opt-in experiments.
v5.0.0 removed all four and fixed the behavior below (setting a removed
name only prints a startup warning; see RELEASE_NOTES.md, v5.0.0).

| Was | Fixed behavior since v5.0.0 |
|---|---|
| Native-ranking rollback flag (default on) | Provider order kept for a single SERP; the BM25 global reorder was removed (providerRank still recorded) |
| RRF rollback flag (default on) | Web results merged from two queries are always ordered by weighted RRF |
| Query-union experiment (opt-in, default off) | Removed with its code: candidate queries are tried in order and the first non-empty result wins, plus at most one adaptive rescue |
| X source-isolation experiment (opt-in, default off) | Removed with its code: direct discovery text |

Related settings:

| Setting | Default | Effect |
|---|---|---|
| `SORA_ALLOW_ANONYMOUS` | false (closed) | Anonymous requests rejected on keyed deployments |
| `SORA_AUTH_TRUST_PROXY` | unset | X-Forwarded-For ignored for local checks |

Adaptive scrape is a per-request option
(`adaptiveScrape`, `scrapeBudget`), default off. PRF retrieval (`enablePrf`) was removed in v4.0.0.

## Suggested stages

1. Shipped with the flags at their defaults (the flags are gone since v5.0.0); watch `sora_*` counters and latency.
2. Compare shadow fields (`providerRank` vs reranked order) on live traffic.
3. Expand the golden set (`eval/search_retrieval_cases.json`) toward 100 with human labels.
4. Flip the adaptive default only after A/B evidence (arms A-E in `scripts/eval-search-retrieval.ts`).

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
- Live eval runs must be spaced out; do not re-probe while throttled.
- Re-checked 2026-09-27 09:16 JST (00:16 UTC): single-query probe healthy
  (`live-factual-01`, 8 items, 592ms, adaptive quiet). Ban lifted;
  live suite returns to spaced rotation (`--limit 1-4`, no bulk 12).
  Follow-up `--limit 4` 4/4 healthy (8/9/10/9, adaptive quiet).

## Container verification (2026-09-27)

- Fixed the forbidden `bun install --frozen-lockfile || bun install`
  fallback in `Containerfile` and `Dockerfile` (RFC build rules).
- Built the publish-path image end to end and booted it:
  `/health` 200. Throwaway tag removed afterwards.

## Gate proof (2026-09-27, local replay of CI)

- Workflow YAML parses; `bun install --frozen-lockfile` clean.
- Gate command green: 205 pass / 0 fail
  across the exact 20 files listed in the workflow.

## Open decisions

- MCP tenant scoping relies on Authorization/X-API-Key; unauthenticated use shares `legacy` scope.
- Deliberate fail-open without a key (v2.30.2; no NODE_ENV gating); per-request 401 when a key is configured.
- Weak-evidence cases (`event-timetable-01/03`) correctly report missing evidence instead of fabricating it.
