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
