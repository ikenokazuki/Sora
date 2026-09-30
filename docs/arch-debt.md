# Architecture debt inventory

Ranked by divergence risk, then churn. Extract, alias, migrate, delete; one item at a time with characterization tests.

## 1. Diverged intent lexicon (HIGH)

INTENT_ATTRIBUTE_TERMS exists in both src/enrichment.ts and src/retrieval/requirements.ts with different contents.
enrichment has執筆者 and監修; requirements has出演時間 and出演辞退 instead.
Same name, different behavior depending on caller. Consolidate into src/retrieval/lexicons/ and re-export from both sites during migration.

## 2. Triplicated stopwords (MED)

COMMON_STOPWORDS (enrichment.ts), STOPWORDS (requirements.ts), ENTITY_STOPWORDS (answerability.ts).
The first two are byte-identical except the name. Unify behind one lexicon module; keep ENTITY_STOPWORDS separate only if its purpose stays distinct.

## 3. Dead RRF module (MED)

src/retrieval/rrf.ts exports a generic reciprocalRankFusion with zero importers.
The canonical one is enrichment.ts reciprocalRankFusion (weighted). Delete rrf.ts or re-export the canonical implementation from it.

## 4. Circular import enrichment and rho_select_v2_adapter (MED)

enrichment.ts imports extractQueryHighlightsRhoV2 from rho_select_v2_adapter.ts, which imports estimateTokens and scoring helpers from enrichment.ts.
Works under ESM but fragile. Break by moving shared scoring primitives one layer down (extractor or retrieval).

## 5. BM25 spread (LOW, scoped 2026-10-01)

Mostly layered reuse: hierarchical_bm25.ts holds canonical primitives,
information_retrieval.ts holds complementary MMR/PRF/Jaccard.
The inline BM25 variants in enrichment.ts (title/snippet) and
rho_select_v2_adapter.ts (heading/body matrix) serve different inputs
and stay separate by design. Fixed the one real dupe:
answerability.ts splitSentences now re-exports the canonical one.

## 6. Scattered score multipliers (DONE 2026-10-01)

Centralized in src/retrieval/evidence_weights.ts (EVIDENCE_WEIGHTS).
All multipliers reference the table; ordering pinned by evidence_weights.test.ts.

## 7. Temporal intent split (DONE 2026-10-01)

Renamed requirements temporalIntent to hasDateReference: the pattern detects
date references (digits plus month-day, relative days, event words), while
lexicons CURRENT_INTENT_TERMS detects present intent. Boundary documented;
relative-day resolution (明日 etc.) stays future work.
