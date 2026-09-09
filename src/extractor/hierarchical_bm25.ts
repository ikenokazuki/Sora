/**
 * 見出し階層ボーナス付き BM25 パッセージ抽出エンジン
 * 
 * 祖先見出し全レベルへの減衰伝播 (Hierarchical Breadcrumb Diffusion) と
 * 標準的な BM25 (IDF × TF飽和) を組み合わせた、シンプルかつ堅牢な抽出ロジック。
 */

export interface HeadingBlock {
  headingPath: string[]; // ルート見出しから直近見出しまで (自分自身を含む)
  nearestHeading: string;
  depth: number;
  body: string;
}

/**
 * Markdown 文書を見出し階層とその直下の本文ブロックのリストにパースする
 */
export function parseBlocks(markdown: string): HeadingBlock[] {
  if (!markdown) return [];

  const lines = markdown.split(/\r?\n/);
  const blocks: HeadingBlock[] = [];
  const headingStack: { level: number; title: string }[] = [];
  let currentBodyLines: string[] = [];
  let hasAnyHeading = false;

  const flush = () => {
    const body = currentBodyLines.join('\n').trim();
    if (body.length > 0) {
      blocks.push({
        headingPath: headingStack.map((h) => h.title),
        nearestHeading: headingStack.length > 0 ? headingStack[headingStack.length - 1].title : '',
        depth: headingStack.length > 0 ? headingStack[headingStack.length - 1].level : 0,
        body,
      });
      currentBodyLines = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      hasAnyHeading = true;
      flush();
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // 現在のレベル以上の見出しをスタックからポップ
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });
    } else {
      currentBodyLines.push(rawLine);
    }
  }
  flush();

  // 見出しが1つも存在せず、空行で区切られた複数段落がある場合は段落ブロックへフォールバック
  if (!hasAnyHeading && blocks.length === 1 && blocks[0].body.includes('\n\n')) {
    const paragraphs = blocks[0].body
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (paragraphs.length > 1) {
      return paragraphs.map((p) => ({
        headingPath: [],
        nearestHeading: '',
        depth: 0,
        body: p,
      }));
    }
  }

  return blocks;
}

/**
 * 全ブロック中、その語を body (または headingPath のいずれか) に含むブロック数から標準的な BM25 IDF を計算
 */
export function idf(
  term: string,
  allBlocks: HeadingBlock[],
  field: 'body' | 'heading'
): number {
  if (!term || allBlocks.length === 0) return 0;
  const N = allBlocks.length;
  let docCount = 0;
  const lowerTerm = term.toLowerCase();

  for (const block of allBlocks) {
    if (field === 'body') {
      if (block.body.toLowerCase().includes(lowerTerm)) {
        docCount++;
      }
    } else {
      const matchInHeading = block.headingPath.some((h) =>
        h.toLowerCase().includes(lowerTerm)
      );
      if (matchInHeading) {
        docCount++;
      }
    }
  }

  // スムージング付き BM25 IDF
  return Math.log((N - docCount + 0.5) / (docCount + 0.5) + 1.0);
}

/**
 * 各ブロックの本文に対して、標準的な BM25 (IDF × TF飽和) でスコアを計算する
 */
export function bm25BodyScore(
  block: HeadingBlock,
  terms: string[],
  allBlocks: HeadingBlock[],
  k1 = 1.5,
  b = 0.75
): number {
  if (allBlocks.length === 0 || terms.length === 0) return 0;
  const avgLen =
    allBlocks.reduce((acc, blk) => acc + blk.body.length, 0) / allBlocks.length || 1;
  const lowerBody = block.body.toLowerCase();
  let score = 0;

  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    let tf = 0;
    let pos = 0;
    while ((pos = lowerBody.indexOf(lowerTerm, pos)) !== -1) {
      tf++;
      pos += lowerTerm.length;
    }

    if (tf > 0) {
      const termIdf = idf(term, allBlocks, 'body');
      const tfNorm =
        (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (block.body.length / avgLen)));
      score += termIdf * tfNorm;
    }
  }

  return score;
}

/**
 * そのブロックの祖先見出し全レベルについて、そのレベルの見出しテキストにクエリ語が含まれていれば、
 * そのレベルの idf × 深さ減衰係数 (gamma^(depth - level)) のボーナスを加算する
 */
export function ancestorBonus(
  block: HeadingBlock,
  terms: string[],
  allBlocks: HeadingBlock[],
  gamma = 0.6
): number {
  let bonus = 0;
  const L = block.headingPath.length;

  for (let idx = 0; idx < L; idx++) {
    const headingTitle = block.headingPath[idx].toLowerCase();
    const distance = L - 1 - idx; // 直近見出しが 0, 親が 1, 祖父が 2...
    const weight = Math.pow(gamma, distance);

    for (const term of terms) {
      const lowerTerm = term.toLowerCase();
      if (headingTitle.includes(lowerTerm)) {
        const headingIdf = idf(term, allBlocks, 'heading');
        bonus += weight * headingIdf;
      }
    }
  }

  return bonus;
}

/**
 * 最終スコア = BM25本文スコア + Σ(祖先レベルのボーナス)
 */
export function scorePassage(
  block: HeadingBlock,
  terms: string[],
  allBlocks: HeadingBlock[],
  opts?: { k1?: number; gamma?: number }
): number {
  const k1 = opts?.k1 ?? 1.5;
  const gamma = opts?.gamma ?? 0.6;

  const bodyScore = bm25BodyScore(block, terms, allBlocks, k1);
  const bonus = ancestorBonus(block, terms, allBlocks, gamma);

  return bodyScore + bonus;
}

/**
 * 最大スコアのブロックを返す
 */
export function extractBestPassage(
  markdown: string,
  terms: string[],
  opts?: { k1?: number; gamma?: number }
): HeadingBlock {
  const blocks = parseBlocks(markdown);
  if (blocks.length === 0) {
    return { headingPath: [], nearestHeading: '', depth: 0, body: '' };
  }

  let bestBlock = blocks[0];
  let maxScore = -Infinity;

  for (const block of blocks) {
    const score = scorePassage(block, terms, blocks, opts);
    if (score > maxScore) {
      maxScore = score;
      bestBlock = block;
    }
  }

  return bestBlock;
}

/**
 * 上位複数ブロックをスコア順に抽出し、パンくず付きテキスト配列として返却する (Sora ハイライト用)
 */
export function extractRankedPassages(
  markdown: string,
  terms: string[],
  maxPassages = 3,
  opts?: { k1?: number; gamma?: number }
): { block: HeadingBlock; score: number; formattedText: string }[] {
  const blocks = parseBlocks(markdown);
  if (blocks.length === 0 || terms.length === 0) return [];

  const scored = blocks.map((block) => ({
    block,
    score: scorePassage(block, terms, blocks, opts),
  }));

  scored.sort((a, b) => b.score - a.score);

  const results: { block: HeadingBlock; score: number; formattedText: string }[] = [];
  const topScore = scored[0].score;

  for (const item of scored) {
    if (results.length >= maxPassages) break;
    // 1位に対してスコアが著しく低い無関係ブロックはスキップ (トップスコアの30%未満)
    if (results.length > 0 && topScore > 0 && item.score < topScore * 0.3) {
      break;
    }

    const headingPrefix = item.block.headingPath.length > 0
      ? `## ${item.block.headingPath.join(' > ')}\n\n`
      : '';

    results.push({
      block: item.block,
      score: item.score,
      formattedText: `${headingPrefix}${item.block.body}`.trim(),
    });
  }

  return results;
}

/**
 * クエリ文字列から単語分割＋形態素バイグラム (Bigram) を自動合成して抽出語リストを生成
 */
export function extractTermsWithBigrams(query: string): string[] {
  if (!query) return [];
  const cleanQuery = query.toLowerCase().trim();
  const rawTerms = cleanQuery.split(/\s+/).filter((t) => t.length >= 2);
  const termSet = new Set<string>(rawTerms);

  // 1. スペース区切り単語間のバイグラム (例: "星風" + "エトワール" -> "星風エトワール")
  for (let i = 0; i < rawTerms.length - 1; i++) {
    const rawBigram = rawTerms[i] + rawTerms[i + 1];
    if (rawBigram.length >= 3) {
      termSet.add(rawBigram);
    }
  }

  // 2. 形態素単語間のバイグラム (例: "乃木" + "坂" -> "乃木坂")
  const segmentWords: string[] = [];
  try {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    for (const seg of segmenter.segment(cleanQuery)) {
      if (seg.isWordLike) {
        const w = seg.segment.toLowerCase().trim();
        if (w.length > 0) {
          if (w.length >= 2) {
            termSet.add(w);
          }
          segmentWords.push(w);
        }
      }
    }
  } catch {}

  for (let i = 0; i < segmentWords.length - 1; i++) {
    const bigram = segmentWords[i] + segmentWords[i + 1];
    if (bigram.length >= 2) {
      termSet.add(bigram);
    }
  }

  return Array.from(termSet);
}

/**
 * 文境界分割（句点、感嘆符、疑問符、改行で分割し、区切り文字を保持）
 */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[^。！？!?\r\n]+[。！？!?\r\n]*/g);
  if (!matches) return [text.trim()];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Dinkelbach法（分数計画法 / Fractional Programming）による最大情報密度区間最適化
 * 
 * 連続する文区間 [i, j] に対し、(区間に含まれるクエリスコアの総和) / (区間の文字数) の比率を
 * 最大化する最適区間 [i*, j*] を反復決定する。
 * 尺取り法（Sliding Window）が局所解（途中にスコア0の文が挟まる谷）に落ちる問題を、
 * 大域的最適解（Global Optimum）として厳密に解決する。
 */
export function dinkelbachOptimalPassage(
  body: string,
  terms: string[],
  allBlocks: HeadingBlock[],
  opts?: { minChars?: number; maxChars?: number; alpha?: number; maxIter?: number }
): string {
  if (!body || terms.length === 0) return body;
  const sentences = splitSentences(body);
  if (sentences.length <= 1) return body;

  const minChars = opts?.minChars ?? 80;
  const maxChars = opts?.maxChars ?? 350;
  const alpha = opts?.alpha ?? 0.6;
  const maxIter = opts?.maxIter ?? 8;
  const eps = 1e-4;

  const m = sentences.length;
  const weights: number[] = new Array(m);
  const lengths: number[] = new Array(m);

  let totalWeight = 0;
  for (let k = 0; k < m; k++) {
    const s = sentences[k];
    lengths[k] = s.length;
    const lower = s.toLowerCase();
    let w = 0;
    for (const term of terms) {
      const lowerTerm = term.toLowerCase();
      if (lower.includes(lowerTerm)) {
        const termIdf = idf(term, allBlocks, 'body');
        const lengthBonus = term.length >= 4 ? 1.4 : term.length >= 3 ? 1.2 : 1.0;
        w += termIdf * lengthBonus;
      }
    }
    weights[k] = w;
    totalWeight += w;
  }

  // クエリ語が一切含まれない場合は先頭文から最大長までを返す
  if (totalWeight <= 0) {
    let acc = '';
    for (const s of sentences) {
      if (acc.length + s.length > maxChars && acc.length >= minChars) break;
      acc += (acc ? ' ' : '') + s;
    }
    return acc;
  }

  // Dinkelbach 反復: max (W(i, j) / (L(i, j)^alpha))
  let lambda = 0;
  let bestI = 0;
  let bestJ = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    let maxSubarrayVal = -Infinity;
    let optI = -1;
    let optJ = -1;

    for (let i = 0; i < m; i++) {
      let curW = 0;
      let curL = 0;
      for (let j = i; j < m; j++) {
        curW += weights[j];
        curL += lengths[j];

        if (curL > maxChars && j > i) {
          break; // 最大長超過
        }

        if (curL >= minChars || (i === 0 && j === m - 1)) {
          const lCost = Math.pow(curL, alpha);
          const val = curW - lambda * lCost;
          if (val > maxSubarrayVal) {
            maxSubarrayVal = val;
            optI = i;
            optJ = j;
          }
        }
      }
    }

    if (optI === -1) {
      // 制約を満たす区間が見つからなければ、最もスコアの高い文を中心に選択
      let highestIdx = 0;
      let highestW = -1;
      for (let k = 0; k < m; k++) {
        if (weights[k] > highestW) {
          highestW = weights[k];
          highestIdx = k;
        }
      }
      bestI = highestIdx;
      bestJ = highestIdx;
      break;
    }

    bestI = optI;
    bestJ = optJ;

    let optW = 0;
    let optL = 0;
    for (let k = bestI; k <= bestJ; k++) {
      optW += weights[k];
      optL += lengths[k];
    }
    const newLambda = optL > 0 ? optW / Math.pow(optL, alpha) : 0;

    if (Math.abs(newLambda - lambda) < eps || maxSubarrayVal < eps) {
      break;
    }
    lambda = newLambda;
  }

  const selectedSentences = sentences.slice(bestI, bestJ + 1);
  const result = selectedSentences.join(' ');
  const prefix = bestI > 0 ? '...' : '';
  const suffix = bestJ < m - 1 ? '...' : '';

  return `${prefix}${result}${suffix}`.trim();
}
