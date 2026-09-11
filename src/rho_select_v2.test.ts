import { describe, it, expect } from 'bun:test';
import {
  selectEvidenceSetRhoV2,
  evaluateUtility,
  validateEvidenceProblem,
  computeWitnessSubsetBound,
  applySafeDominance,
  solveExactObservedStateDP,
  computeGreedyIncumbent,
  solveAdaptiveRefinement,
  RhoResourceLimitError,
  type RhoEvidenceProblem,
  type RhoUtilitySpec,
} from './rho_select_v2.js';

describe('ρSelect v2 Canonical Tests (Gemini Implementation Spec v1.0)', () => {
  // ==========================================
  // T1: Input validation — Fail Closed
  // ==========================================
  describe('T1: Input Validation (Fail-Closed)', () => {
    const validProblem: RhoEvidenceProblem = {
      scores: [[0.8, 0.2], [0.3, 0.9]],
      costs: [10, 15],
      tau: 96,
      utility: { kind: 'weighted-sum', weights: [1.0, 1.0] },
    };

    it('valid input passes without error', () => {
      expect(() => validateEvidenceProblem(validProblem)).not.toThrow();
    });

    it('throws on empty scores or ragged rows', () => {
      expect(() => validateEvidenceProblem({ ...validProblem, scores: [] })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, scores: [[0.5], [0.5, 0.8]] })).toThrow();
    });

    it('throws on NaN, Infinity, negative, or > 1 scores', () => {
      expect(() => validateEvidenceProblem({ ...validProblem, scores: [[NaN, 0.5], [0.5, 0.5]] })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, scores: [[Infinity, 0.5], [0.5, 0.5]] })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, scores: [[-0.1, 0.5], [0.5, 0.5]] })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, scores: [[1.05, 0.5], [0.5, 0.5]] })).toThrow();
    });

    it('throws on cost length mismatch, zero, negative, or non-finite costs', () => {
      expect(() => validateEvidenceProblem({ ...validProblem, costs: [10] })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, costs: [0, 10] })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, costs: [-5, 10] })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, costs: [NaN, 10] })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, costs: [Infinity, 10] })).toThrow();
    });

    it('throws on invalid tau (<= 0, NaN, Infinity)', () => {
      expect(() => validateEvidenceProblem({ ...validProblem, tau: 0 })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, tau: -10 })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, tau: NaN })).toThrow();
      expect(() => validateEvidenceProblem({ ...validProblem, tau: Infinity })).toThrow();
    });

    it('throws on invalid weights (negative, NaN, all zeros)', () => {
      expect(() =>
        validateEvidenceProblem({
          ...validProblem,
          utility: { kind: 'weighted-sum', weights: [-1, 1] },
        }),
      ).toThrow();
      expect(() =>
        validateEvidenceProblem({
          ...validProblem,
          utility: { kind: 'weighted-sum', weights: [0, 0] },
        }),
      ).toThrow();
      expect(() =>
        validateEvidenceProblem({
          ...validProblem,
          utility: { kind: 'weighted-sum', weights: [NaN, 1] },
        }),
      ).toThrow();
    });

    it('throws on invalid grouped-min parameters', () => {
      expect(() =>
        validateEvidenceProblem({
          ...validProblem,
          utility: { kind: 'grouped-min', groups: [], groupWeights: [] },
        }),
      ).toThrow();
      expect(() =>
        validateEvidenceProblem({
          ...validProblem,
          utility: { kind: 'grouped-min', groups: [[0]], groupWeights: [1, 2] }, // mismatch
        }),
      ).toThrow();
      expect(() =>
        validateEvidenceProblem({
          ...validProblem,
          utility: { kind: 'grouped-min', groups: [[99]], groupWeights: [1] }, // out-of-range requirement index
        }),
      ).toThrow();
    });

    it('throws on invalid options (epsilon < 0 or >= 1)', () => {
      expect(() => validateEvidenceProblem(validProblem, { epsilon: -0.1 })).toThrow();
      expect(() => validateEvidenceProblem(validProblem, { epsilon: 1.0 })).toThrow();
      expect(() => validateEvidenceProblem(validProblem, { epsilon: 1.5 })).toThrow();
    });
  });

  // ==========================================
  // Brute-force 全数探索ヘルパー
  // ==========================================
  function bruteForceSolve(problem: RhoEvidenceProblem): {
    bestIndices: number[];
    bestUtility: number;
    bestCost: number;
    bestRho: number;
  } {
    const { scores, costs, tau, utility } = problem;
    const n = scores.length;
    const m = scores[0].length;
    const totalSubsets = 1 << n;

    let bestIndices: number[] = [];
    let bestUtility = 0;
    let bestCost = 0;
    let bestRho = 0;
    let hasSelection = false;

    for (let mask = 1; mask < totalSubsets; mask++) {
      const picks: number[] = [];
      let c = 0;
      const y = new Array(m).fill(0);

      for (let i = 0; i < n; i++) {
        if ((mask & (1 << i)) !== 0) {
          picks.push(i);
          c += costs[i];
          for (let t = 0; t < m; t++) {
            if (scores[i][t] > y[t]) y[t] = scores[i][t];
          }
        }
      }

      const u = evaluateUtility(y, utility);
      const rho = u / (tau + c);

      // tie-break
      let isBetter = false;
      if (!hasSelection) {
        isBetter = true;
      } else {
        const TOL = 1e-12;
        if (Math.abs(rho - bestRho) > TOL) {
          isBetter = rho > bestRho;
        } else if (Math.abs(c - bestCost) > TOL) {
          isBetter = c < bestCost;
        } else if (picks.length !== bestIndices.length) {
          isBetter = picks.length < bestIndices.length;
        } else {
          isBetter = picks.join(',') < bestIndices.join(',');
        }
      }

      if (isBetter) {
        bestIndices = picks;
        bestUtility = u;
        bestCost = c;
        bestRho = rho;
        hasSelection = true;
      }
    }

    return { bestIndices, bestUtility, bestCost, bestRho };
  }

  // ==========================================
  // T2: Exact vs Brute-force property test
  // ==========================================
  describe('T2: Exact DP vs Brute-Force Agreement', () => {
    it('exact DP matches brute-force global optimum across random small problems (50 seeds)', () => {
      // 擬似乱数ジェネレータ
      let seed = 12345;
      const rnd = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      for (let s = 0; s < 50; s++) {
        const n = Math.floor(rnd() * 5) + 2; // 2..6
        const m = Math.floor(rnd() * 3) + 1; // 1..3

        const scores: number[][] = [];
        for (let i = 0; i < n; i++) {
          const row: number[] = [];
          for (let t = 0; t < m; t++) {
            row.push(Number(rnd().toFixed(3)));
          }
          scores.push(row);
        }

        const costs: number[] = [];
        for (let i = 0; i < n; i++) {
          costs.push(Math.floor(rnd() * 30) + 5);
        }

        const tau = Math.floor(rnd() * 80) + 20;

        const utility: RhoUtilitySpec =
          rnd() > 0.5
            ? { kind: 'weighted-sum', weights: new Array(m).fill(0).map(() => Number((rnd() + 0.5).toFixed(2))) }
            : { kind: 'grouped-min', groups: [Array.from({ length: m }, (_, i) => i)], groupWeights: [1.0] };

        const problem: RhoEvidenceProblem = { scores, costs, tau, utility };

        const bf = bruteForceSolve(problem);
        const exact = selectEvidenceSetRhoV2(problem, { exactSubsetThreshold: 100_000, dominancePreprocess: false });

        expect(exact.certificate.exact).toBe(true);
        expect(exact.certificate.solver).toBe('exact');
        expect(exact.rho).toBeCloseTo(bf.bestRho, 8);
        expect(exact.cost).toBeCloseTo(bf.bestCost, 8);
        expect(exact.indices).toEqual(bf.bestIndices);
      }
    });
  });

  // ==========================================
  // T3: State-witness sparsity property
  // ==========================================
  describe('T3: State-Witness Sparsity Property', () => {
    it('any selected set S has a witness subset T with |T| <= m, y(T)=y(S), and C(T) <= C(S)', () => {
      let seed = 54321;
      const rnd = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      for (let test = 0; test < 30; test++) {
        const n = 8;
        const m = 3;
        const scores: number[][] = [];
        for (let i = 0; i < n; i++) {
          const row: number[] = [];
          for (let t = 0; t < m; t++) row.push(Number(rnd().toFixed(3)));
          scores.push(row);
        }
        const costs: number[] = [];
        for (let i = 0; i < n; i++) costs.push(Math.floor(rnd() * 20) + 5);

        // 任意の部分集合 S (例: 5個選択)
        const S = [0, 1, 3, 5, 7];
        const yS = new Array(m).fill(0);
        let costS = 0;
        for (const idx of S) {
          costS += costs[idx];
          for (let t = 0; t < m; t++) yS[t] = Math.max(yS[t], scores[idx][t]);
        }

        // 各 requirement t の max score を達成する candidate を1つずつ選んで T を構成
        const witnessSet = new Set<number>();
        for (let t = 0; t < m; t++) {
          let bestI = -1;
          let maxVal = -1;
          for (const idx of S) {
            if (scores[idx][t] > maxVal) {
              maxVal = scores[idx][t];
              bestI = idx;
            }
          }
          if (bestI !== -1) witnessSet.add(bestI);
        }

        const T = Array.from(witnessSet).sort((a, b) => a - b);
        expect(T.length).toBeLessThanOrEqual(m);

        const yT = new Array(m).fill(0);
        let costT = 0;
        for (const idx of T) {
          costT += costs[idx];
          for (let t = 0; t < m; t++) yT[t] = Math.max(yT[t], scores[idx][t]);
        }

        expect(yT).toEqual(yS);
        expect(costT).toBeLessThanOrEqual(costS);
      }
    });
  });

  // ==========================================
  // T4: Dominance safety
  // ==========================================
  describe('T4: Safe Dominance Invariant', () => {
    it('dominance pruning on vs off yields exactly the same optimal result', () => {
      const problem: RhoEvidenceProblem = {
        scores: [
          [0.9, 0.9], // 0: 優良
          [0.8, 0.8], // 1: 0 に支配される (高コストかつ低スコア)
          [0.1, 0.9], // 2: 異なる強み
          [0.9, 0.1], // 3: 異なる強み
          [0.1, 0.1], // 4: ゴミ
        ],
        costs: [20, 25, 10, 10, 30],
        tau: 50,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0] },
      };

      const withDominance = selectEvidenceSetRhoV2(problem, { dominancePreprocess: true });
      const withoutDominance = selectEvidenceSetRhoV2(problem, { dominancePreprocess: false });

      expect(withDominance.rho).toBeCloseTo(withoutDominance.rho, 8);
      expect(withDominance.cost).toBeCloseTo(withoutDominance.cost, 8);
      expect(withDominance.indices).toEqual(withoutDominance.indices);
      expect(withDominance.diagnostics.keptCandidateCount).toBeLessThan(problem.scores.length);
    });
  });

  // ==========================================
  // T5: AR certificate vs Brute-force
  // ==========================================
  describe('T5: AR Certificate vs Brute-Force Bounds', () => {
    it('AR produces valid lower and upper bounds containing exact optimum (LB <= rho* <= UB)', () => {
      const problem: RhoEvidenceProblem = {
        scores: [
          [0.85, 0.10, 0.05],
          [0.15, 0.90, 0.10],
          [0.05, 0.10, 0.95],
          [0.70, 0.70, 0.10],
          [0.10, 0.80, 0.80],
          [0.90, 0.90, 0.90],
        ],
        costs: [15, 15, 15, 25, 25, 60],
        tau: 80,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0, 1.0] },
      };

      const bf = bruteForceSolve(problem);
      // exactSubsetThreshold を 1 にして AR を強制実行
      const ar = selectEvidenceSetRhoV2(problem, {
        exactSubsetThreshold: 1,
        epsilon: 0.05,
        dominancePreprocess: false,
      });

      expect(ar.certificate.solver).toBe('ar');
      expect(ar.certificate.lowerBound).toBeLessThanOrEqual(bf.bestRho + 1e-9);
      expect(ar.certificate.upperBound).toBeGreaterThanOrEqual(bf.bestRho - 1e-9);
      expect(ar.rho).toBeGreaterThanOrEqual((1 - 0.05) * bf.bestRho - 1e-9);
      expect(ar.certificate.relativeGap).toBeLessThanOrEqual(0.05 + 1e-9);
    });
  });

  // ==========================================
  // T6: AR Monotonic History
  // ==========================================
  describe('T6: AR Monotonic History Properties', () => {
    it('verifies that in AR history, LB is nondecreasing and UB is nonincreasing across all iterations', () => {
      const problem: RhoEvidenceProblem = {
        scores: [
          [0.9, 0.1, 0.2],
          [0.2, 0.8, 0.1],
          [0.1, 0.2, 0.9],
          [0.6, 0.6, 0.6],
        ],
        costs: [20, 20, 20, 35],
        tau: 70,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0, 1.0] },
      };

      const res = selectEvidenceSetRhoV2(problem, {
        exactSubsetThreshold: 1,
        epsilon: 0.01,
        dominancePreprocess: false,
      });

      const history = res.diagnostics.history;
      expect(history).toBeDefined();
      if (history && history.length > 1) {
        for (let i = 1; i < history.length; i++) {
          expect(history[i].lowerBound).toBeGreaterThanOrEqual(history[i - 1].lowerBound - 1e-9);
          expect(history[i].upperBound).toBeLessThanOrEqual(history[i - 1].upperBound + 1e-9);
          expect(history[i].lowerBound).toBeLessThanOrEqual(history[i].upperBound + 1e-9);
        }
      }
    });
  });

  // ==========================================
  // T7: epsilon=0 exact convergence
  // ==========================================
  describe('T7: epsilon=0 Exact Convergence under AR Full Refinement', () => {
    it('AR reaches exact optimum when epsilon=0', () => {
      const problem: RhoEvidenceProblem = {
        scores: [
          [0.8, 0.2],
          [0.2, 0.9],
          [0.7, 0.7],
        ],
        costs: [10, 12, 25],
        tau: 50,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0] },
      };

      const bf = bruteForceSolve(problem);
      const ar = selectEvidenceSetRhoV2(problem, {
        exactSubsetThreshold: 1,
        epsilon: 0.0, // full refinement to exact
        dominancePreprocess: false,
      });

      expect(ar.rho).toBeCloseTo(bf.bestRho, 8);
      expect(ar.certificate.lowerBound).toBeCloseTo(bf.bestRho, 8);
      expect(ar.certificate.upperBound).toBeCloseTo(bf.bestRho, 8);
      expect(ar.certificate.relativeGap).toBeCloseTo(0.0, 8);
      expect(ar.indices).toEqual(bf.bestIndices);
    });
  });

  // ==========================================
  // T8: Deterministic ties
  // ==========================================
  describe('T8: Deterministic Tie Breaking', () => {
    it('consistently selects lexicographically smaller original index on duplicates', () => {
      const problem: RhoEvidenceProblem = {
        scores: [
          [0.8, 0.8], // idx 0
          [0.8, 0.8], // idx 1: 完全一致
          [0.8, 0.8], // idx 2: 完全一致
        ],
        costs: [10, 10, 10],
        tau: 50,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0] },
      };

      const res = selectEvidenceSetRhoV2(problem, { dominancePreprocess: true });
      expect(res.indices).toEqual([0]);

      const resNoDom = selectEvidenceSetRhoV2(problem, { dominancePreprocess: false });
      expect(resNoDom.indices).toEqual([0]);
    });
  });

  // ==========================================
  // T9: >32 candidates without bitwise overflow
  // ==========================================
  describe('T9: >32 Candidates without Bitwise Overflow', () => {
    it('handles 40 candidates correctly without 32-bit bitwise shift overflow', () => {
      const n = 40;
      const m = 2;
      const scores: number[][] = [];
      const costs: number[] = [];

      for (let i = 0; i < n; i++) {
        scores.push([0.05, 0.05]);
        costs.push(50);
      }
      // 36番目と38番目に突出した優秀な候補を配置
      scores[36] = [0.95, 0.10];
      costs[36] = 10;
      scores[38] = [0.10, 0.95];
      costs[38] = 10;

      const problem: RhoEvidenceProblem = {
        scores,
        costs,
        tau: 80,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0] },
      };

      const res = selectEvidenceSetRhoV2(problem, { dominancePreprocess: true });
      expect(res.indices).toEqual([36, 38]);
      expect(res.diagnostics.candidateCount).toBe(40);
    });
  });

  // ==========================================
  // T10: No implicit K
  // ==========================================
  describe('T10: No Implicit K=3 Constraint in Canonical Mode', () => {
    it('selects 4 complementary candidates when tau is sufficiently large without any hard cap', () => {
      // 4 つの独立した requirement に対し、それぞれ特化した安価な候補 4 個
      const problem: RhoEvidenceProblem = {
        scores: [
          [1.0, 0.0, 0.0, 0.0],
          [0.0, 1.0, 0.0, 0.0],
          [0.0, 0.0, 1.0, 0.0],
          [0.0, 0.0, 0.0, 1.0],
        ],
        costs: [5, 5, 5, 5],
        tau: 200, // 大きな tau: 4つ全部取っても分母 220、効用 4.0 で最高密度
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0, 1.0, 1.0] },
      };

      const res = selectEvidenceSetRhoV2(problem);
      expect(res.indices).toEqual([0, 1, 2, 3]);
      expect(res.indices.length).toBe(4); // 3 件で頭打ちにならない！
    });
  });

  // ==========================================
  // T13: Resource Limit Fail-Closed
  // ==========================================
  describe('T13: Resource Limit Guard (Fail-Closed)', () => {
    it('throws RhoResourceLimitError when maxStates is exceeded and never certifies invalid state', () => {
      const problem: RhoEvidenceProblem = {
        scores: [
          [0.9, 0.1],
          [0.8, 0.2],
          [0.7, 0.3],
          [0.6, 0.4],
          [0.5, 0.5],
        ],
        costs: [10, 10, 10, 10, 10],
        tau: 50,
        utility: { kind: 'weighted-sum', weights: [1.0, 1.0] },
      };

      // maxStates を極小の 2 に設定
      expect(() =>
        selectEvidenceSetRhoV2(problem, {
          maxStates: 2,
          dominancePreprocess: false,
        }),
      ).toThrow(RhoResourceLimitError);
    });
  });

  // ==========================================
  // T11 & T12: Adapter Certificate Scope & Integration
  // ==========================================
  describe('T11 & T12: Adapter Certificate Scope and Integration', () => {
    it('T12: Adapter certificate scope is score_defined_objective_only with scoreReliability not_calibrated', async () => {
      const { extractQueryHighlightsRhoV2 } = await import('./rho_select_v2_adapter.js');

      const markdown = `
# クラウドアーキテクチャ
## ストレージ層
分散オブジェクトストレージは99.999999999%の耐久性を保証します。
## 料金体系
クエリごとに0.01ドルが課金されます。
      `;

      const res = extractQueryHighlightsRhoV2(markdown, 'ストレージ 料金体系');
      expect(res.highlights.length).toBeGreaterThan(0);
      expect(res.certificate.scope).toBe('score_defined_objective_only');
      expect(res.certificate.valid).toBe(true);
      expect(res.diagnostics.requirementsSource).toBe('query_terms');
      expect(res.diagnostics.scoreReliability.status).toBe('not_calibrated');
      expect((res.certificate as any).semanticConfidence).toBeUndefined();
    });

    it('applies safe post-selection truncation when highlightMaxCount is provided (No implicit K)', async () => {
      const { extractQueryHighlightsRhoV2 } = await import('./rho_select_v2_adapter.js');

      const markdown = `
# データベース比較
## PostgreSQL
リレーショナルデータベースの最高峰で、ACID特性とトランザクションを完全保証します。
## Redis
高速なインメモリKVSでキャッシュ用途に最適です。
## MongoDB
柔軟なドキュメント志向データベースです。
## SQLite
軽量な組み込みデータベースです。
      `;

      // 1. highlightMaxCount: 1 を指定 -> 自然最適解が複数でも安全に1件へスライスされ、postProcessed: true
      const res = extractQueryHighlightsRhoV2(markdown, 'PostgreSQL Redis MongoDB SQLite', {
        highlightMaxCount: 1,
      });
      expect(res.highlights.length).toBe(1);
      expect(res.certificate.postProcessed).toBe(true);
      expect(res.diagnostics.warning).toBeDefined();
      expect(res.diagnostics.warning).toContain('post-selection truncation');

      // 2. highlightMaxCount: 10 を指定 -> 自然最適解 (<= 4) を下回らないので postProcessed: false
      const resLarge = extractQueryHighlightsRhoV2(markdown, 'PostgreSQL Redis', {
        highlightMaxCount: 10,
      });
      expect(resLarge.certificate.postProcessed).toBe(false);
      expect(resLarge.diagnostics.warning).toBeUndefined();
    });

    it('T11: Legacy rho_select functions continue to pass without regression', async () => {
      const { extractQueryHighlightsRhoSelect } = await import('./rho_select.js');
      const res = extractQueryHighlightsRhoSelect('# タイトル\n## セクション1\n本文です', 'タイトル');
      expect(res.highlights.length).toBeGreaterThan(0);
      expect(res.diagnostics.exactAgreement).toBe(true);
    });

    it('T12: Hierarchical breadcrumb context injection extracts target song section over short unrelated sections', async () => {
      const { extractQueryHighlightsRhoV2 } = await import('./rho_select_v2_adapter.js');
      const markdown = `---
publishedTime: "2026-03-08T22:19:01.000+09:00"
author: "kimisora_mix"
siteName: "note（ノート）"
---

> 📍 **階層**: トップ > 音楽 > ポップス > 【君と見るそら】コール

## ・好きって。

〈イントロ〉タイガーファイヤー始動
タイガーファイヤー(始動)
サイバー ファイバーダイバー バイバー
ジャージャー ファイボー ワイパー

〈サビ〉意味不愛してる
アイアイアイアイ愛してる ×2

〈間奏〉虎火始動
虎虎虎虎 ×3 虎 火
人造 繊維 海人 振動 化繊 飛 除去

〈アウトロ〉混沌MIX
ワ×6 ワールドカオス
諸行 木暮 時雨 神楽 金剛山 翔襲叉
黒雲 無常 世界混沌

## ・遠回りがいい

〈イントロ〉スタンダード
うりゃおい ×4 👏 ×5 しゃーいくぞ
タイガー ファイヤー サイバー ファイバー ダイバー
バイバー ジャージャー ファイバー ワイパー

## ・青春はサイダー

〈イントロ〉スタンダード
うりゃおい ×4 👏 ×5 しゃーいくぞ

## ・待っていてね

〈イントロ〉スタンダード倍速
`;
      const supplemental = [
        '・好きって。 ・遠回りがいい; ・青春はサイダー; ・等身大のアイラブミー; ・ソライロ; ・待っていてね; ・君とあの日の距離; ・特別な時間; ・指先の ...',
      ];
      const res = extractQueryHighlightsRhoV2(markdown, '君と見るそら 好きって コール', {
        supplementalEvidence: supplemental,
      });

      expect(res.highlights.length).toBeGreaterThan(0);
      // 本命の「好きって。」が含まれること
      const joined = res.highlights.join('\n');
      expect(joined).toContain('好きって。');
      expect(joined).toContain('タイガーファイヤー始動');
      // スニペットによるカニバリゼーションが発生していないこと
      expect(joined).not.toContain('📌 **補完証拠 (スニペット)**');
    });

    it('T13: Fallback to supplemental evidence occurs safely when body has no relevant evidence', async () => {
      const { extractQueryHighlightsRhoV2 } = await import('./rho_select_v2_adapter.js');
      const emptyMarkdown = ``;
      const supplemental = [
        '・好きって。 ・遠回りがいい; ・青春はサイダー; ・等身大のアイラブミー; ・ソライロ',
      ];
      const res = extractQueryHighlightsRhoV2(emptyMarkdown, '君と見るそら 好きって コール', {
        supplementalEvidence: supplemental,
      });

      expect(res.highlights.length).toBeGreaterThan(0);
      expect(res.highlights[0]).toContain('📌 **補完証拠 (スニペット)**');
    });
  });
});

