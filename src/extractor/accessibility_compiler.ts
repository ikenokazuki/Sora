/**
 * Accessibility-Aware Web→LLM Evidence Data Plane
 * 
 * Sora 向け決定論的根拠データプレーン (Evidence-Preserving Accessibility Hints)
 * 
 * 責務:
 * 1. Block Provenance: ブロック単位の出所識別子 (sourceId, blockId, anchor) 付与
 * 2. Evidence Diagnostics: 意味的断定を行わない、決定論的観測量 (queryCoverage, weakEvidenceSignal)
 * 3. Candidate Discrepancies: 日付・金額・バージョンの不一致候補の可視化 (勝手に解消しない)
 * 4. Safe Normalization: 外部知識を要しない固定規則による決定論的正規化と導出履歴
 */

import type {
  EvidenceBlockRef,
  HighlightItem,
  EvidenceDiagnostics,
  CandidateDiscrepancy,
  DerivationTrace,
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

/**
 * テキスト群から日付・金額・バージョンの不一致候補 (Candidate Discrepancies) を検出
 * 
 * 重要: Sora はどちらが正しいか解消（Silent Resolve）せず、
 * 上位エージェントに対比情報として提示する。
 */
export function detectDiscrepancies(
  items: Array<{ text: string; sourceId?: string; blockId?: string }>,
): CandidateDiscrepancy[] {
  if (!items || items.length === 0) return [];

  const discrepancies: CandidateDiscrepancy[] = [];

  // 1. 日付の不一致検出
  // 例: 2026-09-01, 2026/09/01, 2026年9月1日
  const dateRegex = /\b(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\b/g;
  const dateMap = new Map<string, { original: string; normalized: string; sourceId?: string; blockId?: string; context?: string }>();

  for (const item of items) {
    let match;
    dateRegex.lastIndex = 0;
    while ((match = dateRegex.exec(item.text)) !== null) {
      const year = match[1];
      const month = match[2].padStart(2, '0');
      const day = match[3].padStart(2, '0');
      const normalized = `${year}-${month}-${day}`;
      if (!dateMap.has(normalized)) {
        // 前後 30 文字をコンテキストとして保持
        const start = Math.max(0, match.index - 20);
        const end = Math.min(item.text.length, match.index + match[0].length + 20);
        const context = item.text.slice(start, end).replace(/\s+/g, ' ').trim();
        dateMap.set(normalized, {
          original: match[0],
          normalized,
          sourceId: item.sourceId,
          blockId: item.blockId,
          context,
        });
      }
    }
  }

  if (dateMap.size >= 2) {
    discrepancies.push({
      kind: 'date',
      values: Array.from(dateMap.values()),
      status: 'needs_agent_resolution',
    });
  }

  // 2. 金額の不一致検出
  // 例: ¥1,200, 1200円, 1,500円
  const moneyRegex = /(?:¥|￥)\s*([\d,]+)|([\d,]+)\s*(?:円)/g;
  const moneyMap = new Map<string, { original: string; normalized: string; sourceId?: string; blockId?: string; context?: string }>();

  for (const item of items) {
    let match;
    moneyRegex.lastIndex = 0;
    while ((match = moneyRegex.exec(item.text)) !== null) {
      const numStr = (match[1] || match[2]).replace(/,/g, '');
      const num = parseInt(numStr, 10);
      if (isNaN(num) || num <= 0) continue;
      const normalized = `${num}円`;
      if (!moneyMap.has(normalized)) {
        const start = Math.max(0, match.index - 20);
        const end = Math.min(item.text.length, match.index + match[0].length + 20);
        const context = item.text.slice(start, end).replace(/\s+/g, ' ').trim();
        moneyMap.set(normalized, {
          original: match[0],
          normalized,
          sourceId: item.sourceId,
          blockId: item.blockId,
          context,
        });
      }
    }
  }

  if (moneyMap.size >= 2) {
    discrepancies.push({
      kind: 'money',
      values: Array.from(moneyMap.values()),
      status: 'needs_agent_resolution',
    });
  }

  // 3. バージョン番号の不一致検出
  // 例: v2.13.0, 2.14.0
  const versionRegex = /\bv?(\d+\.\d+(?:\.\d+)?)\b/g;
  const versionMap = new Map<string, { original: string; normalized: string; sourceId?: string; blockId?: string; context?: string }>();

  for (const item of items) {
    let match;
    versionRegex.lastIndex = 0;
    while ((match = versionRegex.exec(item.text)) !== null) {
      const normalized = match[1];
      if (!versionMap.has(normalized)) {
        const start = Math.max(0, match.index - 20);
        const end = Math.min(item.text.length, match.index + match[0].length + 20);
        const context = item.text.slice(start, end).replace(/\s+/g, ' ').trim();
        versionMap.set(normalized, {
          original: match[0],
          normalized,
          sourceId: item.sourceId,
          blockId: item.blockId,
          context,
        });
      }
    }
  }

  if (versionMap.size >= 2) {
    discrepancies.push({
      kind: 'version',
      values: Array.from(versionMap.values()),
      status: 'needs_agent_resolution',
    });
  }

  return discrepancies;
}

/**
 * 決定論的な安全正規化 (Safe Normalization)
 * 
 * 外部知識（為替レートやインフレ率等）を要する変換は一切行わず、
 * 固定規則による数学的・表記変換のみを実行し、DerivationTrace を生成する。
 */
export function normalizeSafeNumeric(text: string): {
  normalizedText: string;
  derivations: DerivationTrace[];
} {
  if (!text) return { normalizedText: '', derivations: [] };

  const derivations: DerivationTrace[] = [];
  let current = text;

  // 1. 全角英数字の半角化
  const fullwidthDigits = /[０-９]/g;
  if (fullwidthDigits.test(current)) {
    const originalMatches = current.match(fullwidthDigits) || [];
    current = current.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    if (originalMatches.length > 0) {
      derivations.push({
        operation: 'fullwidth_digits_to_halfwidth',
        input: Array.from(new Set(originalMatches)).join(', '),
        output: 'halfwidth digits',
      });
    }
  }

  // 2. 漢数字「万」の展開 (例: 1万2000 -> 12000, 120万 -> 1200000)
  const manRegex = /(\d+)\s*万(?:\s*(\d{1,4}))?(?!\d)/g;
  let manMatch;
  while ((manMatch = manRegex.exec(current)) !== null) {
    const okuMan = parseInt(manMatch[1], 10);
    const remainder = manMatch[2] ? parseInt(manMatch[2], 10) : 0;
    const computed = okuMan * 10000 + remainder;
    derivations.push({
      operation: 'kanji_man_to_digits',
      input: manMatch[0],
      output: computed.toString(),
    });
  }
  current = current.replace(/(\d+)\s*万(?:\s*(\d{1,4}))?(?!\d)/g, (_, man, rem) => {
    const okuMan = parseInt(man, 10);
    const remainder = rem ? parseInt(rem, 10) : 0;
    return (okuMan * 10000 + remainder).toString();
  });

  // 3. 物理単位変換 (km -> m, ms -> s)
  // km -> m (例: 2.4 km -> 2400 m)
  const kmRegex = /\b(\d+(?:\.\d+)?)\s*km\b/gi;
  let kmMatch;
  while ((kmMatch = kmRegex.exec(current)) !== null) {
    const val = parseFloat(kmMatch[1]);
    const inMeters = Math.round(val * 1000);
    derivations.push({
      operation: 'km_to_m',
      input: kmMatch[0],
      output: `${inMeters} m`,
    });
  }
  current = current.replace(/\b(\d+(?:\.\d+)?)\s*km\b/gi, (_, val) => {
    return `${Math.round(parseFloat(val) * 1000)} m`;
  });

  // ms -> s (例: 500 ms -> 0.5 s, 1000 ms -> 1 s)
  const msRegex = /\b(\d+(?:\.\d+)?)\s*ms\b/gi;
  let msMatch;
  while ((msMatch = msRegex.exec(current)) !== null) {
    const val = parseFloat(msMatch[1]);
    const inSec = Number((val / 1000).toFixed(4));
    derivations.push({
      operation: 'ms_to_s',
      input: kmMatch ? kmMatch[0] : `${val} ms`,
      output: `${inSec} s`,
    });
  }
  current = current.replace(/\b(\d+(?:\.\d+)?)\s*ms\b/gi, (_, val) => {
    return `${Number((parseFloat(val) / 1000).toFixed(4))} s`;
  });

  return {
    normalizedText: current,
    derivations,
  };
}
