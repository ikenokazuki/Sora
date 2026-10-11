# Architecture debt inventory

Ranked by divergence risk, then churn. Extract, alias, migrate, delete; one item at a time with characterization tests.

## 1. Diverged intent lexicon (DONE, verified 2026-10-11)

INTENT_ATTRIBUTE_TERMS now comes from one list, src/retrieval/lexicons/temporal.ts (INTENT_ATTRIBUTE_TERMS_LIST).
enrichment.ts and requirements.ts both build their sets from it; temporal.test.ts pins the union.

## 2. Triplicated stopwords (DONE, verified 2026-10-11)

COMMON_STOPWORDS (enrichment.ts) and STOPWORDS (requirements.ts) both alias src/retrieval/lexicons/stopwords.ts.
ENTITY_STOPWORDS (answerability.ts) stays separate on purpose: it filters entity terms with single-character rules.

## 3. Dead RRF module (DONE, verified 2026-10-11)

src/retrieval/rrf.ts is gone; the weighted reciprocalRankFusion in enrichment.ts is the only implementation.

## 4. Circular import enrichment and rho_select_v2_adapter (DONE, verified 2026-10-11)

rho_select_v2_adapter.ts no longer imports enrichment.ts: estimateTokens lives in src/text_tokens.ts and the
scoring helpers in src/retrieval/answerability.ts. enrichment.ts -> rho_select_v2_adapter.ts is now one-way.

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
