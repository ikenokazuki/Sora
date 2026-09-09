/**
 * 情報検索理論 (IR) & 先端 RAG アルゴリズムモジュール
 * 
 * 外部ベクトルDBや巨大モデルに依存せず、決定論的かつインメモリ超高速 (<0.05ms) で
 * LLM の想起率・トークン効率・語彙カバレッジを最大化する 3 大アルゴリズム群：
 * 
 * 1. U字型リオーダリング (Lost in the Middle 対策 / Primacy-Recency Boustrophedon Layout)
 * 2. MMR (Maximal Marginal Relevance / 貪欲多様性最大化による冗長性根絶)
 * 3. インメモリ PRF (Pseudo-Relevance Feedback / 擬似適合フィードバックによる語彙拡張)
 */

import { extractTermsWithBigrams } from './hierarchical_bm25.js';

// =========================================================================
// 1. U字型リオーダリング (Lost in the Middle 対策)
// =========================================================================

/**
 * スコア降順配列 [1位, 2位, 3位, 4位, 5位, ...] を
 * LLM のアテンションが最も高まる先頭と末尾に最重要アイテムを配置する U字型 (Boustrophedon) に並べ替える。
 * 
 * 出力例: [1位, 3位, 5位, ..., 4位, 2位]
 * (1位がプロンプト冒頭、2位がプロンプト末尾、低スコアのものが中央に配置される)
 * 
 * 計算量: O(N)
 */
export function reorderLostInTheMiddle<T>(items: T[]): T[] {
  if (!items || items.length <= 2) {
    return items ? [...items] : [];
  }

  const head: T[] = [];
  const tail: T[] = [];
  let toHead = true;

  for (let i = 0; i < items.length; i++) {
    if (toHead) {
      head.push(items[i]);
    } else {
      tail.unshift(items[i]);
    }
    toHead = !toHead;
  }

  return [...head, ...tail];
}

// =========================================================================
// 2. MMR (Maximal Marginal Relevance / 最大限界関連度)
// =========================================================================

export interface MmrOptions<T> {
  getScore: (item: T) => number;
  getText: (item: T) => string;
  limit: number;
  lambda?: number; // 適合度 vs 新規性のトレードオフ係数 (0.0: 完全多様性, 1.0: 通常スコア順, デフォルト: 0.7)
}

/**
 * 日本語・英語テキストから比較用単語トークン集合を抽出
 */
export function extractSimilarityTokens(text: string): Set<string> {
  const words = new Set<string>();
  if (!text) return words;

  try {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    for (const seg of segmenter.segment(text.toLowerCase())) {
      if (seg.isWordLike) {
        const w = seg.segment.trim();
        if (w.length >= 2) {
          words.add(w);
        }
      }
    }
  } catch {
    // Intl.Segmenter がない環境のフォールバック
    const raw = text.toLowerCase().split(/[\s,._!?。、！？\(\)\[\]「」『』]+/);
    for (const w of raw) {
      if (w.length >= 2) words.add(w);
    }
  }

  return words;
}

/**
 * 2つのテキスト間の語彙類似度 (0.0〜1.0) を計算。
 * Jaccard 類似度と Overlap (Simpson) 類似度の最大値を採用し、
 * 言い換えや短い文の包含関係を確実に検知する。
 */
export function computeTextSimilarity(textA: string, textB: string): number {
  if (!textA || !textB) return 0;
  if (textA === textB) return 1.0;

  const termsA = extractSimilarityTokens(textA);
  const termsB = extractSimilarityTokens(textB);

  if (termsA.size === 0 || termsB.size === 0) return 0;

  let intersection = 0;
  for (const term of termsA) {
    if (termsB.has(term)) {
      intersection++;
    }
  }

  const jaccard = intersection / (termsA.size + termsB.size - intersection);
  const overlap = intersection / Math.min(termsA.size, termsB.size);

  return Math.max(jaccard, overlap);
}

// 後方互換 alias
export const computeJaccardSimilarity = computeTextSimilarity;

/**
 * 候補アイテム群から、クエリ適合度と既存選択アイテムとの類似度ペナルティのトレードオフを
 * 貪欲に最大化して多様なアイテムを選択する (Maximal Marginal Relevance)。
 * 
 * 計算量: O(K * N) (K = limit, N = candidates.length)
 */
export function selectMaximalMarginalRelevance<T>(
  candidates: T[],
  options: MmrOptions<T>
): T[] {
  if (!candidates || candidates.length === 0) return [];
  const limit = Math.min(Math.max(options.limit, 1), candidates.length);
  const lambda = Math.min(Math.max(options.lambda ?? 0.7, 0), 1);

  if (candidates.length <= 1 || limit === 1) {
    return [candidates[0]];
  }

  // スコアの最大値で正規化 (0〜1 スケール)
  const rawScores = candidates.map((c) => Math.max(options.getScore(c), 0));
  const maxScore = Math.max(...rawScores);
  const normalizedScores = rawScores.map((s) => (maxScore > 0 ? s / maxScore : 0));

  // テキストトークンのキャッシュ
  const texts = candidates.map((c) => options.getText(c));

  const selectedIndices: number[] = [];
  const remainingIndices = new Set<number>(candidates.map((_, idx) => idx));

  // 1件目は最高スコアのものを採択
  let bestInitialIdx = 0;
  let bestInitialScore = -Infinity;
  for (const idx of remainingIndices) {
    if (normalizedScores[idx] > bestInitialScore) {
      bestInitialScore = normalizedScores[idx];
      bestInitialIdx = idx;
    }
  }
  selectedIndices.push(bestInitialIdx);
  remainingIndices.delete(bestInitialIdx);

  // 2件目以降を MMR 基準で貪欲選択
  while (selectedIndices.length < limit && remainingIndices.size > 0) {
    let bestMmrScore = -Infinity;
    let bestCandidateIdx = -1;

    for (const candIdx of remainingIndices) {
      const candText = texts[candIdx];
      const candNormScore = normalizedScores[candIdx];

      // すでに選択されたアイテム群との最大類似度を計算
      let maxSimToSelected = 0;
      for (const selIdx of selectedIndices) {
        const sim = computeJaccardSimilarity(candText, texts[selIdx]);
        if (sim > maxSimToSelected) {
          maxSimToSelected = sim;
        }
      }

      // MMR 目的関数: λ * Relevance - (1 - λ) * MaxSimilarity
      const mmrScore = lambda * candNormScore - (1 - lambda) * maxSimToSelected;

      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestCandidateIdx = candIdx;
      }
    }

    if (bestCandidateIdx >= 0) {
      selectedIndices.push(bestCandidateIdx);
      remainingIndices.delete(bestCandidateIdx);
    } else {
      break;
    }
  }

  return selectedIndices.map((idx) => candidates[idx]);
}

// =========================================================================
// 3. インメモリ PRF (Pseudo-Relevance Feedback / 擬似適合フィードバック)
// =========================================================================

export interface PrfResult {
  expandedQuery: string;
  expansionTerms: string[];
}

/**
 * 擬似適合フィードバック (Rocchio 式インメモリ共起解析)
 * 
 * 上位適合ドキュメント (topDocs: 1〜3件) に高頻度で出現し、
 * かつ全ドキュメントコーパス (allDocs) において希少 (高IDF) な共起語を抽出し、
 * 検索クエリの表現揺れ・語彙不足を自動補完する。
 * 
 * 計算量: O(N * 文書長) (インメモリ・0.05ms 未満)
 */
export function expandQueryWithPseudoRelevanceFeedback(
  query: string,
  topDocs: string[],
  allDocs: string[],
  options?: { maxTerms?: number; minDf?: number }
): PrfResult {
  const maxTerms = options?.maxTerms ?? 3;
  const minDf = options?.minDf ?? 1;

  if (!query || topDocs.length === 0 || allDocs.length === 0) {
    return { expandedQuery: query, expansionTerms: [] };
  }

  const queryTerms = new Set(
    extractTermsWithBigrams(query).map((t) => t.toLowerCase())
  );

  // 1. 全文書コーパスにおける単語のドキュメント頻度 DF(w) を計算
  const N = allDocs.length;
  const dfMap = new Map<string, number>();

  for (const doc of allDocs) {
    const docTerms = new Set(extractTermsWithBigrams(doc).map((t) => t.toLowerCase()));
    for (const term of docTerms) {
      if (term.length >= 2) {
        dfMap.set(term, (dfMap.get(term) || 0) + 1);
      }
    }
  }

  // 2. 上位適合文書群における単語の出現頻度 TF(w, topDocs) を集計
  const topTfMap = new Map<string, number>();
  for (const doc of topDocs) {
    const docTerms = extractTermsWithBigrams(doc).map((t) => t.toLowerCase());
    for (const term of docTerms) {
      if (term.length >= 2) {
        topTfMap.set(term, (topTfMap.get(term) || 0) + 1);
      }
    }
  }

  // 3. 各単語の PRF スコア (Rocchio / BM25 適合重み) を算出
  // PRF(w) = TF(w, topDocs) * IDF(w, allDocs)
  const candidateScores: Array<{ term: string; score: number }> = [];

  for (const [term, tf] of topTfMap.entries()) {
    // クエリ自身に含まれる語は除外
    if (queryTerms.has(term)) continue;

    // 数字のみ、またはノイズの除外
    if (/^\d+$/.test(term)) continue;

    const df = dfMap.get(term) || 1;
    if (df < minDf) continue;

    // スムージング付き BM25 IDF
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0);

    // TF飽和 (多すぎる単語に過度に偏らないように log 圧縮)
    const tfScore = Math.log(1 + tf);

    const score = tfScore * idf;
    if (score > 0) {
      candidateScores.push({ term, score });
    }
  }

  // スコア降順にソート
  candidateScores.sort((a, b) => b.score - a.score);

  const expansionTerms = candidateScores.slice(0, maxTerms).map((c) => c.term);
  const expandedQuery = expansionTerms.length > 0
    ? `${query} ${expansionTerms.join(' ')}`
    : query;

  return {
    expandedQuery,
    expansionTerms,
  };
}
