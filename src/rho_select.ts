/**
 * ρSelect (rho-select)
 *
 * Query-Bounded Fractional Optimization for Token-Efficient Web Evidence Selection
 * クエリ有界分数最適化によるトークン効率的Web証拠選択
 *
 * 目的関数:
 *   max_{S ⊆ V, |S| ≤ K} ρ_τ(S) = U(S) / (τ + C(S))
 *
 * - U(S): クエリ語ごとの graded coverage 効用 (正規化単調劣モジュラ関数)
 * - C(S): 選択セクションの推定トークンコスト (加法関数)
 * - τ: 固定コンテキストオーバーヘッド (τ > 0 により singleton 退化を解消)
 * - O(n K 2^m) 疎動的計画法 + コスト–効用 Pareto フロンティア走査による厳密解法
 */

import { estimateTokens } from './enrichment.js';

export type RhoSelectOptions = {
  maxHighlights?: number; // default: 3 (K)
  maxTerms?: number; // default: 6 (q)
  evidenceLevels?: number; // default: 2 (L)
  maxFeatureBits?: number; // default: 18 (hard cap: 30)
  overheadTokens?: number; // default: 96, must be >= 1 (tau)
  k1?: number; // default: 1.2
  delta?: number; // default: 0.8
  wHeading?: number; // default: 3.5
  bHeading?: number; // default: 0.5
  wBody?: number; // default: 1.0
  bBody?: number; // default: 0.75
  phraseWeightFraction?: number; // default: 0.3
  recencyWeightFraction?: number; // default: 0.2
  dinkelbachEpsilon?: number; // default: 1e-9
  dinkelbachMaxIterations?: number; // default: 20
};

export type RhoBm25Options = RhoSelectOptions;

export type RhoSelectDiagnostics = {
  candidateCount: number;
  compactCandidateCount: number;
  termCount: number;
  evidenceLevels: number;
  featureCount: number;
  stateCount: number;
  frontierCount: number;
  selectedCount: number;
  selectedTokens: number;
  utility: number;
  density: number;
  lambda: number;
  dinkelbachIterations: number;
  directOptimumDensity: number;
  exactAgreement: boolean;
};

export type RhoBm25Diagnostics = RhoSelectDiagnostics;

export type RhoSelectResult = {
  highlights: string[];
  diagnostics: RhoSelectDiagnostics;
};

export type RhoBm25Result = RhoSelectResult;

export interface ParsedSection {
  rawHeading: string;
  heading: string;
  headingLevel: number;
  paragraphs: string[];
  fullText: string;
  charLength: number;
  startIndex: number;
}

/**
 * Markdown 本文を見出し (H1〜H6) 単位でセクションに分割
 * コードブロック (```) 内の見出し記号 (#) を安全に保護
 */
export function parseMarkdownSections(markdown: string): ParsedSection[] {
  if (!markdown) return [];

  const lines = markdown.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let currentHeading = '';
  let currentRawHeading = '';
  let currentLevel = 0;
  let currentParagraphs: string[] = [];
  let inCodeBlock = false;
  let sectionStartIndex = 0;
  let runningIndex = 0;
  const headingStack: { level: number; heading: string }[] = [];

  const flush = () => {
    const fullText = currentParagraphs.join('\n').trim();
    if (fullText.length > 0) {
      sections.push({
        rawHeading: currentRawHeading,
        heading: currentHeading,
        headingLevel: currentLevel,
        paragraphs: currentParagraphs.slice(),
        fullText,
        charLength: fullText.length,
        startIndex: sectionStartIndex,
      });
    }
    currentParagraphs = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // コードブロックトグル
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      currentParagraphs.push(line);
      runningIndex += line.length + 1;
      continue;
    }

    if (!inCodeBlock) {
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flush();
        const level = headingMatch[1].length;
        const rawTitle = headingMatch[2].trim();

        // 階層スタックの更新: 自分以上の深さの祖先をポップしてパンくずを構築
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        headingStack.push({ level, heading: rawTitle });

        currentLevel = level;
        currentHeading = headingStack.map((h) => h.heading).join(' > ');
        currentRawHeading = line;
        sectionStartIndex = runningIndex;
        runningIndex += line.length + 1;
        continue;
      }
    }

    currentParagraphs.push(line);
    runningIndex += line.length + 1;
  }
  flush();

  // 見出しが存在するが本文が全くないドキュメント（見出し行のみのファイル）への救済
  if (sections.length === 0 && headingStack.length > 0) {
    sections.push({
      rawHeading: currentRawHeading,
      heading: currentHeading,
      headingLevel: currentLevel,
      paragraphs: [currentHeading],
      fullText: currentHeading,
      charLength: currentHeading.length,
      startIndex: 0,
    });
  }

  // 見出しが1つも検出されず空行区切り段落が存在する場合は段落単位に分割
  if (sections.length === 1 && !sections[0].heading && sections[0].fullText.includes('\n\n')) {
    const rawParagraphs = sections[0].fullText
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (rawParagraphs.length > 1) {
      let offset = 0;
      return rawParagraphs.map((p) => {
        const sec: ParsedSection = {
          rawHeading: '',
          heading: '',
          headingLevel: 0,
          paragraphs: [p],
          fullText: p,
          charLength: p.length,
          startIndex: offset,
        };
        offset += p.length + 2;
        return sec;
      });
    }
  }

  return sections;
}

/**
 * クエリ文字列のトークナイズと重要語選択 (Term Selection)
 * Intl.Segmenter + 英数区切り、重複除去、局所識別度優先
 */
export function tokenizeAndSelectTerms(
  query: string,
  sections: ParsedSection[],
  maxTerms = 6,
): { terms: string[]; rawQuery: string } {
  const rawQuery = (query || '').trim();
  if (!rawQuery) return { terms: [], rawQuery: '' };

  const rawTerms = new Set<string>();

  // 1. 英語・数値・ハイフン語
  const enWords = rawQuery.toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
  for (const w of enWords) {
    rawTerms.add(w);
  }

  // 2. 日本語形態素/単語分割 (Intl.Segmenter)
  if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
    try {
      const segmenter = new (Intl as any).Segmenter('ja', { granularity: 'word' });
      for (const seg of segmenter.segment(rawQuery)) {
        const word = seg.segment.trim().toLowerCase();
        // 2文字以上の実質語（助詞・記号ノイズ除外）
        if (
          word.length >= 2 &&
          !/^[、。・！？!?\s\-_=+\/\\|:;'"()[\]{}]+$/.test(word) &&
          !/^(の|は|が|を|に|へ|と|で|て|た|も|から|まで|より|など)$/.test(word)
        ) {
          rawTerms.add(word);
        }
      }
    } catch {
      // Intl fallback
    }
  }

  // もし単語が抽出できずクエリ全体が日本語単語の場合
  if (rawTerms.size === 0 && rawQuery.length >= 2) {
    rawTerms.add(rawQuery.toLowerCase());
  }

  const allTerms = Array.from(rawTerms);
  if (allTerms.length <= maxTerms) {
    return { terms: allTerms, rawQuery };
  }

  // maxTerms を超える場合、セクション内 DF (Document Frequency) と単語長に基づく識別性スコアリング
  // 単純な先頭切り捨てを禁止
  const N = Math.max(1, sections.length);
  const scoredTerms = allTerms.map((term) => {
    let df = 0;
    for (const sec of sections) {
      if (
        sec.heading.toLowerCase().includes(term) ||
        sec.fullText.toLowerCase().includes(term)
      ) {
        df++;
      }
    }
    // 識別性: 0 < df < N の特異的語を優遇 (df=0 または df=N は情報量が低い)
    const selectivity = df > 0 ? (N - df + 0.5) / (df + 0.5) : 0.1;
    const lengthScore = Math.min(term.length, 6);
    const score = Math.log(1 + selectivity) * (1 + 0.2 * lengthScore);
    return { term, score, df };
  });

  scoredTerms.sort((a, b) => b.score - a.score);
  return {
    terms: scoredTerms.slice(0, maxTerms).map((t) => t.term),
    rawQuery,
  };
}

/**
 * スニペット文字列の構築 (見出し付き)
 */
function buildSnippetText(sec: ParsedSection): string {
  if (sec.heading) {
    return `## ${sec.heading}\n\n${sec.fullText}`.trim();
  }
  return sec.fullText.trim();
}

/**
 * ρSelect による最適ハイライト抽出 (クエリ有界分数最適化)
 */
export function extractQueryHighlightsRhoSelect(
  content: string,
  query: string,
  options?: RhoSelectOptions,
): RhoSelectResult {
  const K = Math.max(1, options?.maxHighlights ?? 3);
  const maxTerms = Math.max(1, options?.maxTerms ?? 6);
  const evidenceLevels = Math.max(1, options?.evidenceLevels ?? 2);
  const maxFeatureBits = Math.min(30, Math.max(2, options?.maxFeatureBits ?? 18));
  const overheadTokens = Math.max(1, options?.overheadTokens ?? 96);
  const k1 = options?.k1 ?? 1.2;
  const delta = options?.delta ?? 0.8;
  const wHeading = options?.wHeading ?? 3.5;
  const bHeading = options?.bHeading ?? 0.5;
  const wBody = options?.wBody ?? 1.0;
  const bBody = options?.bBody ?? 0.75;
  const phraseWeightFraction = options?.phraseWeightFraction ?? 0.3;
  const recencyWeightFraction = options?.recencyWeightFraction ?? 0.2;
  const dinkelbachEps = options?.dinkelbachEpsilon ?? 1e-9;
  const dinkelbachMaxIter = options?.dinkelbachMaxIterations ?? 20;

  const emptyDiagnostics: RhoSelectDiagnostics = {
    candidateCount: 0,
    compactCandidateCount: 0,
    termCount: 0,
    evidenceLevels,
    featureCount: 0,
    stateCount: 0,
    frontierCount: 0,
    selectedCount: 0,
    selectedTokens: 0,
    utility: 0,
    density: 0,
    lambda: 0,
    dinkelbachIterations: 0,
    directOptimumDensity: 0,
    exactAgreement: true,
  };

  if (!content || !query || !content.trim() || !query.trim()) {
    return { highlights: [], diagnostics: emptyDiagnostics };
  }

  // 1. セクション分割
  const sections = parseMarkdownSections(content);
  if (sections.length === 0) {
    return { highlights: [], diagnostics: emptyDiagnostics };
  }

  // 2. トークナイズ & Term Selection
  const { terms, rawQuery } = tokenizeAndSelectTerms(query, sections, maxTerms);
  if (terms.length === 0) {
    return { highlights: [], diagnostics: emptyDiagnostics };
  }

  const N = sections.length;

  // 3. 各 term の DF & 平滑化局所 IDF
  const dfMap = new Map<string, number>();
  for (const t of terms) {
    let df = 0;
    for (const sec of sections) {
      if (
        sec.heading.toLowerCase().includes(t) ||
        sec.fullText.toLowerCase().includes(t)
      ) {
        df++;
      }
    }
    dfMap.set(t, df);
  }

  // 局所 IDF 平滑化 (主題語 df ≈ N の消失を防ぐフロアリング保証)
  const idfMap = new Map<string, number>();
  for (const t of terms) {
    const df = dfMap.get(t) || 0;
    const rawIdf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    // フロアリング: 最小下限 0.35 + 文字長ボーナス
    const lenBonus = t.length >= 4 ? 0.2 : 0;
    const smoothedIdf = Math.max(rawIdf, 0.35) + lenBonus;
    idfMap.set(t, smoothedIdf);
  }

  // 4. 平均長計算
  let sumHeadingLen = 0;
  let sumBodyLen = 0;
  for (const sec of sections) {
    sumHeadingLen += sec.heading.length;
    sumBodyLen += sec.fullText.length;
  }
  const avgHeadingLen = Math.max(1, sumHeadingLen / N);
  const avgBodyLen = Math.max(1, sumBodyLen / N);

  // 出現頻度カウントヘルパー
  const countOccurrences = (text: string, sub: string): number => {
    if (!text || !sub) return 0;
    let count = 0;
    let pos = 0;
    const lower = text.toLowerCase();
    const subLower = sub.toLowerCase();
    while ((pos = lower.indexOf(subLower, pos)) !== -1) {
      count++;
      pos += subLower.length;
    }
    return count;
  };

  // 5. 各セクションの term-wise evidence (e_it) の算出
  const rawEvidenceMatrix: number[][] = [];
  const maxEvidencePerTerm = new Array(terms.length).fill(0);

  for (let i = 0; i < N; i++) {
    const sec = sections[i];
    const row: number[] = [];
    for (let tIdx = 0; tIdx < terms.length; tIdx++) {
      const t = terms[tIdx];
      const idf_t = idfMap.get(t) || 0.5;

      const tfH = countOccurrences(sec.heading, t);
      const tfB = countOccurrences(sec.fullText, t);

      if (tfH === 0 && tfB === 0) {
        row.push(0);
        continue;
      }

      const normH = tfH / (1 - bHeading + bHeading * (sec.heading.length / avgHeadingLen));
      const normB = tfB / (1 - bBody + bBody * (sec.fullText.length / avgBodyLen));
      const weightedTf = wHeading * normH + wBody * normB;

      // term-wise saturation
      const e_it = idf_t * (((k1 + 1) * weightedTf) / (k1 + weightedTf) + delta);
      row.push(e_it);

      if (e_it > maxEvidencePerTerm[tIdx]) {
        maxEvidencePerTerm[tIdx] = e_it;
      }
    }
    rawEvidenceMatrix.push(row);
  }

  // 完全にマッチするセクションが皆無の場合
  const hasAnyMatch = maxEvidencePerTerm.some((val) => val > 0);
  if (!hasAnyMatch) {
    return { highlights: [], diagnostics: { ...emptyDiagnostics, candidateCount: N, termCount: terms.length } };
  }

  // 6. Feature Lattice の構成
  interface FeatureDef {
    id: number;
    termIndex: number;
    level: number;
    weight: number;
    description: string;
  }

  const features: FeatureDef[] = [];
  let bitIndex = 0;

  for (let tIdx = 0; tIdx < terms.length; tIdx++) {
    if (maxEvidencePerTerm[tIdx] <= 0) continue;
    const termWeight = idfMap.get(terms[tIdx]) || 1.0;
    const levelWeight = termWeight / evidenceLevels;

    for (let l = 1; l <= evidenceLevels; l++) {
      if (bitIndex >= maxFeatureBits) break;
      features.push({
        id: bitIndex,
        termIndex: tIdx,
        level: l,
        weight: levelWeight,
        description: `term:${terms[tIdx]}:lvl:${l}`,
      });
      bitIndex++;
    }
  }

  // オプション二値特徴: 完全フレーズ一致 (Exact Phrase)
  let phraseFeatureBit = -1;
  const lowerRawQuery = rawQuery.toLowerCase();
  const isMultiWordQuery = terms.length >= 2 && lowerRawQuery.length >= 4;
  if (isMultiWordQuery && bitIndex < maxFeatureBits) {
    phraseFeatureBit = bitIndex;
    const totalQueryIdf = terms.reduce((acc, t) => acc + (idfMap.get(t) || 1.0), 0);
    features.push({
      id: bitIndex,
      termIndex: -1,
      level: 1,
      weight: totalQueryIdf * phraseWeightFraction,
      description: `phrase:${rawQuery}`,
    });
    bitIndex++;
  }

  // オプション二値特徴: Recency Intent
  let recencyFeatureBit = -1;
  const hasRecencyIntent = /最新|現在|今日|今月|202[4-9]|2030|today|latest|current/i.test(rawQuery);
  if (hasRecencyIntent && bitIndex < maxFeatureBits) {
    recencyFeatureBit = bitIndex;
    features.push({
      id: bitIndex,
      termIndex: -1,
      level: 1,
      weight: 1.0 * recencyWeightFraction,
      description: 'recency_match',
    });
    bitIndex++;
  }

  const totalFeatureCount = features.length;

  // 7. 各セクションの Feature Mask と Token Cost の計算
  interface Candidate {
    sectionIndex: number;
    snippet: string;
    mask: number;
    cost: number;
    utility: number;
  }

  const rawCandidates: Candidate[] = [];

  for (let i = 0; i < N; i++) {
    const sec = sections[i];
    let mask = 0;

    for (const f of features) {
      if (f.termIndex >= 0) {
        // Graded term evidence
        const maxE = maxEvidencePerTerm[f.termIndex];
        if (maxE > 0) {
          const r_it = rawEvidenceMatrix[i][f.termIndex] / maxE;
          if (r_it >= f.level / evidenceLevels) {
            mask |= 1 << f.id;
          }
        }
      } else if (f.id === phraseFeatureBit) {
        // Exact Phrase match
        if (
          sec.heading.toLowerCase().includes(lowerRawQuery) ||
          sec.fullText.toLowerCase().includes(lowerRawQuery)
        ) {
          mask |= 1 << f.id;
        }
      } else if (f.id === recencyFeatureBit) {
        // Recency expression in candidate
        if (
          /202[4-9]|2030|\b\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(sec.fullText) ||
          /最新|現在/.test(sec.fullText)
        ) {
          mask |= 1 << f.id;
        }
      }
    }

    // 1つも特徴をカバーしないセクションは候補から除外
    if (mask === 0) continue;

    const snippet = buildSnippetText(sec);
    const cost = Math.max(1, estimateTokens(snippet));

    // マスクの効用 U
    let utility = 0;
    for (const f of features) {
      if ((mask & (1 << f.id)) !== 0) {
        utility += f.weight;
      }
    }

    rawCandidates.push({
      sectionIndex: i,
      snippet,
      mask,
      cost,
      utility,
    });
  }

  if (rawCandidates.length === 0) {
    return { highlights: [], diagnostics: { ...emptyDiagnostics, candidateCount: N, termCount: terms.length, featureCount: totalFeatureCount } };
  }

  // 8. Dominance Preprocessing
  // 同一の feature mask を持つ候補群では、最小トークンコスト c_i のもののみを残す
  // 同コストなら文書順 (sectionIndex) が早い方を優先
  const maskBestCandidateMap = new Map<number, Candidate>();
  for (const cand of rawCandidates) {
    const existing = maskBestCandidateMap.get(cand.mask);
    if (!existing) {
      maskBestCandidateMap.set(cand.mask, cand);
    } else if (cand.cost < existing.cost) {
      maskBestCandidateMap.set(cand.mask, cand);
    } else if (cand.cost === existing.cost && cand.sectionIndex < existing.sectionIndex) {
      maskBestCandidateMap.set(cand.mask, cand);
    }
  }

  const compactCandidates = Array.from(maskBestCandidateMap.values());
  compactCandidates.sort((a, b) => a.sectionIndex - b.sectionIndex);

  // 9. Exact Sparse DP on (mask, count)
  interface DPState {
    mask: number;
    count: number;
    cost: number;
    picks: number[]; // compactCandidates のインデックス配列
  }

  const dpMap = new Map<number, DPState>();
  const makeKey = (mask: number, count: number) => (mask << 4) | (count & 0xf);

  // 初期状態
  dpMap.set(makeKey(0, 0), {
    mask: 0,
    count: 0,
    cost: 0,
    picks: [],
  });

  for (let cIdx = 0; cIdx < compactCandidates.length; cIdx++) {
    const cand = compactCandidates[cIdx];
    const currentStates = Array.from(dpMap.values());

    for (const state of currentStates) {
      if (state.count >= K) continue; // 最大件数 K 制約

      const nextMask = state.mask | cand.mask;
      const nextCount = state.count + 1;
      const nextCost = state.cost + cand.cost;
      const nextKey = makeKey(nextMask, nextCount);

      const existing = dpMap.get(nextKey);
      if (!existing) {
        dpMap.set(nextKey, {
          mask: nextMask,
          count: nextCount,
          cost: nextCost,
          picks: [...state.picks, cIdx],
        });
      } else if (nextCost < existing.cost) {
        existing.cost = nextCost;
        existing.picks = [...state.picks, cIdx];
      } else if (nextCost === existing.cost) {
        const curFirst = existing.picks[0] ?? Infinity;
        const newFirst = state.picks[0] ?? cIdx;
        if (newFirst < curFirst) {
          existing.cost = nextCost;
          existing.picks = [...state.picks, cIdx];
        }
      }
    }
  }

  // 10. Pareto Frontier の構成
  interface ReachedOutcome {
    mask: number;
    count: number;
    cost: number;
    utility: number;
    picks: number[];
  }

  const reachedOutcomes: ReachedOutcome[] = [];
  for (const state of dpMap.values()) {
    if (state.count === 0) continue; // 空集合は候補外
    let u = 0;
    for (const f of features) {
      if ((state.mask & (1 << f.id)) !== 0) {
        u += f.weight;
      }
    }
    reachedOutcomes.push({
      mask: state.mask,
      count: state.count,
      cost: state.cost,
      utility: u,
      picks: state.picks,
    });
  }

  if (reachedOutcomes.length === 0) {
    return { highlights: [], diagnostics: { ...emptyDiagnostics, candidateCount: N, compactCandidateCount: compactCandidates.length } };
  }

  // コスト昇順にソート (同コストなら utility 降順)
  reachedOutcomes.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    return b.utility - a.utility;
  });

  // Pareto 非支配フロンティアの抽出
  const paretoFrontier: ReachedOutcome[] = [];
  let maxUtilitySoFar = -1;

  for (const out of reachedOutcomes) {
    if (out.utility > maxUtilitySoFar) {
      paretoFrontier.push(out);
      maxUtilitySoFar = out.utility;
    }
  }

  // 11. Shifted Relevance-Density の直接最大化 (Direct Optimum)
  // rho_tau(S) = U(S) / (tau + C(S))
  let bestDensity = -1;
  let bestOutcome: ReachedOutcome = paretoFrontier[0];

  for (const out of paretoFrontier) {
    const density = out.utility / (overheadTokens + out.cost);
    if (density > bestDensity + 1e-12) {
      bestDensity = density;
      bestOutcome = out;
    } else if (Math.abs(density - bestDensity) <= 1e-12) {
      if (out.utility > bestOutcome.utility) {
        bestOutcome = out;
      } else if (out.utility === bestOutcome.utility && out.cost < bestOutcome.cost) {
        bestOutcome = out;
      } else if (out.cost === bestOutcome.cost && out.count < bestOutcome.count) {
        bestOutcome = out;
      }
    }
  }

  // 12. Dinkelbach Verifier (研究検証器)
  let lambda = 0;
  let dinkelbachIters = 0;

  for (let iter = 0; iter < dinkelbachMaxIter; iter++) {
    dinkelbachIters++;
    let maxVal = -Infinity;
    let optOut = paretoFrontier[0];

    for (const out of paretoFrontier) {
      const val = out.utility - lambda * (overheadTokens + out.cost);
      if (val > maxVal) {
        maxVal = val;
        optOut = out;
      }
    }

    const nextLambda = optOut.utility / (overheadTokens + optOut.cost);

    if (Math.abs(nextLambda - lambda) <= dinkelbachEps || maxVal <= dinkelbachEps) {
      lambda = nextLambda;
      break;
    }
    lambda = nextLambda;
  }

  const exactAgreement = Math.abs(bestDensity - lambda) < 1e-7;

  // 13. スニペットを元文書出現順 (sectionIndex 昇順) で整列して返却
  const chosenCandidates = bestOutcome.picks.map((idx) => compactCandidates[idx]);
  chosenCandidates.sort((a, b) => a.sectionIndex - b.sectionIndex);
  const finalHighlights = chosenCandidates.map((c) => c.snippet);

  const diagnostics: RhoSelectDiagnostics = {
    candidateCount: N,
    compactCandidateCount: compactCandidates.length,
    termCount: terms.length,
    evidenceLevels,
    featureCount: totalFeatureCount,
    stateCount: dpMap.size,
    frontierCount: paretoFrontier.length,
    selectedCount: finalHighlights.length,
    selectedTokens: bestOutcome.cost,
    utility: Number(bestOutcome.utility.toFixed(6)),
    density: Number(bestDensity.toFixed(8)),
    lambda: Number(lambda.toFixed(8)),
    dinkelbachIterations: dinkelbachIters,
    directOptimumDensity: Number(bestDensity.toFixed(8)),
    exactAgreement,
  };

  return {
    highlights: finalHighlights,
    diagnostics,
  };
}

/**
 * 後方互換用エイリアス
 */
export const extractQueryHighlightsRho = extractQueryHighlightsRhoSelect;
