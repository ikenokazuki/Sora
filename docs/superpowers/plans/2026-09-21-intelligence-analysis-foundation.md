# Intelligence Analysis Foundation — Phase 0 Baseline

> Spec: pasted v1.0「Sora Country Intelligence 非LLM分析基盤 実装指示書」

- base commit: `384d9855d3bd75cb937eaf9f496c17bbbc5dc33a` (ghostfetch/main, release v2.27.0)
- work branch: `feat/intelligence-analysis-foundation` (isolated clone at /home/ikeno/work/sora)
- recorded: 2026-09-21 JST

## Baseline results (production code untouched)

- `bun test src/services/country_intel`: 92 pass / 0 fail (12 files)
- `bun test` (full): running at time of writing — see final commit message / follow-up note
- `bun run build`: pending full-suite completion
- live test: NOT run (excluded from normal suite per spec §21)

## Known baseline facts

- region table is hand-written with 4 entries only (KR, GE, US, US-GA)
- worldbank falls back to `KOR`, nager falls back to `KR` when countryCode is missing
- GDELT doc URL has no timespan; gdelt events URL has no period handling
- GDACS parses the global feed without region filtering
- wikidata marks entity pages as `official` source candidates
- `runProviders()` drops provider identity on flatMap; coverage maps every provider-area to all evidence ids
- pass1/pass2 are planned and executed concurrently (no verified-source feedback loop)
- situation assembly puts all keyEvents into politics
- `computeTemporalMetric` uses raw `(current-median)/max(mad,eps)` clipped to ±6 (not modified z-score)
- no `src/services/intelligence/` module exists yet

## Phase order

P0: geo correctness, region filtering, period correctness, no fallback country.
P1: provenance, coverage correctness, source verification, real two-pass.
P2: situation assembly, metric registry, provider historical observations, baseline, signals.
P3: domain views, default runtime wiring.
