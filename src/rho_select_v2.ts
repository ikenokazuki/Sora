/**
 * ρSelect v2: Query-Specific Optimality Certificates for Cost-Aware Evidence Set Selection
 *
 * Paper Canonical Specification: rho_select_paper_spec_v100.md
 * Gemini Implementation Spec: v1.0 (media_1789022645848.md)
 *
 * 目的関数:
 *   max_{S ⊆ V} ρ_τ(S) = Φ(y(S)) / (τ + C(S))
 *   y_t(S) = max_{i ∈ S} r_{it}
 *
 * 特徴:
 * - 連続/段階的エビデンス値 r_{it} ∈ [0, 1]
 * - 外部の固定基数制約 K なし (Canonical Unconstrained Mode)
 * - State-Witness Sparsity 定理 (|S*| ≤ m)
 * - 観測値状態空間 (Observed-Value State Space) 上の Exact DP
 * - 粗視化適応的細分化 (Adaptive Refinement: AR) による LB/UB 証明書
 * - Fail-Closed な入力検証と証明書監査
 */

export type RhoUtilitySpec =
  | {
      kind: 'weighted-sum';
      weights: number[];
    }
  | {
      kind: 'grouped-min';
      groups: number[][];
      groupWeights: number[];
    };

export interface RhoEvidenceProblem {
  scores: number[][]; // shape: n candidates x m requirements, each in [0,1]
  costs: number[];    // length n, finite and strictly positive
  tau: number;        // finite, > 0
  utility: RhoUtilitySpec;
}

export interface RhoSolverOptions {
  epsilon?: number; // default 0.05, 0 <= eps < 1
  exactSubsetThreshold?: number; // default 50_000
  dominancePreprocess?: boolean; // default true
  maxIterations?: number; // default 100
  maxStates?: number; // default 500_000 (resource guard)
}

export type RhoSolverKind = 'exact' | 'ar';

export interface RhoOptimizerCertificate {
  scope: 'score_defined_objective_only';
  valid: boolean;
  solver: RhoSolverKind;
  lowerBound: number;
  upperBound: number;
  relativeGap: number;
  epsilon: number;
  exact: boolean;
  iterations: number;
  postProcessed: boolean;
}

export interface RhoV2DiagnosticsHistoryItem {
  iteration: number;
  stateCount: number;
  lowerBound: number;
  upperBound: number;
  relativeGap: number;
  partitionSizes: number[];
}

export interface RhoV2SelectionResult {
  indices: number[];
  utility: number;
  cost: number;
  rho: number;
  certificate: RhoOptimizerCertificate;
  diagnostics: {
    candidateCount: number;
    requirementCount: number;
    keptCandidateCount: number;
    witnessSubsetBound: string;
    stateCount?: number;
    history?: RhoV2DiagnosticsHistoryItem[];
  };
}

export class RhoResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RhoResourceLimitError';
  }
}

/**
 * 効用関数 Φ(y) の計算
 * coordinate-wise monotone であることが保証された built-in spec のみ評価
 */
export function evaluateUtility(y: number[], spec: RhoUtilitySpec): number {
  if (spec.kind === 'weighted-sum') {
    let sum = 0;
    const weights = spec.weights;
    for (let t = 0; t < y.length; t++) {
      sum += weights[t] * y[t];
    }
    return sum;
  } else if (spec.kind === 'grouped-min') {
    let sum = 0;
    const groups = spec.groups;
    const groupWeights = spec.groupWeights;
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      let minVal = 1.0;
      for (let i = 0; i < grp.length; i++) {
        const val = y[grp[i]];
        if (val < minVal) minVal = val;
      }
      sum += groupWeights[g] * minVal;
    }
    return sum;
  }
  throw new Error(`Unknown utility spec kind`);
}

/**
 * 入力バリデーション — Fail-Closed
 * 不正値は一切 silent clip せず即座に throw する
 */
export function validateEvidenceProblem(problem: RhoEvidenceProblem, options?: RhoSolverOptions): void {
  if (!problem || typeof problem !== 'object') {
    throw new Error('RhoEvidenceProblem must be a non-null object');
  }

  const { scores, costs, tau, utility } = problem;

  // tau 検証
  if (typeof tau !== 'number' || !Number.isFinite(tau) || tau <= 0) {
    throw new Error(`Invalid tau: ${tau}. Must be a finite number > 0`);
  }

  // scores 検証
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new Error('scores must be a non-empty 2D array');
  }
  const n = scores.length;
  if (!Array.isArray(scores[0]) || scores[0].length === 0) {
    throw new Error('scores[0] must be a non-empty array of requirements');
  }
  const m = scores[0].length;

  for (let i = 0; i < n; i++) {
    const row = scores[i];
    if (!Array.isArray(row) || row.length !== m) {
      throw new Error(`Ragged scores array at row ${i}: expected length ${m}, got ${row?.length}`);
    }
    for (let t = 0; t < m; t++) {
      const s = row[t];
      if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 1) {
        throw new Error(`Invalid score at (${i}, ${t}): ${s}. Must be in [0, 1]`);
      }
    }
  }

  // costs 検証
  if (!Array.isArray(costs) || costs.length !== n) {
    throw new Error(`costs length mismatch: expected ${n}, got ${costs?.length}`);
  }
  for (let i = 0; i < n; i++) {
    const c = costs[i];
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) {
      throw new Error(`Invalid cost at index ${i}: ${c}. Must be finite and strictly > 0`);
    }
  }

  // utility 検証
  if (!utility || typeof utility !== 'object') {
    throw new Error('utility must be a non-null object');
  }
  if (utility.kind === 'weighted-sum') {
    if (!Array.isArray(utility.weights) || utility.weights.length !== m) {
      throw new Error(`utility.weights length mismatch: expected ${m}, got ${utility.weights?.length}`);
    }
    let totalWeight = 0;
    for (let t = 0; t < m; t++) {
      const w = utility.weights[t];
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
        throw new Error(`Invalid weight at index ${t}: ${w}. Must be finite and >= 0`);
      }
      totalWeight += w;
    }
    if (totalWeight <= 0) {
      throw new Error('Total utility weight must be strictly positive');
    }
  } else if (utility.kind === 'grouped-min') {
    const { groups, groupWeights } = utility;
    if (!Array.isArray(groups) || groups.length === 0) {
      throw new Error('groups must be a non-empty array');
    }
    if (!Array.isArray(groupWeights) || groupWeights.length !== groups.length) {
      throw new Error('groupWeights length mismatch with groups');
    }
    let totalWeight = 0;
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      if (!Array.isArray(grp) || grp.length === 0) {
        throw new Error(`Group ${g} must be a non-empty array of requirement indices`);
      }
      for (let i = 0; i < grp.length; i++) {
        const reqIdx = grp[i];
        if (!Number.isInteger(reqIdx) || reqIdx < 0 || reqIdx >= m) {
          throw new Error(`Invalid requirement index ${reqIdx} in group ${g}. Must be in [0, ${m - 1}]`);
        }
      }
      const gw = groupWeights[g];
      if (typeof gw !== 'number' || !Number.isFinite(gw) || gw < 0) {
        throw new Error(`Invalid groupWeight at ${g}: ${gw}. Must be finite and >= 0`);
      }
      totalWeight += gw;
    }
    if (totalWeight <= 0) {
      throw new Error('Total groupWeight must be strictly positive');
    }
  } else {
    throw new Error(`Unsupported utility kind: ${(utility as any)?.kind}`);
  }

  // options 検証
  if (options) {
    if (options.epsilon !== undefined) {
      if (typeof options.epsilon !== 'number' || !Number.isFinite(options.epsilon) || options.epsilon < 0 || options.epsilon >= 1) {
        throw new Error(`Invalid epsilon: ${options.epsilon}. Must be in [0, 1)`);
      }
    }
    if (options.exactSubsetThreshold !== undefined) {
      if (typeof options.exactSubsetThreshold !== 'number' || options.exactSubsetThreshold < 1) {
        throw new Error('exactSubsetThreshold must be >= 1');
      }
    }
    if (options.maxIterations !== undefined) {
      if (typeof options.maxIterations !== 'number' || options.maxIterations < 1) {
        throw new Error('maxIterations must be >= 1');
      }
    }
    if (options.maxStates !== undefined) {
      if (typeof options.maxStates !== 'number' || options.maxStates < 1) {
        throw new Error('maxStates must be >= 1');
      }
    }
  }
}

/**
 * State-Witness Sparsity に基づく部分集合探索総数の上界計算
 * sum_{k=1}^{min(n, m)} C(n, k)
 * BigInt で正確に計算
 */
export function computeWitnessSubsetBound(n: number, m: number): bigint {
  const kMax = Math.min(n, m);
  let total = 0n;

  // C(n, k) の計算
  for (let k = 1; k <= kMax; k++) {
    let c = 1n;
    for (let i = 1; i <= k; i++) {
      c = (c * BigInt(n - i + 1)) / BigInt(i);
    }
    total += c;
  }
  return total;
}

/**
 * Safe Dominance 剪定
 * 候補 a が b を支配する条件:
 *   cost[a] <= cost[b] かつ ∀t: scores[a][t] >= scores[b][t]
 * 少なくとも1つのスコアまたはコストで真に優れている場合、b をパージ。
 * 完全重複 (cost[a] == cost[b] かつ scores[a] == scores[b]) の場合は、元のインデックスが小さい方を残す。
 */
export function applySafeDominance(
  scores: number[][],
  costs: number[],
): { keptIndices: number[]; keptScores: number[][]; keptCosts: number[] } {
  const n = scores.length;
  const m = scores[0].length;
  const dominated = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    if (dominated[i]) continue;
    const costI = costs[i];
    const scoresI = scores[i];

    for (let j = 0; j < n; j++) {
      if (i === j || dominated[j]) continue;
      const costJ = costs[j];
      const scoresJ = scores[j];

      // i が j を支配できるか判定
      if (costI <= costJ) {
        let allGreaterOrEqual = true;
        let strictImprovement = costI < costJ;

        for (let t = 0; t < m; t++) {
          if (scoresI[t] < scoresJ[t]) {
            allGreaterOrEqual = false;
            break;
          }
          if (scoresI[t] > scoresJ[t]) {
            strictImprovement = true;
          }
        }

        if (allGreaterOrEqual) {
          if (strictImprovement) {
            dominated[j] = 1;
          } else {
            // 完全重複: インデックスが小さい方を残す
            if (i < j) {
              dominated[j] = 1;
            } else {
              dominated[i] = 1;
              break;
            }
          }
        }
      }
    }
  }

  const keptIndices: number[] = [];
  const keptScores: number[][] = [];
  const keptCosts: number[] = [];

  for (let i = 0; i < n; i++) {
    if (!dominated[i]) {
      keptIndices.push(i);
      keptScores.push(scores[i]);
      keptCosts.push(costs[i]);
    }
  }

  return { keptIndices, keptScores, keptCosts };
}

/**
 * タイブレーク比較関数
 * 1. larger rho
 * 2. lower cost
 * 3. fewer candidates
 * 4. lexicographically smaller original-index list
 */
function isBetterCandidateSet(
  rhoA: number,
  costA: number,
  picksA: number[],
  rhoB: number,
  costB: number,
  picksB: number[],
): boolean {
  const TOL = 1e-12;
  if (Math.abs(rhoA - rhoB) > TOL) {
    return rhoA > rhoB;
  }
  if (Math.abs(costA - costB) > TOL) {
    return costA < costB;
  }
  if (picksA.length !== picksB.length) {
    return picksA.length < picksB.length;
  }
  // 辞書順比較
  const len = picksA.length;
  for (let i = 0; i < len; i++) {
    if (picksA[i] !== picksB[i]) {
      return picksA[i] < picksB[i];
    }
  }
  return false;
}

/**
 * Exact Observed-State DP
 * 各 requirement のユニーク観測スコアを rank index に変換し、
 * 各到達可能 rank state における最小コストと選択候補リストを保持する
 */
export function solveExactObservedStateDP(
  problem: RhoEvidenceProblem,
  originalIndices: number[],
  maxStates = 500_000,
): {
  bestIndices: number[];
  bestUtility: number;
  bestCost: number;
  bestRho: number;
  stateCount: number;
} {
  const { scores, costs, tau, utility } = problem;
  const n = scores.length;
  const m = scores[0].length;

  // 1. 各 requirement t のユニーク値をソートして rank index への写像を作成
  const observedValues: number[][] = [];
  for (let t = 0; t < m; t++) {
    const valSet = new Set<number>();
    valSet.add(0.0);
    for (let i = 0; i < n; i++) {
      valSet.add(scores[i][t]);
    }
    const sorted = Array.from(valSet).sort((a, b) => a - b);
    observedValues.push(sorted);
  }

  // candidate のスコアを rank vector に変換
  const candidateRanks: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ranks: number[] = new Array(m);
    for (let t = 0; t < m; t++) {
      // 二分探索で rank を特定
      const s = scores[i][t];
      const arr = observedValues[t];
      let low = 0;
      let high = arr.length - 1;
      let found = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (arr[mid] === s) {
          found = mid;
          break;
        } else if (arr[mid] < s) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      ranks[t] = found;
    }
    candidateRanks.push(ranks);
  }

  // 2. Exact DP: 状態キーを文字列として管理
  interface DPState {
    ranks: number[];
    cost: number;
    picks: number[]; // original indices
  }

  let stateMap = new Map<string, DPState>();
  const initialRanks = new Array(m).fill(0);
  stateMap.set(initialRanks.join(','), {
    ranks: initialRanks,
    cost: 0,
    picks: [],
  });

  for (let i = 0; i < n; i++) {
    const candRanks = candidateRanks[i];
    const candCost = costs[i];
    const origIdx = originalIndices[i];

    const nextEntries: DPState[] = [];

    for (const [key, state] of stateMap.entries()) {
      // 遷移後の rank を計算
      const nextRanks: number[] = new Array(m);
      let changed = false;
      for (let t = 0; t < m; t++) {
        const r = Math.max(state.ranks[t], candRanks[t]);
        nextRanks[t] = r;
        if (r !== state.ranks[t]) changed = true;
      }

      // candidate がすでにカバーされている場合でも、コスト増加となるため
      // 状態が変わらない場合は通常スキップ
      if (!changed && state.picks.length > 0) {
        continue;
      }

      const nextCost = state.cost + candCost;
      const nextPicks = [...state.picks, origIdx].sort((a, b) => a - b);

      nextEntries.push({
        ranks: nextRanks,
        cost: nextCost,
        picks: nextPicks,
      });
    }

    for (const item of nextEntries) {
      const key = item.ranks.join(',');
      const existing = stateMap.get(key);
      if (!existing) {
        if (stateMap.size >= maxStates) {
          throw new RhoResourceLimitError(`Exact DP state limit exceeded: ${maxStates}`);
        }
        stateMap.set(key, item);
      } else {
        // コスト最小化、タイブレークで更新
        if (item.cost < existing.cost) {
          stateMap.set(key, item);
        } else if (item.cost === existing.cost) {
          if (
            item.picks.length < existing.picks.length ||
            (item.picks.length === existing.picks.length && item.picks.join(',') < existing.picks.join(','))
          ) {
            stateMap.set(key, item);
          }
        }
      }
    }
  }

  // 3. 全到達可能状態から最適な目的関数値 ρ を選択
  let bestIndices: number[] = [];
  let bestUtility = 0;
  let bestCost = 0;
  let bestRho = 0;
  let hasSelection = false;

  for (const state of stateMap.values()) {
    if (state.picks.length === 0) continue;

    // actual state values を復元
    const actualValues = new Array(m);
    for (let t = 0; t < m; t++) {
      actualValues[t] = observedValues[t][state.ranks[t]];
    }

    const u = evaluateUtility(actualValues, utility);
    const c = state.cost;
    const rho = u / (tau + c);

    if (
      !hasSelection ||
      isBetterCandidateSet(rho, c, state.picks, bestRho, bestCost, bestIndices)
    ) {
      bestIndices = state.picks;
      bestUtility = u;
      bestCost = c;
      bestRho = rho;
      hasSelection = true;
    }
  }

  return {
    bestIndices,
    bestUtility,
    bestCost,
    bestRho,
    stateCount: stateMap.size,
  };
}

/**
 * Generalized Density Greedy Seed (AR の初期 Incumbent 用)
 * gain / cost が fractional objective を真に改善する間だけ追加する
 */
export function computeGreedyIncumbent(
  problem: RhoEvidenceProblem,
  originalIndices: number[],
): { indices: number[]; utility: number; cost: number; rho: number } {
  const { scores, costs, tau, utility } = problem;
  const n = scores.length;
  const m = scores[0].length;

  const currentY = new Array(m).fill(0);
  let currentCost = 0;
  let currentU = evaluateUtility(currentY, utility);
  let currentRho = currentU / tau;
  const selectedIndices: number[] = [];
  const used = new Uint8Array(n);

  while (true) {
    let bestGainRatio = -1;
    let bestCand = -1;
    let bestNextRho = currentRho;
    let bestNextU = currentU;
    let bestNextCost = currentCost;

    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const nextY = new Array(m);
      for (let t = 0; t < m; t++) {
        nextY[t] = Math.max(currentY[t], scores[i][t]);
      }
      const u = evaluateUtility(nextY, utility);
      const c = currentCost + costs[i];
      const gain = u - currentU;
      if (gain <= 0) continue;

      const gainRatio = gain / costs[i];
      const nextRho = u / (tau + c);

      // fractional objective が改善し、gain ratio が最も高いものを探索
      if (nextRho > currentRho && (gainRatio > bestGainRatio || (Math.abs(gainRatio - bestGainRatio) < 1e-12 && nextRho > bestNextRho))) {
        bestGainRatio = gainRatio;
        bestCand = i;
        bestNextRho = nextRho;
        bestNextU = u;
        bestNextCost = c;
      }
    }

    if (bestCand === -1) {
      break;
    }

    used[bestCand] = 1;
    for (let t = 0; t < m; t++) {
      currentY[t] = Math.max(currentY[t], scores[bestCand][t]);
    }
    currentCost = bestNextCost;
    currentU = bestNextU;
    currentRho = bestNextRho;
    selectedIndices.push(originalIndices[bestCand]);
  }

  selectedIndices.sort((a, b) => a - b);
  return {
    indices: selectedIndices,
    utility: currentU,
    cost: currentCost,
    rho: currentRho,
  };
}

/**
 * Adaptive Refinement (AR) Solver
 * 観測値の粗視化分割から開始し、グローバル上界を支配するセルを二分細分化しながら
 * feasible な LB とグローバル UB を計算して (UB - LB) / UB <= epsilon で停止する
 */
export function solveAdaptiveRefinement(
  problem: RhoEvidenceProblem,
  originalIndices: number[] = Array.from({ length: problem.scores.length }, (_, i) => i),
  options: RhoSolverOptions = {},
): {
  bestIndices: number[];
  bestUtility: number;
  bestCost: number;
  bestRho: number;
  lowerBound: number;
  upperBound: number;
  relativeGap: number;
  iterations: number;
  history: RhoV2DiagnosticsHistoryItem[];
  finalStateCount: number;
} {
  const { scores, costs, tau, utility } = problem;
  const n = scores.length;
  const m = scores[0].length;
  const epsilon = options.epsilon ?? 0.05;
  const maxIterations = options.maxIterations ?? 100;
  const maxStates = options.maxStates ?? 500_000;

  // 1. 各 requirement のユニーク値を抽出
  const observedValues: number[][] = [];
  for (let t = 0; t < m; t++) {
    const valSet = new Set<number>();
    valSet.add(0.0);
    for (let i = 0; i < n; i++) {
      valSet.add(scores[i][t]);
    }
    observedValues.push(Array.from(valSet).sort((a, b) => a - b));
  }

  // 候補スコアの exact rank
  const candidateRanks: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ranks: number[] = new Array(m);
    for (let t = 0; t < m; t++) {
      const s = scores[i][t];
      const arr = observedValues[t];
      let low = 0;
      let high = arr.length - 1;
      let found = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (arr[mid] === s) {
          found = mid;
          break;
        } else if (arr[mid] < s) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      ranks[t] = found;
    }
    candidateRanks.push(ranks);
  }

  // 2. 初期パーティションの作成:
  // rank 0 は singleton cell [0, 0]、positive ranks は 1 つの cell [1, maxRank]
  // partition[t] はセル定義の配列: 各セルは rank の昇順配列 [r_start, ..., r_end]
  let partitions: number[][][] = [];
  for (let t = 0; t < m; t++) {
    const numRanks = observedValues[t].length;
    const cells: number[][] = [[0]];
    if (numRanks > 1) {
      const posCell: number[] = [];
      for (let r = 1; r < numRanks; r++) {
        posCell.push(r);
      }
      cells.push(posCell);
    }
    partitions.push(cells);
  }

  // 初期 Greedy Incumbent を計算し、初期 LB とする
  const greedy = computeGreedyIncumbent(problem, originalIndices);
  let incumbentIndices = greedy.indices;
  let incumbentUtility = greedy.utility;
  let incumbentCost = greedy.cost;
  let incumbentRho = greedy.rho;

  let globalLB = incumbentRho;
  let globalUB = Infinity;
  let finalRelativeGap = 1.0;
  let finalStateCount = 0;

  const history: RhoV2DiagnosticsHistoryItem[] = [];

  for (let iter = 1; iter <= maxIterations; iter++) {
    // 3. Coarse Projection: 各 candidate の exact rank を cell index に写す
    const candidateCellIndices: number[][] = [];
    for (let i = 0; i < n; i++) {
      const cellIdxs: number[] = new Array(m);
      for (let t = 0; t < m; t++) {
        const r = candidateRanks[i][t];
        const cells = partitions[t];
        let foundCell = 0;
        for (let c = 0; c < cells.length; c++) {
          if (cells[c].includes(r)) {
            foundCell = c;
            break;
          }
        }
        cellIdxs[t] = foundCell;
      }
      candidateCellIndices.push(cellIdxs);
    }

    // 4. Coarse DP
    interface CoarseState {
      cellIndices: number[];
      minCost: number;
      picks: number[]; // original indices
    }

    const coarseMap = new Map<string, CoarseState>();
    const initCells = new Array(m).fill(0);
    coarseMap.set(initCells.join(','), {
      cellIndices: initCells,
      minCost: 0,
      picks: [],
    });

    for (let i = 0; i < n; i++) {
      const candCells = candidateCellIndices[i];
      const candCost = costs[i];
      const origIdx = originalIndices[i];

      const nextCoarse: CoarseState[] = [];

      for (const state of coarseMap.values()) {
        const nextCellIdxs: number[] = new Array(m);
        let changed = false;
        for (let t = 0; t < m; t++) {
          const c = Math.max(state.cellIndices[t], candCells[t]);
          nextCellIdxs[t] = c;
          if (c !== state.cellIndices[t]) changed = true;
        }

        if (!changed && state.picks.length > 0) continue;

        const nextCost = state.minCost + candCost;
        const nextPicks = [...state.picks, origIdx].sort((a, b) => a - b);

        nextCoarse.push({
          cellIndices: nextCellIdxs,
          minCost: nextCost,
          picks: nextPicks,
        });
      }

      for (const item of nextCoarse) {
        const key = item.cellIndices.join(',');
        const existing = coarseMap.get(key);
        if (!existing) {
          if (coarseMap.size >= maxStates) {
            throw new RhoResourceLimitError(`Adaptive Refinement state limit exceeded: ${maxStates}`);
          }
          coarseMap.set(key, item);
        } else {
          if (item.minCost < existing.minCost) {
            coarseMap.set(key, item);
          } else if (item.minCost === existing.minCost) {
            if (
              item.picks.length < existing.picks.length ||
              (item.picks.length === existing.picks.length && item.picks.join(',') < existing.picks.join(','))
            ) {
              coarseMap.set(key, item);
            }
          }
        }
      }
    }

    finalStateCount = coarseMap.size;

    // 5. Coarse State ごとに Upper Bound と Feasible Lower Bound を評価
    let currentIterUB = 0;
    let dominatingCoarseKey = '';
    let dominatingCoarseState: CoarseState | null = null;

    for (const [key, state] of coarseMap.entries()) {
      if (state.picks.length === 0) continue;

      // 5.1 Feasible LB の更新: 代表 set を true score で再評価
      const actualY = new Array(m).fill(0);
      for (const pickOrig of state.picks) {
        // 元の index からスコアを取得
        const origPos = originalIndices.indexOf(pickOrig);
        if (origPos !== -1) {
          for (let t = 0; t < m; t++) {
            actualY[t] = Math.max(actualY[t], scores[origPos][t]);
          }
        }
      }
      const trueU = evaluateUtility(actualY, utility);
      const trueCost = state.minCost;
      const trueRho = trueU / (tau + trueCost);

      if (
        trueRho > incumbentRho ||
        (Math.abs(trueRho - incumbentRho) < 1e-12 &&
          isBetterCandidateSet(trueRho, trueCost, state.picks, incumbentRho, incumbentCost, incumbentIndices))
      ) {
        incumbentRho = trueRho;
        incumbentUtility = trueU;
        incumbentCost = trueCost;
        incumbentIndices = state.picks;
      }

      // 5.2 Upper Bound ub(z) = Φ(b_z) / (tau + minCost)
      // b_z は各 cell の最大 actual score
      const bZ = new Array(m);
      for (let t = 0; t < m; t++) {
        const cellIdx = state.cellIndices[t];
        const cellRanks = partitions[t][cellIdx];
        const maxRankInCell = cellRanks[cellRanks.length - 1];
        bZ[t] = observedValues[t][maxRankInCell];
      }

      const optimisticU = evaluateUtility(bZ, utility);
      const ubZ = optimisticU / (tau + state.minCost);

      if (ubZ > currentIterUB) {
        currentIterUB = ubZ;
        dominatingCoarseKey = key;
        dominatingCoarseState = state;
      }
    }

    // LB は単調非減少
    if (incumbentRho > globalLB) {
      globalLB = incumbentRho;
    }
    // UB は単調非増加
    if (currentIterUB < globalUB) {
      globalUB = currentIterUB;
    }

    // gap 計算
    finalRelativeGap = globalUB <= 0 ? 0 : Math.max(0, (globalUB - globalLB) / globalUB);

    const partitionSizes = partitions.map((p) => p.length);
    history.push({
      iteration: iter,
      stateCount: coarseMap.size,
      lowerBound: globalLB,
      upperBound: globalUB,
      relativeGap: finalRelativeGap,
      partitionSizes,
    });

    // 停止条件判定
    if (finalRelativeGap <= epsilon + 1e-12) {
      break;
    }

    // 6. Refinement: global UB を支配する coarse state から non-singleton cell を分割
    let refinedAny = false;

    if (dominatingCoarseState) {
      // 支配状態が参照している各 requirement の cell をチェック
      for (let t = 0; t < m; t++) {
        const cellIdx = dominatingCoarseState.cellIndices[t];
        const cellRanks = partitions[t][cellIdx];
        if (cellRanks.length > 1) {
          // median で二分割
          const mid = Math.floor(cellRanks.length / 2);
          const left = cellRanks.slice(0, mid);
          const right = cellRanks.slice(mid);

          // partitions[t] の cellIdx を left と right に置換
          partitions[t].splice(cellIdx, 1, left, right);
          refinedAny = true;
          break; // 1 iteration あたり 1 cell 分割
        }
      }
    }

    // 支配状態に non-singleton cell がない場合、他の non-singleton cell を探す
    if (!refinedAny) {
      for (let t = 0; t < m; t++) {
        for (let c = 0; c < partitions[t].length; c++) {
          if (partitions[t][c].length > 1) {
            const cellRanks = partitions[t][c];
            const mid = Math.floor(cellRanks.length / 2);
            partitions[t].splice(c, 1, cellRanks.slice(0, mid), cellRanks.slice(mid));
            refinedAny = true;
            break;
          }
        }
        if (refinedAny) break;
      }
    }

    // もはや細分化可能なセルがないのに gap > epsilon なら不変条件違反
    if (!refinedAny) {
      // 全て exact singleton に到達したはず
      // この場合、UB は LB と完全に一致しているはずである
      if (finalRelativeGap > 1e-6) {
        throw new Error(`Adaptive Refinement failed: no refinable cells remaining, but relative gap (${finalRelativeGap}) > tolerance`);
      }
      break;
    }
  }

  return {
    bestIndices: incumbentIndices,
    bestUtility: incumbentUtility,
    bestCost: incumbentCost,
    bestRho: incumbentRho,
    lowerBound: globalLB,
    upperBound: globalUB,
    relativeGap: finalRelativeGap,
    iterations: history.length,
    history,
    finalStateCount,
  };
}

/**
 * AR Certificate 独立監査 — 必須
 * 違反があれば即座に fail closed で throw する
 */
export function auditRhoCertificate(
  certificate: RhoOptimizerCertificate,
  history: RhoV2DiagnosticsHistoryItem[] | undefined,
  bestRho: number,
): void {
  const TOL = 1e-9;

  if (certificate.scope !== 'score_defined_objective_only') {
    throw new Error(`Certificate scope mismatch: ${certificate.scope}`);
  }
  if (!certificate.valid) {
    throw new Error('Certificate is marked invalid');
  }
  if (!Number.isFinite(certificate.lowerBound) || !Number.isFinite(certificate.upperBound)) {
    throw new Error('Non-finite bounds in certificate');
  }
  if (certificate.lowerBound > certificate.upperBound + TOL) {
    throw new Error(`Lower bound (${certificate.lowerBound}) exceeds upper bound (${certificate.upperBound})`);
  }
  if (certificate.solver === 'exact') {
    if (Math.abs(certificate.lowerBound - certificate.upperBound) > TOL || certificate.relativeGap > TOL) {
      throw new Error('Exact solver must have relativeGap = 0 and LB == UB');
    }
    return;
  }

  // AR ソルバーの監査
  if (!history || history.length === 0) {
    throw new Error('Missing history for AR certificate audit');
  }

  let prevLB = -Infinity;
  let prevUB = Infinity;

  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (!Number.isFinite(item.lowerBound) || !Number.isFinite(item.upperBound)) {
      throw new Error(`Non-finite bounds at history iteration ${item.iteration}`);
    }
    if (item.lowerBound > item.upperBound + TOL) {
      throw new Error(`LB > UB at history iteration ${item.iteration}`);
    }
    if (item.lowerBound < prevLB - TOL) {
      throw new Error(`LB decreased at history iteration ${item.iteration}: ${item.lowerBound} < ${prevLB}`);
    }
    if (item.upperBound > prevUB + TOL) {
      throw new Error(`UB increased at history iteration ${item.iteration}: ${item.upperBound} > ${prevUB}`);
    }

    const recomputedGap = item.upperBound <= 0 ? 0 : Math.max(0, (item.upperBound - item.lowerBound) / item.upperBound);
    if (Math.abs(recomputedGap - item.relativeGap) > 1e-6) {
      throw new Error(`Gap mismatch at history iteration ${item.iteration}`);
    }

    prevLB = item.lowerBound;
    prevUB = item.upperBound;
  }

  const finalItem = history[history.length - 1];
  if (Math.abs(certificate.lowerBound - finalItem.lowerBound) > TOL || Math.abs(certificate.upperBound - finalItem.upperBound) > TOL) {
    throw new Error('Final certificate bounds do not match final history bounds');
  }
  if (Math.abs(bestRho - certificate.lowerBound) > TOL) {
    throw new Error(`Returned rho (${bestRho}) does not match lower bound (${certificate.lowerBound})`);
  }
  if (certificate.relativeGap > certificate.epsilon + TOL) {
    throw new Error(`Relative gap (${certificate.relativeGap}) exceeds epsilon (${certificate.epsilon})`);
  }
}

/**
 * 低レベル第一級ソルバーエントリーポイント
 * selectEvidenceSetRhoV2
 */
export function selectEvidenceSetRhoV2(
  problem: RhoEvidenceProblem,
  options: RhoSolverOptions = {},
): RhoV2SelectionResult {
  // 1. Fail-closed 入力検証
  validateEvidenceProblem(problem, options);

  const rawN = problem.scores.length;
  const rawM = problem.scores[0].length;
  const exactThreshold = options.exactSubsetThreshold ?? 50_000;
  const dominancePreprocess = options.dominancePreprocess ?? true;
  const epsilon = options.epsilon ?? 0.05;

  // 2. Raw witness bound 計算
  const rawWitnessBound = computeWitnessSubsetBound(rawN, rawM);

  // 3. Safe Dominance 剪定
  let workingProblem = problem;
  let keptOriginalIndices: number[] = Array.from({ length: rawN }, (_, i) => i);

  if (dominancePreprocess) {
    // raw bound が threshold 超過時、または明示的に剪定が有効な場合に実行
    const pruned = applySafeDominance(problem.scores, problem.costs);
    keptOriginalIndices = pruned.keptIndices;
    workingProblem = {
      ...problem,
      scores: pruned.keptScores,
      costs: pruned.keptCosts,
    };
  }

  const keptN = workingProblem.scores.length;
  const finalWitnessBound = computeWitnessSubsetBound(keptN, rawM);

  // 4. Hybrid Dispatch: Exact vs Adaptive Refinement (AR)
  const shouldUseExact = finalWitnessBound <= BigInt(exactThreshold);

  let indices: number[] = [];
  let utility = 0;
  let cost = 0;
  let rho = 0;
  let certificate: RhoOptimizerCertificate;
  let stateCount = 0;
  let history: RhoV2DiagnosticsHistoryItem[] | undefined;

  if (shouldUseExact) {
    const exactRes = solveExactObservedStateDP(
      workingProblem,
      keptOriginalIndices,
      options.maxStates ?? 500_000,
    );
    indices = exactRes.bestIndices;
    utility = exactRes.bestUtility;
    cost = exactRes.bestCost;
    rho = exactRes.bestRho;
    stateCount = exactRes.stateCount;

    certificate = {
      scope: 'score_defined_objective_only',
      valid: true,
      solver: 'exact',
      lowerBound: rho,
      upperBound: rho,
      relativeGap: 0,
      epsilon,
      exact: true,
      iterations: 1,
      postProcessed: false,
    };
  } else {
    const arRes = solveAdaptiveRefinement(
      workingProblem,
      keptOriginalIndices,
      options,
    );
    indices = arRes.bestIndices;
    utility = arRes.bestUtility;
    cost = arRes.bestCost;
    rho = arRes.bestRho;
    stateCount = arRes.finalStateCount;
    history = arRes.history;

    certificate = {
      scope: 'score_defined_objective_only',
      valid: true,
      solver: 'ar',
      lowerBound: arRes.lowerBound,
      upperBound: arRes.upperBound,
      relativeGap: arRes.relativeGap,
      epsilon,
      exact: arRes.relativeGap === 0,
      iterations: arRes.iterations,
      postProcessed: false,
    };
  }

  // 5. 独立監査器による証明書検証
  auditRhoCertificate(certificate, history, rho);

  return {
    indices,
    utility,
    cost,
    rho,
    certificate,
    diagnostics: {
      candidateCount: rawN,
      requirementCount: rawM,
      keptCandidateCount: keptN,
      witnessSubsetBound: finalWitnessBound.toString(),
      stateCount,
      ...(history ? { history } : {}),
    },
  };
}
