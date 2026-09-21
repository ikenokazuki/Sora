# Intelligence Analysis Foundation — Phase 0 Baseline

> Spec: pasted v1.0「Sora Country Intelligence 非LLM分析基盤 実装指示書」

- base commit: `384d9855d3bd75cb937eaf9f496c17bbbc5dc33a` (ghostfetch/main, release v2.27.0)
- work branch: `feat/intelligence-analysis-foundation` (isolated clone at /home/ikeno/work/sora)
- recorded: 2026-09-21 JST

## Baseline results (production code untouched)

- `bun test src/services/country_intel`: 92 pass / 0 fail (12 files)
- `bun test` (full): implementation complete — 688 pass / 2 fail (690 total).
  Both failures are pre-existing on base 384d985 and unrelated to intel:
  `checkProductCompliance ... Prior Notice` (timeout flake; passes in isolation) and
  `integratedSearch should return 9/6 live information` (live Yahoo index drift; fails on clean main too).
- `bun test src/services/country_intel/ src/services/intelligence/`: 134 pass / 0 fail (23 files)
- `bun run build`: GREEN (server.js 10.76 MB)
- live smoke (`live_smoke.ts --live`): NOT run (release-time only per spec §21)
- `bun x tsc --noEmit`: only pre-existing `src/services/life.ts(350,13)` TS7022 (also present on clean main)

## Commits on feat/intelligence-analysis-foundation

- test(intel): pin geography and provider scope failures
- fix(intel): normalize country identity at provider boundaries
- refactor(intel): preserve provider provenance through reports
- refactor(intel): execute verified two-pass country research
- feat(intel): assemble deterministic factual situation sections
- feat(intel): add deterministic intelligence metric engine (metrics + baseline + signals)
- feat(intel): parse provider-native historical media observations
- feat(intel): persist baseline-eligible observations
- feat(intel): add reusable intelligence domain views
- feat(intel): enable validated country intelligence runtime

## Deferred (spec guidance, no gate test)

- §20 eventKey: optional cross-run stable key not populated (false merge risk). Field not added.
- official_web / yahoo_realtime providers are not in the default runtime (need app-layer deps). P3 follow-up.
- actualWindow vs requestedWindow plumbing for non-period providers (Nager yearly, WorldBank fixed range):
  period is honored where the provider supports it (GDELT timespan); window mixing is not modeled in coverage yet.

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
