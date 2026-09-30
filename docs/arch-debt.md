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

## 5. BM25 spread (LOW, needs scoping)

BM25-adjacent code in extractor/information_retrieval.ts, extractor/hierarchical_bm25.ts, enrichment.ts, rho_select_v2_adapter.ts.
Unclear whether layered reuse or competing implementations. Scope before touching.

## 6. Scattered score multipliers (LOW)

associationMultiplier, structuralMultiplier, temporalMultiplier each hardcode their ladders (1.6, 1.8, 1.4, 1.3, 1.2, 1.15, 0.75, 0.7).
Centralize into one weights table once the ladder stabilizes via eval.

## 7. Temporal intent split (LOW)

requirements.ts TEMPORAL_PATTERN (date-ish) vs lexicons/temporal.ts CURRENT_INTENT_TERMS (present-ish).
Document the boundary: pattern detects date references, lexicon detects present intent. Merge only if a case needs both.
