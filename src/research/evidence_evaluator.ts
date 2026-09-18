/**
 * Sora Evidence Compiler Research — Quality & Performance Evaluator
 *
 * NOTE: This is a research-only module.
 * Evaluates Arm A, Arm B, and Arm C on precision, structural, adversarial, and synthetic corpora.
 */

import { estimateTokens } from '../enrichment.js';
import { tokenizeAndSelectTerms, type ParsedSection } from '../rho_select.js';
import {
  selectEvidenceSetRhoV2,
  type RhoEvidenceProblem,
  type RhoSolverOptions,
  type RhoOptimizerCertificate,
} from '../rho_select_v2.js';
import {
  type ResearchCandidateBlock,
  buildArmACandidates,
  buildArmBCandidates,
  buildArmCCandidates,
  reconstructArmCHighlights,
} from './evidence_atoms.js';
import {
  type BenchmarkTestCase,
} from './evidence_benchmark_fixtures.js';

export type AtomArm = 'ArmA' | 'ArmB' | 'ArmC';

export interface ArmExecutionResult {
  arm: AtomArm;
  testCaseId: string;
  candidateCount: number;
  selectedCount: number;
  selectedEvidenceChars: number;
  selectedEvidenceTokens: number;
  highlights: string[];
  requiredEvidenceRecall: boolean;
  distractorInclusion: boolean;
  structuralClosure: boolean;
  parseMs: number;
  atomizeMs: number;
  scoreMs: number;
  rhoSelectMs: number;
  renderMs: number;
  totalMs: number;
  heapUsedDelta: number;
}

export interface ArmSummaryMetrics {
  arm: AtomArm;
  testCaseCount: number;
  requiredEvidenceRecallRate: number; // 0.0 - 1.0
  distractorInclusionRate: number; // 0.0 - 1.0 (lower is better)
  structuralClosureRate: number; // 0.0 - 1.0
  avgSelectedChars: number;
  avgSelectedTokens: number;
  avgCandidateCount: number;
  avgSelectedCount: number;
  medianMs: number;
  p95Ms: number;
  avgHeapDeltaBytes: number;
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
 * Shared scoring and solver core identical to production extractQueryHighlightsRhoV2.
 * Isolates candidate construction from solver mechanics.
 */
export function solveCandidatesWithProductionRhoV2(
  rawCandidates: ResearchCandidateBlock[],
  query: string,
  options: {
    tau?: number;
    wHeading?: number;
    bHeading?: number;
    wBody?: number;
    bBody?: number;
    k1?: number;
    delta?: number;
    epsilon?: number;
    exactSubsetThreshold?: number;
    dominancePreprocess?: boolean;
    maxIterations?: number;
    maxStates?: number;
    maxTerms?: number;
  } = {},
): {
  selectedCandidates: ResearchCandidateBlock[];
  selectedIndices: number[];
  rho: number;
  certificate: RhoOptimizerCertificate;
  scoreMs: number;
  rhoSelectMs: number;
} {
  const tau = options.tau ?? 96;
  const wHeading = options.wHeading ?? 3.5;
  const bHeading = options.bHeading ?? 0.5;
  const wBody = options.wBody ?? 1.0;
  const bBody = options.bBody ?? 0.75;
  const k1 = options.k1 ?? 1.2;
  const delta = options.delta ?? 0.8;

  let candidates = [...rawCandidates];
  if (candidates.length === 0) {
    return {
      selectedCandidates: [],
      selectedIndices: [],
      rho: 0,
      certificate: {
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
      },
      scoreMs: 0,
      rhoSelectMs: 0,
    };
  }

  // 1. Requirements generation
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
  const requirements = termSelection.terms;

  if (requirements.length === 0) {
    return {
      selectedCandidates: [],
      selectedIndices: [],
      rho: 0,
      certificate: {
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
      },
      scoreMs: 0,
      rhoSelectMs: 0,
    };
  }

  // 2. Supplemental evidence fallback control
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

  const scoreStart = performance.now();
  const n = candidates.length;
  const m = requirements.length;

  let avgHeadingLen = 0;
  let avgBodyLen = 0;
  for (const c of candidates) {
    avgHeadingLen += c.heading.length;
    avgBodyLen += c.body.length;
  }
  avgHeadingLen = Math.max(avgHeadingLen / n, 1);
  avgBodyLen = Math.max(avgBodyLen / n, 1);

  const idfList: number[] = new Array(m);
  for (let t = 0; t < m; t++) {
    const req = requirements[t];
    let df = 0;
    for (const c of candidates) {
      if (
        c.heading.toLowerCase().includes(req.toLowerCase()) ||
        c.body.toLowerCase().includes(req.toLowerCase())
      ) {
        df++;
      }
    }
    idfList[t] = Math.max(0.1, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  const rawScores: number[][] = [];
  const maxRawPerRequirement = new Array(m).fill(0);

  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    const row: number[] = new Array(m);
    const normHLen = c.heading.length / avgHeadingLen;
    const normBLen = c.body.length / avgBodyLen;

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

      const evidence = idfList[t] * (((k1 + 1) * compositeTf) / (k1 + compositeTf) + delta);
      row[t] = evidence;
      if (evidence > maxRawPerRequirement[t]) {
        maxRawPerRequirement[t] = evidence;
      }
    }
    rawScores.push(row);
  }

  const normalizedScores: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = new Array(m);
    for (let t = 0; t < m; t++) {
      const maxVal = maxRawPerRequirement[t];
      row[t] = maxVal > 0 ? Math.min(Math.max(rawScores[i][t] / maxVal, 0), 1.0) : 0.0;
    }
    normalizedScores.push(row);
  }

  const sumIdf = idfList.reduce((acc, v) => acc + v, 0);
  const weights = sumIdf > 0 ? idfList.map((v) => (v / sumIdf) * m) : new Array(m).fill(1.0);
  const costs = candidates.map((c) => c.cost);

  const scoreEnd = performance.now();
  const scoreMs = scoreEnd - scoreStart;

  const rhoSelectStart = performance.now();
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
  const rhoSelectEnd = performance.now();
  const rhoSelectMs = rhoSelectEnd - rhoSelectStart;

  const selectedCandidates = selection.indices.map((idx) => candidates[idx]);

  return {
    selectedCandidates,
    selectedIndices: selection.indices,
    rho: selection.rho,
    certificate: selection.certificate,
    scoreMs,
    rhoSelectMs,
  };
}

/**
 * Executes an evaluation of a single testcase under a specified Arm.
 */
export function evaluateTestCaseUnderArm(
  testCase: BenchmarkTestCase,
  arm: AtomArm,
): ArmExecutionResult {
  const heapBefore = process.memoryUsage().heapUsed;
  const tTotalStart = performance.now();

  let tAtomizeStart = performance.now();
  let candidates: ResearchCandidateBlock[];

  if (arm === 'ArmA') {
    const res = buildArmACandidates(testCase.markdown, testCase.supplementalEvidence);
    candidates = res.candidates;
  } else if (arm === 'ArmB') {
    const res = buildArmBCandidates(testCase.markdown, testCase.supplementalEvidence);
    candidates = res.candidates;
  } else {
    const res = buildArmCCandidates(testCase.markdown, testCase.supplementalEvidence);
    candidates = res.candidates;
  }
  const tAtomizeEnd = performance.now();
  const atomizeMs = tAtomizeEnd - tAtomizeStart;

  const solveRes = solveCandidatesWithProductionRhoV2(candidates, testCase.query);

  const tRenderStart = performance.now();
  let highlights: string[] = [];
  if (arm === 'ArmC') {
    highlights = reconstructArmCHighlights(solveRes.selectedCandidates);
  } else {
    highlights = solveRes.selectedCandidates.map((c) => c.snippetText);
  }
  const tRenderEnd = performance.now();
  const renderMs = tRenderEnd - tRenderStart;

  const tTotalEnd = performance.now();
  const totalMs = tTotalEnd - tTotalStart;
  const heapAfter = process.memoryUsage().heapUsed;
  const heapUsedDelta = Math.max(0, heapAfter - heapBefore);

  const joinedHighlights = highlights.join('\n\n');
  const selectedChars = joinedHighlights.length;
  const selectedTokens = estimateTokens(joinedHighlights);

  // Recall evaluation: All required keywords must be in highlights
  const recall = testCase.requiredKeywords.every((kw) => joinedHighlights.includes(kw));

  // Distractor evaluation: None of distractor keywords should appear
  let distractorInclusion = false;
  if (testCase.distractorKeywords && testCase.distractorKeywords.length > 0) {
    distractorInclusion = testCase.distractorKeywords.some((dkw) => joinedHighlights.includes(dkw));
  }

  // Structural closure evaluation
  let structuralClosure = true;
  if (testCase.requiresStructuralClosure) {
    structuralClosure = testCase.requiresStructuralClosure.closureAssertion(highlights);
  }

  return {
    arm,
    testCaseId: testCase.id,
    candidateCount: candidates.length,
    selectedCount: solveRes.selectedCandidates.length,
    selectedEvidenceChars: selectedChars,
    selectedEvidenceTokens: selectedTokens,
    highlights,
    requiredEvidenceRecall: recall,
    distractorInclusion,
    structuralClosure,
    parseMs: atomizeMs * 0.2, // estimated portion
    atomizeMs,
    scoreMs: solveRes.scoreMs,
    rhoSelectMs: solveRes.rhoSelectMs,
    renderMs,
    totalMs,
    heapUsedDelta,
  };
}

/**
 * Runs suite of test cases across arms and calculates aggregate metrics.
 */
export function aggregateArmMetrics(
  results: ArmExecutionResult[],
  latencies: number[], // measured warmup/repeated latencies
): ArmSummaryMetrics {
  const n = results.length;
  if (n === 0) {
    return {
      arm: 'ArmA',
      testCaseCount: 0,
      requiredEvidenceRecallRate: 0,
      distractorInclusionRate: 0,
      structuralClosureRate: 0,
      avgSelectedChars: 0,
      avgSelectedTokens: 0,
      avgCandidateCount: 0,
      avgSelectedCount: 0,
      medianMs: 0,
      p95Ms: 0,
      avgHeapDeltaBytes: 0,
    };
  }

  const arm = results[0].arm;
  const recallCount = results.filter((r) => r.requiredEvidenceRecall).length;
  const distractorCount = results.filter((r) => r.distractorInclusion).length;
  const closureCount = results.filter((r) => r.structuralClosure).length;

  const totalChars = results.reduce((acc, r) => acc + r.selectedEvidenceChars, 0);
  const totalTokens = results.reduce((acc, r) => acc + r.selectedEvidenceTokens, 0);
  const totalCandidates = results.reduce((acc, r) => acc + r.candidateCount, 0);
  const totalSelected = results.reduce((acc, r) => acc + r.selectedCount, 0);
  const totalHeap = results.reduce((acc, r) => acc + r.heapUsedDelta, 0);

  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const medianMs =
    sortedLatencies.length > 0
      ? sortedLatencies[Math.floor(sortedLatencies.length * 0.5)]
      : 0;
  const p95Ms =
    sortedLatencies.length > 0
      ? sortedLatencies[Math.floor(sortedLatencies.length * 0.95)]
      : 0;

  return {
    arm,
    testCaseCount: n,
    requiredEvidenceRecallRate: Number((recallCount / n).toFixed(4)),
    distractorInclusionRate: Number((distractorCount / n).toFixed(4)),
    structuralClosureRate: Number((closureCount / n).toFixed(4)),
    avgSelectedChars: Math.round(totalChars / n),
    avgSelectedTokens: Math.round(totalTokens / n),
    avgCandidateCount: Number((totalCandidates / n).toFixed(1)),
    avgSelectedCount: Number((totalSelected / n).toFixed(1)),
    medianMs: Number(medianMs.toFixed(3)),
    p95Ms: Number(p95Ms.toFixed(3)),
    avgHeapDeltaBytes: Math.round(totalHeap / n),
  };
}
