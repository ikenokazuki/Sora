// Query requirement extraction (RFC P1-DEEP-02).
// LLM-free: whitespace terms + INTENT_ATTRIBUTE_TERMS +
// extractTermsWithBigrams + temporal intent detection.
import { extractTermsWithBigrams } from '../extractor/hierarchical_bm25.js';
import { INTENT_ATTRIBUTE_TERMS_LIST } from './lexicons/temporal.js';
import { STOPWORDS_LIST } from './lexicons/stopwords.js';

export interface QueryRequirements {
  entityTerms: string[];
  intentTerms: string[];
  supportTerms: string[];
  hasDateReference: boolean;
}

const STOPWORDS: Set<string> = new Set(STOPWORDS_LIST);

export const INTENT_ATTRIBUTE_TERMS: Set<string> = new Set(INTENT_ATTRIBUTE_TERMS_LIST);

const TEMPORAL_PATTERN = /\d.*[月日时時\/\-:\uff1a]|\d{1,2}:\d{2}|明日|今日|昨日|明後日|発売日|公開日|配信日|日程|開催/i;

export function extractQueryRequirements(query: string): QueryRequirements {
  const empty: QueryRequirements = { entityTerms: [], intentTerms: [], supportTerms: [], hasDateReference: false };
  if (!query || typeof query !== 'string') return empty;
  const normalized = query.toLowerCase().trim();
  if (!normalized) return empty;
  const hasDateReference = TEMPORAL_PATTERN.test(query);
  const whitespaceWords = normalized.split(/[\s\u3000]+/).map((w) => w.trim()).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  const extracted = extractTermsWithBigrams(query)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const entityTerms = whitespaceWords.slice(0, 3);
  const entitySet = new Set(entityTerms);
  const intentTerms: string[] = [];
  // Attribute terms count as intent even when they are whitespace tokens.
  for (const attr of INTENT_ATTRIBUTE_TERMS) {
    if (normalized.includes(attr.toLowerCase())) {
      intentTerms.push(attr.toLowerCase());
    }
  }
  const supportTerms = extracted.filter((t) => !entitySet.has(t) && !intentTerms.includes(t));
  return { entityTerms, intentTerms, supportTerms, hasDateReference };
}
