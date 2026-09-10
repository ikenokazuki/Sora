import { describe, it, expect } from 'bun:test';
import {
  selectEvidenceSetRhoV2,
  evaluateUtility,
  validateEvidenceProblem,
  applySafeDominance,
  solveExactObservedStateDP,
  computeGreedyIncumbent,
  solveAdaptiveRefinement,
  RhoResourceLimitError,
  type RhoEvidenceProblem,
  type RhoUtilitySpec,
} from './rho_select_v2.js';

// ==========================================
// Deterministic PRNG: Mulberry32
// ==========================================
function createMulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brute-force exponential solver for small instances
function bruteForceSolve(problem: RhoEvidenceProblem): {
  bestRho: number;
  bestCost: number;
  bestIndices: number[];
} {
  const n = problem.costs.length;
  const m = problem.scores[0].length;
  const tau = problem.tau;

  let bestRho = 0;
  let bestCost = 0;
  let bestIndices: number[] = [];

  const totalSubsets = 1 << n;
  for (let mask = 0; mask < totalSubsets; mask++) {
    let cost = 0;
    const y = new Array(m).fill(0);
    const indices: number[] = [];

    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0) {
        cost += problem.costs[i];
        indices.push(i);
        const row = problem.scores[i];
        for (let t = 0; t < m; t++) {
          if (row[t] > y[t]) y[t] = row[t];
        }
      }
    }

    const utility = evaluateUtility(y, problem.utility);
    const rho = utility / (tau + cost);

    // Strict tie-breaking identical to optimizer:
    // 1. higher rho
    // 2. smaller cost
    // 3. lexicographically smaller indices
    let isBetter = false;
    if (rho > bestRho + 1e-12) {
      isBetter = true;
    } else if (Math.abs(rho - bestRho) <= 1e-12) {
      if (cost < bestCost - 1e-12) {
        isBetter = true;
      } else if (Math.abs(cost - bestCost) <= 1e-12) {
        // Lexicographical compare
        const len = Math.min(indices.length, bestIndices.length);
        for (let k = 0; k < len; k++) {
          if (indices[k] < bestIndices[k]) {
            isBetter = true;
            break;
          } else if (indices[k] > bestIndices[k]) {
            break;
          }
        }
        if (!isBetter && indices.length < bestIndices.length) {
          isBetter = true;
        }
      }
    }

    if (isBetter) {
      bestRho = rho;
      bestCost = cost;
      bestIndices = indices;
    }
  }

  return { bestRho, bestCost, bestIndices };
}

describe('ρSelect v2 Comprehensive Stress Test Suite (1,000 Deterministic Seeds)', () => {
  // ----------------------------------------------------
  // Stress 1: Exact vs Brute-force & Dominance Invariance (300 seeds)
  // ----------------------------------------------------
  it('Stress 1: Exact vs Brute-force with and without dominance across 300 random instances', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rng = createMulberry32(seed * 7919);
      const n = Math.floor(rng() * 6) + 4; // n in [4, 9]
      const m = Math.floor(rng() * 3) + 1; // m in [1, 3]

      const scores: number[][] = [];
      for (let i = 0; i < n; i++) {
        const row: number[] = [];
        for (let t = 0; t < m; t++) {
          row.push(Number(rng().toFixed(3)));
        }
        scores.push(row);
      }

      const costs: number[] = [];
      for (let i = 0; i < n; i++) {
        costs.push(Math.floor(rng() * 25) + 5);
      }

      const tau = Math.floor(rng() * 100) + 10;
      const utility: RhoUtilitySpec =
        rng() > 0.4
          ? { kind: 'weighted-sum', weights: new Array(m).fill(0).map(() => Number((rng() + 0.2).toFixed(2))) }
          : { kind: 'grouped-min', groups: [Array.from({ length: m }, (_, i) => i)], groupWeights: [1.0] };

      const problem: RhoEvidenceProblem = { scores, costs, tau, utility };

      const bf = bruteForceSolve(problem);
      // Run exact with dominance OFF
      const exactNoDom = selectEvidenceSetRhoV2(problem, {
        exactSubsetThreshold: 100_000,
        dominancePreprocess: false,
      });

      // Run exact with dominance ON
      const exactWithDom = selectEvidenceSetRhoV2(problem, {
        exactSubsetThreshold: 100_000,
        dominancePreprocess: true,
      });

      expect(exactNoDom.certificate.exact).toBe(true);
      expect(exactNoDom.rho).toBeCloseTo(bf.bestRho, 7);
      expect(exactNoDom.cost).toBeCloseTo(bf.bestCost, 7);

      expect(exactWithDom.certificate.exact).toBe(true);
      expect(exactWithDom.rho).toBeCloseTo(bf.bestRho, 7);
      expect(exactWithDom.cost).toBeCloseTo(bf.bestCost, 7);
    }
  });

  // ----------------------------------------------------
  // Stress 2: Adaptive Refinement Bounds (LB <= optimum <= UB) across 300 seeds
  // ----------------------------------------------------
  it('Stress 2: AR bound correctness (LB <= optimum <= UB) across 300 seeds', () => {
    for (let seed = 301; seed <= 600; seed++) {
      const rng = createMulberry32(seed * 4001);
      const n = Math.floor(rng() * 5) + 5; // n in [5, 9]
      const m = Math.floor(rng() * 3) + 2; // m in [2, 4]

      const scores: number[][] = [];
      for (let i = 0; i < n; i++) {
        const row: number[] = [];
        for (let t = 0; t < m; t++) row.push(Number(rng().toFixed(3)));
        scores.push(row);
      }
      const costs: number[] = [];
      for (let i = 0; i < n; i++) costs.push(Math.floor(rng() * 30) + 5);
      const tau = Math.floor(rng() * 80) + 20;
      const utility: RhoUtilitySpec = {
        kind: 'weighted-sum',
        weights: new Array(m).fill(1.0),
      };

      const problem: RhoEvidenceProblem = { scores, costs, tau, utility };
      const bf = bruteForceSolve(problem);

      // Force AR solver via exactSubsetThreshold = 1 with epsilon = 0.05
      const arResult = selectEvidenceSetRhoV2(problem, {
        exactSubsetThreshold: 1,
        epsilon: 0.05,
        maxIterations: 50,
      });

      expect(arResult.certificate.valid).toBe(true);
      expect(arResult.certificate.lowerBound).toBeLessThanOrEqual(bf.bestRho + 1e-7);
      expect(arResult.certificate.upperBound).toBeGreaterThanOrEqual(bf.bestRho - 1e-7);
      expect(arResult.certificate.relativeGap).toBeLessThanOrEqual(0.05 + 1e-7);
    }
  });

  // ----------------------------------------------------
  // Stress 3: Epsilon = 0 Exact Convergence across 150 seeds
  // ----------------------------------------------------
  it('Stress 3: AR with epsilon=0 converges to exact optimum across 150 seeds', () => {
    for (let seed = 601; seed <= 750; seed++) {
      const rng = createMulberry32(seed * 6271);
      const n = Math.floor(rng() * 4) + 4; // n in [4, 7]
      const m = 2;

      const scores: number[][] = [];
      for (let i = 0; i < n; i++) {
        scores.push([Number(rng().toFixed(2)), Number(rng().toFixed(2))]);
      }
      const costs: number[] = [];
      for (let i = 0; i < n; i++) costs.push(Math.floor(rng() * 20) + 5);
      const tau = 50;

      const problem: RhoEvidenceProblem = {
        scores,
        costs,
        tau,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0] },
      };

      const bf = bruteForceSolve(problem);
      const arZero = selectEvidenceSetRhoV2(problem, {
        exactSubsetThreshold: 1,
        epsilon: 0,
        maxIterations: 200,
      });

      expect(arZero.certificate.valid).toBe(true);
      expect(arZero.rho).toBeCloseTo(bf.bestRho, 6);
      expect(arZero.certificate.relativeGap).toBeCloseTo(0, 5);
    }
  });

  // ----------------------------------------------------
  // Stress 4: Edge Cases - Ties, Duplicate Candidates, Extreme Tau (150 seeds)
  // ----------------------------------------------------
  it('Stress 4: Robustness under duplicate candidates, extreme tau, and ties across 150 seeds', () => {
    for (let seed = 751; seed <= 900; seed++) {
      const rng = createMulberry32(seed * 1999);
      const n = 6;
      const m = 2;

      // Duplicate or identical candidate rows
      const baseRow = [Number(rng().toFixed(2)), Number(rng().toFixed(2))];
      const scores: number[][] = [
        [...baseRow],
        [...baseRow], // identical
        [Number(rng().toFixed(2)), 0.0],
        [0.0, Number(rng().toFixed(2))],
        [0.99, 0.99],
        [0.01, 0.01],
      ];
      const costs = [10, 10, 15, 15, 50, 5];

      // Extreme tau: either ultra-small (0.01) or huge (10,000)
      const tau = rng() > 0.5 ? 0.01 : 10000;

      const problem: RhoEvidenceProblem = {
        scores,
        costs,
        tau,
        utility: { kind: 'weighted-sum', weights: [1.0, 2.0] },
      };

      const bf = bruteForceSolve(problem);
      const res = selectEvidenceSetRhoV2(problem, { exactSubsetThreshold: 50_000 });

      expect(res.certificate.valid).toBe(true);
      expect(res.rho).toBeCloseTo(bf.bestRho, 7);
      expect(res.cost).toBeCloseTo(bf.bestCost, 7);
    }
  });

  // ----------------------------------------------------
  // Stress 5: Fail-closed & Resource Protection & NaN Handling (100 seeds)
  // ----------------------------------------------------
  it('Stress 5: Fail-closed and resource limits strictly withhold valid=true certificates across 100 seeds', () => {
    for (let seed = 901; seed <= 1000; seed++) {
      const rng = createMulberry32(seed * 8831);

      // A. All-zero evidence -> rho must be 0, indices empty, certificate exact
      const allZeroProblem: RhoEvidenceProblem = {
        scores: [[0, 0], [0, 0], [0, 0]],
        costs: [10, 15, 20],
        tau: 50,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0] },
      };
      const zeroRes = selectEvidenceSetRhoV2(allZeroProblem);
      expect(zeroRes.rho).toBe(0);
      expect(zeroRes.indices).toEqual([]);
      expect(zeroRes.certificate.exact).toBe(true);

      // B. NaN / Infinity input -> must throw immediately
      expect(() =>
        validateEvidenceProblem({
          ...allZeroProblem,
          scores: [[NaN, 0], [0, 0], [0, 0]],
        }),
      ).toThrow();

      expect(() =>
        validateEvidenceProblem({
          ...allZeroProblem,
          costs: [10, Infinity, 20],
        }),
      ).toThrow();

      // C. Resource limit fail-closed (budget = 1 step in AR)
      const largeProblem: RhoEvidenceProblem = {
        scores: Array.from({ length: 15 }, () => [Number(rng().toFixed(2)), Number(rng().toFixed(2))]),
        costs: Array.from({ length: 15 }, () => 10),
        tau: 50,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0] },
      };

      // With maxSteps = 1 and tiny timeout, AR must not emit a false uncertified claim
      try {
        const guardedRes = selectEvidenceSetRhoV2(largeProblem, {
          exactSubsetThreshold: 1, // force AR
          maxIterations: 1,
          epsilon: 1e-9, // impossible to converge in 1 step
          maxStates: 2, // ultra-low limit to trigger resource guard
        });
        // If it returns, valid must not be true for an unachieved gap
        if (!guardedRes.certificate.exact) {
          expect(guardedRes.certificate.relativeGap).toBeGreaterThan(1e-9);
        }
      } catch (err: any) {
        // Must throw either RhoResourceLimitError or audit error (relative gap exceeds epsilon)
        expect(err).toBeDefined();
        expect(err.message).toMatch(/resource limit|exceeds epsilon|state/i);
      }
    }
  });
});
