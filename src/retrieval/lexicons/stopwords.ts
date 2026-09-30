// Shared stopwords. requirements STOPWORDS and enrichment COMMON_STOPWORDS
// were byte-identical; both now alias this list.
// ENTITY_STOPWORDS in answerability.ts stays separate: it serves
// entity-term filtering with single-character rules, a different purpose.
export const STOPWORDS_LIST: string[] = [
  'について', 'とは', '一覧', 'まとめ', '情報', '詳細', '公式', 'サイト', 'ページ',
  '最新', 'おすすめ', '比較', 'ランキング', '紹介', '方法', 'やり方', '使い方',
  'の', 'に', 'は', 'を', 'と', 'が', 'で', 'から', 'まで', 'より',
  'how', 'what', 'who', 'where', 'when', 'why', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for',
];
