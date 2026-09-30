// Query requirement extraction (RFC P1-DEEP-02).
// LLM-free: whitespace terms + INTENT_ATTRIBUTE_TERMS +
// extractTermsWithBigrams + temporal intent detection.
import { extractTermsWithBigrams } from '../extractor/hierarchical_bm25.js';
import { INTENT_ATTRIBUTE_TERMS_LIST } from './lexicons/temporal.js';

export interface QueryRequirements {
  entityTerms: string[];
  intentTerms: string[];
  supportTerms: string[];
  temporalIntent: boolean;
}

const STOPWORDS = new Set([
  'について', 'とは', '一覧', 'まとめ', '情報', '詳細', '公式', 'サイト', 'ページ',
  '最新', 'おすすめ', '比較', 'ランキング', '紹介', '方法', 'やり方', '使い方',
  'の', 'に', 'は', 'を', 'と', 'が', 'で', 'から', 'まで', 'より',
  'how', 'what', 'who', 'where', 'when', 'why', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for',
]);

export const INTENT_ATTRIBUTE_TERMS: Set<string> = new Set(INTENT_ATTRIBUTE_TERMS_LIST);

const TEMPORAL_PATTERN = /\d.*[月日时時\/\-:\uff1a]|\d{1,2}:\d{2}|明日|今日|昨日|明後日|発売日|公開日|配信日|日程|開催/i;

export function extractQueryRequirements(query: string): QueryRequirements {
  const empty: QueryRequirements = { entityTerms: [], intentTerms: [], supportTerms: [], temporalIntent: false };
  if (!query || typeof query !== 'string') return empty;
  const normalized = query.toLowerCase().trim();
  if (!normalized) return empty;
  const temporalIntent = TEMPORAL_PATTERN.test(query);
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
  return { entityTerms, intentTerms, supportTerms, temporalIntent };
}
