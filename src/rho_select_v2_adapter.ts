/**
 * ρSelect v2 Sora Markdown / Web Adapter
 *
 * Paper Canonical Specification: rho_select_paper_spec_v100.md
 * Gemini Implementation Spec: v1.0 (media_1789022645848.md)
 *
 * 責務:
 * - Markdown 本文の見出し階層セクションパース
 * - 検索スニペット・補完証拠の候補プール合流
 * - requirements / pseudo-requirements の生成
 * - continuous score matrix r_it ∈ [0, 1] の算出 (Sora operational lexical scorer)
 * - estimateTokens によるコスト評価
 * - 低レベル optimizer (selectEvidenceSetRhoV2) の呼び出し
 * - 結果の整形と Text Fragment 生成
 */

import { estimateTokens } from './enrichment.js';
import { analyzeFacetEvidence, associationMultiplier, computeEvidenceCoverage, dateYearMultiplier, detectCurrentIntent, entityTermsForQuery, extractDateRequirements, splitSentences, structuralMultiplier, temporalMultiplier } from './retrieval/answerability.js';
import { parseMarkdownSections, tokenizeAndSelectTerms, type ParsedSection } from './rho_select.js';
import {
  selectEvidenceSetRhoV2,
  type RhoEvidenceProblem,
  type RhoSolverOptions,
  type RhoOptimizerCertificate,
  type RhoV2DiagnosticsHistoryItem,
} from './rho_select_v2.js';

export interface RhoSelectV2Options {
  requirements?: string[];
  requirementWeights?: number[];
  tau?: number; // default: 96
  overheadTokens?: number; // tau のエイリアス
  maxTerms?: number; // default: 6
  supplementalEvidence?: string[];
  epsilon?: number; // default: 0.05
  exactSubsetThreshold?: number; // default: 50_000
  dominancePreprocess?: boolean; // default: true
  maxIterations?: number; // default: 100
  maxStates?: number; // default: 500_000
  highlightMaxCount?: number;
  adaptiveCandidate?: boolean;
  candidateStages?: number[]; // 指定時は安全なポストトランケーション (post-selection truncation) を適用
  wHeading?: number; // default: 3.5
  bHeading?: number; // default: 0.5
  wBody?: number; // default: 1.0
  bBody?: number; // default: 0.75
  k1?: number; // default: 1.2
  delta?: number; // default: 0.8
  limits?: ExtractionLimits; // default: unlimited (callers opt in)
}

export interface RhoSelectV2HighlightItem {
  text: string;
  score: number;
  cost: number;
  evidenceScores: number[];
  heading?: string;
}

export interface RhoSelectV2Diagnostics {
  engine: 'rho-select-v2';
  requirementsSource: 'explicit' | 'query_terms';
  requirements: string[];
  requirementWeights: number[];
  scoreReliability: { status: 'not_calibrated' };
  candidateCount: number;
  keptCandidateCount: number;
  selectedCount: number;
  selectedTokens: number;
  utility: number;
  cost: number;
  rho: number;
  witnessSubsetBound: string;
  certificate: RhoOptimizerCertificate;
  warning?: string;
  history?: RhoV2DiagnosticsHistoryItem[];
  mentionCoverage?: number;
  answerCoverage?: number;
  coveredRequirements?: string[];
  answeredRequirements?: string[];
  missingRequirements?: string[];
  candidateExpansion?: { initial: number; final: number; stages: number };
  escalation?: { path: 'precision' | 'recall'; reason: string };
  extractionMs?: number;
  limitsApplied?: string[];
}

export interface RhoSelectV2Result {
  highlights: string[];
  highlightItems: RhoSelectV2HighlightItem[];
  certificate: RhoOptimizerCertificate;
  diagnostics: RhoSelectV2Diagnostics;
}

interface CandidateBlock {
  heading: string;
  body: string;
  snippetText: string;
  cost: number;
  isSupplemental: boolean;
}

/**
 * テキスト内での語句出現回数をカウント (大文字小文字無視)
 */
function rankCandidatesCheap(pool: Array<{ heading: string; body: string }>, requirements: string[]): number[] {
  const scored = pool.map((c, idx) => {
    let s = 0;
    const reqs = requirements || [];
    for (const r of reqs) {
      if (!r) continue;
      const t = r.trim();
      if (!t) continue;
      s += countOccurrences(c.heading, t) * 3 + countOccurrences(c.body, t);
    }
    return { idx, s };
  });
  scored.sort((a, b) => (b.s !== a.s ? b.s - a.s : a.idx - b.idx));
  return scored.map((e) => e.idx);
}

function chr10(): string {
  return String.fromCharCode(10);
}

function countOccurrences(text: string, term: string): number {
  if (!text || !term) return 0;
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = lowerText.indexOf(lowerTerm, pos)) !== -1) {
    count++;
    pos += lowerTerm.length;
  }
  return count;
}

/**
 * Markdown 文書および補完証拠から候補セクション群を構築
 */
export function buildCandidateBlocks(
  markdown: string,
  supplementalEvidence?: string[],
): CandidateBlock[] {
  const parsedSections = parseMarkdownSections(markdown);
  const candidates: CandidateBlock[] = [];

  for (const sec of parsedSections) {
    const heading = sec.heading.trim();
    const body = sec.fullText.trim();
    if (!body && !heading) continue;

    const snippetText = heading ? `## ${heading}\n\n${body}` : body;
    const cost = Math.max(estimateTokens(snippetText), 1);

    candidates.push({
      heading,
      body,
      snippetText,
      cost,
      isSupplemental: false,
    });
  }

  // 補完証拠 (検索スニペット・ディスクリプション等) の追加
  if (supplementalEvidence && supplementalEvidence.length > 0) {
    for (const sup of supplementalEvidence) {
      const trimmed = (sup || '').trim();
      if (!trimmed) continue;

      // 本文と全く同一のものは重複排除
      const isDuplicate = candidates.some((c) => c.body.includes(trimmed) || trimmed.includes(c.body));
      if (isDuplicate) continue;

      const snippetText = `> 📌 **補完証拠 (スニペット)**: ${trimmed}`;
      const cost = Math.max(estimateTokens(snippetText), 1);

      candidates.push({
        heading: '補完証拠',
        body: trimmed,
        snippetText,
        cost,
        isSupplemental: true,
      });
    }
  }

  return candidates;
}

/**
 * 高レベル Sora Markdown Adapter
 * extractQueryHighlightsRhoV2
 */
export function extractQueryHighlightsRhoV2(
  markdown: string,
  query: string,
  options: RhoSelectV2Options = {},
): RhoSelectV2Result {
  const tau = options.tau ?? options.overheadTokens ?? 96;
  const wHeading = options.wHeading ?? 3.5;
  const bHeading = options.bHeading ?? 0.5;
  const wBody = options.wBody ?? 1.0;
  const bBody = options.bBody ?? 0.75;
  const k1 = options.k1 ?? 1.2;
  const delta = options.delta ?? 0.8;

  // 1. 候補セクションの構築
  const limits = options.limits;
  const limitsApplied: string[] = [];
  if (limits?.maxHtmlBytes !== undefined && limits.maxHtmlBytes >= 0 && markdown.length > limits.maxHtmlBytes) {
    markdown = markdown.slice(0, limits.maxHtmlBytes);
    limitsApplied.push(`input-truncated:${limits.maxHtmlBytes}`);
  }
  let candidates = buildCandidateBlocks(markdown, options.supplementalEvidence);
  if (limits?.maxBlocks !== undefined && limits.maxBlocks >= 0 && candidates.length > limits.maxBlocks) {
    candidates = candidates.slice(0, limits.maxBlocks);
    limitsApplied.push(`blocks-truncated:${limits.maxBlocks}`);
  }
  if (candidates.length === 0) {
    const emptyCert: RhoOptimizerCertificate = {
      scope: 'score_defined_objective_only',
      valid: true,
      solver: 'exact',
      lowerBound: 0,
      upperBound: 0,
      relativeGap: 0,
      epsilon: options.epsilon ?? 0.05,
      exact: true,
      iterations: 0,
      postProcessed: false,
    };
    return {
      highlights: [],
      highlightItems: [],
      certificate: emptyCert,
      diagnostics: {
        engine: 'rho-select-v2',
        requirementsSource: options.requirements && options.requirements.length > 0 ? 'explicit' : 'query_terms',
        requirements: options.requirements || [],
        requirementWeights: [],
        scoreReliability: { status: 'not_calibrated' },
        candidateCount: 0,
        keptCandidateCount: 0,
        ...(limitsApplied.length > 0 ? { limitsApplied } : {}),
        selectedCount: 0,
        selectedTokens: 0,
        utility: 0,
        cost: 0,
        rho: 0,
        witnessSubsetBound: '0',
        certificate: emptyCert,
      },
    };
  }

  // 2. Requirements の決定
  let requirements: string[] = [];
  let requirementsSource: 'explicit' | 'query_terms' = 'query_terms';

  if (options.requirements && options.requirements.length > 0) {
    requirements = options.requirements.map((r) => r.trim()).filter((r) => r.length > 0);
    requirementsSource = 'explicit';
  } else {
    const parsedSecs: ParsedSection[] = candidates.map((c) => ({
      rawHeading: c.heading,
      heading: c.heading,
      headingLevel: 2,
      paragraphs: [c.body],
      fullText: c.body,
      charLength: c.body.length,
      startIndex: 0,
    }));
    const termSelection = tokenizeAndSelectTerms(query, parsedSecs, options.maxTerms ?? 6);
    requirements = termSelection.terms;
    requirementsSource = 'query_terms';
  }

  // requirements が空の場合の早期リターン
  if (requirements.length === 0) {
    const emptyCert: RhoOptimizerCertificate = {
      scope: 'score_defined_objective_only',
      valid: true,
      solver: 'exact',
      lowerBound: 0,
      upperBound: 0,
      relativeGap: 0,
      epsilon: options.epsilon ?? 0.05,
      exact: true,
      iterations: 0,
      postProcessed: false,
    };
    return {
      highlights: [],
      highlightItems: [],
      certificate: emptyCert,
      diagnostics: {
        engine: 'rho-select-v2',
        requirementsSource,
        requirements: [],
        requirementWeights: [],
        scoreReliability: { status: 'not_calibrated' },
        candidateCount: candidates.length,
        keptCandidateCount: candidates.length,
        ...(limitsApplied.length > 0 ? { limitsApplied } : {}),
        selectedCount: 0,
        selectedTokens: 0,
        utility: 0,
        cost: 0,
        rho: 0,
        witnessSubsetBound: '0',
        certificate: emptyCert,
      },
    };
  }

  // 補完証拠 (スニペット) のフォールバック制御 (カニバリゼーション防止):
  // 本文候補が存在し、かつクエリ用語にマッチする本文エビデンスが1件以上ある場合、
  // スニペットが短さだけで本文を駆逐するのを防ぐため、本文候補のみを採用する。
  const bodyCandidates = candidates.filter((c) => !c.isSupplemental);
  if (bodyCandidates.length > 0) {
    const hasBodyMatch = bodyCandidates.some((c) =>
      requirements.some(
        (r) =>
          c.heading.toLowerCase().includes(r.toLowerCase()) ||
          c.body.toLowerCase().includes(r.toLowerCase()),
      ),
    );
    if (hasBodyMatch) {
      candidates = bodyCandidates;
    }
  }

  const n = candidates.length;
  const m = requirements.length;
  const cheapOrder = rankCandidatesCheap(candidates, requirements);
  const assocEntities = entityTermsForQuery(query);
  const currentIntent = detectCurrentIntent(query);
  const dateReqs = extractDateRequirements(query);
  const solveSubset = (sub: number[]): { scores: number[][]; weights: number[]; selection: any } => {
    const pool = sub.map((ci) => candidates[ci]);
    const pn = pool.length;

  // 3. Continuous Score Matrix r_it ∈ [0, 1] の算出 (BM25+ Lexical Scorer)
  let avgHeadingLen = 0;
  let avgBodyLen = 0;
    for (const c of pool) {
      avgHeadingLen += c.heading.length;
      avgBodyLen += c.body.length;
    }
    avgHeadingLen = Math.max(avgHeadingLen / pn, 1);
    avgBodyLen = Math.max(avgBodyLen / pn, 1);

  // Requirement ごとの Document Frequency (DF) と local smoothed IDF
  const idfList: number[] = new Array(m);
  for (let t = 0; t < m; t++) {
    const req = requirements[t];
    let df = 0;
    for (const c of pool) {
      if (c.heading.toLowerCase().includes(req.toLowerCase()) || c.body.toLowerCase().includes(req.toLowerCase())) {
        df++;
      }
    }
    // Robertson BM25 smoothed IDF with minimum floor
    idfList[t] = Math.max(0.1, Math.log(1 + (pn - df + 0.5) / (df + 0.5)));
  }

  // Raw evidence matrix
  const rawScores: number[][] = [];
  const maxRawPerRequirement = new Array(m).fill(0);

    for (let i = 0; i < pn; i++) {
      const c = pool[i];
    const row: number[] = new Array(m);

    const normHLen = c.heading.length / avgHeadingLen;
    const normBLen = c.body.length / avgBodyLen;
    const blockSentences = splitSentences(c.heading + chr10() + c.body);

    for (let t = 0; t < m; t++) {
      const req = requirements[t];
      const tfH = countOccurrences(c.heading, req);
      const tfB = countOccurrences(c.body, req);

      if (tfH === 0 && tfB === 0) {
        row[t] = 0;
        continue;
      }

      const normTfH = tfH / (1 - bHeading + bHeading * normHLen);
      const normTfB = tfB / (1 - bBody + bBody * normBLen);
      const compositeTf = wHeading * normTfH + wBody * normTfB;

      // BM25+ 式
      const baseEvidence = idfList[t] * (((k1 + 1) * compositeTf) / (k1 + compositeTf) + delta);
      let evidence = baseEvidence;
      try {
        const facetEv = analyzeFacetEvidence(blockSentences, assocEntities, req);
        const structMult = structuralMultiplier(c.heading + chr10() + c.body, req);
        const mult = Math.max(associationMultiplier(facetEv), structMult);
        evidence = baseEvidence * mult * temporalMultiplier(blockSentences, req, currentIntent) * dateYearMultiplier(blockSentences, dateReqs);
      } catch {}
      row[t] = evidence;
      if (evidence > maxRawPerRequirement[t]) {
        maxRawPerRequirement[t] = evidence;
      }
    }
    rawScores.push(row);
  }

  // [0, 1] への正規化
  const normalizedScores: number[][] = [];
    for (let i = 0; i < pn; i++) {
      const row: number[] = new Array(m);
    for (let t = 0; t < m; t++) {
      const maxVal = maxRawPerRequirement[t];
      row[t] = maxVal > 0 ? Math.min(Math.max(rawScores[i][t] / maxVal, 0), 1.0) : 0.0;
    }
    normalizedScores.push(row);
  }

  // 4. Utility Weights
  let weights: number[] = [];
  if (options.requirementWeights && options.requirementWeights.length === m) {
    weights = options.requirementWeights;
  } else {
    if (requirementsSource === 'explicit') {
      weights = new Array(m).fill(1.0);
    } else {
      // query_terms の場合: idfList を正規化して合計が m になるように設定
      const sumIdf = idfList.reduce((acc, v) => acc + v, 0);
      weights = sumIdf > 0 ? idfList.map((v) => (v / sumIdf) * m) : new Array(m).fill(1.0);
    }
  }

    const costs = pool.map((c) => c.cost);

  // 5. 低レベル Optimizer の実行
  const problem: RhoEvidenceProblem = {
    scores: normalizedScores,
    costs,
    tau,
    utility: { kind: 'weighted-sum', weights },
  };

  const solverOptions: RhoSolverOptions = {
    epsilon: options.epsilon ?? 0.05,
    exactSubsetThreshold: options.exactSubsetThreshold ?? 50_000,
    dominancePreprocess: options.dominancePreprocess ?? true,
    maxIterations: options.maxIterations ?? 100,
    maxStates: options.maxStates ?? 500_000,
  };

    const selection = selectEvidenceSetRhoV2(problem, solverOptions);
    return { scores: normalizedScores, weights, selection };
  };
  const allIdx = candidates.map((_, ci) => ci);
  const adaptiveCandidate = options.adaptiveCandidate ?? true;
  const stageSizes: number[] = options.candidateStages ?? [12, 24, 48];
  let finalSub = allIdx;
  let finalScores: number[][] = [];
  let finalWeights: number[] = [];
  let selection: any = null;
  let stagesRun = 0;
  let finalStageSize = n;
  if (!adaptiveCandidate || n <= 12) {
    const r0 = solveSubset(allIdx);
    finalScores = r0.scores;
    finalWeights = r0.weights;
    selection = r0.selection;
    stagesRun = 1;
  } else {
    let stagePos = 0;
    while (true) {
      const K = stagePos < stageSizes.length ? stageSizes[stagePos] : n;
      const sub = K >= n ? allIdx : cheapOrder.slice(0, Math.max(1, Math.min(K, n)));
      const r = solveSubset(sub);
      stagesRun += 1;
      finalSub = sub;
      finalScores = r.scores;
      finalWeights = r.weights;
      selection = r.selection;
      finalStageSize = sub.length;
      if (K >= n) break;
      let covAns = 0;
      try {
        const texts = r.selection.indices.map((si: number) => candidates[sub[si]].snippetText);
        covAns = computeEvidenceCoverage(texts, assocEntities, requirements).answerCoverage;
      } catch {}
      if (covAns >= 1) break;
      stagePos += 1;
    }
  }

  // 6. 結果の構築
  const selectedIndices = selection.indices;
  let highlights: string[] = [];
  let highlightItems: RhoSelectV2HighlightItem[] = [];

  for (const si of selectedIndices) {
    const idx = finalSub[si];
    const cand = candidates[idx];
    highlights.push(cand.snippetText);
    highlightItems.push({
      text: cand.snippetText,
      score: Number(selection.rho.toFixed(4)),
      cost: cand.cost,
      evidenceScores: finalScores[si].map((s) => Number(s.toFixed(4))),
      heading: cand.heading || undefined,
    });
  }

  const certificate: RhoOptimizerCertificate = { ...selection.certificate };
  let warningMessage: string | undefined = undefined;

  // ハード K 制限のポストトランケーション対応 (指示書 第17条準拠)
  // canonical unconstrained で大域最適解を求めた後、もし明示的に highlightMaxCount が指定され、
  // かつ選出数がそれを上回る場合のみ、上位K件に安全にスライスし、証明書を postProcessed = true とする
  if (
    options.highlightMaxCount !== undefined &&
    options.highlightMaxCount !== null &&
    options.highlightMaxCount > 0 &&
    selectedIndices.length > options.highlightMaxCount
  ) {
    certificate.postProcessed = true;
    highlights = highlights.slice(0, options.highlightMaxCount);
    highlightItems = highlightItems.slice(0, options.highlightMaxCount);
    warningMessage = `highlightMaxCount (${options.highlightMaxCount}) was applied as post-selection truncation. Original optimal unconstrained set had ${selectedIndices.length} items with rho=${selection.rho.toFixed(6)}. Certificate reflects the pre-truncation unconstrained objective.`;
  }

  const selectedTokens = highlightItems.reduce((acc, item) => acc + item.cost, 0);
  let evidenceCoverage: { mentionCoverage: number; answerCoverage: number; coveredRequirements: string[]; answeredRequirements: string[]; missingRequirements: string[] } | null = null;
  try {
    evidenceCoverage = computeEvidenceCoverage(highlightItems.map((h) => h.text), assocEntities, requirements);
  } catch {}

  const diagnostics: RhoSelectV2Diagnostics = {
    engine: 'rho-select-v2',
    requirementsSource,
    requirements,
    requirementWeights: finalWeights.map((w) => Number(w.toFixed(4))),
    scoreReliability: { status: 'not_calibrated' },
    candidateCount: selection.diagnostics.candidateCount,
    keptCandidateCount: selection.diagnostics.keptCandidateCount,
    selectedCount: highlightItems.length,
    selectedTokens,
    utility: Number(selection.utility.toFixed(4)),
    cost: selection.cost,
    rho: Number(selection.rho.toFixed(6)),
    witnessSubsetBound: selection.diagnostics.witnessSubsetBound,
    certificate,
    ...(warningMessage ? { warning: warningMessage } : {}),
    ...(selection.diagnostics.history ? { history: selection.diagnostics.history } : {}),
    candidateExpansion: { initial: Math.min(12, n), final: finalStageSize, stages: stagesRun },
    ...(limitsApplied.length > 0 ? { limitsApplied } : {}),
    ...(evidenceCoverage ? {
      mentionCoverage: evidenceCoverage.mentionCoverage,
      answerCoverage: evidenceCoverage.answerCoverage,
      coveredRequirements: evidenceCoverage.coveredRequirements,
      answeredRequirements: evidenceCoverage.answeredRequirements,
      missingRequirements: evidenceCoverage.missingRequirements,
    } : {}),
  };

  return {
    highlights,
    highlightItems,
    certificate,
    diagnostics,
  };
}

/**
 * Resource guards for highlight extraction (spec section 53).
 * maxBlocks / maxExtractionMs are enforced inside the adapter.
 * maxHtmlBytes caps adapter input chars. maxTables / maxDomNodes are
 * enforced upstream (transport byte cap, parser table minimization).
 */
export interface ExtractionLimits {
  maxHtmlBytes?: number;
  maxBlocks?: number;
  maxTables?: number;
  maxDomNodes?: number;
  maxExtractionMs?: number;
}

export interface ExtractionEscalationOptions extends RhoSelectV2Options {
  /** Answer-coverage bar for skipping the recall pass. Default 0.5. */
  recallAnswerThreshold?: number;
}

/**
 * Trafilatura-style escalation (spec section 51):
 * Fast/precision extraction first; a relaxed recall pass runs only when
 * requirements exist yet answer coverage is weak. Returns the better
 * pass by answer coverage (ties keep precision). Never throws for
 * coverage reasons; time-boxed by limits.maxExtractionMs.
 */
export function extractWithEscalation(
  markdown: string,
  query: string,
  options: ExtractionEscalationOptions = {},
): RhoSelectV2Result {
  const t0 = Date.now();
  const precision = extractQueryHighlightsRhoV2(markdown, query, options);
  const stamp = (r: RhoSelectV2Result) => {
    try {
      (r.diagnostics as any).extractionMs = Date.now() - t0;
    } catch {}
    return r;
  };
  const reqs = precision.diagnostics.requirements || [];
  const precisionCoverage = precision.diagnostics.answerCoverage ?? 0;
  const budget = options.limits?.maxExtractionMs;
  const outOfTime = budget !== undefined && budget >= 0 && Date.now() - t0 >= budget;
  if (
    reqs.length === 0 ||
    precision.diagnostics.candidateCount === 0 ||
    precisionCoverage >= (options.recallAnswerThreshold ?? 0.5) ||
    outOfTime
  ) {
    try {
      (precision.diagnostics as any).escalation = {
        path: 'precision',
        reason:
          reqs.length === 0
            ? 'no-requirements'
            : precision.diagnostics.candidateCount === 0
              ? 'no-candidates'
              : outOfTime
                ? 'time-boxed'
                : 'sufficient',
      };
    } catch {}
    return stamp(precision);
  }
  const recall = extractQueryHighlightsRhoV2(markdown, query, {
    ...options,
    tau: (options.tau ?? options.overheadTokens ?? 96) * 2,
    maxTerms: (options.maxTerms ?? 6) + 4,
    adaptiveCandidate: true,
  });
  const recallCoverage = recall.diagnostics.answerCoverage ?? 0;
  const winner = recallCoverage > precisionCoverage ? recall : precision;
  try {
    (winner.diagnostics as any).escalation = {
      path: winner === recall ? 'recall' : 'precision',
      reason: `precision-answer:${precisionCoverage.toFixed(2)} recall-answer:${recallCoverage.toFixed(2)}`,
    };
  } catch {}
  return stamp(winner);
}
