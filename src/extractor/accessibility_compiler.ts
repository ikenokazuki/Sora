/**
 * Accessibility-Aware Web→LLM Evidence Data Plane
 * 
 * Sora 向け決定論的根拠データプレーン (Evidence-Preserving Accessibility Hints)
 * 
 * 責務:
 * 1. Block Provenance: ブロック単位の出所識別子 (sourceId, blockId, anchor) 付与
 * 2. Evidence Diagnostics: 意味的断定を行わない、決定論的観測量 (queryCoverage, weakEvidenceSignal)
 */

import type {
  EvidenceBlockRef,
  EvidenceDiagnostics,
} from '../types.js';
import type { HeadingBlock } from './hierarchical_bm25.js';
import { extractTermsWithBigrams } from './hierarchical_bm25.js';

export interface ProvenanceBlock extends HeadingBlock {
  blockId: string; // 例: "P1", "P2"
  sourceId: string; // 例: "S1"
  ref: EvidenceBlockRef;
}

/**
 * HeadingBlock 群にブロック単位の出所メタデータ (Block Provenance) を付与
 */
export function assignBlockProvenance(
  blocks: HeadingBlock[],
  sourceId = 'S1',
  url?: string,
  publishedTime?: string,
): ProvenanceBlock[] {
  if (!blocks || blocks.length === 0) return [];

  return blocks.map((block, idx) => {
    const blockId = `P${idx + 1}`;
    const ref: EvidenceBlockRef = {
      sourceId,
      blockId,
      url,
      publishedTime,
      nearestHeading: block.nearestHeading || undefined,
      headingPath: block.headingPath.length > 0 ? block.headingPath : undefined,
    };

    return {
      ...block,
      blockId,
      sourceId,
      ref,
    };
  });
}

/**
 * ブロック用の Markdown アンカーヘッダー文字列を生成
 * 例: "> [S1:P4 | 2026-09-01]"
 */
export function formatBlockAnchor(ref: EvidenceBlockRef): string {
  const parts = [`${ref.sourceId}:${ref.blockId}`];
  if (ref.publishedTime) {
    const cleanDate = ref.publishedTime.split('T')[0];
    parts.push(cleanDate);
  }
  return `> [${parts.join(' | ')}]`;
}

/**
 * 決定論的証拠充足性観測量 (Evidence Diagnostics) を計算
 * 
 * 重要: Sora は「十分か/不十分か」の意味判定を行わず、
 * クエリ語句の網羅率や候補数などの客観的観測データのみを返す。
 */
export function computeEvidenceDiagnostics(
  content: string,
  query: string,
  candidateCount = 0,
  topScore = 0,
): EvidenceDiagnostics {
  if (!query || query.trim().length === 0) {
    return {
      queryCoverage: 0,
      matchedTerms: [],
      missingTerms: [],
      candidateCount: 0,
      topScore: 0,
      weakEvidenceSignal: true,
      reasons: ['empty_query'],
    };
  }

  const terms = extractTermsWithBigrams(query);
  if (terms.length === 0) {
    return {
      queryCoverage: 0,
      matchedTerms: [],
      missingTerms: [],
      candidateCount,
      topScore,
      weakEvidenceSignal: true,
      reasons: ['no_valid_query_terms'],
    };
  }

  // クエリの基本キーワード単語 (スペース区切りまたは2文字以上の形態素)
  const baseWords = Array.from(new Set(
    query.toLowerCase().trim().split(/\s+/).filter((t) => t.length >= 2)
  ));

  const lowerContent = content.toLowerCase();
  const matchedTerms: string[] = [];
  const missingTerms: string[] = [];

  for (const term of terms) {
    if (lowerContent.includes(term.toLowerCase())) {
      matchedTerms.push(term);
    } else {
      missingTerms.push(term);
    }
  }

  // 基本単語がどれだけ本文に含まれているかをカバレッジとする (直感的かつ数学的に厳密)
  const matchedBaseWords = baseWords.filter((w) => lowerContent.includes(w));
  const queryCoverage = baseWords.length > 0
    ? Number((matchedBaseWords.length / baseWords.length).toFixed(4))
    : (terms.length > 0 ? Number((matchedTerms.length / terms.length).toFixed(4)) : 0);

  const reasons: string[] = [];
  if (candidateCount === 0) {
    reasons.push('no_matching_blocks');
  }
  if (queryCoverage < 0.35) {
    reasons.push('low_query_coverage');
  }
  if (topScore > 0 && topScore < 0.5) {
    reasons.push('low_relevance_score');
  }

  const weakEvidenceSignal = candidateCount === 0 || queryCoverage < 0.35;

  return {
    queryCoverage,
    matchedTerms,
    missingTerms,
    candidateCount,
    topScore: Number(topScore.toFixed(4)),
    weakEvidenceSignal,
    reasons,
  };
}
